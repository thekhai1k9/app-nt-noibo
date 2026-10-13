import json
import unicodedata
from datetime import datetime, timedelta, timezone

from httpx import AsyncClient
from sqlalchemy import delete, event, func, select, update

from app.chat import service
from app.chat.retention import purge_archived_rooms
from app.db import SessionLocal, engine
from app.models import Message, MessageMention, Room, RoomMember
from tests.conftest import add_message, auth_headers, create_room, create_user, login, token_for
from tests.helpers import expect_silence, recv_json, recv_type, ws_open


async def _token(live, username):
    async with AsyncClient(base_url=live.http) as http:
        return (await login(http, username)).json()["access_token"]


async def _send(ws, room_id, body, client_id=None, **extra):
    await ws.send(json.dumps({"type": "send", "room_id": room_id, "body": body, "client_id": client_id, **extra}))


async def _svc_send(user_id, room_id, body, client_id=None, **kwargs):
    async with SessionLocal() as s:
        message, _, _ = await service.send_message(s, user_id, room_id, body, client_id, **kwargs)
        return message.id


async def _rows(model):
    async with SessionLocal() as s:
        return list((await s.execute(select(model))).scalars())


async def _page(client, headers, room, **params):
    r = await client.get(f"/api/rooms/{room}/messages", params=params, headers=headers)
    assert r.status_code == 200, r.text
    return r.json()["items"]


# ---------- 1 ----------

async def test_reply_to_message_in_same_room_shows_quote(live_server):
    a, b = await create_user("alice"), await create_user("bob")
    room = await create_room(member_ids=[a, b])
    first = await _svc_send(a, room, "tin gốc")
    wa, _ = await ws_open(live_server.ws, await _token(live_server, "alice"))
    wb, _ = await ws_open(live_server.ws, await _token(live_server, "bob"))
    await _send(wb, room, "trả lời nè", "r1", reply_to_id=first)
    quote = {"id": first, "sender_id": a, "sender_name": "Alice", "snippet": "tin gốc", "deleted": False}
    for ws in (wa, wb):
        event_ = await recv_type(ws, "message")
        assert event_["message"]["reply_to"] == quote
        assert event_["message"]["mentions"] == []
    async with AsyncClient(base_url=live_server.http) as http:
        items = await _page(http, auth_headers(await _token(live_server, "alice")), room)
    assert [m["reply_to"] for m in items] == [None, quote]
    await wa.close()
    await wb.close()


# ---------- 2 ----------

async def test_reply_to_other_room_or_missing_or_deleted_is_rejected(live_server):
    a, b, c = await create_user("alice"), await create_user("bob"), await create_user("carol")
    room = await create_room(member_ids=[a, b])
    other = await create_room(member_ids=[a, c])
    foreign = await _svc_send(c, other, "bí mật phòng khác")
    gone = await _svc_send(a, room, "sẽ xoá")
    async with SessionLocal() as s:
        await service.delete_message(s, a, gone)
    ws, _ = await ws_open(live_server.ws, await _token(live_server, "alice"))
    for n, bad in enumerate((foreign, 987654, gone, 2**63 - 1)):
        await _send(ws, room, "x", f"c{n}", reply_to_id=bad)
        assert await recv_type(ws, "error") == {"type": "error", "code": "invalid_reply", "client_id": f"c{n}"}
    await ws.close()
    bads = ("1", 0, -1, True, 2**63, 1.5, [1])
    for chunk in (bads[:4], bads[4:]):  # giới hạn tốc độ 5 tin/kết nối trong test
        ws, _ = await ws_open(live_server.ws, await _token(live_server, "alice"))
        for n, bad in enumerate(chunk):
            await _send(ws, room, "x", f"t{n}", reply_to_id=bad)
            assert (await recv_type(ws, "error"))["code"] == "invalid_message", bad
        await ws.close()
    async with SessionLocal() as s:
        count = (await s.execute(select(func.count()).select_from(Message).where(Message.room_id == room))).scalar_one()
    assert count == 1  # chỉ tin đã xoá


# ---------- 3 ----------

