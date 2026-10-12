import asyncio
from datetime import datetime, timedelta, timezone

from httpx import AsyncClient
from sqlalchemy import select, update

from app.chat.bus import RedisMessageBus
from app.chat.hub import Connection, Hub
from app.chat.retention import purge_archived_rooms, run_purger
from app.db import SessionLocal
from app.models import Message, Room, RoomMember
from app.redis_client import get_redis
from tests.conftest import add_message, auth_headers, create_direct, create_room, create_user, token_for
from tests.helpers import InMemoryBus, recv_json, ws_open
from tests.test_admin_rooms import room_changed_targets
from tests.test_ws import _send, _token


async def _set_archived(room_id, when):
    async with SessionLocal() as s:
        await s.execute(update(Room).where(Room.id == room_id).values(archived_at=when))
        await s.commit()


async def _member(client, username):
    return auth_headers(await token_for(client, username))


async def test_delete_archives_instead_of_deleting(client, admin_headers):
    a = await create_user("alice")
    room = await create_room(name="Lưu", member_ids=[a])
    await add_message(room, a)
    assert (await client.delete(f"/api/admin/rooms/{room}", headers=admin_headers)).status_code == 204
    async with SessionLocal() as s:
        assert (await s.get(Room, room)).archived_at is not None
        assert len((await s.execute(select(Message))).all()) == 1
        assert len((await s.execute(select(RoomMember))).all()) == 1


async def test_archived_room_disappears_for_members(client, admin_headers):
    a = await create_user("alice")
    room = await create_room(name="Lưu", member_ids=[a])
    msg = await add_message(room, a)
    await add_message(room, a, "tin khác")
    h = await _member(client, "alice")
    assert [r["id"] for r in (await client.get("/api/rooms", headers=h)).json()] == [room]
    await client.delete(f"/api/admin/rooms/{room}", headers=admin_headers)
    assert (await client.get("/api/rooms", headers=h)).json() == []
    for r in (
        await client.get(f"/api/rooms/{room}/messages", headers=h),
        await client.post(f"/api/rooms/{room}/read", json={"message_id": msg}, headers=h),
        await client.patch(f"/api/messages/{msg}", json={"body": "sửa"}, headers=h),
        await client.delete(f"/api/messages/{msg}", headers=h),
    ):
        assert (r.status_code, r.json()["detail"]) == (404, "room_not_found")


async def test_archived_room_is_closed_to_websocket(live_server):
    await create_user("root", role="admin")
    a, b = await create_user("alice"), await create_user("bob")
    room = await create_room(name="Nhóm", member_ids=[a, b])
    wa, _ = await ws_open(live_server.ws, await _token(live_server, "alice"))
    wb, _ = await ws_open(live_server.ws, await _token(live_server, "bob"))
    async with AsyncClient(base_url=live_server.http) as http:
        admin = auth_headers(await _token(live_server, "root"))
        assert (await http.delete(f"/api/admin/rooms/{room}", headers=admin)).status_code == 204
    assert await recv_json(wa) == {"type": "rooms_changed"}
    assert await recv_json(wb) == {"type": "rooms_changed"}
    await _send(wa, room, "vào phòng đã lưu", "z1")
    reply = await recv_json(wa)
    while reply == {"type": "rooms_changed"}:  # có thể còn một rooms_changed trùng từ reconcile
        reply = await recv_json(wa)
    assert reply == {"type": "error", "code": "room_not_found", "client_id": "z1"}
    # tin mới đẩy thẳng lên bus của phòng cũng không tới kết nối
    mid = await add_message(room, a, "lén")
    await RedisMessageBus(get_redis()).publish_room(room, {"type": "message", "message": {"id": mid}})
    # reconcile và sự kiện bus có thể cùng báo rooms_changed (hợp lệ); chỉ cấm tin nhắn của phòng đã lưu trữ
    received = []
    while True:
        try:
            received.append(await recv_json(wb, 0.6))
        except asyncio.TimeoutError:
            break
    assert all(event == {"type": "rooms_changed"} for event in received), received
    await wa.close()
    await wb.close()


async def test_reconcile_drops_archived_rooms_from_connections():
    a = await create_user("alice")
    live = await create_room(name="Sống", member_ids=[a])
    gone = await create_room(name="Lưu", member_ids=[a])
    await _set_archived(gone, datetime.now(timezone.utc))
    hub = Hub(InMemoryBus(), SessionLocal)
    conn = Connection(a, [live, gone])
    hub.register(conn)
    await hub.reconcile()
    assert conn.room_ids == {live}


async def test_admin_list_hides_archived_by_default_and_shows_with_flag(client, admin_headers):
    a = await create_user("alice")
    active = await create_room(name="Hoạt động", member_ids=[a])
    old = await create_room(name="Đã lưu", member_ids=[a])
    await client.delete(f"/api/admin/rooms/{old}", headers=admin_headers)
    default = (await client.get("/api/admin/rooms", headers=admin_headers)).json()
    assert [r["id"] for r in default] == [active]
    assert default[0]["archived_at"] is None and default[0]["purge_at"] is None
    archived = (await client.get("/api/admin/rooms?archived=true", headers=admin_headers)).json()
    assert [r["id"] for r in archived] == [old]
    got = datetime.fromisoformat(archived[0]["archived_at"])
    assert datetime.fromisoformat(archived[0]["purge_at"]) - got == timedelta(days=3)


