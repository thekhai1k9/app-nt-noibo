import time

import pytest
from sqlalchemy import text

from app.chat import service
from app.chat.service import ChatError
from app.db import SessionLocal
from app.models import Message, User
from tests.conftest import add_message, create_direct, create_room, create_user


async def _two_users_room():
    a, b = await create_user("alice"), await create_user("bob")
    return a, b, await create_room(member_ids=[a, b])


# ---------- phòng direct ----------

async def test_direct_room_is_created_once_and_found_again():
    a, b = await create_user("alice"), await create_user("bob")
    async with SessionLocal() as s:
        alice = await s.get(User, a)
        room, created = await service.get_or_create_direct(s, alice, b)
        again, created_again = await service.get_or_create_direct(s, alice, b)
        reverse, _ = await service.get_or_create_direct(s, await s.get(User, b), a)
    assert created is True and created_again is False
    assert room.id == again.id == reverse.id


async def test_direct_room_rejects_self_and_unknown_or_inactive_users():
    a = await create_user("alice")
    ghost = await create_user("ghost", active=False)
    async with SessionLocal() as s:
        alice = await s.get(User, a)
        for other, code in ((a, "cannot_chat_with_self"), (9999, "user_not_found"), (ghost, "user_not_found")):
            with pytest.raises(ChatError) as err:
                await service.get_or_create_direct(s, alice, other)
            assert err.value.code == code


async def test_non_member_gets_room_not_found():
    a, b, room = await _two_users_room()
    outsider = await create_user("carol")
    async with SessionLocal() as s:
        with pytest.raises(ChatError) as err:
            await service.require_member(s, room, outsider)
        assert (err.value.status, err.value.code) == (404, "room_not_found")
        with pytest.raises(ChatError):
            await service.require_member(s, 9999, a)  # phòng không tồn tại trả cùng một lỗi


# ---------- gửi tin ----------

async def test_send_message_is_idempotent_per_sender_and_client_id():
    a, b, room = await _two_users_room()
    async with SessionLocal() as s:
        first, name, created = await service.send_message(s, a, room, "xin chào", "cid-1")
        second, _, created_again = await service.send_message(s, a, room, "xin chào", "cid-1")
        theirs, _, theirs_created = await service.send_message(s, b, room, "chào bạn", "cid-1")
    assert created is True and created_again is False
    assert first.id == second.id
    assert name == "Alice"
    assert theirs_created is True and theirs.id != first.id  # cùng client_id nhưng khác người gửi


@pytest.mark.parametrize(
    ("body", "code"),
    [("", "empty_message"), ("   \n\t ", "empty_message"), ("x" * 4001, "message_too_long")],
)
async def test_send_message_validates_the_body(body, code):
    a, _, room = await _two_users_room()
    async with SessionLocal() as s:
        with pytest.raises(ChatError) as err:
            await service.send_message(s, a, room, body, None)
    assert (err.value.status, err.value.code) == (400, code)


async def test_send_message_trims_edges_and_keeps_inner_text():
    a, _, room = await _two_users_room()
    async with SessionLocal() as s:
        msg, _, _ = await service.send_message(s, a, room, "  dòng 1\ndòng 2  ", None)
    assert msg.body == "dòng 1\ndòng 2"


async def test_send_message_rejects_non_members_and_inactive_senders():
    a, _, room = await _two_users_room()
    outsider = await create_user("carol")
    async with SessionLocal() as s:
        with pytest.raises(ChatError) as err:
            await service.send_message(s, outsider, room, "hi", None)
        assert err.value.code == "room_not_found"
        (await s.get(User, a)).is_active = False
        await s.commit()
        with pytest.raises(ChatError) as err:
            await service.send_message(s, a, room, "hi", None)
        assert (err.value.status, err.value.code) == (401, "not_authenticated")


async def test_client_id_longer_than_64_chars_is_rejected():
    a, _, room = await _two_users_room()
    async with SessionLocal() as s:
        with pytest.raises(ChatError) as err:
            await service.send_message(s, a, room, "hi", "c" * 65)
    assert err.value.code == "invalid_client_id"


# ---------- phân trang ----------

async def _ids(page):
    return [m.id for m in page.items]


