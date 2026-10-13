import asyncio
import json
from datetime import timedelta

import pytest
from httpx import AsyncClient
from redis.exceptions import ConnectionError as RedisConnectionError
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db import SessionLocal
from app.models import Message, Room, RoomMember
from tests.conftest import add_message, auth_headers, create_branch, create_direct, create_room, create_user, token_for
from tests.helpers import recv_json, ws_open


@pytest.fixture
def small_limits(monkeypatch):
    def _set(**env):
        for key, value in env.items():
            monkeypatch.setenv(key, str(value))
        get_settings.cache_clear()

    yield _set
    monkeypatch.undo()
    get_settings.cache_clear()


async def _headers(client, username):
    return auth_headers(await token_for(client, username))


async def _room_count():
    async with SessionLocal() as s:
        return (await s.execute(select(func.count()).select_from(Room))).scalar_one()


async def test_user_creates_group_with_members_across_branches(live_server):
    a = await create_user("alice", branch_id=await create_branch("HN", "HN"))
    b = await create_user("bob", branch_id=await create_branch("HCM", "HCM"))
    c = await create_user("carol")
    async with AsyncClient(base_url=live_server.http) as http:
        tb, tc = await token_for(http, "bob"), await token_for(http, "carol")
        ha, hb, hc = (await _headers(http, "alice"), auth_headers(tb), auth_headers(tc))
        wb, _ = await ws_open(live_server.ws, tb)
        wc, _ = await ws_open(live_server.ws, tc)
        r = await http.post("/api/rooms/group", json={"name": "Dự án", "member_ids": [b, c]}, headers=ha)
        assert r.status_code == 201, r.text
        body = r.json()
        assert body["my_role"] == "owner" and body["member_count"] == 3 and body["branch_id"] is None
        assert body["type"] == "group" and body["name"] == "Dự án"
        listed = {x["id"]: x for x in (await http.get("/api/rooms", headers=ha)).json()}
        assert listed[body["id"]] == body
        for h in (hb, hc):
            item = next(x for x in (await http.get("/api/rooms", headers=h)).json() if x["id"] == body["id"])
            assert item["my_role"] == "member" and item["member_count"] == 3 and item["branch_id"] is None
        members = (await http.get(f"/api/rooms/{body['id']}/members", headers=hb)).json()
        assert {m["user_id"]: m["role"] for m in members} == {a: "owner", b: "member", c: "member"}
        assert all(m["last_read_message_id"] is None for m in members)
        assert await recv_json(wb) == {"type": "rooms_changed"}
        assert await recv_json(wc) == {"type": "rooms_changed"}
        await wb.close()
        await wc.close()


@pytest.mark.parametrize("name", ["", "   ", "x" * 101, "ab\x00c", "​​", " ​\t ", "\x07\x08"])
async def test_group_name_invalid_is_422(client, name):
    await create_user("alice")
    r = await client.post(
        "/api/rooms/group", json={"name": name, "member_ids": []}, headers=await _headers(client, "alice")
    )
    assert r.status_code == 422
    assert await _room_count() == 0


async def test_group_name_is_stripped(client):
    await create_user("alice")
    r = await client.post(
        "/api/rooms/group", json={"name": "  Kho  ", "member_ids": []}, headers=await _headers(client, "alice")
    )
    assert (r.status_code, r.json()["name"]) == (201, "Kho")


async def test_group_member_ids_dedupe_and_ignore_self(client, bus):
    a, b = await create_user("alice"), await create_user("bob")
    r = await client.post(
        "/api/rooms/group", json={"name": "G", "member_ids": [a, b, b]}, headers=await _headers(client, "alice")
    )
    assert r.status_code == 201 and r.json()["member_count"] == 2
    async with SessionLocal() as s:
        roles = dict((await s.execute(select(RoomMember.user_id, RoomMember.role))).all())
    assert roles == {a: "owner", b: "member"}
    assert [t for sc, t, e in bus.published if e == {"type": "rooms_changed"}] == [a, b]


async def test_inactive_or_missing_member_creates_nothing(client, bus):
    await create_user("alice")
    b = await create_user("bob")
    gone = await create_user("gone", active=False)
    h = await _headers(client, "alice")
    for bad in (gone, 99999):
        r = await client.post("/api/rooms/group", json={"name": "G", "member_ids": [b, bad]}, headers=h)
        assert (r.status_code, r.json()["detail"]) == (404, "user_not_found")
    assert await _room_count() == 0
    assert bus.published == []
    async with SessionLocal() as s:
        assert (await s.execute(select(func.count()).select_from(RoomMember))).scalar_one() == 0


async def test_too_many_member_ids(client):
    await create_user("alice")
    ids = [await create_user(f"u{i}") for i in range(200)]
    h = await _headers(client, "alice")
    r = await client.post("/api/rooms/group", json={"name": "Full", "member_ids": ids}, headers=h)
    assert (r.status_code, r.json()["detail"]) == (409, "group_full")
    assert await _room_count() == 0
    r = await client.post("/api/rooms/group", json={"name": "Max", "member_ids": ids[:199]}, headers=h)
    assert (r.status_code, r.json()["member_count"]) == (201, 200)


async def test_member_cap_follows_setting(client, small_limits):
    small_limits(MAX_GROUP_MEMBERS=3)
    await create_user("alice")
    ids = [await create_user(f"u{i}") for i in range(3)]
    h = await _headers(client, "alice")
    assert (await client.post("/api/rooms/group", json={"name": "A", "member_ids": ids}, headers=h)).status_code == 409
    assert (await client.post("/api/rooms/group", json={"name": "A", "member_ids": ids[:2]}, headers=h)).status_code == 201


