import asyncio
import logging
from collections.abc import Callable, Iterable
from contextlib import AbstractAsyncContextManager, aclosing

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.chat.bus import BusEvent, MessageBus
from app.chat.service import user_room_ids
from app.models import Room, RoomMember, User

log = logging.getLogger(__name__)

CLOSE_UNAUTHENTICATED = 4401
CLOSE_ACCOUNT_LOCKED = 4403
CLOSE_SLOW_CONSUMER = 4408
DISCONNECT_CODES = {CLOSE_UNAUTHENTICATED, CLOSE_ACCOUNT_LOCKED}
RECONCILE_TIMEOUT_SECONDS = 10.0


class Connection:
    """Trạng thái của một WebSocket: hàng đợi gửi đi và tập phòng đang tham gia."""

    def __init__(self, user_id: int, room_ids: Iterable[int] = (), queue_size: int = 100):
        self.user_id = user_id
        self.room_ids: set[int] = set(room_ids)
        self.queue: asyncio.Queue[dict | None] = asyncio.Queue(maxsize=queue_size)
        self.close_code: int | None = None
        self.version = 0  # tăng mỗi khi hub gán lại room_ids

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
    ):
        self.bus = bus
        self._session_factory = session_factory
        self._reconnect_delay = reconnect_delay
        self._conns: dict[int, set[Connection]] = {}

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
            for conn in self._all():
                if event.target_id in conn.room_ids:
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

    async def close_all(self, code: int = 1001) -> None:
        for conn in self._all():
            conn.close(code)
