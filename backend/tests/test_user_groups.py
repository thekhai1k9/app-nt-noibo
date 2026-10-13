import asyncio
import json

import pytest
from httpx import AsyncClient
from redis.exceptions import ConnectionError as RedisConnectionError
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db import SessionLocal
from app.models import Room, RoomMember
from tests.conftest import auth_headers, create_branch, create_direct, create_room, create_user, token_for
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
