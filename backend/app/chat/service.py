import functools
from datetime import datetime, timedelta, timezone

from sqlalchemy import and_, delete, func, or_, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.chat.schemas import MemberReceipt, MessageOut, MessagePage, RoomOut, to_message_out
from app.config import get_settings
from app.models import Message, Room, RoomMember, User

MAX_PAGE = 100
MAX_CLIENT_ID = 64
GROUP_LOCK_CLASS = 5001  # khoá advisory theo người tạo nhóm


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


async def require_member(session: AsyncSession, room_id: int, user_id: int, *, lock_membership: bool = False) -> Room:
    """Trả phòng nếu user là thành viên; nếu không (kể cả phòng không tồn tại) ném 404 room_not_found.

    lock_membership: khoá dòng thành viên FOR KEY SHARE đến hết giao dịch, nên một lần gỡ/rời (DELETE dòng đó)
    đang diễn ra phải chờ giao dịch này, và nếu gỡ xong trước thì kiểm tra thấy dòng đã mất."""
    query = (
        select(Room)
        .join(RoomMember, RoomMember.room_id == Room.id)
        .where(Room.id == room_id, RoomMember.user_id == user_id, Room.archived_at.is_(None))
    )
    if lock_membership:
        query = query.with_for_update(read=True, key_share=True, of=RoomMember)
    row = await session.execute(query)
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
    await require_member(session, room_id, user_id, lock_membership=True)
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


async def list_rooms(session: AsyncSession, user_id: int, only_room_id: int | None = None) -> list[RoomOut]:
    query = (
        select(Room, RoomMember.role)
        .join(RoomMember, RoomMember.room_id == Room.id)
        .where(RoomMember.user_id == user_id, Room.archived_at.is_(None))
    )
    if only_room_id is not None:
        query = query.where(Room.id == only_room_id)
    rows = (await session.execute(query)).all()
    if not rows:
        return []
    mine = [room for room, _ in rows]
    my_roles = {room.id: role for room, role in rows}
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
                my_role=my_roles[room.id] if room.type == "group" else None,
            )
        )
    result.sort(key=lambda r: (r.last_activity, r.id), reverse=True)
    return result


async def get_room_out(session: AsyncSession, user_id: int, room_id: int) -> RoomOut:
    """RoomOut của một phòng, đúng dạng phần tử của list_rooms."""
    rooms = await list_rooms(session, user_id, only_room_id=room_id)
    if not rooms:
        raise ChatError(404, "room_not_found")
    return rooms[0]


async def create_group(session: AsyncSession, user: User, name: str, member_ids: list[int]) -> tuple[Room, list[int]]:
    """Tạo nhóm + toàn bộ thành viên trong một giao dịch; người tạo là owner.

    Trả (phòng, id những người được mời đã bỏ trùng/bỏ chính mình)."""
    settings = get_settings()
    me_id = user.id
    invited = [uid for uid in dict.fromkeys(member_ids) if uid != me_id]
    if 1 + len(invited) > settings.max_group_members:
        raise ChatError(409, "group_full")
    # Tuần tự hoá các lần tạo nhóm của cùng một người để giới hạn đếm đúng khi gọi song song.
    await session.execute(select(func.pg_advisory_xact_lock(GROUP_LOCK_CLASS, me_id)))
    owned = (
        await session.execute(
            select(func.count())
            .select_from(RoomMember)
            .join(Room, Room.id == RoomMember.room_id)
            .where(
                RoomMember.user_id == me_id,
                RoomMember.role == "owner",
                Room.type == "group",
                Room.archived_at.is_(None),
            )
        )
    ).scalar_one()
    if owned >= settings.max_owned_groups:
        raise ChatError(409, "too_many_groups")
    # Trần theo ngày tính cả nhóm đã lưu trữ: tạo rồi giải tán liên tục không né được giới hạn.
    created_today = (
        await session.execute(
            select(func.count())
            .select_from(Room)
            .where(
                Room.created_by == me_id,
                Room.type == "group",
                Room.created_at > func.now() - timedelta(hours=24),
            )
        )
    ).scalar_one()
    if created_today >= settings.group_create_per_day:
        raise ChatError(429, "rate_limited")
    if invited:
        # FOR SHARE: giữ các hàng người dùng trong giao dịch này nên không bị xoá giữa lúc kiểm tra và lúc chèn.
        active = set(
            (
                await session.execute(
                    select(User.id).where(User.id.in_(invited), User.is_active.is_(True)).with_for_update(read=True)
                )
            ).scalars()
        )
        if len(active) != len(invited):
            raise ChatError(404, "user_not_found")
    room = Room(type="group", name=name, branch_id=None, created_by=me_id)
    session.add(room)
    await session.flush()
    session.add(RoomMember(room_id=room.id, user_id=me_id, role="owner"))
    session.add_all([RoomMember(room_id=room.id, user_id=uid) for uid in invited])
    try:
        await session.commit()
    except IntegrityError:  # người được mời bị xoá cùng lúc: không để lại gì, trả 404 thay vì 500
        await session.rollback()
        raise ChatError(404, "user_not_found")
    return room, invited


