from datetime import datetime, timezone

from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.chat.schemas import MemberReceipt, MessageOut, MessagePage, RoomOut, to_message_out
from app.config import get_settings
from app.models import Message, Room, RoomMember, User

MAX_PAGE = 100
MAX_CLIENT_ID = 64


class ChatError(Exception):
    def __init__(self, status: int, code: str):
        super().__init__(code)
        self.status = status
        self.code = code


def escape_like(text: str) -> str:
    return text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _direct_key(a: int, b: int) -> str:
    return f"{min(a, b)}:{max(a, b)}"


async def user_room_ids(session: AsyncSession, user_id: int) -> set[int]:
    rows = await session.execute(
        select(RoomMember.room_id)
        .join(Room, Room.id == RoomMember.room_id)
        .where(RoomMember.user_id == user_id, Room.archived_at.is_(None))
    )
    return set(rows.scalars())


async def require_member(session: AsyncSession, room_id: int, user_id: int) -> Room:
    """Trả phòng nếu user là thành viên; nếu không (kể cả phòng không tồn tại) ném 404 room_not_found."""
    row = await session.execute(
        select(Room)
        .join(RoomMember, RoomMember.room_id == Room.id)
        .where(Room.id == room_id, RoomMember.user_id == user_id, Room.archived_at.is_(None))
    )
    room = row.scalar_one_or_none()
    if room is None:
        raise ChatError(404, "room_not_found")
    return room


async def get_or_create_direct(session: AsyncSession, me: User, other_id: int) -> tuple[Room, bool]:
    if other_id == me.id:
        raise ChatError(400, "cannot_chat_with_self")
    other = await session.get(User, other_id)
    if other is None or not other.is_active:
        raise ChatError(404, "user_not_found")
    key = _direct_key(me.id, other_id)
    existing = (await session.execute(select(Room).where(Room.direct_key == key))).scalar_one_or_none()
    if existing is not None:
        return existing, False
    me_id = me.id
    room = Room(type="direct", direct_key=key, created_by=me_id)
    try:
        # SAVEPOINT: nếu thua cuộc đua, chỉ việc chèn phòng bị huỷ; `me` vẫn dùng được.
        async with session.begin_nested():
            session.add(room)
            await session.flush()
    except IntegrityError:
        # Người kia vừa tạo cùng lúc: ràng buộc unique đảm bảo chỉ một phòng.
        existing = (await session.execute(select(Room).where(Room.direct_key == key))).scalar_one_or_none()
        if existing is None:
            raise
        return existing, False
    session.add_all([RoomMember(room_id=room.id, user_id=me_id), RoomMember(room_id=room.id, user_id=other_id)])
    await session.commit()
    return room, True


def _clean_body(body: str) -> str:
    if "\x00" in body:
        raise ChatError(400, "invalid_message")
    body = body.strip()
    if not body:
        raise ChatError(400, "empty_message")
    if len(body) > get_settings().max_message_length:
        raise ChatError(400, "message_too_long")
    return body


async def send_message(
    session: AsyncSession, user_id: int, room_id: int, body: str, client_id: str | None
) -> tuple[Message, str, bool]:
    body = _clean_body(body)
    if client_id is not None:
        if "\x00" in client_id:
            raise ChatError(400, "invalid_message")
        if client_id == "" or len(client_id) > MAX_CLIENT_ID:
            raise ChatError(400, "invalid_client_id")
    user = await session.get(User, user_id)
    if user is None or not user.is_active:
        raise ChatError(401, "not_authenticated")
    await require_member(session, room_id, user_id)
    stmt = (
        pg_insert(Message)
        .values(room_id=room_id, sender_id=user_id, body=body, client_id=client_id)
        .on_conflict_do_nothing(constraint="uq_messages_room_sender_client")
        .returning(Message)
    )
    message = (await session.execute(stmt)).scalar_one_or_none()
    created = message is not None
    if message is None:
        message = (
            await session.execute(
                select(Message).where(
                    Message.room_id == room_id, Message.sender_id == user_id, Message.client_id == client_id
                )
            )
        ).scalar_one()
    await session.commit()
    return message, user.full_name, created


async def list_messages(
    session: AsyncSession,
    room_id: int,
    *,
    before: int | None = None,
    after: int | None = None,
    around: int | None = None,
    limit: int = 50,
) -> MessagePage:
    if sum(cursor is not None for cursor in (before, after, around)) > 1:
        raise ChatError(400, "invalid_cursor")
    limit = max(1, min(limit, MAX_PAGE))
    base = (
        select(Message, User.full_name)
        .join(User, User.id == Message.sender_id)
        .where(Message.room_id == room_id)
    )

    def out(rows) -> list[MessageOut]:
        return [to_message_out(msg, name) for msg, name in rows]

    if after is not None:
        rows = (await session.execute(base.where(Message.id > after).order_by(Message.id).limit(limit + 1))).all()
        return MessagePage(items=out(rows[:limit]), has_more_before=False, has_more_after=len(rows) > limit)

    if around is not None:
        target = (await session.execute(base.where(Message.id == around))).first()
        if target is None:
            raise ChatError(404, "message_not_found")
        before_count = (limit - 1) // 2
        after_count = limit - 1 - before_count
        older = (
            await session.execute(base.where(Message.id < around).order_by(Message.id.desc()).limit(before_count + 1))
        ).all()
        newer = (
            await session.execute(base.where(Message.id > around).order_by(Message.id).limit(after_count + 1))
        ).all()
        rows = list(reversed(older[:before_count])) + [target] + newer[:after_count]
        return MessagePage(
            items=out(rows), has_more_before=len(older) > before_count, has_more_after=len(newer) > after_count
        )

    query = base if before is None else base.where(Message.id < before)
    rows = (await session.execute(query.order_by(Message.id.desc()).limit(limit + 1))).all()
    return MessagePage(items=out(list(reversed(rows[:limit]))), has_more_before=len(rows) > limit, has_more_after=False)


