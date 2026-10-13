import asyncio
import json
import logging
import time
from collections import deque

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.chat import service
from app.chat.bus import publish_room_safely
from app.chat.hub import Connection, Hub, apply_room_snapshot
from app.chat.service import ChatError
from app.config import get_settings
from app.db import SessionLocal
from app.models import User
from app.security import decode_access_token

log = logging.getLogger(__name__)
router = APIRouter()

MAX_FRAME_BYTES = 16_384
MAX_ROOM_ID = 2**31 - 1
MAX_MESSAGE_ID = 2**63 - 1
MAX_USER_ID = 2**31 - 1
MAX_MENTIONS_RAW = 200  # chặn danh sách khổng lồ; service lọc rồi mới cắt còn 20
MAX_CLIENT_ID_CHARS = 64
CLOSE_UNAUTHENTICATED = 4401
CLOSE_FRAME_TOO_LARGE = 4413
CLOSE_INTERNAL_ERROR = 1011


def _client_id(value) -> str | None:
    """Chỉ echo lại client_id hợp lệ (chuỗi tối đa 64 ký tự), còn lại là null."""
    return value if isinstance(value, str) and len(value) <= MAX_CLIENT_ID_CHARS else None


async def _receive(websocket: WebSocket) -> str | None:
    """Nhận một frame; trả None nếu không phải text (binary hoặc loại khác)."""
    message = await websocket.receive()
    if message["type"] == "websocket.disconnect":
        raise WebSocketDisconnect(message.get("code", 1000))
    text = message.get("text")
    return text if isinstance(text, str) else None


async def _authenticate(websocket: WebSocket) -> User | None:
    settings = get_settings()
    try:
        raw = await asyncio.wait_for(_receive(websocket), timeout=settings.ws_auth_timeout_seconds)
        if raw is not None and len(raw.encode("utf-8")) > MAX_FRAME_BYTES:
            await _close(websocket, CLOSE_FRAME_TOO_LARGE)
            return None
        data = json.loads(raw) if raw is not None else None
    except (asyncio.TimeoutError, ValueError, WebSocketDisconnect, RuntimeError):
        await _close(websocket, CLOSE_UNAUTHENTICATED)
        return None
    token = data.get("token") if isinstance(data, dict) and data.get("type") == "auth" else None
    user_id = decode_access_token(token) if isinstance(token, str) else None
    user = None
    if user_id is not None:
        try:
            async with SessionLocal() as session:
                user = await session.get(User, user_id)
        except Exception:
            log.exception("websocket auth: failed to load user")
            await _close(websocket, CLOSE_INTERNAL_ERROR)
            return None
    if user is None or not user.is_active or user.must_change_password:
        await _close(websocket, CLOSE_UNAUTHENTICATED)
        return None
    return user


async def _close(websocket: WebSocket, code: int) -> None:
    try:
        await websocket.close(code=code)
    except (RuntimeError, WebSocketDisconnect, OSError):  # client đã biến mất hoặc đã đóng
        pass


def _valid_reply_to(value) -> bool:
    return value is None or (isinstance(value, int) and not isinstance(value, bool) and 1 <= value <= MAX_MESSAGE_ID)


def _valid_mentions(value) -> bool:
    return value is None or (
        isinstance(value, list)
        and len(value) <= MAX_MENTIONS_RAW
        and all(isinstance(v, int) and not isinstance(v, bool) and 1 <= v <= MAX_USER_ID for v in value)
    )