def _is_deadlock(exc: DBAPIError) -> bool:
    orig = exc.orig
    for err in (orig, getattr(orig, "__cause__", None)):
        if getattr(err, "sqlstate", None) == "40P01" or type(err).__name__ == "DeadlockDetectedError":
            return True
    return False


def retry_on_deadlock(fn):
    """Chạy lại cả giao dịch đúng một lần nếu Postgres báo deadlock; vẫn lỗi thì 409 conflict (không 500)."""

    @functools.wraps(fn)
    async def wrapper(session: AsyncSession, *args, **kwargs):
        for attempt in (0, 1):
            try:
                return await fn(session, *args, **kwargs)
            except DBAPIError as exc:
                if not _is_deadlock(exc):
                    raise
                await session.rollback()
                if attempt:
                    raise ChatError(409, "conflict")

    return wrapper


async def lock_room_row(session: AsyncSession, room_id: int) -> Room | None:
    """SELECT ... FOR NO KEY UPDATE trên hàng phòng: mọi thay đổi thành viên/chủ phòng (người dùng lẫn admin) qua đây
    nên chạy tuần tự theo phòng. Trả None nếu phòng không tồn tại."""
    return (
        await session.execute(
            select(Room)
            .where(Room.id == room_id)
            .with_for_update(key_share=True)  # FOR NO KEY UPDATE: không chặn INSERT tin nhắn (FOR KEY SHARE)
            .execution_options(populate_existing=True)
        )
    ).scalar_one_or_none()


