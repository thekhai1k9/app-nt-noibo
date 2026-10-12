import asyncio
import json

import pytest
from httpx import AsyncClient
from websockets.asyncio.client import connect

from tests.conftest import (
    add_message,
    auth_headers,
    create_room,
    create_user,
    login,
)
from tests.helpers import expect_silence, recv_json, wait_closed, ws_open


async def _token(live, username):
    async with AsyncClient(base_url=live.http) as http:
        r = await login(http, username)
        return r.json()["access_token"]


async def _send(ws, room_id, body, client_id=None):
    await ws.send(json.dumps({"type": "send", "room_id": room_id, "body": body, "client_id": client_id}))


# ---------- xác thực ----------

async def test_valid_token_gets_ready(live_server):
    uid = await create_user("alice")
    ws, first = await ws_open(live_server.ws, await _token(live_server, "alice"))
    assert first == {"type": "ready", "user_id": uid}
    await ws.close()


async def test_bad_token_is_closed_with_4401(live_server):
    await create_user("alice")
    ws = await connect(f"{live_server.ws}/api/ws")
    await ws.send(json.dumps({"type": "auth", "token": "garbage"}))
    assert await wait_closed(ws) == 4401


async def test_no_auth_message_in_time_is_closed_with_4401(live_server):
    ws = await connect(f"{live_server.ws}/api/ws")
    assert await wait_closed(ws, timeout=4) == 4401


async def test_first_message_must_be_auth(live_server):
    await create_user("alice")
    ws = await connect(f"{live_server.ws}/api/ws")
    await ws.send(json.dumps({"type": "send", "room_id": 1, "body": "x"}))
    assert await wait_closed(ws) == 4401


async def test_a_user_who_must_change_the_password_cannot_connect(live_server):
    await create_user("fresh", must_change=True)
    ws = await connect(f"{live_server.ws}/api/ws")
    await ws.send(json.dumps({"type": "auth", "token": await _token(live_server, "fresh")}))
    assert await wait_closed(ws) == 4401


async def test_a_user_locked_after_login_cannot_connect_with_their_old_token(live_server):
    from app.db import SessionLocal
    from app.models import User

    uid = await create_user("later")
    token = await _token(live_server, "later")
    async with SessionLocal() as s:
        (await s.get(User, uid)).is_active = False
        await s.commit()
    ws = await connect(f"{live_server.ws}/api/ws")
    await ws.send(json.dumps({"type": "auth", "token": token}))
    assert await wait_closed(ws) == 4401


# ---------- gửi và nhận ----------

async def test_message_reaches_all_members_and_nobody_else(live_server):
    a, b, c = await create_user("alice"), await create_user("bob"), await create_user("carol")
    room = await create_room(member_ids=[a, b])
    wa, _ = await ws_open(live_server.ws, await _token(live_server, "alice"))
    wb, _ = await ws_open(live_server.ws, await _token(live_server, "bob"))
    wc, _ = await ws_open(live_server.ws, await _token(live_server, "carol"))
    await _send(wa, room, "  xin chào  ", "cid-1")

    mine, theirs = await recv_json(wa), await recv_json(wb)
    for event in (mine, theirs):
        assert event["type"] == "message"
        message = event["message"]
        assert (message["room_id"], message["sender_id"], message["body"], message["sender_name"]) == (room, a, "xin chào", "Alice")
    assert mine["message"]["client_id"] == "cid-1" and mine["message"]["id"] == theirs["message"]["id"]
    await expect_silence(wc)
    for ws in (wa, wb, wc):
        await ws.close()


