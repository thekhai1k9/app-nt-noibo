import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError

from app.db import SessionLocal
from app.models import Message, Room, RoomMember
from tests.conftest import add_message, create_direct, create_room, create_user


async def test_direct_key_is_unique():
    a, b = await create_user("alice"), await create_user("bob")
    await create_direct(a, b)
    with pytest.raises(IntegrityError):
        await create_direct(a, b)


async def test_client_id_unique_per_room_and_sender_but_not_across_senders():
    a, b = await create_user("alice"), await create_user("bob")
    room = await create_room(member_ids=[a, b])
    await add_message(room, a, client_id="c1")
    await add_message(room, b, client_id="c1")  # người khác dùng cùng client_id: được phép
    with pytest.raises(IntegrityError):
        await add_message(room, a, client_id="c1")


async def test_null_client_ids_do_not_collide():
    a = await create_user("alice")
    room = await create_room(member_ids=[a])
    await add_message(room, a)
    await add_message(room, a)


async def test_deleting_a_room_cascades_to_members_and_messages():
    a = await create_user("alice")
    room = await create_room(member_ids=[a])
    await add_message(room, a)
    async with SessionLocal() as s:
        await s.delete(await s.get(Room, room))
        await s.commit()
        assert (await s.execute(select(RoomMember))).first() is None
        assert (await s.execute(select(Message))).first() is None


async def test_message_ids_are_bigint_and_increasing():
    a = await create_user("alice")
    room = await create_room(member_ids=[a])
    first, second = await add_message(room, a), await add_message(room, a)
    assert second > first


async def test_pagination_index_exists():
    async with SessionLocal() as s:
        row = (
            await s.execute(text("SELECT indexdef FROM pg_indexes WHERE indexname = 'ix_messages_room_id_id'"))
        ).scalar_one()
    assert "room_id" in row and "id DESC" in row