async def test_owned_group_limit_ignores_archived(client, small_limits):
    small_limits(MAX_OWNED_GROUPS=2)
    await create_user("alice")
    h = await _headers(client, "alice")
    ids = []
    for n in ("1", "2"):
        r = await client.post("/api/rooms/group", json={"name": n, "member_ids": []}, headers=h)
        assert r.status_code == 201
        ids.append(r.json()["id"])
    r = await client.post("/api/rooms/group", json={"name": "3", "member_ids": []}, headers=h)
    assert (r.status_code, r.json()["detail"]) == (409, "too_many_groups")
    async with SessionLocal() as s:
        (await s.get(Room, ids[0])).archived_at = func.now()
        await s.commit()
    assert (await client.post("/api/rooms/group", json={"name": "3", "member_ids": []}, headers=h)).status_code == 201


async def test_owned_limit_only_counts_own_owner_rows(client, small_limits):
    small_limits(MAX_OWNED_GROUPS=1)
    a, b = await create_user("alice"), await create_user("bob")
    h = await _headers(client, "alice")
    await create_room(member_ids=[a])  # nhóm admin tạo: alice chỉ là member, không tính
    assert (await client.post("/api/rooms/group", json={"name": "A", "member_ids": [b]}, headers=h)).status_code == 201
    hb = await _headers(client, "bob")  # bob là member nhóm của alice, vẫn tạo được nhóm riêng
    assert (await client.post("/api/rooms/group", json={"name": "B", "member_ids": []}, headers=hb)).status_code == 201


async def test_concurrent_creates_at_limit_minus_one(client, small_limits):
    small_limits(MAX_OWNED_GROUPS=2)
    await create_user("alice")
    h = await _headers(client, "alice")
    assert (await client.post("/api/rooms/group", json={"name": "0", "member_ids": []}, headers=h)).status_code == 201
    rs = await asyncio.gather(
        *(client.post("/api/rooms/group", json={"name": f"c{i}", "member_ids": []}, headers=h) for i in range(4))
    )
    assert sorted(r.status_code for r in rs) == [201, 409, 409, 409]
    assert await _room_count() == 2


async def test_group_can_be_created_alone(client, bus):
    a = await create_user("alice")
    r = await client.post("/api/rooms/group", json={"name": "Một mình"}, headers=await _headers(client, "alice"))
    assert (r.status_code, r.json()["member_count"], r.json()["my_role"]) == (201, 1, "owner")
    assert [(sc, t) for sc, t, e in bus.published] == [("user", a)]


async def test_redis_failure_does_not_fail_creation(client, bus):
    await create_user("alice")
    b = await create_user("bob")

    async def boom(*a, **k):
        raise RedisConnectionError("down")

    bus.publish_user = boom
    r = await client.post(
        "/api/rooms/group", json={"name": "G", "member_ids": [b]}, headers=await _headers(client, "alice")
    )
    assert r.status_code == 201


async def test_unauthenticated_and_must_change_password_rejected(client):
    body = {"name": "G", "member_ids": []}
    assert (await client.post("/api/rooms/group", json=body)).status_code == 401
    await create_user("temp", must_change=True)
    r = await client.post("/api/rooms/group", json=body, headers=await _headers(client, "temp"))
    assert (r.status_code, r.json()["detail"]) == (403, "password_change_required")
    assert await _room_count() == 0


async def test_my_role_for_admin_created_and_direct_rooms(client):
    a, b = await create_user("alice"), await create_user("bob")
    group = await create_room(name="Admin tạo", member_ids=[a, b])
    direct = await create_direct(a, b)
    h = await _headers(client, "alice")
    rooms = {r["id"]: r for r in (await client.get("/api/rooms", headers=h)).json()}
    assert rooms[group]["my_role"] == "member"
    assert rooms[direct]["my_role"] is None
    r = await client.get(f"/api/rooms/{group}/members", headers=h)
    assert {m["role"] for m in r.json()} == {"member"}


async def test_creator_connections_learn_about_the_new_room(live_server):
    await create_user("alice")
    b = await create_user("bob")
    async with AsyncClient(base_url=live_server.http) as http:
        ta, tb = await token_for(http, "alice"), await token_for(http, "bob")
        wa1, _ = await ws_open(live_server.ws, ta)
        wa2, _ = await ws_open(live_server.ws, ta)
        wb, _ = await ws_open(live_server.ws, tb)
        r = await http.post("/api/rooms/group", json={"name": "G", "member_ids": [b]}, headers=auth_headers(ta))
        room = r.json()["id"]
        for ws in (wa1, wa2, wb):
            assert await recv_json(ws) == {"type": "rooms_changed"}
        await wb.send(json.dumps({"type": "send", "room_id": room, "body": "chào", "client_id": "c1"}))
        for ws in (wa1, wa2):
            event = await recv_json(ws)
            assert event["type"] == "message" and event["message"]["body"] == "chào"
        for ws in (wa1, wa2, wb):
            await ws.close()


async def test_member_deleted_mid_create_is_404_not_500(client, monkeypatch):
    from sqlalchemy.exc import IntegrityError

    await create_user("alice")
    b = await create_user("bob")
    h = await _headers(client, "alice")
    real_commit = AsyncSession.commit

    async def commit_fails_once(self):
        raise IntegrityError("insert", {}, Exception("fk"))

    monkeypatch.setattr(AsyncSession, "commit", commit_fails_once)
    r = await client.post("/api/rooms/group", json={"name": "G", "member_ids": [b]}, headers=h)
    monkeypatch.setattr(AsyncSession, "commit", real_commit)
    assert (r.status_code, r.json()["detail"]) == (404, "user_not_found")
    assert await _room_count() == 0


# ---------- Task 2: quản lý nhóm ----------


async def _make_group(http, headers, name="Nhóm", member_ids=()):
    r = await http.post("/api/rooms/group", json={"name": name, "member_ids": list(member_ids)}, headers=headers)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _users(*names):
    return [await create_user(n) for n in names]


async def _headers_for(client, *names):
    return [await _headers(client, n) for n in names]


async def _tokens(http, *names):
    return [await token_for(http, n) for n in names]