async def test_resending_the_same_client_id_stores_and_broadcasts_once(live_server):
    a, b = await create_user("alice"), await create_user("bob")
    room = await create_room(member_ids=[a, b])
    wa, _ = await ws_open(live_server.ws, await _token(live_server, "alice"))
    wb, _ = await ws_open(live_server.ws, await _token(live_server, "bob"))
    await _send(wa, room, "một lần", "dup")
    first = await recv_json(wa)
    await recv_json(wb)
    await _send(wa, room, "một lần", "dup")
    again = await recv_json(wa)  # người gửi nhận lại đúng tin cũ
    assert again["message"]["id"] == first["message"]["id"]
    await expect_silence(wb)  # người khác không nhận bản thứ hai
    async with AsyncClient(base_url=live_server.http) as http:
        headers = auth_headers(await _token(live_server, "bob"))
        page = (await http.get(f"/api/rooms/{room}/messages", headers=headers)).json()
    assert [m["body"] for m in page["items"]] == ["một lần"]
    await wa.close()
    await wb.close()


async def test_non_members_including_admins_cannot_send(live_server):
    a = await create_user("alice")
    await create_user("root", role="admin")
    room = await create_room(member_ids=[a])
    ws, _ = await ws_open(live_server.ws, await _token(live_server, "root"))
    await _send(ws, room, "xâm nhập", "x1")
    error = await recv_json(ws)
    assert error == {"type": "error", "code": "room_not_found", "client_id": "x1"}
    await _send(ws, 987654, "phòng ma", "x2")
    assert (await recv_json(ws))["code"] == "room_not_found"
    await ws.close()
    assert (await _messages_in(room)) == []


async def _messages_in(room_id):
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import Message

    async with SessionLocal() as s:
        return list((await s.execute(select(Message).where(Message.room_id == room_id))).scalars())


async def test_bad_input_returns_errors_but_keeps_the_connection_open(live_server):
    a = await create_user("alice")
    room = await create_room(member_ids=[a])
    ws, _ = await ws_open(live_server.ws, await _token(live_server, "alice"))

    await ws.send("không phải json")
    assert (await recv_json(ws))["code"] == "invalid_json"
    await ws.send(json.dumps({"type": "bay_len_troi"}))
    assert (await recv_json(ws))["code"] == "unknown_type"
    await ws.send(json.dumps({"type": "send", "room_id": "một", "body": 5}))
    assert (await recv_json(ws))["code"] == "invalid_message"
    await _send(ws, room, "   ", "e1")
    assert await recv_json(ws) == {"type": "error", "code": "empty_message", "client_id": "e1"}
    await _send(ws, room, "x" * 4001, "e2")
    assert (await recv_json(ws))["code"] == "message_too_long"
    await ws.send(json.dumps({"type": "ping"}))
    assert await recv_json(ws) == {"type": "pong"}
    await _send(ws, room, "vẫn gửi được", "ok")
    assert (await recv_json(ws))["message"]["body"] == "vẫn gửi được"
    await ws.close()


async def test_oversized_frame_closes_with_4413(live_server):
    await create_user("alice")
    ws, _ = await ws_open(live_server.ws, await _token(live_server, "alice"))
    await ws.send("x" * 20_000)
    assert await wait_closed(ws) == 4413


async def test_rate_limit_replies_with_an_error_after_the_burst(live_server):
    a = await create_user("alice")
    room = await create_room(member_ids=[a])
    ws, _ = await ws_open(live_server.ws, await _token(live_server, "alice"))
    codes = []
    for n in range(7):  # WS_RATE_LIMIT_MESSAGES=5 trong conftest
        await _send(ws, room, f"tin {n}", f"r{n}")
    for _ in range(7):
        event = await recv_json(ws)
        codes.append(event["code"] if event["type"] == "error" else "ok")
    assert codes.count("ok") == 5 and codes.count("rate_limited") == 2
    await ws.close()


# ---------- thay đổi thành viên và khoá tài khoản ----------

async def test_removing_a_member_stops_delivery_on_their_open_connection(live_server):
    await create_user("root", role="admin")
    a, b = await create_user("alice"), await create_user("bob")
    room = await create_room(name="Nhóm", member_ids=[a, b])
    wa, _ = await ws_open(live_server.ws, await _token(live_server, "alice"))
    wb, _ = await ws_open(live_server.ws, await _token(live_server, "bob"))
    await _send(wa, room, "trước khi bị gỡ", "p1")
    await recv_json(wa)
    assert (await recv_json(wb))["message"]["body"] == "trước khi bị gỡ"

    async with AsyncClient(base_url=live_server.http) as http:
        admin = auth_headers(await _token(live_server, "root"))
        assert (await http.delete(f"/api/admin/rooms/{room}/members/{b}", headers=admin)).status_code == 200
    assert (await recv_json(wb)) == {"type": "rooms_changed"}
    await _send(wa, room, "sau khi bị gỡ", "p2")
    await recv_json(wa)
    await expect_silence(wb)
    await wa.close()
    await wb.close()