async def list_rooms(session: AsyncSession, user_id: int) -> list[RoomOut]:
    mine = (
        await session.execute(
            select(Room)
            .join(RoomMember, RoomMember.room_id == Room.id)
            .where(RoomMember.user_id == user_id, Room.archived_at.is_(None))
        )
    ).scalars().all()
    if not mine:
        return []
    room_ids = [room.id for room in mine]

    counts = dict(
        (
            await session.execute(
                select(RoomMember.room_id, func.count()).where(RoomMember.room_id.in_(room_ids)).group_by(RoomMember.room_id)
            )
        ).all()
    )
    direct_ids = [room.id for room in mine if room.type == "direct"]
    peers: dict[int, tuple[int, str]] = {}
    if direct_ids:
        rows = await session.execute(
            select(RoomMember.room_id, User.id, User.full_name)
            .join(User, User.id == RoomMember.user_id)
            .where(RoomMember.room_id.in_(direct_ids), RoomMember.user_id != user_id)
        )
        peers = {room_id: (peer_id, name) for room_id, peer_id, name in rows}

    newest = (
        select(Message.room_id, func.max(Message.id).label("mid"))
        .where(Message.room_id.in_(room_ids))
        .group_by(Message.room_id)
        .subquery()
    )
    last_rows = await session.execute(
        select(Message, User.full_name)
        .join(newest, Message.id == newest.c.mid)
        .join(User, User.id == Message.sender_id)
    )
    last = {msg.room_id: to_message_out(msg, name) for msg, name in last_rows}

    unread_rows = await session.execute(
        select(RoomMember.room_id, func.count(Message.id))
        .select_from(RoomMember)
        .join(Room, Room.id == RoomMember.room_id)
        .join(
            Message,
            and_(
                Message.room_id == RoomMember.room_id,
                Message.id > func.coalesce(RoomMember.last_read_message_id, 0),
                Message.sender_id != user_id,
                Message.deleted_at.is_(None),
            ),
            isouter=True,
        )
        .where(RoomMember.user_id == user_id, Room.archived_at.is_(None))
        .group_by(RoomMember.room_id)
    )
    unread = dict(unread_rows.all())

    result = []
    for room in mine:
        last_message = last.get(room.id)
        peer = peers.get(room.id)
        result.append(
            RoomOut(
                id=room.id,
                type=room.type,
                name=peer[1] if peer else room.name,
                branch_id=room.branch_id,
                member_count=counts.get(room.id, 0),
                peer_id=peer[0] if peer else None,
                last_message=last_message,
                unread_count=unread.get(room.id, 0),
                last_activity=last_message.created_at if last_message else room.created_at,
            )
        )
    result.sort(key=lambda r: (r.last_activity, r.id), reverse=True)
    return result


async def mark_read(session: AsyncSession, room_id: int, user_id: int, message_id: int) -> int | None:
    """Đặt mốc đã đọc; trả mốc mới chỉ khi mốc thực sự tăng, ngược lại None."""
    await require_member(session, room_id, user_id)
    message = await session.get(Message, message_id)
    if message is None or message.room_id != room_id:
        raise ChatError(404, "message_not_found")
    # Một câu UPDATE có điều kiện: khoá hàng + so sánh nguyên tử nên hai request song song
    # không thể cùng tuyên bố "tăng" và mốc không bao giờ giảm.
    advanced = (
        await session.execute(
            update(RoomMember)
            .where(
                RoomMember.room_id == room_id,
                RoomMember.user_id == user_id,
                or_(RoomMember.last_read_message_id.is_(None), RoomMember.last_read_message_id < message_id),
            )
            .values(last_read_message_id=message_id)
            .returning(RoomMember.last_read_message_id)
        )
    ).scalar_one_or_none()
    await session.commit()
    return advanced


async def list_members(session: AsyncSession, room_id: int, user_id: int) -> list[MemberReceipt]:
    await require_member(session, room_id, user_id)
    rows = await session.execute(
        select(RoomMember.user_id, User.full_name, RoomMember.last_read_message_id)
        .join(User, User.id == RoomMember.user_id)
        .where(RoomMember.room_id == room_id)
        .order_by(User.full_name, User.id)
    )
    return [MemberReceipt(user_id=uid, full_name=name, last_read_message_id=last) for uid, name, last in rows]


async def _own_message(session: AsyncSession, user_id: int, message_id: int) -> Message:
    message = await session.get(Message, message_id)
    if message is None:
        raise ChatError(404, "message_not_found")
    await require_member(session, message.room_id, user_id)
    if message.deleted_at is not None:
        raise ChatError(404, "message_not_found")
    if message.sender_id != user_id:
        raise ChatError(403, "forbidden")
    return message


async def edit_message(session: AsyncSession, user_id: int, message_id: int, body: str) -> tuple[Message, str]:
    message = await _own_message(session, user_id, message_id)
    message.body = _clean_body(body)
    message.edited_at = datetime.now(timezone.utc)
    sender = await session.get(User, user_id)
    await session.commit()
    return message, sender.full_name


async def delete_message(session: AsyncSession, user_id: int, message_id: int) -> Message:
    message = await _own_message(session, user_id, message_id)
    message.deleted_at = datetime.now(timezone.utc)
    await session.commit()
    return message
