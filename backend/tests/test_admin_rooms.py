from sqlalchemy import select

from app.db import SessionLocal
from app.models import Message, Room, RoomMember
from tests.conftest import add_message, auth_headers, create_branch, create_direct, create_room, create_user, token_for


def room_changed_targets(bus):
    return sorted(target for scope, target, event in bus.published if scope == "user" and event == {"type": "rooms_changed"})


async def test_admin_room_endpoints_require_an_admin(client, member_headers):
    for method, url, kwargs in (
        ("get", "/api/admin/rooms", {}),
        ("post", "/api/admin/rooms", {"json": {"name": "X", "member_ids": []}}),
        ("get", "/api/admin/rooms/1", {}),
        ("patch", "/api/admin/rooms/1", {"json": {"name": "Y"}}),
        ("delete", "/api/admin/rooms/1", {}),
        ("post", "/api/admin/rooms/1/members", {"json": {"user_id": 1}}),
        ("delete", "/api/admin/rooms/1/members/1", {}),
    ):
        r = await getattr(client, method)(url, headers=member_headers, **kwargs)
        assert (r.status_code, r.json()["detail"]) == (403, "forbidden"), (method, url)
        assert (await getattr(client, method)(url, **kwargs)).status_code == 401


async def test_create_group_does_not_add_the_admin_and_notifies_members(client, admin_headers, bus):
    hn = await create_branch("Hà Nội", "HN")
    a, b = await create_user("alice", branch_id=hn), await create_user("bob", branch_id=hn)
    r = await client.post(
        "/api/admin/rooms",
        json={"name": "Dự án kho", "branch_id": hn, "member_ids": [a, b, a]},
        headers=admin_headers,
    )
    assert r.status_code == 201
    body = r.json()
    assert body["name"] == "Dự án kho" and body["member_count"] == 2
    assert sorted(m["user_id"] for m in body["members"]) == sorted([a, b])
    assert all(m["username"] in ("alice", "bob") for m in body["members"])
    assert room_changed_targets(bus) == sorted([a, b])


async def test_create_group_validation(client, admin_headers):
    a = await create_user("alice")
    ghost = await create_user("ghost", active=False)
    cases = (
        ({"name": "", "member_ids": []}, 422),
        ({"name": "x" * 101, "member_ids": []}, 422),
        ({"name": "A", "member_ids": [9999]}, 404),
        ({"name": "A", "member_ids": [ghost]}, 404),
        ({"name": "A", "branch_id": 9999, "member_ids": [a]}, 404),
    )
    for payload, status in cases:
        r = await client.post("/api/admin/rooms", json=payload, headers=admin_headers)
        assert r.status_code == status, payload
    assert (await client.post("/api/admin/rooms", json={"name": "A", "member_ids": [9999]}, headers=admin_headers)).json()["detail"] == "user_not_found"


async def test_list_shows_groups_only_with_member_counts_and_filters(client, admin_headers):
    hn, dn = await create_branch("Hà Nội", "HN"), await create_branch("Đà Nẵng", "DN")
    a, b = await create_user("alice"), await create_user("bob")
    await create_room(name="Kinh doanh", member_ids=[a, b], branch_id=hn)
    await create_room(name="Kho", member_ids=[a], branch_id=dn)
    await create_direct(a, b)
    r = await client.get("/api/admin/rooms", headers=admin_headers)
    assert sorted((x["name"], x["member_count"]) for x in r.json()) == [("Kho", 1), ("Kinh doanh", 2)]
    by_branch = await client.get("/api/admin/rooms", params={"branch_id": dn}, headers=admin_headers)
    assert [x["name"] for x in by_branch.json()] == ["Kho"]
    search = await client.get("/api/admin/rooms", params={"q": "kinh"}, headers=admin_headers)
    assert [x["name"] for x in search.json()] == ["Kinh doanh"]


async def test_direct_rooms_are_invisible_and_unmanageable_for_admins(client, admin_headers):
    a, b = await create_user("alice"), await create_user("bob")
    direct = await create_direct(a, b)
    await add_message(direct, a, "riêng tư")
    for method, url, kwargs in (
        ("get", f"/api/admin/rooms/{direct}", {}),
        ("patch", f"/api/admin/rooms/{direct}", {"json": {"name": "x"}}),
        ("delete", f"/api/admin/rooms/{direct}", {}),
        ("post", f"/api/admin/rooms/{direct}/members", {"json": {"user_id": a}}),
        ("delete", f"/api/admin/rooms/{direct}/members/{a}", {}),
    ):
        r = await getattr(client, method)(url, headers=admin_headers, **kwargs)
        assert (r.status_code, r.json()["detail"]) == (404, "room_not_found"), (method, url)