async def test_adding_a_member_starts_delivery_on_their_open_connection(live_server):
    await create_user("root", role="admin")
    a, b = await create_user("alice"), await create_user("bob")
    room = await create_room(name="Nhóm", member_ids=[a])
    wa, _ = await ws_open(live_server.ws, await _token(live_server, "alice"))
    wb, _ = await ws_open(live_server.ws, await _token(live_server, "bob"))
    async with AsyncClient(base_url=live_server.http) as http:
        admin = auth_headers(await _token(live_server, "root"))
        await http.post(f"/api/admin/rooms/{room}/members", json={"user_id": b}, headers=admin)
    assert (await recv_json(wb)) == {"type": "rooms_changed"}
    await _send(wa, room, "chào người mới", "n1")
    await recv_json(wa)
    assert (await recv_json(wb))["message"]["body"] == "chào người mới"
    await wa.close()
    await wb.close()


async def test_locking_a_user_closes_their_websocket_with_4403(live_server):
    await create_user("root", role="admin")
    victim = await create_user("victim")
    ws, _ = await ws_open(live_server.ws, await _token(live_server, "victim"))
    async with AsyncClient(base_url=live_server.http) as http:
        admin = auth_headers(await _token(live_server, "root"))
        r = await http.patch(f"/api/admin/users/{victim}", json={"is_active": False}, headers=admin)
        assert r.status_code == 200
    assert await wait_closed(ws) == 4403


async def test_a_message_sent_after_being_locked_is_rejected_even_without_the_disconnect_event(live_server):
    from app.db import SessionLocal
    from app.models import User

    a = await create_user("alice")
    room = await create_room(member_ids=[a])
    ws, _ = await ws_open(live_server.ws, await _token(live_server, "alice"))
    async with SessionLocal() as s:
        (await s.get(User, a)).is_active = False
        await s.commit()
    await _send(ws, room, "sau khi khoá", "l1")
    assert await wait_closed(ws) == 4401
    assert (await _messages_in(room)) == []


async def test_one_user_can_have_several_connections_and_all_receive(live_server):
    a, b = await create_user("alice"), await create_user("bob")
    room = await create_room(member_ids=[a, b])
    token = await _token(live_server, "alice")
    tab1, _ = await ws_open(live_server.ws, token)
    tab2, _ = await ws_open(live_server.ws, token)
    wb, _ = await ws_open(live_server.ws, await _token(live_server, "bob"))
    await _send(wb, room, "gửi cho cả hai tab", "m1")
    await recv_json(wb)
    assert (await recv_json(tab1))["message"]["body"] == "gửi cho cả hai tab"
    assert (await recv_json(tab2))["message"]["body"] == "gửi cho cả hai tab"
    for ws in (tab1, tab2, wb):
        await ws.close()


async def test_rest_edit_and_delete_are_pushed_to_connected_members(live_server):
    a, b = await create_user("alice"), await create_user("bob")
    room = await create_room(member_ids=[a, b])
    msg = await add_message(room, a, "gốc")
    wb, _ = await ws_open(live_server.ws, await _token(live_server, "bob"))
    async with AsyncClient(base_url=live_server.http) as http:
        headers = auth_headers(await _token(live_server, "alice"))
        await http.patch(f"/api/messages/{msg}", json={"body": "đã sửa"}, headers=headers)
        updated = await recv_json(wb)
        assert (updated["type"], updated["message"]["body"]) == ("message_updated", "đã sửa")
        await http.delete(f"/api/messages/{msg}", headers=headers)
        assert await recv_json(wb) == {"type": "message_deleted", "room_id": room, "message_id": msg}
    await wb.close()