async def _wait_for(ws, predicate, timeout: float = 3):
    """Đọc (kể cả presence) cho tới khi có sự kiện thoả predicate; bỏ qua mọi sự kiện khác."""
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        event = await recv_json(ws, max(deadline - asyncio.get_running_loop().time(), 0.001), include_presence=True)
        if predicate(event):
            return event


async def _drain(ws, seconds: float) -> list[dict]:
    """Gom mọi sự kiện đến trong `seconds` giây (không bỏ sót presence)."""
    events: list[dict] = []
    deadline = asyncio.get_running_loop().time() + seconds
    while True:
        remaining = deadline - asyncio.get_running_loop().time()
        if remaining <= 0:
            return events
        try:
            events.append(json.loads(await asyncio.wait_for(ws.recv(), remaining)))
        except asyncio.TimeoutError:
            return events


def _is_rooms_changed(event):
    return event.get("type") == "rooms_changed"


def _changed_for(bus):
    return [t for sc, t, e in bus.published if sc == "user" and e == {"type": "rooms_changed"}]


async def _roles(room_id):
    async with SessionLocal() as s:
        rows = await s.execute(select(RoomMember.user_id, RoomMember.role).where(RoomMember.room_id == room_id))
        return dict(rows.all())


async def _archived_at(room_id):
    async with SessionLocal() as s:
        return (await s.execute(select(Room.archived_at).where(Room.id == room_id))).scalar_one()


@pytest.mark.parametrize("op", ["rename", "add", "remove", "dissolve"])
async def test_only_owner_can_rename_add_remove_dissolve(client, op):
    a, b, c, d = await _users("alice", "bob", "carol", "dave")
    ha, hb, hc = await _headers_for(client, "alice", "bob", "carol")
    room = await _make_group(client, ha, "G", [b])

    def call(headers, room_id):
        if op == "rename":
            return client.patch(f"/api/rooms/{room_id}", json={"name": "Mới"}, headers=headers)
        if op == "add":
            return client.post(f"/api/rooms/{room_id}/members", json={"user_id": d}, headers=headers)
        if op == "remove":
            return client.delete(f"/api/rooms/{room_id}/members/{a}", headers=headers)
        return client.delete(f"/api/rooms/{room_id}", headers=headers)

    r = await call(hb, room)  # thành viên thường
    assert (r.status_code, r.json()["detail"]) == (403, "forbidden")
    r = await call(hc, room)  # người ngoài phòng
    assert (r.status_code, r.json()["detail"]) == (404, "room_not_found")
    direct = await create_direct(a, b)
    r = await call(ha, direct)  # phòng direct, kể cả là thành viên
    assert (r.status_code, r.json()["detail"]) == (404, "room_not_found")
    r = await call(ha, 999999)
    assert (r.status_code, r.json()["detail"]) == (404, "room_not_found")
    assert await _roles(room) == {a: "owner", b: "member"}
    async with SessionLocal() as s:
        assert (await s.get(Room, room)).name == "G"
        (await s.get(Room, room)).archived_at = func.now()
        await s.commit()
    for headers in (ha, hb):  # phòng đã lưu trữ: 404 cho cả chủ
        r = await call(headers, room)
        assert (r.status_code, r.json()["detail"]) == (404, "room_not_found")
    for target in (room, direct):
        r = await client.post(f"/api/rooms/{target}/leave", headers=hc)
        assert (r.status_code, r.json()["detail"]) == (404, "room_not_found")
    r = await client.post(f"/api/rooms/{room}/leave", headers=ha)  # lưu trữ rồi thì không rời được nữa
    assert (r.status_code, r.json()["detail"]) == (404, "room_not_found")
    r = await client.post(f"/api/rooms/{direct}/leave", headers=ha)  # direct không có khái niệm rời
    assert (r.status_code, r.json()["detail"]) == (404, "room_not_found")


async def test_owner_renames_and_members_get_rooms_changed(live_server):
    a, b, c = await _users("alice", "bob", "carol")
    async with AsyncClient(base_url=live_server.http) as http:
        ta, tb, tc = await _tokens(http, "alice", "bob", "carol")
        room = await _make_group(http, auth_headers(ta), "Cũ", [b, c])
        ws = [(await ws_open(live_server.ws, t))[0] for t in (ta, tb, tc)]
        for w in ws:  # để rooms_changed lúc tạo nhóm và presence ban đầu lắng xuống
            await _drain(w, 0.6)
        r = await http.patch(f"/api/rooms/{room}", json={"name": "  Mới  "}, headers=auth_headers(ta))
        assert r.status_code == 200 and r.json()["name"] == "Mới" and r.json()["my_role"] == "owner"
        for w in ws:
            await _wait_for(w, _is_rooms_changed)
        for t in (ta, tb, tc):
            listed = {x["id"]: x for x in (await http.get("/api/rooms", headers=auth_headers(t))).json()}
            assert listed[room]["name"] == "Mới"
        for bad in ("", "   ", "x" * 101, "ab\x00c", "​​"):
            r = await http.patch(f"/api/rooms/{room}", json={"name": bad}, headers=auth_headers(ta))
            assert r.status_code == 422
        for w in ws:
            await w.close()