async def test_snippet_is_truncated_sanitized_and_never_leaks_deleted_text(client):
    a, b = await create_user("alice"), await create_user("bob")
    room = await create_room(member_ids=[a, b])
    family = "\U0001F468‍\U0001F469‍\U0001F467‍\U0001F466"
    body = ("ab\ncd\t\r\x0b \U0001F600  " + family) * 30
    assert len(body) > 400
    src = await _svc_send(a, room, body)
    await _svc_send(b, room, "trả lời", reply_to_id=src)
    ha = auth_headers(await token_for(client, "alice"))
    quote = (await _page(client, ha, room))[-1]["reply_to"]
    snippet = quote["snippet"]
    assert 0 < len(snippet) <= 120
    assert not any(unicodedata.category(ch) in ("Cc", "Zl", "Zp") for ch in snippet)
    assert "  " not in snippet and not snippet.endswith("‍")
    snippet.encode("utf-8")  # không có surrogate lẻ
    assert snippet.startswith("ab cd \U0001F600 \U0001F468")
    # sửa tin gốc -> trích dẫn mới ở lần tải lại
    assert (await client.patch(f"/api/messages/{src}", json={"body": "nội dung mới"}, headers=ha)).status_code == 200
    assert (await _page(client, ha, room))[-1]["reply_to"]["snippet"] == "nội dung mới"
    # xoá tin gốc -> không lộ chữ
    assert (await client.delete(f"/api/messages/{src}", headers=ha)).status_code == 204
    quote = (await _page(client, ha, room))[-1]["reply_to"]
    assert quote == {"id": src, "sender_id": a, "sender_name": "Alice", "snippet": "", "deleted": True}


async def test_snippet_helper_cuts_on_code_points():
    from app.chat.service import _sanitize_snippet

    assert _sanitize_snippet("\U0001F600" * 200) == "\U0001F600" * 120
    assert _sanitize_snippet("  a \n\n\t b  ") == "a b"
    cut = _sanitize_snippet("x" * 119 + "‍" + "y")  # ZWJ treo sau khi cắt bị bỏ
    assert cut == "x" * 119


# ---------- 4 ----------

async def test_reply_is_idempotent_with_client_id(live_server):
    a, b, c = await create_user("alice"), await create_user("bob"), await create_user("carol")
    room = await create_room(member_ids=[a, b, c])
    one, two = await _svc_send(b, room, "một"), await _svc_send(b, room, "hai")
    ws, _ = await ws_open(live_server.ws, await _token(live_server, "alice"))
    await _send(ws, room, "trả lời @Bob", "dup", reply_to_id=one, mentions=[b])
    first = (await recv_type(ws, "message"))["message"]
    await _send(ws, room, "trả lời @Bob", "dup", reply_to_id=two, mentions=[c])
    again = (await recv_type(ws, "message"))["message"]
    assert again == first
    assert first["reply_to"]["id"] == one and [m["user_id"] for m in first["mentions"]] == [b]
    # gửi lặp với reply_to_id không hợp lệ cũng không phá tính idempotent
    await _send(ws, room, "trả lời @Bob", "dup", reply_to_id=987654)
    assert (await recv_type(ws, "message"))["message"] == first
    mine = [m for m in await _rows(Message) if m.sender_id == a]
    assert len(mine) == 1 and mine[0].reply_to_id == one
    assert [(m.message_id, m.user_id) for m in await _rows(MessageMention)] == [(first["id"], b)]
    await ws.close()


# ---------- 5 ----------

async def test_mentions_keep_only_room_members(live_server):
    a, b, c, d = [await create_user(n) for n in ("alice", "bob", "carol", "dave")]
    room = await create_room(member_ids=[a, b, c])
    ws, _ = await ws_open(live_server.ws, await _token(live_server, "alice"))
    junk = [d, 987654, b, b, c, a, 2**31 - 1]
    await _send(ws, room, "@Alice @Bob @Carol @Dave", "m1", mentions=junk + list(range(1000, 1018)))  # 25 phần tử
    message = (await recv_type(ws, "message"))["message"]
    assert [m["user_id"] for m in message["mentions"]] == sorted([a, b, c])
    assert {m["user_id"]: m["full_name"] for m in message["mentions"]} == {a: "Alice", b: "Bob", c: "Carol"}
    await ws.close()
    bads = ["1", [1, "2"], [True], [0], [-1], [2**31], [1.5], [[1]], {"a": 1}, list(range(1, 202))]
    for start in range(0, len(bads), 4):  # giới hạn tốc độ 5 tin/kết nối trong test
        ws, _ = await ws_open(live_server.ws, await _token(live_server, "alice"))
        for n, bad in enumerate(bads[start : start + 4]):
            await _send(ws, room, "x", f"bad{n}", mentions=bad)
            assert (await recv_type(ws, "error"))["code"] == "invalid_message", bad
        await ws.close()