# ---------- đầu vào dị dạng và kích thước frame ----------

async def test_out_of_range_room_id_returns_an_error_and_keeps_the_connection(live_server):
    await create_user("alice")
    ws, _ = await ws_open(live_server.ws, await _token(live_server, "alice"))
    await _send(ws, 99999999999, "quá lớn", "big")
    assert await recv_json(ws) == {"type": "error", "code": "invalid_message", "client_id": "big"}
    await _send(ws, 0, "không", "zero")
    assert (await recv_json(ws))["code"] == "invalid_message"
    await ws.send(json.dumps({"type": "ping"}))
    assert await recv_json(ws) == {"type": "pong"}
    await ws.close()


async def test_binary_frame_after_auth_returns_unsupported_frame_and_keeps_the_connection(live_server):
    await create_user("alice")
    ws, _ = await ws_open(live_server.ws, await _token(live_server, "alice"))
    await ws.send(b"\x00\x01\x02")
    assert await recv_json(ws) == {"type": "error", "code": "unsupported_frame", "client_id": None}
    await ws.send(json.dumps({"type": "ping"}))
    assert await recv_json(ws) == {"type": "pong"}
    await ws.close()


async def test_binary_frame_before_auth_is_closed_with_4401(live_server):
    ws = await connect(f"{live_server.ws}/api/ws")
    await ws.send(b"\x00\x01\x02")
    assert await wait_closed(ws) == 4401


async def test_oversized_first_frame_is_closed_with_4413(live_server):
    ws = await connect(f"{live_server.ws}/api/ws")
    await ws.send("x" * 20_000)
    assert await wait_closed(ws) == 4413


async def test_frame_above_the_transport_ceiling_closes_the_connection(live_server):
    await create_user("alice")
    ws, _ = await ws_open(live_server.ws, await _token(live_server, "alice"))
    await ws.send("x" * 100_000)
    assert await wait_closed(ws) is not None


async def test_frame_of_exactly_the_limit_is_an_ordinary_frame(live_server):
    await create_user("alice")
    ws, _ = await ws_open(live_server.ws, await _token(live_server, "alice"))
    await ws.send("x" * 16_384)
    assert (await recv_json(ws))["code"] == "invalid_json"
    await ws.send(json.dumps({"type": "ping"}))
    assert await recv_json(ws) == {"type": "pong"}
    await ws.close()


async def test_frame_is_measured_in_encoded_bytes_not_characters(live_server):
    await create_user("alice")
    ws, _ = await ws_open(live_server.ws, await _token(live_server, "alice"))
    text = "ệ" * 5_500  # 5.500 ký tự nhưng 16.500 byte UTF-8
    assert len(text) < 16_384 < len(text.encode("utf-8"))
    await ws.send(text)
    assert await wait_closed(ws) == 4413


# ---------- lỗi nội bộ ----------

async def test_unexpected_error_while_sending_returns_internal_error_and_keeps_the_connection(live_server, monkeypatch):
    from app.chat import service

    a = await create_user("alice")
    room = await create_room(member_ids=[a])
    ws, _ = await ws_open(live_server.ws, await _token(live_server, "alice"))

    async def boom(*args, **kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(service, "send_message", boom)
    await _send(ws, room, "sẽ lỗi", "i1")
    assert await recv_json(ws) == {"type": "error", "code": "internal_error", "client_id": "i1"}
    await ws.send(json.dumps({"type": "ping"}))
    assert await recv_json(ws) == {"type": "pong"}
    await ws.close()


async def test_database_failure_while_authenticating_closes_with_1011(live_server, monkeypatch):
    from app.routers import ws as ws_module

    await create_user("alice")
    token = await _token(live_server, "alice")

    def broken_session():
        raise ConnectionError("db down")

    monkeypatch.setattr(ws_module, "SessionLocal", broken_session)
    ws = await connect(f"{live_server.ws}/api/ws")
    await ws.send(json.dumps({"type": "auth", "token": token}))
    assert await wait_closed(ws) == 1011