async def test_owner_adds_member_with_read_marker_at_latest(client, bus, small_limits):
    small_limits(MAX_GROUP_MEMBERS=4)
    a, b, d, e, f = await _users("alice", "bob", "dave", "erin", "fred")
    gone = await create_user("gone", active=False)
    ha, hd = await _headers_for(client, "alice", "dave")
    room = await _make_group(client, ha, "G", [b])
    for i in range(5):
        await add_message(room, a if i % 2 else b, f"tin {i}")
    bus.published.clear()
    r = await client.post(f"/api/rooms/{room}/members", json={"user_id": d}, headers=ha)
    assert r.status_code == 200, r.text
    members = {m["user_id"]: m for m in r.json()}
    assert set(members) == {a, b, d} and members[d]["role"] == "member"
    async with SessionLocal() as s:
        latest = (await s.execute(select(func.max(Message.id)))).scalar_one()
    assert members[d]["last_read_message_id"] == latest
    notified = _changed_for(bus)  # chủ trước, rồi người mới và các thành viên cũ
    assert notified[0] == a and sorted(notified) == sorted([a, b, d])
    item = next(x for x in (await client.get("/api/rooms", headers=hd)).json() if x["id"] == room)
    assert item["unread_count"] == 0 and item["member_count"] == 3
    page = (await client.get(f"/api/rooms/{room}/messages", headers=hd)).json()
    assert [m["body"] for m in page["items"]] == [f"tin {i}" for i in range(5)]
    # tin mới sau khi vào vẫn tính chưa đọc; thêm lại không đặt lại mốc và không phát sự kiện
    await add_message(room, a, "tin mới")
    bus.published.clear()
    r = await client.post(f"/api/rooms/{room}/members", json={"user_id": d}, headers=ha)
    assert r.status_code == 200 and {m["user_id"] for m in r.json()} == {a, b, d}
    assert bus.published == []
    item = next(x for x in (await client.get("/api/rooms", headers=hd)).json() if x["id"] == room)
    assert item["unread_count"] == 1
    for bad in (gone, 999999):
        r = await client.post(f"/api/rooms/{room}/members", json={"user_id": bad}, headers=ha)
        assert (r.status_code, r.json()["detail"]) == (404, "user_not_found")
    # đủ thành viên: người mới 409, người đã có vẫn idempotent 200
    assert (await client.post(f"/api/rooms/{room}/members", json={"user_id": e}, headers=ha)).status_code == 200
    r = await client.post(f"/api/rooms/{room}/members", json={"user_id": f}, headers=ha)
    assert (r.status_code, r.json()["detail"]) == (409, "group_full")
    assert (await client.post(f"/api/rooms/{room}/members", json={"user_id": e}, headers=ha)).status_code == 200
    assert len(await _roles(room)) == 4


async def test_default_member_cap_is_200_on_add(client):
    await create_user("alice")
    ids = [await create_user(f"u{i}") for i in range(199)]
    extra = await create_user("extra")
    ha = await _headers(client, "alice")
    room = await _make_group(client, ha, "Full", ids)
    r = await client.post(f"/api/rooms/{room}/members", json={"user_id": extra}, headers=ha)
    assert (r.status_code, r.json()["detail"]) == (409, "group_full")
    assert len(await _roles(room)) == 200


async def test_removed_member_loses_access_immediately(live_server):
    a, b, c = await _users("alice", "bob", "carol")
    zed = await create_user("zed")
    async with AsyncClient(base_url=live_server.http) as http:
        ta, tb, tc = await _tokens(http, "alice", "bob", "carol")
        ha, hc = auth_headers(ta), auth_headers(tc)
        room = await _make_group(http, ha, "G", [b, c])
        wa, _ = await ws_open(live_server.ws, ta)
        wb, _ = await ws_open(live_server.ws, tb)
        wc, _ = await ws_open(live_server.ws, tc)
        for w in (wa, wb, wc):
            await _drain(w, 0.6)  # để presence ban đầu và rooms_changed lúc tạo nhóm lắng xuống
        await wc.send(json.dumps({"type": "send", "room_id": room, "body": "tin cũ của C", "client_id": "c-old"}))
        await _wait_for(wc, lambda e: e.get("type") == "message")
        assert (await http.get(f"/api/rooms/{room}/messages", headers=hc)).status_code == 200
        r = await http.delete(f"/api/rooms/{room}/members/{c}", headers=ha)
        assert r.status_code == 200 and {m["user_id"] for m in r.json()} == {a, b}
        await _wait_for(wc, _is_rooms_changed)  # hub đã tính lại room_ids của C
        r = await http.get(f"/api/rooms/{room}/messages", headers=hc)
        assert (r.status_code, r.json()["detail"]) == (404, "room_not_found")
        assert (await http.get(f"/api/rooms/{room}/members", headers=hc)).status_code == 404
        assert (await http.post(f"/api/rooms/{room}/read", json={"message_id": 1}, headers=hc)).status_code == 404
        await wc.send(json.dumps({"type": "send", "room_id": room, "body": "lén", "client_id": "c-new"}))
        err = await _wait_for(wc, lambda e: e.get("type") == "error")
        assert err["code"] == "room_not_found" and err["client_id"] == "c-new"
        # các thành viên còn lại chat bình thường và thấy đủ message/typing/read/presence; C thì không
        await wc.send(json.dumps({"type": "typing", "room_id": room}))
        await wb.send(json.dumps({"type": "send", "room_id": room, "body": "chuyện nội bộ", "client_id": "b1"}))
        msg = await _wait_for(wa, lambda e: e.get("type") == "message" and e["message"]["client_id"] == "b1")
        await wb.send(json.dumps({"type": "typing", "room_id": room}))
        await _wait_for(wa, lambda e: e.get("type") == "typing" and e["user_id"] == b)
        r = await http.post(f"/api/rooms/{room}/read", json={"message_id": msg["message"]["id"]}, headers=ha)
        assert r.status_code == 204
        await _wait_for(wb, lambda e: e.get("type") == "read" and e["user_id"] == a)
        await wb.close()  # B offline -> presence tới phòng: A thấy
        await _wait_for(wa, lambda e: e.get("type") == "presence" and e["user_id"] == b and e["online"] is False)
        leaked = [e for e in await _drain(wc, 0.7) if e.get("type") in ("message", "typing", "read", "presence")]
        assert leaked == []
        page = (await http.get(f"/api/rooms/{room}/messages", headers=ha)).json()
        assert "tin cũ của C" in [m["body"] for m in page["items"]]  # tin cũ ở lại
        assert not any(m["body"] == "lén" for m in page["items"])
        assert (await http.get("/api/rooms", headers=hc)).json() == []
        r = await http.delete(f"/api/rooms/{room}/members/{a}", headers=ha)
        assert (r.status_code, r.json()["detail"]) == (400, "cannot_remove_self")
        for gone in (c, zed, 999999):
            r = await http.delete(f"/api/rooms/{room}/members/{gone}", headers=ha)
            assert (r.status_code, r.json()["detail"]) == (404, "member_not_found")
        for w in (wa, wc):
            await w.close()