async def _handle_send(conn: Connection, hub: Hub, data: dict, window: deque) -> None:
    settings = get_settings()
    client_id = _client_id(data.get("client_id"))
    now = time.monotonic()
    while window and now - window[0] > settings.ws_rate_limit_seconds:
        window.popleft()
    if len(window) >= settings.ws_rate_limit_messages:
        conn.offer({"type": "error", "code": "rate_limited", "client_id": client_id})
        return
    window.append(now)

    room_id, body = data.get("room_id"), data.get("body")
    raw_client_id = data.get("client_id")
    if (
        not isinstance(room_id, int)
        or isinstance(room_id, bool)
        or not (1 <= room_id <= MAX_ROOM_ID)
        or not isinstance(body, str)
        or not (raw_client_id is None or isinstance(raw_client_id, str))
        or not _valid_reply_to(data.get("reply_to_id"))
        or not _valid_mentions(data.get("mentions"))
        or not (data.get("mention_all") is None or isinstance(data.get("mention_all"), bool))
    ):
        conn.offer({"type": "error", "code": "invalid_message", "client_id": client_id})
        return
    try:
        async with SessionLocal() as session:
            message, sender_name, created = await service.send_message(
                session,
                conn.user_id,
                room_id,
                body,
                raw_client_id,
                reply_to_id=data.get("reply_to_id"),
                mentions=data.get("mentions") or (),
                mention_all=data.get("mention_all") is True,
            )
            (out,) = await service.messages_out(session, [(message, sender_name)])
    except ChatError as err:
        if err.status == 401:
            conn.close(CLOSE_UNAUTHENTICATED)
            return
        conn.offer({"type": "error", "code": err.code, "client_id": client_id})
        return
    except Exception:
        log.exception("websocket send failed")
        conn.offer({"type": "error", "code": "internal_error", "client_id": client_id})
        return
    event = {"type": "message", "message": out.model_dump(mode="json")}
    if not created:
        conn.offer(event)  # gửi trùng: chỉ trả lại cho người gửi
    elif not await publish_room_safely(hub.bus, room_id, event):
        conn.offer(event)  # bus lỗi: ít nhất người gửi thấy tin của mình; người khác tải lại khi nối lại


async def _handle_typing(conn: Connection, hub: Hub, data: dict) -> None:
    room_id = data.get("room_id")
    if not isinstance(room_id, int) or isinstance(room_id, bool) or not (1 <= room_id <= MAX_ROOM_ID):
        conn.offer({"type": "error", "code": "invalid_message", "client_id": None})
        return
    if room_id not in conn.room_ids:
        return  # không phải thành viên (hoặc phòng đã lưu trữ): bỏ qua im lặng
    now = time.monotonic()
    for stale in [r for r in conn.typing_last if r not in conn.room_ids]:
        del conn.typing_last[stale]  # không để bộ nhớ throttle phình ra khi rời phòng
    last = conn.typing_last.get(room_id)
    if last is not None and now - last < get_settings().ws_typing_interval_seconds:
        return
    conn.typing_last[room_id] = now
    await publish_room_safely(
        hub.bus,
        room_id,
        {"type": "typing", "room_id": room_id, "user_id": conn.user_id, "user_name": conn.user_name},
    )


async def _reader(websocket: WebSocket, conn: Connection, hub: Hub) -> None:
    window: deque[float] = deque()
    while True:
        raw = await _receive(websocket)
        if conn.close_code is not None:  # hub đã quyết định đóng: không xử lý thêm frame nào
            return
        if raw is None:
            conn.offer({"type": "error", "code": "unsupported_frame", "client_id": None})
            continue
        if len(raw.encode("utf-8")) > MAX_FRAME_BYTES:
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
            await hub.refresh_presence(conn)
        elif kind == "send":
            await _handle_send(conn, hub, data, window)
        elif kind == "typing":
            await _handle_typing(conn, hub, data)
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
    conn = Connection(user.id, user_name=user.full_name, initialized=False)
    hub.register(conn)
    try:
        async with SessionLocal() as session:
            version = conn.version
            ids = await service.user_room_ids(session, user.id)
        apply_room_snapshot(conn, version, ids)  # bỏ qua nếu hub đã áp dụng snapshot mới hơn trong lúc chờ
        conn.initialized = True
        await websocket.send_json({"type": "ready", "user_id": user.id})
        await hub.on_connected(conn)
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
            if isinstance(exc, RuntimeError):
                log.debug("websocket task ended with RuntimeError", exc_info=exc)
            elif exc is not None and not isinstance(exc, WebSocketDisconnect):
                log.error("websocket task failed", exc_info=exc)
        if conn.close_code is not None:
            # reader tự đóng (ví dụ 4413) hoặc writer bị huỷ trước khi kịp đóng; _close nuốt lỗi đóng đôi
            await _close(websocket, conn.close_code)
    finally:
        hub.unregister(conn)
        await asyncio.shield(hub.on_disconnected(conn))