async def test_admin_cannot_read_messages_of_groups_they_are_not_in(client, admin_headers):
    a = await create_user("alice")
    room = await create_room(name="Kín", member_ids=[a])
    await add_message(room, a, "nội dung nhóm")
    detail = (await client.get(f"/api/admin/rooms/{room}", headers=admin_headers)).json()
    assert "nội dung nhóm" not in str(detail)
    r = await client.get(f"/api/rooms/{room}/messages", headers=admin_headers)
    assert (r.status_code, r.json()["detail"]) == (404, "room_not_found")


async def test_rename_add_and_remove_members(client, admin_headers, bus):
    a, b, c = await create_user("alice"), await create_user("bob"), await create_user("carol")
    room = await create_room(name="Cũ", member_ids=[a])
    renamed = await client.patch(f"/api/admin/rooms/{room}", json={"name": " Mới "}, headers=admin_headers)
    assert renamed.json()["name"] == "Mới"

    added = await client.post(f"/api/admin/rooms/{room}/members", json={"user_id": b}, headers=admin_headers)
    assert added.status_code == 200 and added.json()["member_count"] == 2
    again = await client.post(f"/api/admin/rooms/{room}/members", json={"user_id": b}, headers=admin_headers)
    assert again.json()["member_count"] == 2  # thêm lại không báo lỗi, không nhân đôi
    assert (await client.post(f"/api/admin/rooms/{room}/members", json={"user_id": 9999}, headers=admin_headers)).status_code == 404
    assert room_changed_targets(bus).count(b) == 2

    bus.published.clear()
    removed = await client.delete(f"/api/admin/rooms/{room}/members/{b}", headers=admin_headers)
    assert removed.status_code == 200 and removed.json()["member_count"] == 1
    assert room_changed_targets(bus) == [b]
    missing = await client.delete(f"/api/admin/rooms/{room}/members/{c}", headers=admin_headers)
    assert (missing.status_code, missing.json()["detail"]) == (404, "member_not_found")


async def test_delete_group_removes_messages_and_notifies_every_member(client, admin_headers, bus):
    a, b = await create_user("alice"), await create_user("bob")
    room = await create_room(name="Bỏ", member_ids=[a, b])
    await add_message(room, a)
    r = await client.delete(f"/api/admin/rooms/{room}", headers=admin_headers)
    assert r.status_code == 204
    assert room_changed_targets(bus) == sorted([a, b])
    async with SessionLocal() as s:
        assert (await s.execute(select(Room))).first() is None
        assert (await s.execute(select(RoomMember))).first() is None
        assert (await s.execute(select(Message))).first() is None
    assert (await client.delete(f"/api/admin/rooms/{room}", headers=admin_headers)).status_code == 404


async def _unread(client, username, room_id):
    headers = auth_headers(await token_for(client, username))
    rooms = (await client.get("/api/rooms", headers=headers)).json()
    return next(r["unread_count"] for r in rooms if r["id"] == room_id)


async def test_new_member_does_not_see_history_as_unread(client, admin_headers):
    a, b = await create_user("alice"), await create_user("bob")
    room = await create_room(name="Có lịch sử", member_ids=[a])
    for _ in range(3):
        await add_message(room, a)
    r = await client.post(f"/api/admin/rooms/{room}/members", json={"user_id": b}, headers=admin_headers)
    assert r.status_code == 200
    assert await _unread(client, "bob", room) == 0
    await add_message(room, a, "sau khi vào")
    assert await _unread(client, "bob", room) == 1


async def test_re_adding_an_existing_member_keeps_their_read_position(client, admin_headers):
    a, b = await create_user("alice"), await create_user("bob")
    room = await create_room(name="Giữ vị trí", member_ids=[a])
    await add_message(room, a)
    await client.post(f"/api/admin/rooms/{room}/members", json={"user_id": b}, headers=admin_headers)
    await add_message(room, a, "mới")
    assert await _unread(client, "bob", room) == 1
    await client.post(f"/api/admin/rooms/{room}/members", json={"user_id": b}, headers=admin_headers)
    assert await _unread(client, "bob", room) == 1


async def test_deleting_a_group_leaves_other_rooms_messages_and_memberships_alone(client, admin_headers):
    a, b = await create_user("alice"), await create_user("bob")
    doomed = await create_room(name="Bỏ", member_ids=[a, b])
    other_group = await create_room(name="Giữ", member_ids=[a, b])
    direct = await create_direct(a, b)
    await add_message(doomed, a, "sẽ mất")
    kept = [await add_message(other_group, a, "nhóm khác"), await add_message(direct, b, "tin riêng")]

    assert (await client.delete(f"/api/admin/rooms/{doomed}", headers=admin_headers)).status_code == 204

    async with SessionLocal() as s:
        remaining = (await s.execute(select(Message.id).order_by(Message.id))).scalars().all()
        members = set((await s.execute(select(RoomMember.room_id, RoomMember.user_id))).all())
        rooms = set((await s.execute(select(Room.id))).scalars())
    assert list(remaining) == kept
    assert rooms == {other_group, direct}
    assert members == {(other_group, a), (other_group, b), (direct, a), (direct, b)}