async def test_mentions_are_capped_at_20_in_order():
    users = [await create_user(f"user{i:02d}") for i in range(25)]
    room = await create_room(member_ids=users)
    body = " ".join(f"@User{i:02d}" for i in range(25))
    mid = await _svc_send(users[0], room, body, mentions=list(reversed(users)))
    async with SessionLocal() as s:
        stored = set((await s.execute(select(MessageMention.user_id).where(MessageMention.message_id == mid))).scalars())
    assert stored == set(list(reversed(users))[:20])


# ---------- 6 ----------

async def test_mentions_reach_only_room_members(live_server):
    a, b, c = await create_user("alice"), await create_user("bob"), await create_user("carol")
    room = await create_room(member_ids=[a, b])
    wa, _ = await ws_open(live_server.ws, await _token(live_server, "alice"))
    wb, _ = await ws_open(live_server.ws, await _token(live_server, "bob"))
    wc, _ = await ws_open(live_server.ws, await _token(live_server, "carol"))
    await _send(wa, room, "@Bob @Carol", "m1", mentions=[b, c])
    for ws in (wa, wb):
        assert [m["user_id"] for m in (await recv_type(ws, "message"))["message"]["mentions"]] == [b]
    await expect_silence(wc)
    for ws in (wa, wb, wc):
        await ws.close()


# ---------- 7 ----------

async def test_edit_keeps_or_replaces_mentions(client, bus):
    a, b, c = await create_user("alice"), await create_user("bob"), await create_user("carol")
    room = await create_room(member_ids=[a, b, c])
    ha = auth_headers(await token_for(client, "alice"))
    src = await _svc_send(b, room, "gốc")
    msg = await _svc_send(a, room, "chào @Bob và @Carol", reply_to_id=src, mentions=[b, c])

    r = await client.patch(f"/api/messages/{msg}", json={"body": "chào @Bob thôi"}, headers=ha)
    assert r.status_code == 200
    assert [m["user_id"] for m in r.json()["mentions"]] == [b]
    assert r.json()["reply_to"]["id"] == src
    scope, target, ev = bus.published[-1]
    assert (scope, target, ev["type"]) == ("room", room, "message_updated")
    assert ev["message"]["mentions"] == r.json()["mentions"] and ev["message"]["reply_to"] == r.json()["reply_to"]

    # khớp nguyên văn: "@bob" (khác hoa thường) không đủ để giữ
    r = await client.patch(f"/api/messages/{msg}", json={"body": "chào @bob"}, headers=ha)
    assert r.json()["mentions"] == []

    r = await client.patch(f"/api/messages/{msg}", json={"body": "chào @Bob @Carol", "mentions": [c, b, b, 987654, a]}, headers=ha)
    assert [m["user_id"] for m in r.json()["mentions"]] == [b, c]  # đã lọc, bỏ trùng/lạ
    assert r.json()["reply_to"]["id"] == src

    r = await client.patch(f"/api/messages/{msg}", json={"body": "ok", "mentions": []}, headers=ha)
    assert r.json()["mentions"] == []
    r = await client.patch(f"/api/messages/{msg}", json={"body": "ok", "mentions": ["x"]}, headers=ha)
    assert r.status_code == 422
    assert await _rows(MessageMention) == []


# ---------- 8 ----------

class _Counter:
    def __init__(self):
        self.n = 0

    def __call__(self, *args, **kwargs):
        self.n += 1


async def _count_statements(coro_fn):
    counter = _Counter()
    event.listen(engine.sync_engine, "before_cursor_execute", counter)
    try:
        await coro_fn()
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", counter)
    return counter.n