async def test_events_to_removed_user_dont_leak_to_others(live_server):
    a, b, c = await _users("alice", "bob", "carol")
    async with AsyncClient(base_url=live_server.http) as http:
        ta, tb, tc = await _tokens(http, "alice", "bob", "carol")
        room = await _make_group(http, auth_headers(ta), "G", [b, c])
        wa, _ = await ws_open(live_server.ws, ta)
        wb, _ = await ws_open(live_server.ws, tb)
        wc, _ = await ws_open(live_server.ws, tc)
        for w in (wa, wb, wc):
            await _drain(w, 0.6)
        r = await http.delete(f"/api/rooms/{room}/members/{c}", headers=auth_headers(ta))
        assert r.status_code == 200
        await _wait_for(wc, _is_rooms_changed)
        for w in (wa, wb):
            await _wait_for(w, _is_rooms_changed)
            await _drain(w, 0.3)  # mọi sự kiện của C lúc còn trong phòng đã đến trước mốc này
        await wc.send(json.dumps({"type": "typing", "room_id": room}))
        await wc.close()  # C offline: presence chỉ tới các phòng C còn là thành viên (không còn phòng nào)
        await wb.close()  # đối chứng dương: presence của B vẫn tới A
        await _wait_for(wa, lambda e: e.get("type") == "presence" and e["user_id"] == b and e["online"] is False)
        stray = [e for e in await _drain(wa, 0.8) if e.get("user_id") == c]
        assert stray == []
        await wa.close()


async def test_member_leaves(client, bus):
    a, b, c = await _users("alice", "bob", "carol")
    ha, hb, hc = await _headers_for(client, "alice", "bob", "carol")
    room = await _make_group(client, ha, "G", [b, c])
    bus.published.clear()
    r = await client.post(f"/api/rooms/{room}/leave", headers=hb)
    assert r.status_code == 204 and r.content == b""
    assert (await client.get(f"/api/rooms/{room}/messages", headers=hb)).status_code == 404
    assert (await client.get("/api/rooms", headers=hb)).json() == []
    notified = _changed_for(bus)  # người rời trước (hub cần bỏ phòng), rồi các thành viên còn lại
    assert notified[0] == b and sorted(notified) == sorted([a, b, c])
    assert await _roles(room) == {a: "owner", c: "member"}
    r = await client.post(f"/api/rooms/{room}/leave", headers=hb)
    assert (r.status_code, r.json()["detail"]) == (404, "room_not_found")
    item = next(x for x in (await client.get("/api/rooms", headers=ha)).json() if x["id"] == room)
    assert item["member_count"] == 2 and item["my_role"] == "owner"


async def test_leaving_member_websocket_stops_receiving(live_server):
    a, b = await _users("alice", "bob")
    async with AsyncClient(base_url=live_server.http) as http:
        ta, tb = await _tokens(http, "alice", "bob")
        room = await _make_group(http, auth_headers(ta), "G", [b])
        wa, _ = await ws_open(live_server.ws, ta)
        wb, _ = await ws_open(live_server.ws, tb)
        for w in (wa, wb):
            await _drain(w, 0.6)
        assert (await http.post(f"/api/rooms/{room}/leave", headers=auth_headers(tb))).status_code == 204
        await _wait_for(wb, _is_rooms_changed)
        await wa.send(json.dumps({"type": "send", "room_id": room, "body": "sau khi B rời", "client_id": "a1"}))
        await _wait_for(wa, lambda e: e.get("type") == "message")
        assert [e for e in await _drain(wb, 0.5) if e.get("type") == "message"] == []
        await wa.close()
        await wb.close()


async def test_owner_leaves_transfers_ownership(client):
    a, b, c, d = await _users("alice", "bob", "carol", "dave")
    ha, hb, hc = await _headers_for(client, "alice", "bob", "carol")
    # hòa joined_at (cùng giao dịch tạo): user_id nhỏ nhất (bob) thừa kế
    room = await _make_group(client, ha, "Hòa", [c, b])
    assert (await client.post(f"/api/rooms/{room}/leave", headers=ha)).status_code == 204
    assert await _roles(room) == {b: "owner", c: "member"}
    members = (await client.get(f"/api/rooms/{room}/members", headers=hc)).json()
    assert {m["user_id"]: m["role"] for m in members} == {b: "owner", c: "member"}
    item = next(x for x in (await client.get("/api/rooms", headers=hb)).json() if x["id"] == room)
    assert item["my_role"] == "owner"
    # joined_at sớm nhất thắng dù user_id lớn hơn
    room2 = await _make_group(client, ha, "Sớm", [b, c])
    assert (await client.post(f"/api/rooms/{room2}/members", json={"user_id": d}, headers=ha)).status_code == 200
    async with SessionLocal() as s:
        await s.execute(
            update(RoomMember)
            .where(RoomMember.room_id == room2, RoomMember.user_id == c)
            .values(joined_at=func.now() - timedelta(hours=1))
        )
        await s.commit()
    assert (await client.post(f"/api/rooms/{room2}/leave", headers=ha)).status_code == 204
    assert await _roles(room2) == {b: "member", c: "owner", d: "member"}
    assert (await client.patch(f"/api/rooms/{room2}", json={"name": "X"}, headers=hc)).status_code == 200
    assert (await client.patch(f"/api/rooms/{room2}", json={"name": "Y"}, headers=ha)).status_code == 404


