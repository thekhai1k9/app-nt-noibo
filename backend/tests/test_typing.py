import asyncio
import json

from httpx import AsyncClient

from app.config import get_settings
from tests.conftest import auth_headers, create_room, create_user, login
from tests.helpers import expect_silence, recv_json, ws_open


async def _token(live, username):
    async with AsyncClient(base_url=live.http) as http:
        r = await login(http, username)
        return r.json()["access_token"]


async def _typing(ws, room_id, **extra):
    await ws.send(json.dumps({"type": "typing", "room_id": room_id, **extra}))


async def test_typing_reaches_other_members_with_authenticated_identity(live_server):
    a, b = await create_user("alice"), await create_user("bob")
    room = await create_room(member_ids=[a, b])
    wa, _ = await ws_open(live_server.ws, await _token(live_server, "alice"))
    wb, _ = await ws_open(live_server.ws, await _token(live_server, "bob"))
    await _typing(wa, room, user_id=999, user_name="Kẻ giả mạo")
    assert await recv_json(wb) == {"type": "typing", "room_id": room, "user_id": a, "user_name": "Alice"}
    await wa.close()
    await wb.close()


async def test_typing_not_delivered_outside_room(live_server):
    a, b, c = await create_user("alice"), await create_user("bob"), await create_user("carol")
    room = await create_room(member_ids=[a, b])
    wa, _ = await ws_open(live_server.ws, await _token(live_server, "alice"))
    wb, _ = await ws_open(live_server.ws, await _token(live_server, "bob"))
    wc, _ = await ws_open(live_server.ws, await _token(live_server, "carol"))
    await _typing(wa, room)
    await recv_json(wb)
    await expect_silence(wc)
    await _typing(wc, room)
    await expect_silence(wb)
    await expect_silence(wc)  # không có lỗi cho người ngoài phòng
    for ws in (wa, wb, wc):
        await ws.close()


async def test_typing_is_throttled_per_room(live_server, monkeypatch):
    import types

    import app.routers.ws as ws_module

    clock = {"t": 1000.0}  # dong ho gia: khong phu thuoc thoi gian that
    monkeypatch.setattr(ws_module, "time", types.SimpleNamespace(monotonic=lambda: clock["t"]))
    a, b = await create_user("alice"), await create_user("bob")
    r1 = await create_room(member_ids=[a, b])
    r2 = await create_room(member_ids=[a, b])
    wa, _ = await ws_open(live_server.ws, await _token(live_server, "alice"))
    wb, _ = await ws_open(live_server.ws, await _token(live_server, "bob"))
    for _ in range(5):
        await _typing(wa, r1)
    assert (await recv_json(wb))["room_id"] == r1
    await expect_silence(wb, 0.3)
    await _typing(wa, r2)  # phòng khác không bị chặn bởi r1
    assert (await recv_json(wb))["room_id"] == r2
    clock["t"] += get_settings().ws_typing_interval_seconds + 1
    await _typing(wa, r1)
    assert (await recv_json(wb))["room_id"] == r1
    await wa.close()
    await wb.close()


async def test_typing_invalid_room_id(live_server):
    a = await create_user("alice")
    await create_room(member_ids=[a])
    ws, _ = await ws_open(live_server.ws, await _token(live_server, "alice"))
    for bad in ("1", True, 0, 2**31, None, 1.5):
        await _typing(ws, bad)
        assert (await recv_json(ws))["code"] == "invalid_message"
    await ws.close()


async def test_typing_does_not_consume_send_rate_limit(live_server):
    a = await create_user("alice")
    room = await create_room(member_ids=[a])
    ws, _ = await ws_open(live_server.ws, await _token(live_server, "alice"))
    for _ in range(30):
        await _typing(ws, room)
    for n in range(5):  # WS_RATE_LIMIT_MESSAGES=5 trong conftest
        await ws.send(json.dumps({"type": "send", "room_id": room, "body": f"t{n}", "client_id": f"c{n}"}))
    messages = 0
    while messages < 5:
        event = await recv_json(ws)
        if event["type"] == "message":
            messages += 1
        else:
            assert event["type"] == "typing"  # bus phát lại typing cho cả người gửi
    await ws.close()


async def test_typing_after_archive_or_removal(live_server):
    await create_user("root", role="admin")
    a, b = await create_user("alice"), await create_user("bob")
    room = await create_room(name="Nhóm", member_ids=[a, b])
    other = await create_room(name="Nhóm 2", member_ids=[a, b])
    wa, _ = await ws_open(live_server.ws, await _token(live_server, "alice"))
    wb, _ = await ws_open(live_server.ws, await _token(live_server, "bob"))
    async with AsyncClient(base_url=live_server.http) as http:
        admin = auth_headers(await _token(live_server, "root"))
        assert (await http.delete(f"/api/admin/rooms/{room}/members/{a}", headers=admin)).status_code == 200
        assert (await recv_json(wa)) == {"type": "rooms_changed"}
        await _typing(wa, room)
        await expect_silence(wb)
        assert (await http.delete(f"/api/admin/rooms/{other}", headers=admin)).status_code == 204
        assert (await recv_json(wa)) == {"type": "rooms_changed"}
        assert (await recv_json(wb)) == {"type": "rooms_changed"}  # lưu trữ báo cho mọi thành viên
        await _typing(wa, other)
        await expect_silence(wb)
    await wa.close()
    await wb.close()


async def test_typing_last_pruned_for_rooms_no_longer_joined(live_server):
    a, b = await create_user("alice"), await create_user("bob")
    r1 = await create_room(member_ids=[a, b])
    r2 = await create_room(member_ids=[a, b])
    wa, _ = await ws_open(live_server.ws, await _token(live_server, "alice"))
    wb, _ = await ws_open(live_server.ws, await _token(live_server, "bob"))
    hub = live_server.app.state.hub
    conn = next(iter(hub._conns[a]))
    await _typing(wa, r1)
    assert (await recv_json(wb))["room_id"] == r1
    assert set(conn.typing_last) == {r1}
    conn.room_ids.discard(r1)  # roi phong r1
    await _typing(wa, r2)
    assert (await recv_json(wb))["room_id"] == r2
    assert set(conn.typing_last) == {r2}
    await wa.close()
    await wb.close()