async def test_pagination_default_before_and_after():
    a, _, room = await _two_users_room()
    ids = [await add_message(room, a, f"m{i}") for i in range(10)]
    async with SessionLocal() as s:
        newest = await service.list_messages(s, room, limit=4)
        older = await service.list_messages(s, room, before=newest.items[0].id, limit=4)
        oldest = await service.list_messages(s, room, before=older.items[0].id, limit=4)
        after = await service.list_messages(s, room, after=ids[6], limit=2)
        after_rest = await service.list_messages(s, room, after=after.items[-1].id, limit=5)
    assert await _ids(newest) == ids[6:10] and newest.has_more_before is True
    assert await _ids(older) == ids[2:6] and older.has_more_before is True
    assert await _ids(oldest) == ids[0:2] and oldest.has_more_before is False
    assert await _ids(after) == ids[7:9] and after.has_more_after is True
    assert await _ids(after_rest) == ids[9:10] and after_rest.has_more_after is False


async def test_pagination_edges():
    a, _, room = await _two_users_room()
    async with SessionLocal() as s:
        empty = await service.list_messages(s, room)
    assert empty.items == [] and empty.has_more_before is False
    ids = [await add_message(room, a) for _ in range(3)]
    async with SessionLocal() as s:
        before_oldest = await service.list_messages(s, room, before=ids[0])
        clamped = await service.list_messages(s, room, limit=10_000)
        zero = await service.list_messages(s, room, limit=0)
    assert before_oldest.items == [] and before_oldest.has_more_before is False
    assert len(clamped.items) == 3
    assert len(zero.items) == 1  # limit tối thiểu là 1


async def test_pagination_around_and_invalid_cursors():
    a, _, room = await _two_users_room()
    other_room = await create_room(member_ids=[a])
    ids = [await add_message(room, a) for _ in range(9)]
    foreign = await add_message(other_room, a)
    async with SessionLocal() as s:
        page = await service.list_messages(s, room, around=ids[4], limit=4)
        assert await _ids(page) == ids[2:7]  # 2 tin trước, tin đích, 2 tin sau
        assert page.has_more_before is True and page.has_more_after is True
        with pytest.raises(ChatError) as err:
            await service.list_messages(s, room, around=foreign)
        assert (err.value.status, err.value.code) == (404, "message_not_found")
        with pytest.raises(ChatError) as err:
            await service.list_messages(s, room, around=9_999_999)
        assert err.value.code == "message_not_found"
        with pytest.raises(ChatError) as err:
            await service.list_messages(s, room, before=ids[3], after=ids[1])
        assert (err.value.status, err.value.code) == (400, "invalid_cursor")


async def test_pages_are_ascending_and_include_sender_names_in_one_pass():
    a, b, room = await _two_users_room()
    await add_message(room, a, "một")
    await add_message(room, b, "hai")
    async with SessionLocal() as s:
        page = await service.list_messages(s, room)
    assert [(m.sender_name, m.body) for m in page.items] == [("Alice", "một"), ("Bob", "hai")]


async def test_a_20000_message_room_pages_quickly_through_the_index():
    a, _, room = await _two_users_room()
    async with SessionLocal() as s:
        await s.execute(
            text(
                "INSERT INTO messages (room_id, sender_id, body) "
                "SELECT CAST(:room AS integer), CAST(:sender AS integer), 'tin ' || g "
                "FROM generate_series(1, 20000) AS g"
            ),
            {"room": room, "sender": a},
        )
        await s.execute(text("ANALYZE messages"))
        await s.commit()
    async with SessionLocal() as s:
        started = time.perf_counter()
        newest = await service.list_messages(s, room)
        older = await service.list_messages(s, room, before=newest.items[0].id)
        elapsed = time.perf_counter() - started
    assert len(newest.items) == 50 and len(older.items) == 50
    assert older.items[-1].id == newest.items[0].id - 1
    assert elapsed < 1.0, f"hai trang mất {elapsed:.2f}s"


# ---------- tin đã xoá, sửa, xoá ----------

async def test_deleted_messages_stay_in_the_list_without_their_text():
    a, _, room = await _two_users_room()
    msg_id = await add_message(room, a, "bí mật")
    async with SessionLocal() as s:
        await service.delete_message(s, a, msg_id)
        page = await service.list_messages(s, room)
    assert page.items[0].deleted is True and page.items[0].body == ""


