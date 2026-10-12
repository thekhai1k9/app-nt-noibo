import asyncio
import logging
import uuid
from collections.abc import Callable, Iterable
from contextlib import AbstractAsyncContextManager, aclosing

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.chat.bus import BusEvent, MessageBus, publish_room_safely
from app.chat.presence import Presence
from app.chat.service import user_room_ids
from app.models import Room, RoomMember, User

log = logging.getLogger(__name__)

CLOSE_UNAUTHENTICATED = 4401
CLOSE_ACCOUNT_LOCKED = 4403
CLOSE_SLOW_CONSUMER = 4408
DISCONNECT_CODES = {CLOSE_UNAUTHENTICATED, CLOSE_ACCOUNT_LOCKED}
RECONCILE_TIMEOUT_SECONDS = 10.0
PRESENCE_OP_TIMEOUT_SECONDS = 1.0  # gioi han cho thao tac presence tren duong xu ly frame/ket noi


class Connection:
    """Trạng thái của một WebSocket: hàng đợi gửi đi và tập phòng đang tham gia."""

    def __init__(self, user_id: int, room_ids: Iterable[int] = (), queue_size: int = 100, user_name: str = ""):
        self.user_id = user_id
        self.user_name = user_name  # lấy từ tài khoản đã xác thực, không bao giờ từ frame
        self.typing_last: dict[int, float] = {}  # phòng -> time.monotonic() lần gửi typing gần nhất
        self.room_ids: set[int] = set(room_ids)
        self.queue: asyncio.Queue[dict | None] = asyncio.Queue(maxsize=queue_size)
        self.close_code: int | None = None
        self.version = 0  # tăng mỗi khi hub gán lại room_ids
        self.conn_id = uuid.uuid4().hex

    def offer(self, event: dict) -> bool:
        if self.close_code is not None:
            return False
        try:
            self.queue.put_nowait(event)
            return True
        except asyncio.QueueFull:
            return False

    def close(self, code: int) -> None:
        """Đánh dấu đóng: xả hàng đợi rồi đặt sentinel None để writer đóng WebSocket với `code`."""
        if self.close_code is not None:
            return
        self.close_code = code
        while not self.queue.empty():
            self.queue.get_nowait()
        self.queue.put_nowait(None)


def apply_room_snapshot(conn: Connection, version: int, room_ids: Iterable[int]) -> bool:
    """Gán room_ids đọc từ DB chỉ khi hub chưa áp dụng snapshot mới hơn (version không đổi)."""
    if conn.version != version:
        return False
    conn.room_ids = set(room_ids)
    return True