async def _owned_group(
    session: AsyncSession, room_id: int, user_id: int, *, owner_only: bool = True
) -> tuple[Room, str]:
    """Kiểm tra quyền rồi khoá phòng. Trả (phòng, vai trò của người gọi).

    Bước 1 (không khoá, rẻ): phòng tồn tại + là group + chưa lưu trữ + người gọi là thành viên, nếu không 404
    room_not_found (giống hệt nhau để không lộ phòng tồn tại; người ngoài không bao giờ khoá được phòng nào).
    Bước 2: khoá FOR UPDATE rồi kiểm tra lại dưới khoá (phòng/thành viên có thể đã đổi); cuối cùng mới đến
    vai trò chủ (403 forbidden). Khoá giữ đến hết giao dịch."""
    visible = (
        await session.execute(
            select(Room.id)
            .join(RoomMember, RoomMember.room_id == Room.id)
            .where(
                Room.id == room_id,
                RoomMember.user_id == user_id,
                Room.type == "group",
                Room.archived_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if visible is None:
        raise ChatError(404, "room_not_found")
    room = await lock_room_row(session, room_id)
    if room is None or room.type != "group" or room.archived_at is not None:
        raise ChatError(404, "room_not_found")
    role = (
        await session.execute(
            select(RoomMember.role).where(RoomMember.room_id == room_id, RoomMember.user_id == user_id)
        )
    ).scalar_one_or_none()
    if role is None:
        raise ChatError(404, "room_not_found")
    if owner_only and role != "owner":
        raise ChatError(403, "forbidden")
    return room, role


async def transfer_ownership(session: AsyncSession, room_id: int) -> int | None:
    """Chuyển quyền chủ cho thành viên còn lại vào sớm nhất (hòa: user_id nhỏ nhất); gọi khi chủ vừa rời/bị gỡ,
    dưới khoá phòng. Trả id người thừa kế (None nếu không còn ai)."""
    heir = (
        await session.execute(
            select(RoomMember.user_id)
            .join(User, User.id == RoomMember.user_id)
            .where(RoomMember.room_id == room_id)
            # người đã bị khoá chỉ được chọn khi không còn ai khác
            .order_by(User.is_active.desc(), RoomMember.joined_at, RoomMember.user_id)
            .limit(1)
        )
    ).scalar_one_or_none()
    if heir is not None:
        await session.execute(
            update(RoomMember).where(RoomMember.room_id == room_id, RoomMember.user_id == heir).values(role="owner")
        )
    return heir


async def _member_ids(session: AsyncSession, room_id: int) -> list[int]:
    rows = await session.execute(select(RoomMember.user_id).where(RoomMember.room_id == room_id))
    return list(rows.scalars())


async def after_member_removed(
    session: AsyncSession, room_id: int, *, was_owner: bool, archive_if_empty: bool
) -> tuple[int | None, list[int]]:
    """Việc phải làm ngay sau khi xoá một thành viên (dưới khoá phòng): hết người thì lưu trữ (nếu archive_if_empty),
    chủ vừa đi thì chuyển quyền. Trả (id người thừa kế hoặc None, id các thành viên còn lại)."""
    remaining = await _member_ids(session, room_id)
    if not remaining:
        if archive_if_empty:
            await session.execute(update(Room).where(Room.id == room_id).values(archived_at=func.now()))
        return None, remaining
    heir = await transfer_ownership(session, room_id) if was_owner else None
    return heir, remaining


@retry_on_deadlock
async def rename_group(session: AsyncSession, room_id: int, user_id: int, name: str) -> list[int]:
    """Đổi tên nhóm; trả id các thành viên cần báo rooms_changed."""
    room, _ = await _owned_group(session, room_id, user_id)
    room.name = name
    member_ids = await _member_ids(session, room_id)
    await session.commit()
    return member_ids


@retry_on_deadlock
async def add_group_member(session: AsyncSession, room_id: int, user_id: int, new_user_id: int) -> list[int]:
    """Thêm thành viên (idempotent); trả id những người cần báo (rỗng nếu đã là thành viên)."""
    await _owned_group(session, room_id, user_id)
    target = (
        await session.execute(select(User).where(User.id == new_user_id).with_for_update(read=True))
    ).scalar_one_or_none()
    if target is None or not target.is_active:
        raise ChatError(404, "user_not_found")
    member_ids = await _member_ids(session, room_id)
    if new_user_id in member_ids:
        await session.rollback()  # không đổi gì; nhả khoá
        return []
    if len(member_ids) >= get_settings().max_group_members:
        raise ChatError(409, "group_full")
    # Người mới vào không coi lịch sử là chưa đọc: mốc đã đọc = tin nhắn mới nhất hiện có.
    latest = (await session.execute(select(func.max(Message.id)).where(Message.room_id == room_id))).scalar()
    session.add(RoomMember(room_id=room_id, user_id=new_user_id, last_read_message_id=latest))
    try:
        await session.commit()
    except IntegrityError:  # người dùng bị xoá cùng lúc
        await session.rollback()
        raise ChatError(404, "user_not_found")
    return [*member_ids, new_user_id]


@retry_on_deadlock
async def remove_group_member(session: AsyncSession, room_id: int, user_id: int, target_id: int) -> list[int]:
    """Gỡ thành viên; trả id những người cần báo (kể cả người bị gỡ, vì hub cần tính lại room_ids của họ)."""
    await _owned_group(session, room_id, user_id)
    if target_id == user_id:
        raise ChatError(400, "cannot_remove_self")
    member_ids = await _member_ids(session, room_id)
    if target_id not in member_ids:
        raise ChatError(404, "member_not_found")
    await session.execute(delete(RoomMember).where(RoomMember.room_id == room_id, RoomMember.user_id == target_id))
    await session.commit()
    return [target_id, *(uid for uid in member_ids if uid != target_id)]  # người bị gỡ được báo đầu tiên


@retry_on_deadlock
async def leave_group(session: AsyncSession, room_id: int, user_id: int) -> list[int]:
    """Rời nhóm. Chủ rời thì chuyển quyền cho người vào sớm nhất (hòa: user_id nhỏ nhất); không còn ai thì lưu trữ.

    Trả id những người còn lại (rỗng nếu nhóm bị lưu trữ)."""
    _, my_role = await _owned_group(session, room_id, user_id, owner_only=False)
    await session.execute(delete(RoomMember).where(RoomMember.room_id == room_id, RoomMember.user_id == user_id))
    _, remaining = await after_member_removed(session, room_id, was_owner=my_role == "owner", archive_if_empty=True)
    await session.commit()
    return remaining


@retry_on_deadlock
async def dissolve_group(session: AsyncSession, room_id: int, user_id: int) -> list[int]:
    """Giải tán = lưu trữ (như admin xoá); trả id mọi thành viên để báo."""
    room, _ = await _owned_group(session, room_id, user_id)
    member_ids = await _member_ids(session, room_id)
    room.archived_at = func.now()
    await session.commit()
    return member_ids


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
        select(RoomMember.user_id, User.full_name, RoomMember.last_read_message_id, RoomMember.role)
        .join(User, User.id == RoomMember.user_id)
        .where(RoomMember.room_id == room_id)
        .order_by(User.full_name, User.id)
    )
    return [
        MemberReceipt(user_id=uid, full_name=name, last_read_message_id=last, role=role)
        for uid, name, last, role in rows
    ]


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
