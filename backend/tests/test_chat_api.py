from tests.conftest import add_message, auth_headers, create_branch, create_direct, create_room, create_user, token_for


async def _setup(client):
    a, b = await create_user("alice"), await create_user("bob")
    room = await create_room(member_ids=[a, b])
    ta, tb = await token_for(client, "alice"), await token_for(client, "bob")
    return a, b, room, auth_headers(ta), auth_headers(tb)


# ---------- thư mục người dùng ----------

async def test_directory_lists_active_colleagues_except_self(client):
    hn = await create_branch("Hà Nội", "HN")
    await create_user("alice", branch_id=hn)
    await create_user("bob", branch_id=hn)
    await create_user("ghost", branch_id=hn, active=False)
    headers = auth_headers(await token_for(client, "alice"))
    r = await client.get("/api/users/directory", headers=headers)
    assert r.status_code == 200
    assert [u["username"] for u in r.json()] == ["bob"]
    assert r.json()[0]["branch_name"] == "Hà Nội"
    assert "password_hash" not in r.json()[0]


async def test_directory_search_escapes_like_wildcards(client):
    await create_user("alice")
    await create_user("ha_le")
    await create_user("haxle")
    headers = auth_headers(await token_for(client, "alice"))
    r = await client.get("/api/users/directory", params={"q": "ha_le"}, headers=headers)
    assert [u["username"] for u in r.json()] == ["ha_le"]


async def test_directory_requires_login_and_a_changed_password(client):
    assert (await client.get("/api/users/directory")).status_code == 401
    await create_user("temp", must_change=True)
    headers = auth_headers(await token_for(client, "temp"))
    r = await client.get("/api/users/directory", headers=headers)
    assert (r.status_code, r.json()["detail"]) == (403, "password_change_required")


# ---------- phòng ----------

async def test_open_direct_room_creates_then_reuses_and_notifies_both_users(client, bus):
    a, b = await create_user("alice"), await create_user("bob")
    headers = auth_headers(await token_for(client, "alice"))
    first = await client.post("/api/rooms/direct", json={"user_id": b}, headers=headers)
    again = await client.post("/api/rooms/direct", json={"user_id": b}, headers=headers)
    assert (first.status_code, again.status_code) == (201, 200)
    assert first.json()["id"] == again.json()["id"]
    assert first.json()["type"] == "direct" and first.json()["name"] == "Bob" and first.json()["peer_id"] == b
    notified = {(scope, target) for scope, target, event in bus.published if event == {"type": "rooms_changed"}}
    assert notified == {("user", a), ("user", b)}


async def test_open_direct_room_errors(client):
    a = await create_user("alice")
    ghost = await create_user("ghost", active=False)
    headers = auth_headers(await token_for(client, "alice"))
    for payload, status, code in (
        ({"user_id": a}, 400, "cannot_chat_with_self"),
        ({"user_id": 9999}, 404, "user_not_found"),
        ({"user_id": ghost}, 404, "user_not_found"),
        ({}, 422, "validation_error"),
    ):
        r = await client.post("/api/rooms/direct", json=payload, headers=headers)
        assert r.status_code == status, payload
        if status != 422:
            assert r.json()["detail"] == code


async def test_room_list_for_the_caller(client):
    a, b, room, ha, hb = await _setup(client)
    await add_message(room, b, "chào")
    r = await client.get("/api/rooms", headers=ha)
    assert r.status_code == 200
    assert [(x["id"], x["unread_count"]) for x in r.json()] == [(room, 1)]
    assert r.json()[0]["last_message"]["body"] == "chào"
    assert (await client.get("/api/rooms")).status_code == 401


# ---------- tin nhắn: đọc ----------

async def test_messages_page_with_cursors(client):
    a, b, room, ha, hb = await _setup(client)
    ids = [await add_message(room, a, f"m{i}") for i in range(6)]
    r = await client.get(f"/api/rooms/{room}/messages", params={"limit": 3}, headers=ha)
    body = r.json()
    assert [m["id"] for m in body["items"]] == ids[3:6] and body["has_more_before"] is True
    r = await client.get(f"/api/rooms/{room}/messages", params={"before": ids[3], "limit": 3}, headers=ha)
    assert [m["id"] for m in r.json()["items"]] == ids[0:3] and r.json()["has_more_before"] is False
    r = await client.get(f"/api/rooms/{room}/messages", params={"after": ids[4]}, headers=ha)
    assert [m["id"] for m in r.json()["items"]] == ids[5:6]
    r = await client.get(f"/api/rooms/{room}/messages", params={"around": ids[2], "limit": 2}, headers=ha)
    assert [m["id"] for m in r.json()["items"]] == ids[2:4]


