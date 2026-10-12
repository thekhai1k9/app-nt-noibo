import asyncio
import logging
from collections.abc import Callable, Iterable
from contextlib import AbstractAsyncContextManager, aclosing

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.chat.bus import BusEvent, MessageBus
from app.models import RoomMember

log = logging.getLogger(__name__)

CLOSE_ACCOUNT_LOCKED = 4403
CLOSE_SLOW_CONSUMER = 4408


class Connection:
    """Trạng thái của một WebSocket: hàng đợi gửi đi và tập phòng đang tham gia."""

    def __init__(self, user_id: int, room_ids: Iterable[int] = (), queue_size: int = 100):
        self.user_id = user_id
        self.room_ids: set[int] = set(room_ids)
        self.queue: asyncio.Queue[dict | None] = asyncio.Queue(maxsize=queue_size)
        self.close_code: int | None = None

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
            for conn in conns:
                conn.close(CLOSE_ACCOUNT_LOCKED)
        elif kind == "rooms_changed" and conns:
            async with self._session_factory() as session:
                rows = await session.execute(select(RoomMember.room_id).where(RoomMember.user_id == event.target_id))
                room_ids = set(rows.scalars())
            for conn in conns:
                conn.room_ids = set(room_ids)
                self._offer(conn, {"type": "rooms_changed"})

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