async def test_last_member_leaving_archives_the_group(client):
    a, b = await _users("alice", "bob")
    await create_user("root", role="admin")
    ha, hb, hroot = await _headers_for(client, "alice", "bob", "root")
    room = await _make_group(client, ha, "Cuối", [b])
    assert (await client.post(f"/api/rooms/{room}/leave", headers=ha)).status_code == 204
    assert await _archived_at(room) is None
    assert (await client.post(f"/api/rooms/{room}/leave", headers=hb)).status_code == 204
    assert await _archived_at(room) is not None
    archived = (await client.get("/api/admin/rooms?archived=true", headers=hroot)).json()
    assert [r["id"] for r in archived] == [room]
    solo = await _make_group(client, ha, "Một mình")
    assert (await client.post(f"/api/rooms/{solo}/leave", headers=ha)).status_code == 204
    assert await _archived_at(solo) is not None


async def test_leave_admin_created_group_allowed_but_no_management(client):
    a, b, d = await _users("alice", "bob", "dave")
    room = await create_room(name="Admin tạo", member_ids=[a, b])
    ha, hb = await _headers_for(client, "alice", "bob")
    for headers in (ha, hb):
        for r in (
            await client.patch(f"/api/rooms/{room}", json={"name": "X"}, headers=headers),
            await client.post(f"/api/rooms/{room}/members", json={"user_id": d}, headers=headers),
            await client.delete(f"/api/rooms/{room}/members/{b}", headers=headers),
            await client.delete(f"/api/rooms/{room}", headers=headers),
        ):
            assert (r.status_code, r.json()["detail"]) == (403, "forbidden")
    assert (await client.post(f"/api/rooms/{room}/leave", headers=ha)).status_code == 204
    assert await _roles(room) == {b: "member"}  # không tự sinh chủ nhóm
    assert (await client.post(f"/api/rooms/{room}/leave", headers=hb)).status_code == 204
    assert await _archived_at(room) is not None


async def test_owner_dissolves_group(live_server):
    a, b, c = await _users("alice", "bob", "carol")
    await create_user("root", role="admin")
    async with AsyncClient(base_url=live_server.http) as http:
        ta, tb, tc, troot = await _tokens(http, "alice", "bob", "carol", "root")
        room = await _make_group(http, auth_headers(ta), "Tan", [b, c])
        ws = [(await ws_open(live_server.ws, t))[0] for t in (ta, tb, tc)]
        for w in ws:
            await _drain(w, 0.6)
        assert (await http.delete(f"/api/rooms/{room}", headers=auth_headers(ta))).status_code == 204
        for w in ws:
            await _wait_for(w, _is_rooms_changed)
        for t in (ta, tb, tc):
            assert (await http.get("/api/rooms", headers=auth_headers(t))).json() == []
            assert (await http.get(f"/api/rooms/{room}/messages", headers=auth_headers(t))).status_code == 404
        assert await _archived_at(room) is not None
        await ws[0].send(json.dumps({"type": "send", "room_id": room, "body": "x", "client_id": "z"}))
        assert (await _wait_for(ws[0], lambda e: e.get("type") == "error"))["code"] == "room_not_found"
        hroot = auth_headers(troot)
        archived = (await http.get("/api/admin/rooms?archived=true", headers=hroot)).json()
        assert [x["id"] for x in archived] == [room]
        assert (await http.post(f"/api/admin/rooms/{room}/restore", headers=hroot)).status_code == 200
        assert await _roles(room) == {a: "owner", b: "member", c: "member"}
        item = next(x for x in (await http.get("/api/rooms", headers=auth_headers(ta))).json() if x["id"] == room)
        assert item["my_role"] == "owner"
        assert (await http.patch(f"/api/rooms/{room}", json={"name": "Lại"}, headers=auth_headers(ta))).status_code == 200
        for w in ws:
            await w.close()


async def test_concurrent_add_member_is_safe(client, small_limits):
    await create_user("alice")
    b = await create_user("bob")
    ha = await _headers(client, "alice")
    others = [await create_user(f"u{i}") for i in range(10)]
    for target in others[:4]:  # cùng một người: cả hai 200, đúng một dòng
        room = await _make_group(client, ha, f"S{target}", [b])
        rs = await asyncio.gather(
            *(client.post(f"/api/rooms/{room}/members", json={"user_id": target}, headers=ha) for _ in range(2))
        )
        assert [r.status_code for r in rs] == [200, 200], [r.text for r in rs]
        async with SessionLocal() as s:
            n = (
                await s.execute(
                    select(func.count())
                    .select_from(RoomMember)
                    .where(RoomMember.room_id == room, RoomMember.user_id == target)
                )
            ).scalar_one()
        assert n == 1
    small_limits(MAX_GROUP_MEMBERS=3)
    for x, y in ((others[4], others[5]), (others[6], others[7]), (others[8], others[9])):
        room = await _make_group(client, ha, "Chật", [b])  # còn đúng một chỗ trống
        rs = await asyncio.gather(
            client.post(f"/api/rooms/{room}/members", json={"user_id": x}, headers=ha),
            client.post(f"/api/rooms/{room}/members", json={"user_id": y}, headers=ha),
        )
        assert sorted(r.status_code for r in rs) == [200, 409], [r.text for r in rs]
        assert len(await _roles(room)) == 3


async def test_owner_leave_races_with_add(client):
    a, b = await _users("alice", "bob")
    ha = await _headers(client, "alice")
    targets = [await create_user(f"u{i}") for i in range(6)]
    for target in targets:
        room = await _make_group(client, ha, f"R{target}", [b])
        leave, add = await asyncio.gather(
            client.post(f"/api/rooms/{room}/leave", headers=ha),
            client.post(f"/api/rooms/{room}/members", json={"user_id": target}, headers=ha),
        )
        assert leave.status_code == 204
        assert add.status_code in (200, 404), add.text
        if add.status_code == 404:
            assert add.json()["detail"] == "room_not_found"
        roles = await _roles(room)
        assert list(roles.values()).count("owner") == 1  # còn thành viên thì luôn đúng một chủ
        assert a not in roles and (target in roles) == (add.status_code == 200)
        assert await _archived_at(room) is None


