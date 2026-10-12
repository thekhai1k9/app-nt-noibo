import asyncio
import json

import pytest
from websockets.asyncio.client import connect

from app.chat.bus import BusEvent


class InMemoryBus:
    """MessageBus chạy trong tiến trình, dùng cho test không cần Redis thật."""

    def __init__(self):
        self.published: list[tuple[str, int, dict]] = []
        self.fail_listens = 0  # số lần listen() tiếp theo lỗi trước khi đăng ký
        self.fail_after_subscribe = 0  # số lần listen() tiếp theo đăng ký xong rồi mới lỗi
        self._queue: asyncio.Queue[BusEvent] = asyncio.Queue()

    async def publish_room(self, room_id: int, event: dict) -> None:
        self.published.append(("room", room_id, event))
        await self._queue.put(BusEvent("room", room_id, json.loads(json.dumps(event))))

    async def publish_user(self, user_id: int, event: dict) -> None:
        self.published.append(("user", user_id, event))
        await self._queue.put(BusEvent("user", user_id, json.loads(json.dumps(event))))

    async def listen(self):
        if self.fail_listens > 0:
            self.fail_listens -= 1
            raise ConnectionError("bus down")
        yield BusEvent("system", 0, {"type": "subscribed"})
        if self.fail_after_subscribe > 0:
            self.fail_after_subscribe -= 1
            raise ConnectionError("bus dropped")
        while True:
            yield await self._queue.get()


async def ws_open(ws_base: str, token: str):
    """Mở WebSocket, gửi tin auth, trả (ws, tin đầu tiên nhận được)."""
    ws = await connect(f"{ws_base}/api/ws")
    await ws.send(json.dumps({"type": "auth", "token": token}))
    first = json.loads(await asyncio.wait_for(ws.recv(), 3))
    return ws, first


async def recv_json(ws, timeout: float = 3, include_presence: bool = False):
    """Nhận một sự kiện; mặc định bỏ qua `presence` (sự kiện nền do kết nối của người khác gây ra)."""
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        event = json.loads(await asyncio.wait_for(ws.recv(), max(deadline - asyncio.get_running_loop().time(), 0.001)))
        if include_presence or event.get("type") != "presence":
            return event


async def expect_silence(ws, seconds: float = 0.4):
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(ws.recv(), seconds)


async def wait_closed(ws, timeout: float = 3) -> int | None:
    await asyncio.wait_for(ws.wait_closed(), timeout)
    return ws.protocol.close_code  # websockets 13.1: Connection has no close_code attribute