async def test_page_loading_uses_constant_queries():
    users = [await create_user(f"user{i}") for i in range(5)]
    room = await create_room(member_ids=users)
    ids = []
    for i in range(60):
        kwargs = {}
        if i % 2 and ids:
            kwargs["reply_to_id"] = ids[-1]
        if i % 3 == 0:
            kwargs["mentions"] = users[1:]
            text = f"tin {i} @User1 @User2 @User3 @User4"
        else:
            text = f"tin {i}"
        ids.append(await _svc_send(users[i % 5], room, text, **kwargs))

    async def load(limit):
        async with SessionLocal() as s:
            page = await service.list_messages(s, room, limit=limit)
            assert len(page.items) == limit
            return page

    small = await _count_statements(lambda: load(10))
    large = await _count_statements(lambda: load(50))
    assert large - small <= 0, (small, large)
    page = await load(50)
    assert sum(m.reply_to is not None for m in page.items) >= 20
    assert sum(len(m.mentions) > 1 for m in page.items) >= 10

    async def load_rooms():
        async with SessionLocal() as s:
            await service.list_rooms(s, users[0])

    rooms_small = await _count_statements(load_rooms)
    for i in range(30):  # thêm phòng không đổi số truy vấn
        await create_room(member_ids=users[:2])
    assert await _count_statements(load_rooms) == rooms_small


async def test_extras_cost_exactly_two_queries_per_page():
    a = await create_user("alice")
    room = await create_room(member_ids=[a])
    first = await _svc_send(a, room, "x")
    await _svc_send(a, room, "y", reply_to_id=first, mentions=[a])
    async with SessionLocal() as s:
        msgs = list((await s.execute(select(Message).where(Message.room_id == room))).scalars())

    async def run():
        async with SessionLocal() as s:
            await service.load_message_extras(s, msgs)

    assert await _count_statements(run) == 2


# ---------- 9 ----------

async def test_unread_mentions_follow_read_marker(client):
    a, b = await create_user("alice"), await create_user("bob")
    room = await create_room(member_ids=[a, b])
    other = await create_room(member_ids=[a, b])
    hb = auth_headers(await token_for(client, "bob"))
    m1 = await _svc_send(a, room, "@Bob 1", mentions=[b])
    m2 = await _svc_send(a, room, "@Bob 2", mentions=[b])
    await _svc_send(b, room, "@Bob tự nhắc", mentions=[b])
    async with SessionLocal() as s:
        await service.delete_message(s, a, m2)
    last = await _svc_send(a, room, "không nhắc")
    await _svc_send(a, other, "@Alice", mentions=[a])  # nhắc người khác, không tính cho Bob

    def by_room(rooms):
        return {r["id"]: r for r in rooms}

    rooms = by_room((await client.get("/api/rooms", headers=hb)).json())
    assert rooms[room]["unread_mentions"] == 2 - 1  # m1 (m2 đã xoá, tin tự nhắc không tính)
    assert rooms[other]["unread_mentions"] == 0
    assert (await client.post(f"/api/rooms/{room}/read", json={"message_id": m1}, headers=hb)).status_code == 204
    assert by_room((await client.get("/api/rooms", headers=hb)).json())[room]["unread_mentions"] == 0
    m4 = await _svc_send(a, room, "@Bob 4", mentions=[b])
    assert by_room((await client.get("/api/rooms", headers=hb)).json())[room]["unread_mentions"] == 1
    await client.post(f"/api/rooms/{room}/read", json={"message_id": m4}, headers=hb)
    assert by_room((await client.get("/api/rooms", headers=hb)).json())[room]["unread_mentions"] == 0
    assert last < m4

    # cùng dạng ở POST /rooms/group và POST /rooms/direct
    g = await client.post("/api/rooms/group", json={"name": "Nhóm", "member_ids": [a]}, headers=hb)
    assert g.status_code == 201 and g.json()["unread_mentions"] == 0
    d = await client.post("/api/rooms/direct", json={"user_id": a}, headers=hb)
    assert d.json()["unread_mentions"] == 0


async def test_unread_mentions_ignore_rooms_the_user_left_or_archived(client):
    a, b = await create_user("alice"), await create_user("bob")
    room = await create_room(member_ids=[a, b])
    await _svc_send(a, room, "@Bob", mentions=[b])
    hb = auth_headers(await token_for(client, "bob"))
    async with SessionLocal() as s:
        await s.execute(update(Room).where(Room.id == room).values(archived_at=func.now()))
        await s.commit()
    assert (await client.get("/api/rooms", headers=hb)).json() == []