async def test_redis_failure_does_not_fail_management(client, bus):
    b = (await _users("alice", "bob"))[1]
    ha = await _headers(client, "alice")
    room = await _make_group(client, ha, "G", [b])

    async def boom(*args, **kwargs):
        raise RedisConnectionError("down")

    bus.publish_user = boom
    assert (await client.patch(f"/api/rooms/{room}", json={"name": "H"}, headers=ha)).status_code == 200
    assert (await client.delete(f"/api/rooms/{room}/members/{b}", headers=ha)).status_code == 200
    assert (await client.post(f"/api/rooms/{room}/leave", headers=ha)).status_code == 204


async def test_removed_and_leaving_users_are_notified_first(client, bus):
    a, b, c = await _users("alice", "bob", "carol")
    ha, hb = await _headers_for(client, "alice", "bob")
    room = await _make_group(client, ha, "G", [b, c])
    bus.published.clear()
    assert (await client.delete(f"/api/rooms/{room}/members/{c}", headers=ha)).status_code == 200
    notified = _changed_for(bus)
    assert notified[0] == c and sorted(notified) == sorted([a, b, c])
    bus.published.clear()
    assert (await client.post(f"/api/rooms/{room}/leave", headers=hb)).status_code == 204
    assert _changed_for(bus)[0] == b


async def test_removed_user_is_notified_even_if_bus_breaks_afterwards(client, bus):
    a, b = await _users("alice", "bob")
    ha = await _headers(client, "alice")
    room = await _make_group(client, ha, "G", [b])
    real = bus.publish_user
    calls = []

    async def flaky(user_id, event):
        calls.append(user_id)
        if len(calls) > 1:
            raise RedisConnectionError("down")
        await real(user_id, event)

    bus.publish_user = flaky
    bus.published.clear()
    assert (await client.delete(f"/api/rooms/{room}/members/{b}", headers=ha)).status_code == 200
    assert _changed_for(bus) == [b]


async def _admin_headers(client):
    await create_user("root", role="admin")
    return await _headers(client, "root")


async def test_admin_add_races_with_owner_add_of_same_user(client):
    a = await create_user("alice")
    ha, hroot = await _headers(client, "alice"), await _admin_headers(client)
    for i in range(4):
        target = await create_user(f"t{i}")
        room = await _make_group(client, ha, f"G{i}")
        rs = await asyncio.gather(
            client.post(f"/api/rooms/{room}/members", json={"user_id": target}, headers=ha),
            client.post(f"/api/admin/rooms/{room}/members", json={"user_id": target}, headers=hroot),
        )
        assert [r.status_code for r in rs] == [200, 200], [r.text for r in rs]
        assert set(await _roles(room)) == {a, target}


async def test_leave_races_with_admin_removing_the_heir(client):
    hroot = await _admin_headers(client)
    for i in range(5):
        a, b, c = await _users(f"a{i}", f"b{i}", f"c{i}")
        ha = await _headers(client, f"a{i}")
        room = await _make_group(client, ha, "G", [b, c])  # b có user_id nhỏ hơn c: là người thừa kế khi hòa
        leave, rem = await asyncio.gather(
            client.post(f"/api/rooms/{room}/leave", headers=ha),
            client.delete(f"/api/admin/rooms/{room}/members/{b}", headers=hroot),
        )
        assert (leave.status_code, rem.status_code) == (204, 200), (leave.text, rem.text)
        assert await _roles(room) == {c: "owner"}


async def test_admin_removing_the_owner_transfers_ownership(client):
    hroot = await _admin_headers(client)
    a, b, c = await _users("alice", "bob", "carol")
    ha = await _headers(client, "alice")
    room = await _make_group(client, ha, "G", [c, b])
    r = await client.delete(f"/api/admin/rooms/{room}/members/{a}", headers=hroot)
    assert r.status_code == 200
    assert await _roles(room) == {b: "owner", c: "member"}
    assert (await client.delete(f"/api/admin/rooms/{room}/members/{c}", headers=hroot)).status_code == 200
    assert await _roles(room) == {b: "owner"}


async def test_non_member_never_blocks_on_the_room_lock(client):
    a, b, outsider = await _users("alice", "bob", "carol")
    ha, hc = await _headers_for(client, "alice", "carol")
    room = await _make_group(client, ha, "G", [b])
    async with SessionLocal() as holder:
        await holder.execute(select(Room).where(Room.id == room).with_for_update())  # giữ khoá phòng
        for call in (
            client.patch(f"/api/rooms/{room}", json={"name": "X"}, headers=hc),
            client.post(f"/api/rooms/{room}/members", json={"user_id": outsider}, headers=hc),
            client.delete(f"/api/rooms/{room}/members/{b}", headers=hc),
            client.delete(f"/api/rooms/{room}", headers=hc),
            client.post(f"/api/rooms/{room}/leave", headers=hc),
        ):
            r = await asyncio.wait_for(call, 1.5)
            assert (r.status_code, r.json()["detail"]) == (404, "room_not_found")
        # đối chứng: người trong phòng thì phải chờ khoá
        pending = asyncio.ensure_future(client.patch(f"/api/rooms/{room}", json={"name": "X"}, headers=ha))
        done, _ = await asyncio.wait({pending}, timeout=0.5)
        assert not done
        await holder.rollback()
    assert (await pending).status_code == 200


async def test_two_members_leaving_simultaneously(client):
    a, b, c = await _users("alice", "bob", "carol")
    ha, hb = await _headers_for(client, "alice", "bob")
    room = await _make_group(client, ha, "G", [b, c])
    rs = await asyncio.gather(
        client.post(f"/api/rooms/{room}/leave", headers=ha), client.post(f"/api/rooms/{room}/leave", headers=hb)
    )
    assert [r.status_code for r in rs] == [204, 204]
    assert await _roles(room) == {c: "owner"}  # còn thành viên thì luôn đúng một chủ
    room2 = await _make_group(client, ha, "G2", [b])
    rs = await asyncio.gather(
        client.post(f"/api/rooms/{room2}/leave", headers=ha), client.post(f"/api/rooms/{room2}/leave", headers=hb)
    )
    assert [r.status_code for r in rs] == [204, 204]
    assert await _roles(room2) == {} and await _archived_at(room2) is not None