async def test_archived_group_cannot_be_modified(client, admin_headers):
    a, b = await create_user("alice"), await create_user("bob")
    room = await create_room(name="Lưu", member_ids=[a])
    await client.delete(f"/api/admin/rooms/{room}", headers=admin_headers)
    calls = [
        await client.patch(f"/api/admin/rooms/{room}", json={"name": "Mới"}, headers=admin_headers),
        await client.post(f"/api/admin/rooms/{room}/members", json={"user_id": b}, headers=admin_headers),
        await client.delete(f"/api/admin/rooms/{room}/members/{a}", headers=admin_headers),
        await client.delete(f"/api/admin/rooms/{room}", headers=admin_headers),
    ]
    for r in calls:
        assert (r.status_code, r.json()["detail"]) == (404, "room_not_found")
    got = await client.get(f"/api/admin/rooms/{room}", headers=admin_headers)
    assert got.status_code == 200 and got.json()["archived_at"] is not None


async def test_restore_brings_everything_back(client, admin_headers, bus):
    a, b = await create_user("alice"), await create_user("bob")
    await create_user("member1")
    room = await create_room(name="Khôi phục", member_ids=[a, b])
    for _ in range(2):
        await add_message(room, a)
    h = await _member(client, "bob")
    before = (await client.get("/api/rooms", headers=h)).json()[0]
    assert before["unread_count"] == 2
    await client.delete(f"/api/admin/rooms/{room}", headers=admin_headers)
    bus.published.clear()
    member_h = await _member(client, "member1")
    assert (await client.post(f"/api/admin/rooms/{room}/restore", headers=member_h)).status_code == 403
    r = await client.post(f"/api/admin/rooms/{room}/restore", headers=admin_headers)
    assert r.status_code == 200 and r.json()["archived_at"] is None
    assert room_changed_targets(bus) == sorted([a, b])
    after = (await client.get("/api/rooms", headers=h)).json()[0]
    assert (after["id"], after["unread_count"], after["last_message"]) == (room, 2, before["last_message"])
    assert len((await client.get(f"/api/rooms/{room}/messages", headers=h)).json()["items"]) == 2
    for rid in (room, 99999):  # đang hoạt động hoặc không tồn tại
        r = await client.post(f"/api/admin/rooms/{rid}/restore", headers=admin_headers)
        assert (r.status_code, r.json()["detail"]) == (404, "room_not_found")


async def test_purge_deletes_only_expired_archived_rooms():
    a = await create_user("alice")
    now = datetime.now(timezone.utc)
    active = await create_room(name="A", member_ids=[a])
    recent = await create_room(name="B", member_ids=[a])
    expired = await create_room(name="C", member_ids=[a])
    for rid in (active, recent, expired):
        await add_message(rid, a)
    await _set_archived(recent, now - timedelta(days=1))
    await _set_archived(expired, now - timedelta(days=4))
    assert await purge_archived_rooms(SessionLocal, 3) == 1
    async with SessionLocal() as s:
        assert set((await s.execute(select(Room.id))).scalars()) == {active, recent}
        assert set((await s.execute(select(Message.room_id))).scalars()) == {active, recent}
        assert set((await s.execute(select(RoomMember.room_id))).scalars()) == {active, recent}
    assert await purge_archived_rooms(SessionLocal, 3) == 0


async def test_purge_boundary_uses_the_given_now():
    a = await create_user("alice")
    archived = datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc)
    room = await create_room(name="Biên", member_ids=[a])
    await _set_archived(room, archived)
    assert await purge_archived_rooms(SessionLocal, 3, now=archived + timedelta(days=3, seconds=-1)) == 0
    assert await purge_archived_rooms(SessionLocal, 3, now=archived + timedelta(days=3)) == 1


async def test_purger_survives_errors():
    a = await create_user("alice")
    room = await create_room(name="Quá hạn", member_ids=[a])
    await _set_archived(room, datetime.now(timezone.utc) - timedelta(days=10))
    calls = {"n": 0}

    def factory():
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("db down")
        return SessionLocal()

    task = asyncio.create_task(run_purger(factory, 3, 0.05))
    for _ in range(100):
        await asyncio.sleep(0.05)
        async with SessionLocal() as s:
            if await s.get(Room, room) is None:
                break
    else:
        raise AssertionError("room was never purged")
    assert calls["n"] >= 2
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    assert task.done()


async def test_direct_rooms_are_not_touched_by_archiving(client, admin_headers):
    a, b = await create_user("alice"), await create_user("bob")
    direct = await create_direct(a, b)
    assert (await client.delete(f"/api/admin/rooms/{direct}", headers=admin_headers)).status_code == 404
    assert (await client.post(f"/api/admin/rooms/{direct}/restore", headers=admin_headers)).status_code == 404
    await _set_archived(direct, datetime.now(timezone.utc) - timedelta(days=30))
    assert await purge_archived_rooms(SessionLocal, 3) == 0
    async with SessionLocal() as s:
        assert await s.get(Room, direct) is not None
