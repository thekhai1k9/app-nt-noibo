import asyncio
import json
import logging
import time
from collections import deque

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.chat import service
from app.chat.bus import publish_room_safely
from app.chat.hub import Connection, Hub
from app.chat.schemas import to_message_out
from app.chat.service import ChatError
from app.config import get_settings
from app.db import SessionLocal
from app.models import User
from app.security import decode_access_token

log = logging.getLogger(__name__)
router = APIRouter()

MAX_FRAME_CHARS = 16_384
CLOSE_UNAUTHENTICATED = 4401
CLOSE_FRAME_TOO_LARGE = 4413


async def _authenticate(websocket: WebSocket) -> User | None:
    settings = get_settings()
    try:
        raw = await asyncio.wait_for(websocket.receive_text(), timeout=settings.ws_auth_timeout_seconds)
        data = json.loads(raw)
    except (asyncio.TimeoutError, ValueError, WebSocketDisconnect, RuntimeError):
        await _close(websocket, CLOSE_UNAUTHENTICATED)
        return None
    token = data.get("token") if isinstance(data, dict) and data.get("type") == "auth" else None
    user_id = decode_access_token(token) if isinstance(token, str) else None
    user = None
    if user_id is not None:
        async with SessionLocal() as session:
            user = await session.get(User, user_id)
    if user is None or not user.is_active or user.must_change_password:
        await _close(websocket, CLOSE_UNAUTHENTICATED)
        return None
    return user


async def _close(websocket: WebSocket, code: int) -> None:
    try:
        await websocket.close(code=code)
    except RuntimeError:
        pass


async def _handle_send(conn: Connection, hub: Hub, data: dict, window: deque) -> None:
    settings = get_settings()
    client_id = data.get("client_id")
    now = time.monotonic()
    while window and now - window[0] > settings.ws_rate_limit_seconds:
        window.popleft()
    if len(window) >= settings.ws_rate_limit_messages:
        conn.offer({"type": "error", "code": "rate_limited", "client_id": client_id})
        return
    window.append(now)

    room_id, body = data.get("room_id"), data.get("body")
    if (
        not isinstance(room_id, int)
        or isinstance(room_id, bool)
        or not isinstance(body, str)
        or not (client_id is None or isinstance(client_id, str))
    ):
        conn.offer({"type": "error", "code": "invalid_message", "client_id": client_id if isinstance(client_id, str) else None})
        return
    try:
        async with SessionLocal() as session:
            message, sender_name, created = await service.send_message(session, conn.user_id, room_id, body, client_id)
    except ChatError as err:
        if err.status == 401:
            conn.close(CLOSE_UNAUTHENTICATED)
            return
        conn.offer({"type": "error", "code": err.code, "client_id": client_id})
        return
    event = {"type": "message", "message": to_message_out(message, sender_name).model_dump(mode="json")}
    if not created:
        conn.offer(event)  # gửi trùng: chỉ trả lại cho người gửi
    elif not await publish_room_safely(hub.bus, room_id, event):
        conn.offer(event)  # bus lỗi: ít nhất người gửi thấy tin của mình; người khác tải lại khi nối lại


async def _reader(websocket: WebSocket, conn: Connection, hub: Hub) -> None:
    window: deque[float] = deque()
    while True:
        raw = await websocket.receive_text()
        if len(raw) > MAX_FRAME_CHARS:
            conn.close(CLOSE_FRAME_TOO_LARGE)
            return
        try:
            data = json.loads(raw)
        except ValueError:
            conn.offer({"type": "error", "code": "invalid_json", "client_id": None})
            continue
        kind = data.get("type") if isinstance(data, dict) else None
        if kind == "ping":
            conn.offer({"type": "pong"})
        elif kind == "send":
            await _handle_send(conn, hub, data, window)
        else:
            conn.offer({"type": "error", "code": "unknown_type", "client_id": None})


async def _writer(websocket: WebSocket, conn: Connection) -> None:
    while True:
        event = await conn.queue.get()
        if event is None:
            await _close(websocket, conn.close_code or 1000)
            return
        await websocket.send_json(event)


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    hub: Hub = websocket.app.state.hub
    await websocket.accept()
    user = await _authenticate(websocket)
    if user is None:
        return
    conn = Connection(user.id)
    hub.register(conn)
    try:
        async with SessionLocal() as session:
            conn.room_ids = await service.user_room_ids(session, user.id)
        await websocket.send_json({"type": "ready", "user_id": user.id})
        tasks = {
            asyncio.create_task(_reader(websocket, conn, hub)),
            asyncio.create_task(_writer(websocket, conn)),
        }
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        for task in done:
            exc = task.exception()
            if exc is not None and not isinstance(exc, (WebSocketDisconnect, RuntimeError)):
                log.error("websocket task failed", exc_info=exc)
        if conn.close_code is not None and conn.queue.qsize():
            # reader tự đóng (ví dụ 4413): để writer kịp đóng WebSocket với mã đã đặt
            await _close(websocket, conn.close_code)
    finally:
        hub.unregister(conn)