# ---------- 10 ----------

async def test_last_message_preview_carries_quote_and_mentions(client):
    a, b = await create_user("alice"), await create_user("bob")
    room = await create_room(member_ids=[a, b])
    src = await _svc_send(b, room, "câu hỏi")
    await _svc_send(a, room, "@Bob đây", reply_to_id=src, mentions=[b])
    ha = auth_headers(await token_for(client, "alice"))
    last = (await client.get("/api/rooms", headers=ha)).json()[0]["last_message"]
    assert last["reply_to"] == {"id": src, "sender_id": b, "sender_name": "Bob", "snippet": "câu hỏi", "deleted": False}
    assert last["mentions"] == [{"user_id": b, "full_name": "Bob"}]


async def test_deleted_message_carries_no_quote_or_mentions(client):
    a, b = await create_user("alice"), await create_user("bob")
    room = await create_room(member_ids=[a, b])
    src = await _svc_send(b, room, "gốc")
    mid = await _svc_send(a, room, "@Bob", reply_to_id=src, mentions=[b])
    ha = auth_headers(await token_for(client, "alice"))
    assert (await client.delete(f"/api/messages/{mid}", headers=ha)).status_code == 204
    item = (await _page(client, ha, room))[-1]
    assert (item["deleted"], item["reply_to"], item["mentions"]) == (True, None, [])


# ---------- 11 ----------

async def test_archived_or_removed_member_cannot_reply_or_mention(live_server):
    a, b, c = await create_user("alice"), await create_user("bob"), await create_user("carol")
    room = await create_room(member_ids=[a, b, c])
    src = await _svc_send(a, room, "bí mật")
    old = await _svc_send(a, room, "@Bob cũ", mentions=[b])
    async with SessionLocal() as s:
        await s.execute(delete(RoomMember).where(RoomMember.room_id == room, RoomMember.user_id == b))
        await s.commit()
    wb, _ = await ws_open(live_server.ws, await _token(live_server, "bob"))
    await _send(wb, room, "lén", "x1", reply_to_id=src)
    assert await recv_type(wb, "error") == {"type": "error", "code": "room_not_found", "client_id": "x1"}
    await _send(wb, room, "lén", "x2", reply_to_id=987654)  # không phân biệt được với id đúng
    assert (await recv_type(wb, "error"))["code"] == "room_not_found"
    wa, _ = await ws_open(live_server.ws, await _token(live_server, "alice"))
    await _send(wa, room, "@Bob @Carol", "n1", mentions=[b, c])
    assert [m["user_id"] for m in (await recv_type(wa, "message"))["message"]["mentions"]] == [c]
    async with AsyncClient(base_url=live_server.http) as http:
        items = await _page(http, auth_headers(await _token(live_server, "alice")), room)
    assert [m["user_id"] for m in next(i for i in items if i["id"] == old)["mentions"]] == [b]  # lịch sử giữ nguyên
    await wa.close()
    await wb.close()


async def test_archived_room_rejects_reply(live_server):
    a = await create_user("alice")
    room = await create_room(member_ids=[a])
    src = await _svc_send(a, room, "x")
    async with SessionLocal() as s:
        await s.execute(update(Room).where(Room.id == room).values(archived_at=func.now()))
        await s.commit()
    ws, _ = await ws_open(live_server.ws, await _token(live_server, "alice"))
    await _send(ws, room, "y", "z", reply_to_id=src)
    assert (await recv_type(ws, "error"))["code"] == "room_not_found"
    await ws.close()


# ---------- khác ----------

async def test_quote_never_resolves_across_rooms_even_if_data_is_inconsistent():
    a, c = await create_user("alice"), await create_user("carol")
    room, other = await create_room(member_ids=[a]), await create_room(member_ids=[c])
    foreign = await add_message(other, c, "riêng tư")
    bad = await add_message(room, a, "tin")
    async with SessionLocal() as s:
        await s.execute(update(Message).where(Message.id == bad).values(reply_to_id=foreign))
        await s.commit()
    async with SessionLocal() as s:
        page = await service.list_messages(s, room)
    assert page.items[0].reply_to is None


