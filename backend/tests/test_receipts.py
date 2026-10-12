from httpx import AsyncClient
from redis.exceptions import RedisError
from sqlalchemy import delete, func, select

from app.db import SessionLocal
from app.models import Room, RoomMember
from tests.conftest import add_message, auth_headers, create_room, create_user, token_for
from tests.helpers import expect_silence, recv_json, ws_open
from tests.test_ws import _token


async def _read(http, token, room, message_id):
    return await http.post(f"/api/rooms/{room}/read", json={"message_id": message_id}, headers=auth_headers(token))


async def test_read_publishes_event_to_room_members_only(live_server):
    a, b, _c = await create_user("alice"), await create_user("bob"), await create_user("carol")
    room = await create_room(member_ids=[a, b])
    msg = await add_message(room, b)
    wb, _ = await ws_open(live_server.ws, await _token(live_server, "bob"))
    wc, _ = await ws_open(live_server.ws, await _token(live_server, "carol"))
    async with AsyncClient(base_url=live_server.http) as http:
        assert (await _read(http, await _token(live_server, "alice"), room, msg)).status_code == 204
    assert await recv_json(wb) == {"type": "read", "room_id": room, "user_id": a, "message_id": msg}
    await expect_silence(wc, 0.5)
    await wb.close()
    await wc.close()


async def test_read_event_only_when_marker_advances(live_server):
    a, b = await create_user("alice"), await create_user("bob")
    room = await create_room(member_ids=[a, b])
    m1, m2 = await add_message(room, b), await add_message(room, b)
    wb, _ = await ws_open(live_server.ws, await _token(live_server, "bob"))
    async with AsyncClient(base_url=live_server.http) as http:
        ta = await _token(live_server, "alice")
        for mid in (m2, m2, m1):
            assert (await _read(http, ta, room, mid)).status_code == 204
    assert (await recv_json(wb))["message_id"] == m2
    await expect_silence(wb, 0.5)
    async with SessionLocal() as s:
        last = (
            await s.execute(
                select(RoomMember.last_read_message_id).where(RoomMember.room_id == room, RoomMember.user_id == a)
            )
        ).scalar_one()
    assert last == m2
    await wb.close()


async def test_read_event_reaches_senders_other_tab(live_server):
    a, b = await create_user("alice"), await create_user("bob")
    room = await create_room(member_ids=[a, b])
    msg = await add_message(room, b)
    ta = await _token(live_server, "alice")
    w1, _ = await ws_open(live_server.ws, ta)
    w2, _ = await ws_open(live_server.ws, ta)
    async with AsyncClient(base_url=live_server.http) as http:
        await _read(http, ta, room, msg)
    for ws in (w1, w2):
        assert await recv_json(ws) == {"type": "read", "room_id": room, "user_id": a, "message_id": msg}
        await ws.close()


async def test_members_lists_receipts(client):
    a, b = await create_user("zed"), await create_user("amy")
    await create_user("out")
    room = await create_room(member_ids=[a, b])
    msg = await add_message(room, b)
    ha = auth_headers(await token_for(client, "zed"))
    await client.post(f"/api/rooms/{room}/read", json={"message_id": msg}, headers=ha)
    r = await client.get(f"/api/rooms/{room}/members", headers=ha)
    assert r.status_code == 200
    assert r.json() == [
        {"user_id": b, "full_name": "Amy", "last_read_message_id": None},
        {"user_id": a, "full_name": "Zed", "last_read_message_id": msg},
    ]
    hc = auth_headers(await token_for(client, "out"))
    r = await client.get(f"/api/rooms/{room}/members", headers=hc)
    assert r.status_code == 404 and "room_not_found" in r.text
    async with SessionLocal() as s:  # thành viên bị gỡ
        await s.execute(delete(RoomMember).where(RoomMember.room_id == room, RoomMember.user_id == b))
        await s.commit()
    hb = auth_headers(await token_for(client, "amy"))
    assert (await client.get(f"/api/rooms/{room}/members", headers=hb)).status_code == 404
    async with SessionLocal() as s:  # phòng đã lưu trữ
        await s.execute(Room.__table__.update().where(Room.id == room).values(archived_at=func.now()))
        await s.commit()
    assert (await client.get(f"/api/rooms/{room}/members", headers=ha)).status_code == 404


async def test_read_survives_bus_failure(client, bus):
    a, b = await create_user("alice"), await create_user("bob")
    room = await create_room(member_ids=[a, b])
    msg = await add_message(room, b)

    async def boom(*args, **kwargs):
        raise RedisError("down")

    bus.publish_room = boom
    ha = auth_headers(await token_for(client, "alice"))
    assert (await client.post(f"/api/rooms/{room}/read", json={"message_id": msg}, headers=ha)).status_code == 204
    r = await client.get(f"/api/rooms/{room}/members", headers=ha)
    assert {m["user_id"]: m["last_read_message_id"] for m in r.json()}[a] == msg