async def test_only_the_sender_can_edit_or_delete():
    a, b, room = await _two_users_room()
    msg_id = await add_message(room, a, "gốc")
    async with SessionLocal() as s:
        for action in (service.edit_message(s, b, msg_id, "sửa"), service.delete_message(s, b, msg_id)):
            with pytest.raises(ChatError) as err:
                await action
            assert (err.value.status, err.value.code) == (403, "forbidden")
        msg, _ = await service.edit_message(s, a, msg_id, "  đã sửa  ")
        assert msg.body == "đã sửa" and msg.edited_at is not None
        with pytest.raises(ChatError) as err:
            await service.edit_message(s, a, msg_id, "   ")
        assert err.value.code == "empty_message"
        await service.delete_message(s, a, msg_id)
        with pytest.raises(ChatError) as err:
            await service.edit_message(s, a, msg_id, "sau khi xoá")
        assert err.value.code == "message_not_found"


async def test_edit_and_delete_are_hidden_from_non_members():
    a, _, room = await _two_users_room()
    outsider = await create_user("carol")
    msg_id = await add_message(room, a)
    async with SessionLocal() as s:
        with pytest.raises(ChatError) as err:
            await service.edit_message(s, outsider, msg_id, "x")
        assert err.value.code == "room_not_found"
        with pytest.raises(ChatError) as err:
            await service.delete_message(s, outsider, msg_id)
        assert err.value.code == "room_not_found"


# ---------- danh sách phòng, chưa đọc ----------

async def test_room_list_has_peer_names_last_message_and_unread_counts():
    a, b = await create_user("alice"), await create_user("bob")
    direct = await create_direct(a, b)
    group = await create_room(name="Dự án", member_ids=[a, b, await create_user("carol")])
    await add_message(direct, b, "tin 1")
    await add_message(direct, b, "tin 2")
    last = await add_message(direct, a, "của mình")
    await add_message(group, b, "trong nhóm")
    async with SessionLocal() as s:
        rooms = {r.id: r for r in await service.list_rooms(s, a)}
    assert rooms[direct].name == "Bob" and rooms[direct].peer_id == b and rooms[direct].type == "direct"
    assert rooms[direct].unread_count == 2  # tin của chính mình không tính
    assert rooms[direct].last_message.id == last
    assert rooms[group].name == "Dự án" and rooms[group].member_count == 3 and rooms[group].unread_count == 1


async def test_room_list_is_sorted_by_latest_activity_and_empty_for_new_users():
    a, b = await create_user("alice"), await create_user("bob")
    quiet = await create_room(name="Yên", member_ids=[a])
    busy = await create_room(name="Sôi nổi", member_ids=[a, b])
    await add_message(busy, b)
    async with SessionLocal() as s:
        assert [r.id for r in await service.list_rooms(s, a)] == [busy, quiet]
        assert await service.list_rooms(s, await create_user("newbie")) == []


async def test_mark_read_only_moves_forward_and_clears_unread():
    a, b, room = await _two_users_room()
    ids = [await add_message(room, b) for _ in range(3)]
    async with SessionLocal() as s:
        await service.mark_read(s, room, a, ids[1])
        assert (await service.list_rooms(s, a))[0].unread_count == 1
        await service.mark_read(s, room, a, ids[0])  # lùi lại: bị bỏ qua
        assert (await service.list_rooms(s, a))[0].unread_count == 1
        await service.mark_read(s, room, a, ids[2])
        assert (await service.list_rooms(s, a))[0].unread_count == 0


async def test_mark_read_rejects_non_members_and_foreign_messages():
    a, b, room = await _two_users_room()
    other_room = await create_room(member_ids=[a])
    foreign = await add_message(other_room, a)
    outsider = await create_user("carol")
    async with SessionLocal() as s:
        with pytest.raises(ChatError) as err:
            await service.mark_read(s, room, outsider, 1)
        assert err.value.code == "room_not_found"
        with pytest.raises(ChatError) as err:
            await service.mark_read(s, room, a, foreign)
        assert err.value.code == "message_not_found"


def test_escape_like_escapes_wildcards():
    assert service.escape_like("a_b%c\\d") == "a\\_b\\%c\\\\d"