async def test_purge_archived_room_with_replies_and_mentions_inside():
    a, b = await create_user("alice"), await create_user("bob")
    room = await create_room(member_ids=[a, b])
    keep = await create_room(member_ids=[a, b])
    prev = None
    for i in range(6):
        prev = await _svc_send(a if i % 2 else b, room, f"chuỗi {i} @Alice @Bob", reply_to_id=prev, mentions=[a, b])
    survivor = await _svc_send(a, keep, "giữ @Bob", mentions=[b])
    async with SessionLocal() as s:
        await s.execute(
            update(Room).where(Room.id == room).values(archived_at=datetime.now(timezone.utc) - timedelta(days=10))
        )
        await s.commit()
    assert await purge_archived_rooms(SessionLocal, 3) == 1
    assert [m.id for m in await _rows(Message)] == [survivor]
    assert [m.message_id for m in await _rows(MessageMention)] == [survivor]


async def test_deleting_a_source_row_nulls_the_reply_pointer():
    a = await create_user("alice")
    room = await create_room(member_ids=[a])
    src = await _svc_send(a, room, "gốc")
    child = await _svc_send(a, room, "con", reply_to_id=src)
    async with SessionLocal() as s:
        await s.execute(delete(Message).where(Message.id == src))
        await s.commit()
    async with SessionLocal() as s:
        assert (await s.get(Message, child)).reply_to_id is None
        page = await service.list_messages(s, room)
    assert page.items[0].reply_to is None


# ---------- 13 ----------

async def test_mention_requires_visible_at_name(client):
    a, b, c = await create_user("alice"), await create_user("bob"), await create_user("carol")
    room = await create_room(member_ids=[a, b, c])
    ha = auth_headers(await token_for(client, "alice"))
    await _svc_send(a, room, "không có tên", mentions=[b, c])
    await _svc_send(a, room, "chào @Bob thôi", mentions=[b, c])
    await _svc_send(a, room, "chào @bob viết thường", mentions=[b])  # phân biệt hoa thường
    items = await _page(client, ha, room)
    assert [[m["user_id"] for m in i["mentions"]] for i in items] == [[], [b], []]


# ---------- 14-18: @all ----------

async def _group(*usernames):
    ids = [await create_user(n) for n in usernames]
    return ids, await create_room(member_ids=ids)


def _unread(rooms, room):
    return next(r["unread_mentions"] for r in rooms if r["id"] == room)


async def test_mention_all_in_group_marks_everyone(client):
    (a, b, c), room = await _group("alice", "bob", "carol")
    hs = {u: auth_headers(await token_for(client, u)) for u in ("alice", "bob", "carol")}
    mid = await _svc_send(a, room, "@all họp 9h", mention_all=True)
    page = await _page(client, hs["alice"], room)
    assert page[0]["mention_all"] is True and page[0]["mentions"] == []
    got = {u: _unread((await client.get("/api/rooms", headers=h)).json(), room) for u, h in hs.items()}
    assert got == {"alice": 0, "bob": 1, "carol": 1}
    assert (await client.post(f"/api/rooms/{room}/read", json={"message_id": mid}, headers=hs["bob"])).status_code == 204
    assert _unread((await client.get("/api/rooms", headers=hs["bob"])).json(), room) == 0
    assert _unread((await client.get("/api/rooms", headers=hs["carol"])).json(), room) == 1
    last = (await client.get("/api/rooms", headers=hs["carol"])).json()[0]["last_message"]
    assert last["mention_all"] is True


async def test_mention_all_rejected_in_direct_or_without_token(client):
    (a, b, c), room = await _group("alice", "bob", "carol")
    direct = await create_room("direct", member_ids=[a, b])
    ha = auth_headers(await token_for(client, "alice"))
    await _svc_send(a, direct, "@all trong 1-1", mention_all=True)
    for body in ("email@all.com", "x@all", "@allen", "@@all", "@all_hands"):
        await _svc_send(a, room, body, mention_all=True)
    await _svc_send(a, room, "@all nhưng không bật cờ")
    await _svc_send(a, room, "xin chào @ALL!", mention_all=True)  # không phân biệt hoa thường, dấu câu sau OK
    assert [m["mention_all"] for m in await _page(client, ha, direct)] == [False]
    assert [m["mention_all"] for m in await _page(client, ha, room)] == [False] * 6 + [True]