async def test_owner_leave_races_with_member_removal(client):
    for i in range(5):
        a, b, c = await _users(f"a{i}", f"b{i}", f"c{i}")
        ha = await _headers(client, f"a{i}")
        room = await _make_group(client, ha, "G", [b, c])
        leave, rem = await asyncio.gather(
            client.post(f"/api/rooms/{room}/leave", headers=ha),
            client.delete(f"/api/rooms/{room}/members/{c}", headers=ha),
        )
        assert leave.status_code == 204
        assert rem.status_code in (200, 404), rem.text
        if rem.status_code == 404:
            assert rem.json()["detail"] == "room_not_found"
        roles = await _roles(room)
        assert list(roles.values()).count("owner") == 1 and a not in roles and b in roles


async def test_deadlock_is_retried_once_then_409():
    from sqlalchemy.exc import DBAPIError

    from app.chat import service

    class Orig(Exception):
        sqlstate = "40P01"

    class FakeSession:
        rollbacks = 0

        async def rollback(self):
            self.rollbacks += 1

    calls = []

    @service.retry_on_deadlock
    async def flaky(session, fail_times):
        calls.append(1)
        if len(calls) <= fail_times:
            raise DBAPIError("stmt", {}, Orig())
        return "ok"

    session = FakeSession()
    assert await flaky(session, 1) == "ok" and len(calls) == 2 and session.rollbacks == 1
    calls.clear()
    with pytest.raises(service.ChatError) as info:
        await flaky(session, 5)
    assert (info.value.status, info.value.code) == (409, "conflict") and len(calls) == 2


async def test_admin_removing_the_owner_notifies_everyone_affected(client, bus):
    hroot = await _admin_headers(client)
    a, b, c = await _users("alice", "bob", "carol")
    ha = await _headers(client, "alice")
    room = await _make_group(client, ha, "G", [c, b])
    bus.published.clear()
    assert (await client.delete(f"/api/admin/rooms/{room}/members/{a}", headers=hroot)).status_code == 200
    notified = _changed_for(bus)
    assert notified[0] == a and sorted(notified) == sorted([a, b, c])  # người bị gỡ trước, rồi người thừa kế + còn lại
    bus.published.clear()  # gỡ người thường (nhóm có chủ): chỉ người bị gỡ như trước
    assert (await client.delete(f"/api/admin/rooms/{room}/members/{c}", headers=hroot)).status_code == 200
    assert _changed_for(bus) == [c]


async def test_admin_removing_the_last_owner_archives_but_ownerless_groups_stay(client):
    hroot = await _admin_headers(client)
    a, b = await _users("alice", "bob")
    ha = await _headers(client, "alice")
    room = await _make_group(client, ha, "Một mình")
    r = await client.delete(f"/api/admin/rooms/{room}/members/{a}", headers=hroot)
    assert r.status_code == 200
    assert await _archived_at(room) is not None
    # nhóm admin tạo không chủ: gỡ hết thành viên vẫn không tự lưu trữ (hành vi cũ)
    plain = await create_room(name="Admin tạo", member_ids=[b])
    assert (await client.delete(f"/api/admin/rooms/{plain}/members/{b}", headers=hroot)).status_code == 200
    assert await _archived_at(plain) is None


async def test_admin_add_member_enforces_group_cap(client, small_limits):
    small_limits(MAX_GROUP_MEMBERS=2)
    hroot = await _admin_headers(client)
    b, c = await _users("bob", "carol")
    await create_user("alice")
    ha = await _headers(client, "alice")
    room = await _make_group(client, ha, "G", [b])
    r = await client.post(f"/api/admin/rooms/{room}/members", json={"user_id": c}, headers=hroot)
    assert (r.status_code, r.json()["detail"]) == (409, "group_full")
    r = await client.post(f"/api/admin/rooms/{room}/members", json={"user_id": b}, headers=hroot)
    assert r.status_code == 200  # đã là thành viên: idempotent kể cả khi đầy
    assert len(await _roles(room)) == 2


async def test_admin_room_edits_wait_for_the_room_lock(client):
    """Đối chứng cho việc tuần tự hoá: giữ khoá phòng ở phiên khác, các thao tác admin phải chờ (không chạy chen)."""
    hroot = await _admin_headers(client)
    a, b, c = await _users("alice", "bob", "carol")
    ha = await _headers(client, "alice")
    room = await _make_group(client, ha, "G", [b])
    calls = [
        lambda: client.post(f"/api/admin/rooms/{room}/members", json={"user_id": b}, headers=hroot),
        lambda: client.post(f"/api/admin/rooms/{room}/members", json={"user_id": c}, headers=hroot),
        lambda: client.delete(f"/api/admin/rooms/{room}/members/{c}", headers=hroot),
        lambda: client.patch(f"/api/admin/rooms/{room}", json={"name": "Z"}, headers=hroot),
    ]
    for make in calls:
        async with SessionLocal() as holder:
            await holder.execute(select(Room).where(Room.id == room).with_for_update(key_share=True))
            pending = asyncio.ensure_future(make())
            done, _ = await asyncio.wait({pending}, timeout=0.5)
            assert not done
            await holder.rollback()
        assert (await pending).status_code in (200, 404)


async def test_message_insert_is_not_blocked_by_group_management_lock(client):
    from app.chat import service

    a, b = await _users("alice", "bob")
    ha = await _headers(client, "alice")
    room = await _make_group(client, ha, "G", [b])
    async with SessionLocal() as holder:
        await holder.execute(select(Room).where(Room.id == room).with_for_update(key_share=True))
        async with SessionLocal() as s:
            message, _, created = await asyncio.wait_for(service.send_message(s, a, room, "xin chào", "m1"), 2)
        assert created
        await holder.rollback()