class Hub:
    def __init__(
        self,
        bus: MessageBus,
        session_factory: Callable[[], AbstractAsyncContextManager[AsyncSession]],
        reconnect_delay: float = 1.0,
        presence: Presence | None = None,
    ):
        self.bus = bus
        self._session_factory = session_factory
        self._reconnect_delay = reconnect_delay
        self._conns: dict[int, set[Connection]] = {}
        self.presence = presence
        self._announced: dict[int, bool] = {}  # trang thai presence da phat thanh cong gan nhat
        self._dirty: set[int] = set()  # user can (phat lai) trang thai
        self._wake = asyncio.Event()
        self._announcing: int | None = None
        self._announcer: asyncio.Task | None = None
        self._baselined = False  # luot quet dau tien chi ghi nhan, khong phat
        self._closing = False

    def register(self, conn: Connection) -> None:
        self._conns.setdefault(conn.user_id, set()).add(conn)

    def unregister(self, conn: Connection) -> None:
        conns = self._conns.get(conn.user_id)
        if conns:
            conns.discard(conn)
            if not conns:
                del self._conns[conn.user_id]

    def _all(self) -> list[Connection]:
        return [conn for conns in self._conns.values() for conn in conns]

    def _offer(self, conn: Connection, event: dict) -> None:
        if not conn.offer(event) and conn.close_code is None:
            conn.close(CLOSE_SLOW_CONSUMER)

    def broadcast(self, event: dict) -> None:
        for conn in self._all():
            self._offer(conn, event)

    async def _dispatch(self, event: BusEvent) -> None:
        if not isinstance(event.payload, dict):
            return
        if event.scope == "room":
            own_presence = event.payload.get("user_id") if event.payload.get("type") == "presence" else None
            for conn in self._all():
                if event.target_id in conn.room_ids and conn.user_id != own_presence:  # không báo presence cho chính mình
                    self._offer(conn, event.payload)
            return
        if event.scope != "user":
            return
        conns = list(self._conns.get(event.target_id, ()))
        kind = event.payload.get("type")
        if kind == "disconnect":
            code = event.payload.get("code")
            if type(code) is not int or code not in DISCONNECT_CODES:
                code = CLOSE_ACCOUNT_LOCKED
            for conn in conns:
                conn.close(code)
        elif kind == "rooms_changed" and conns:
            async with self._session_factory() as session:
                room_ids = await user_room_ids(session, event.target_id)
            for conn in conns:
                conn.room_ids = set(room_ids)
                conn.version += 1
                self._offer(conn, {"type": "rooms_changed"})

    async def reconcile(self) -> None:
        """Một lượt đối soát với DB: nạp lại room_ids của mọi kết nối và đóng kết nối của user bị khoá (4403)
        hoặc phải đổi mật khẩu (4401). Sự kiện bus có thể bị lỡ nên đây là lưới an toàn."""
        conns = self._all()
        if not conns:
            return
        versions = {conn: conn.version for conn in conns}
        user_ids = {conn.user_id for conn in conns}
        try:
            async with self._session_factory() as session:
                rows = await session.execute(
                    select(User.id, User.is_active, User.must_change_password).where(User.id.in_(user_ids))
                )
                rows_state = list(rows)
                blocked_locked = {uid for uid, active, _ in rows_state if not active}
                blocked_reauth = {uid for uid, active, must_change in rows_state if active and must_change}
                rows = await session.execute(
                    select(RoomMember.user_id, RoomMember.room_id)
                    .join(Room, Room.id == RoomMember.room_id)
                    .where(RoomMember.user_id.in_(user_ids), Room.archived_at.is_(None))
                )
                by_user: dict[int, set[int]] = {}
                for user_id, room_id in rows:
                    by_user.setdefault(user_id, set()).add(room_id)
        except Exception:
            log.exception("failed to reconcile connections with the database")
            return
        for conn in conns:
            if conn.user_id in blocked_locked:
                conn.close(CLOSE_ACCOUNT_LOCKED)
            elif conn.user_id in blocked_reauth:
                conn.close(CLOSE_UNAUTHENTICATED)
            elif conn.version == versions[conn]:  # chưa có sự kiện/snapshot mới hơn trong lúc đọc DB
                new_rooms = set(by_user.get(conn.user_id, ()))
                changed = new_rooms != conn.room_ids
                conn.room_ids = new_rooms
                conn.version += 1
                if changed:
                    self._offer(conn, {"type": "rooms_changed"})

    async def _reconcile_guarded(self) -> None:
        try:
            await asyncio.wait_for(self.reconcile(), timeout=RECONCILE_TIMEOUT_SECONDS)
        except Exception:  # CancelledError là BaseException nên vẫn lan ra ngoài
            log.exception("reconcile failed or timed out")

    async def run_reconciler(self, interval: float) -> None:
        """Chạy `reconcile` định kỳ mãi mãi; lỗi một lượt không làm dừng vòng lặp."""
        while True:
            await asyncio.sleep(interval)
            await self._reconcile_guarded()

    async def run(self) -> None:
        """Nghe bus mãi mãi; khi bus lỗi thì báo client tải lại (`resync`) rồi nghe lại."""
        delay = self._reconnect_delay
        had_subscription = False
        while True:
            try:
                async with aclosing(self.bus.listen()) as events:
                    async for event in events:
                        if event.scope == "system":
                            if had_subscription:
                                await self._reconcile_guarded()
                                self.broadcast({"type": "resync"})
                            had_subscription = True
                            delay = self._reconnect_delay
                            continue
                        try:
                            await self._dispatch(event)
                        except Exception:
                            log.exception("failed to dispatch bus event")
                            continue
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("message bus listener failed")
            await asyncio.sleep(delay)
            delay = min(delay * 2, 30)

    # ---------- presence ----------
    # Thong bao presence theo TRANG THAI (khong theo chuyen tiep): moi user co `_announced` (trang thai da phat thanh
    # cong gan nhat) va co the nam trong `_dirty`. Mot tac vu announcer duy nhat lay tung user trong `_dirty`, tinh trang
    # thai HIEN TAI tai thoi diem phat roi moi phat; loi thi tra user ve `_dirty` de luot quet sau thu lai.

    def _is_registered(self, conn: Connection) -> bool:
        return conn in self._conns.get(conn.user_id, ())

    def _kick(self) -> None:
        """Danh thuc announcer (tao luoi khi can). Khong lam gi sau close_all."""
        if self._closing:
            return
        if self._announcer is None or self._announcer.done():
            self._announcer = asyncio.create_task(self._announcer_loop())
        self._wake.set()

    def _mark_dirty(self, user_id: int) -> None:
        self._dirty.add(user_id)
        self._kick()

    async def _current_state(self, user_id: int) -> bool:
        if any(c.close_code is None for c in self._conns.get(user_id, ())):
            return True
        if self.presence is None:
            return False
        return user_id in await self.presence.online_user_ids()

    async def _publish(self, user_id: int, online: bool) -> None:
        """Phat presence toi cac phong chua luu tru ma user la thanh vien; nem loi neu co phong khong phat duoc."""
        async with self._session_factory() as session:
            room_ids = await user_room_ids(session, user_id)
        event = {"type": "presence", "user_id": user_id, "online": online}
        failed = False
        for room_id in sorted(room_ids):
            if not await publish_room_safely(self.bus, room_id, event):
                failed = True
        if failed:
            raise RuntimeError("presence publish failed")

    async def _announce_user(self, user_id: int) -> None:
        online = await self._current_state(user_id)
        if self._announced.get(user_id) == online:
            return
        await self._publish(user_id, online)
        self._announced[user_id] = online

    async def _announcer_loop(self) -> None:
        while True:
            await self._wake.wait()
            self._wake.clear()
            for user_id in sorted(self._dirty):
                self._dirty.discard(user_id)  # thay doi moi trong luc phat se danh dau lai
                self._announcing = user_id
                try:
                    await self._announce_user(user_id)
                except Exception:
                    log.warning("presence announce failed; will retry on next sweep", exc_info=True)
                    self._dirty.add(user_id)
                finally:
                    self._announcing = None

    async def _remove_quietly(self, conn: Connection) -> None:
        try:
            await self.presence.remove(conn.user_id, conn.conn_id)
        except Exception:
            log.warning("presence remove failed", exc_info=True)

    async def on_connected(self, conn: Connection) -> None:
        if self.presence is None:
            return
        try:
            await asyncio.wait_for(self.presence.touch(conn.user_id, conn.conn_id), PRESENCE_OP_TIMEOUT_SECONDS)
        except Exception:
            log.warning("presence touch failed on connect", exc_info=True)
        self._mark_dirty(conn.user_id)  # ke ca khi Redis loi: trang thai cuc bo da la online

    async def on_disconnected(self, conn: Connection) -> None:
        if self.presence is None:
            return
        await self._remove_quietly(conn)  # luon xoa, ke ca khi on_connected loi/bi huy; het han se don neu loi
        self._mark_dirty(conn.user_id)

    async def refresh_presence(self, conn: Connection) -> None:
        """Gia han ket noi khi client ping (mot ZADD, co gioi han thoi gian); loi Redis khong anh huong ket noi."""
        if self.presence is None:
            return
        try:
            await asyncio.wait_for(self.presence.touch(conn.user_id, conn.conn_id), PRESENCE_OP_TIMEOUT_SECONDS)
        except Exception:
            log.warning("presence refresh failed", exc_info=True)
        if not self._is_registered(conn):
            await self._remove_quietly(conn)  # dung de lan gia han muon hoan tac viec xoa khi ngat ket noi

    async def _collect_online(self) -> set[int]:
        """Phan Redis cua mot luot quet: gia han ket noi cuc bo TRUOC roi doc tap online."""
        local = [c for c in self._all() if c.close_code is None]
        await self.presence.touch_many((c.user_id, c.conn_id) for c in local)
        for conn in local:
            if not self._is_registered(conn):  # da ngat ket noi trong luc gia han: hoan tac phan tu vua ghi
                await self._remove_quietly(conn)
        online = await self.presence.online_user_ids()
        return online | {c.user_id for c in self._all() if c.close_code is None}

    def _reconcile_announced(self, online: set[int]) -> None:
        if not self._baselined:
            self._baselined = True  # luot dau: ghi nhan trang thai hien co, khong phat
            for user_id in online:
                if user_id not in self._dirty and user_id != self._announcing:  # đang chờ/đang phát thì để announcer lo
                    self._announced.setdefault(user_id, True)
        else:
            for user_id in online | set(self._announced):
                if self._announced.get(user_id, False) != (user_id in online):
                    self._dirty.add(user_id)
        if self._dirty:
            self._kick()

    async def sweep_presence(self) -> None:
        if self.presence is None:
            return
        self._reconcile_announced(await self._collect_online())

    async def _sweep_guarded(self) -> None:
        if self.presence is None:
            return
        try:  # timeout chi bao phan Redis; viec phat nam o announcer nen khong bi mat khi qua han
            online = await asyncio.wait_for(self._collect_online(), timeout=RECONCILE_TIMEOUT_SECONDS)
        except Exception:
            log.exception("presence sweep failed or timed out")
            if self._dirty:
                self._kick()  # thu lai cac thong bao con ton
            return
        self._reconcile_announced(online)

    async def run_presence_sweeper(self, interval: float) -> None:
        while True:
            await asyncio.sleep(interval)
            await self._sweep_guarded()

    async def close_all(self, code: int = 1001) -> None:
        self._closing = True
        announcer, self._announcer = self._announcer, None
        if announcer is not None:
            announcer.cancel()
            await asyncio.gather(announcer, return_exceptions=True)
        for conn in self._all():
            conn.close(code)