async def test_mention_all_flag_must_be_a_bool_on_the_wire(live_server):
    (a, b), room = await _group("alice", "bob")
    ws, _ = await ws_open(live_server.ws, await _token(live_server, "alice"))
    for n, bad in enumerate(("true", 1, "yes", [True])):
        await _send(ws, room, "@all", f"b{n}", mention_all=bad)
        assert (await recv_type(ws, "error"))["code"] == "invalid_message", bad
    await _send(ws, room, "@all ok", "ok", mention_all=True)
    assert (await recv_type(ws, "message"))["message"]["mention_all"] is True
    await ws.close()


async def test_mention_all_with_reply_and_idempotent_resend(live_server):
    (a, b), room = await _group("alice", "bob")
    src = await _svc_send(b, room, "câu hỏi")
    ws, _ = await ws_open(live_server.ws, await _token(live_server, "alice"))
    await _send(ws, room, "@all trả lời", "r", reply_to_id=src, mention_all=True)
    first = (await recv_type(ws, "message"))["message"]
    assert first["mention_all"] is True and first["reply_to"]["id"] == src
    await _send(ws, room, "@all trả lời", "r")  # gửi lặp không cờ: bản đầu thắng
    assert (await recv_type(ws, "message"))["message"] == first
    await ws.close()


async def test_mention_all_rate_limited(live_server, monkeypatch):
    from app.chat import limits
    from app.config import get_settings

    monkeypatch.setenv("MENTION_ALL_PER_WINDOW", "2")
    get_settings.cache_clear()
    try:
        (a, b), room = await _group("alice", "bob")
        wa, _ = await ws_open(live_server.ws, await _token(live_server, "alice"))
        wb, _ = await ws_open(live_server.ws, await _token(live_server, "bob"))
        for n in range(3):
            await _send(wa, room, f"@all {n}", f"a{n}", mention_all=True)
        assert (await recv_type(wa, "message"))["message"]["mention_all"] is True
        assert (await recv_type(wa, "message"))["message"]["mention_all"] is True
        assert await recv_type(wa, "error") == {"type": "error", "code": "rate_limited", "client_id": "a2"}
        async with SessionLocal() as s:
            bodies = list((await s.execute(select(Message.body).where(Message.room_id == room))).scalars())
        assert sorted(bodies) == ["@all 0", "@all 1"]
        # tin thường vẫn gửi được, và người khác không bị ảnh hưởng
        await _send(wa, room, "tin thường", "n1")
        assert (await recv_type(wa, "message"))["message"]["body"] == "tin thường"
        await _send(wb, room, "@all của Bob", "b1", mention_all=True)
        assert (await recv_type(wb, "message"))["message"]["mention_all"] is True

        # Redis lỗi thì cho qua
        async def boom(*args, **kwargs):
            raise ConnectionError("redis down")

        monkeypatch.setattr(limits, "register_attempt", boom)
        await _send(wa, room, "@all khi redis hỏng", "a9", mention_all=True)
        assert (await recv_type(wa, "message"))["message"]["mention_all"] is True
        await wa.close()
        await wb.close()
    finally:
        monkeypatch.undo()
        get_settings.cache_clear()


async def test_edit_cannot_add_mention_all(client, bus):
    (a, b), room = await _group("alice", "bob")
    ha = auth_headers(await token_for(client, "alice"))
    plain = await _svc_send(a, room, "bình thường", mention_all=True)
    flagged = await _svc_send(a, room, "@all họp", mention_all=True)

    r = await client.patch(f"/api/messages/{plain}", json={"body": "giờ có @all"}, headers=ha)
    assert r.status_code == 200 and r.json()["mention_all"] is False
    r = await client.patch(f"/api/messages/{flagged}", json={"body": "đã bỏ"}, headers=ha)
    assert r.json()["mention_all"] is False
    r = await client.patch(f"/api/messages/{flagged}", json={"body": "lại @all"}, headers=ha)
    assert r.json()["mention_all"] is False  # đã mất cờ thì không lấy lại được

    live = await _svc_send(a, room, "@all họp", mention_all=True)
    reply = await _svc_send(a, room, "@all kèm trả lời", reply_to_id=live, mention_all=True)
    r = await client.patch(f"/api/messages/{reply}", json={"body": "@all vẫn giữ"}, headers=ha)
    assert r.json()["mention_all"] is True and r.json()["reply_to"]["id"] == live
    scope, target, ev = bus.published[-1]
    assert (scope, target, ev["type"]) == ("room", room, "message_updated")
    assert ev["message"] == r.json() and ev["message"]["mention_all"] is True