async def test_messages_validation_errors(client):
    a, b, room, ha, hb = await _setup(client)
    url = f"/api/rooms/{room}/messages"
    assert (await client.get(url, params={"limit": 0}, headers=ha)).status_code == 422
    assert (await client.get(url, params={"limit": 101}, headers=ha)).status_code == 422
    r = await client.get(url, params={"before": 5, "after": 1}, headers=ha)
    assert (r.status_code, r.json()["detail"]) == (400, "invalid_cursor")
    r = await client.get(url, params={"around": 424242}, headers=ha)
    assert (r.status_code, r.json()["detail"]) == (404, "message_not_found")


async def test_non_members_including_admins_get_404_on_every_room_endpoint(client):
    a, b, room, ha, hb = await _setup(client)
    msg = await add_message(room, a)
    await create_user("carol")
    await create_user("root", role="admin")
    for who in ("carol", "root"):
        headers = auth_headers(await token_for(client, who))
        for method, url, kwargs in (
            ("get", f"/api/rooms/{room}/messages", {}),
            ("post", f"/api/rooms/{room}/read", {"json": {"message_id": msg}}),
            ("patch", f"/api/messages/{msg}", {"json": {"body": "x"}}),
            ("delete", f"/api/messages/{msg}", {}),
        ):
            r = await getattr(client, method)(url, headers=headers, **kwargs)
            assert (r.status_code, r.json()["detail"]) == (404, "room_not_found"), (who, method, url)
    # phòng không tồn tại trả đúng cùng một lỗi
    r = await client.get("/api/rooms/987654/messages", headers=ha)
    assert (r.status_code, r.json()["detail"]) == (404, "room_not_found")


# ---------- đã đọc ----------

async def test_mark_read_updates_the_unread_count(client):
    a, b, room, ha, hb = await _setup(client)
    ids = [await add_message(room, b) for _ in range(2)]
    assert (await client.get("/api/rooms", headers=ha)).json()[0]["unread_count"] == 2
    r = await client.post(f"/api/rooms/{room}/read", json={"message_id": ids[1]}, headers=ha)
    assert r.status_code == 204
    assert (await client.get("/api/rooms", headers=ha)).json()[0]["unread_count"] == 0


# ---------- sửa, xoá ----------

async def test_edit_message_updates_and_broadcasts(client, bus):
    a, b, room, ha, hb = await _setup(client)
    msg = await add_message(room, a, "gốc")
    r = await client.patch(f"/api/messages/{msg}", json={"body": "  đã sửa "}, headers=ha)
    assert r.status_code == 200 and r.json()["body"] == "đã sửa" and r.json()["edited_at"] is not None
    scope, target, event = bus.published[-1]
    assert (scope, target, event["type"], event["message"]["id"]) == ("room", room, "message_updated", msg)
    forbidden = await client.patch(f"/api/messages/{msg}", json={"body": "x"}, headers=hb)
    assert (forbidden.status_code, forbidden.json()["detail"]) == (403, "forbidden")
    empty = await client.patch(f"/api/messages/{msg}", json={"body": "   "}, headers=ha)
    assert (empty.status_code, empty.json()["detail"]) == (400, "empty_message")


async def test_delete_message_hides_the_text_and_broadcasts(client, bus):
    a, b, room, ha, hb = await _setup(client)
    msg = await add_message(room, a, "bí mật")
    assert (await client.delete(f"/api/messages/{msg}", headers=hb)).status_code == 403
    assert (await client.delete(f"/api/messages/{msg}", headers=ha)).status_code == 204
    assert bus.published[-1] == ("room", room, {"type": "message_deleted", "room_id": room, "message_id": msg})
    page = (await client.get(f"/api/rooms/{room}/messages", headers=hb)).json()
    assert page["items"][0]["deleted"] is True and page["items"][0]["body"] == ""
    again = await client.delete(f"/api/messages/{msg}", headers=ha)
    assert (again.status_code, again.json()["detail"]) == (404, "message_not_found")