async def test_mention_all_not_counted_for_removed_member(client):
    (a, b, c), room = await _group("alice", "bob", "carol")
    hb, hc = auth_headers(await token_for(client, "bob")), auth_headers(await token_for(client, "carol"))
    await _svc_send(a, room, "@all", mention_all=True)
    async with SessionLocal() as s:
        await s.execute(delete(RoomMember).where(RoomMember.room_id == room, RoomMember.user_id == c))
        await s.commit()
    assert (await client.get("/api/rooms", headers=hc)).json() == []
    assert _unread((await client.get("/api/rooms", headers=hb)).json(), room) == 1


async def test_unread_mentions_with_mention_all_stays_constant_queries():
    users = [await create_user(f"u{i}") for i in range(3)]
    for _ in range(2):
        room = await create_room(member_ids=users)
        await _svc_send(users[1], room, "@all", mention_all=True)

    async def run():
        async with SessionLocal() as s:
            await service.list_rooms(s, users[0])

    base = await _count_statements(run)
    for _ in range(5):
        room = await create_room(member_ids=users)
        await _svc_send(users[1], room, "@all", mention_all=True)
    assert await _count_statements(run) == base


# ---------- snippet hardening / validation ----------

async def test_snippet_drops_bidi_and_zero_width_characters(client):
    a, b = await create_user("alice"), await create_user("bob")
    room = await create_room(member_ids=[a, b])
    ha = auth_headers(await token_for(client, "alice"))
    family = "\U0001F468‍\U0001F469‍\U0001F467"
    tricky = await _svc_send(a, room, "gốc‮đảo⁦x⁩ vô​hình﻿⁠ " + family)
    invisible = await _svc_send(a, room, "​‎‮")
    await _svc_send(b, room, "r1", reply_to_id=tricky)
    await _svc_send(b, room, "r2", reply_to_id=invisible)
    items = await _page(client, ha, room)
    q1, q2 = items[-2]["reply_to"], items[-1]["reply_to"]
    assert q1["snippet"] == "gốcđảox vôhình " + family and q1["deleted"] is False
    assert q2 == {"id": invisible, "sender_id": a, "sender_name": "Alice", "snippet": "", "deleted": False}
    for ch in q1["snippet"]:
        assert unicodedata.category(ch) != "Cf" or ch == "‍"


async def test_snippet_helper_edge_cases():
    from app.chat.service import _sanitize_snippet

    assert _sanitize_snippet("‍‍") == ""
    assert _sanitize_snippet("a" * 119 + "‮" + "b" * 10) == "a" * 119 + "b"  # cắt SAU khi làm sạch
    fam = "\U0001F468‍\U0001F469‍\U0001F467"
    assert _sanitize_snippet(fam * 5) == fam * 5


async def test_patch_mentions_use_strict_integer_validation(client):
    (a, b), room = await _group("alice", "bob")
    ha = auth_headers(await token_for(client, "alice"))
    msg = await _svc_send(a, room, "chào @Bob", mentions=[b])
    for bad in ("1", [True], ["2"], [1.5], [0], [-1], [2**31], list(range(1, 202)), "x", {"a": 1}):
        r = await client.patch(f"/api/messages/{msg}", json={"body": "chào @Bob", "mentions": bad}, headers=ha)
        assert r.status_code == 422, bad
    r = await client.patch(f"/api/messages/{msg}", json={"body": "chào @Bob", "mentions": list(range(1, 201))}, headers=ha)
    assert r.status_code == 200 and [m["user_id"] for m in r.json()["mentions"]] == [b]
