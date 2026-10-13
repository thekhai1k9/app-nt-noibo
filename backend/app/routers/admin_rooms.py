from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.chat import service
from app.chat.bus import MessageBus, publish_user_safely
from app.config import get_settings
from app.db import get_session
from app.deps import require_admin
from app.ids import BranchId, BranchIdQuery, RoomIdPath, UserId, UserIdPath
from app.models import Branch, Message, Room, RoomMember, User
from app.routers.chat import get_bus

router = APIRouter(prefix="/admin/rooms", tags=["admin"], dependencies=[Depends(require_admin)])


class MemberOut(BaseModel):
    user_id: int
    full_name: str
    username: str
    branch_id: int


class AdminRoomOut(BaseModel):
    id: int
    name: str
    branch_id: int | None
    member_count: int
    created_at: datetime
    archived_at: datetime | None = None
    purge_at: datetime | None = None


class AdminRoomDetail(AdminRoomOut):
    members: list[MemberOut]


class RoomCreateIn(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    name: str = Field(min_length=1, max_length=100)
    branch_id: BranchId | None = None
    member_ids: list[UserId] = Field(default_factory=list, max_length=200)


class RoomRenameIn(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    name: str = Field(min_length=1, max_length=100)


class MemberIn(BaseModel):
    user_id: UserId


def _purge_at(room: Room) -> datetime | None:
    if room.archived_at is None:
        return None
    return room.archived_at + timedelta(days=get_settings().room_archive_retention_days)


def _room_out(room: Room, member_count: int) -> AdminRoomOut:
    return AdminRoomOut(
        id=room.id,
        name=room.name or "",
        branch_id=room.branch_id,
        member_count=member_count,
        created_at=room.created_at,
        archived_at=room.archived_at,
        purge_at=_purge_at(room),
    )


async def _group_or_404(
    session: AsyncSession, room_id: int, *, archived: bool | None = False, lock: bool = False
) -> Room:
    """archived: False = chỉ nhóm hoạt động, True = chỉ nhóm đã lưu trữ, None = cả hai.
    lock: khoá hàng phòng (FOR UPDATE) như các thao tác của người dùng, để tuần tự hoá với chúng."""
    room = await (service.lock_room_row(session, room_id) if lock else session.get(Room, room_id))
    if (
        room is None
        or room.type != "group"
        or (archived is False and room.archived_at is not None)
        or (archived is True and room.archived_at is None)
    ):
        raise HTTPException(status_code=404, detail="room_not_found")
    return room


async def _member_ids(session: AsyncSession, room_id: int) -> list[int]:
    rows = await session.execute(select(RoomMember.user_id).where(RoomMember.room_id == room_id))
    return list(rows.scalars())


async def _detail(session: AsyncSession, room: Room) -> AdminRoomDetail:
    rows = await session.execute(
        select(User)
        .join(RoomMember, RoomMember.user_id == User.id)
        .where(RoomMember.room_id == room.id)
        .order_by(User.full_name)
    )
    members = [
        MemberOut(user_id=u.id, full_name=u.full_name, username=u.username, branch_id=u.branch_id)
        for u in rows.scalars()
    ]
    return AdminRoomDetail(
        id=room.id,
        name=room.name or "",
        branch_id=room.branch_id,
        member_count=len(members),
        created_at=room.created_at,
        archived_at=room.archived_at,
        purge_at=_purge_at(room),
        members=members,
    )


async def _notify(bus: MessageBus, user_ids: list[int]) -> None:
    for user_id in user_ids:
        if not await publish_user_safely(bus, user_id, {"type": "rooms_changed"}):
            return  # bus hỏng/treo: không mất thêm N x timeout; các client sẽ đối soát sau


async def _active_user_or_404(session: AsyncSession, user_id: int) -> User:
    user = await session.get(User, user_id)
    if user is None or not user.is_active:
        raise HTTPException(status_code=404, detail="user_not_found")
    return user


@router.get("", response_model=list[AdminRoomOut])
async def list_rooms(
    q: str | None = None,
    branch_id: BranchIdQuery = None,
    archived: bool = False,
    session: AsyncSession = Depends(get_session),
) -> list[AdminRoomOut]:
    counts = select(RoomMember.room_id, func.count().label("n")).group_by(RoomMember.room_id).subquery()
    query = (
        select(Room, func.coalesce(counts.c.n, 0))
        .outerjoin(counts, counts.c.room_id == Room.id)
        .where(Room.type == "group", Room.archived_at.is_not(None) if archived else Room.archived_at.is_(None))
        .order_by(Room.name)
    )
    if branch_id is not None:
        query = query.where(Room.branch_id == branch_id)
    if q and q.strip():
        query = query.where(Room.name.ilike(f"%{service.escape_like(q.strip())}%", escape="\\"))
    rows = (await session.execute(query)).all()
    return [_room_out(r, n) for r, n in rows]


@router.post("", response_model=AdminRoomDetail, status_code=201)
async def create_room(
    body: RoomCreateIn,
    session: AsyncSession = Depends(get_session),
    bus: MessageBus = Depends(get_bus),
    admin: User = Depends(require_admin),
) -> AdminRoomDetail:
    if body.branch_id is not None and await session.get(Branch, body.branch_id) is None:
        raise HTTPException(status_code=404, detail="branch_not_found")
    member_ids = list(dict.fromkeys(body.member_ids))
    for user_id in member_ids:
        await _active_user_or_404(session, user_id)
    room = Room(type="group", name=body.name, branch_id=body.branch_id, created_by=admin.id)
    session.add(room)
    await session.flush()
    session.add_all([RoomMember(room_id=room.id, user_id=user_id) for user_id in member_ids])
    await session.commit()
    await session.refresh(room)  # nạp created_at do server đặt
    await _notify(bus, member_ids)
    return await _detail(session, room)


@router.get("/{room_id}", response_model=AdminRoomDetail)
async def get_room(room_id: RoomIdPath, session: AsyncSession = Depends(get_session)) -> AdminRoomDetail:
    return await _detail(session, await _group_or_404(session, room_id, archived=None))


@router.patch("/{room_id}", response_model=AdminRoomDetail)
async def rename_room(
    room_id: RoomIdPath,
    body: RoomRenameIn,
    session: AsyncSession = Depends(get_session),
    bus: MessageBus = Depends(get_bus),
) -> AdminRoomDetail:
    room = await _group_or_404(session, room_id, lock=True)
    room.name = body.name
    await session.commit()
    await _notify(bus, await _member_ids(session, room.id))
    return await _detail(session, room)


@router.delete("/{room_id}", status_code=204)
async def delete_room(
    room_id: RoomIdPath, session: AsyncSession = Depends(get_session), bus: MessageBus = Depends(get_bus)
) -> None:
    room = await _group_or_404(session, room_id, lock=True)
    member_ids = await _member_ids(session, room.id)
    room.archived_at = func.now()
    await session.commit()
    await _notify(bus, member_ids)


@router.post("/{room_id}/restore", response_model=AdminRoomDetail)
async def restore_room(
    room_id: RoomIdPath, session: AsyncSession = Depends(get_session), bus: MessageBus = Depends(get_bus)
) -> AdminRoomDetail:
    room = await _group_or_404(session, room_id, archived=True, lock=True)
    room.archived_at = None
    await session.commit()
    await _notify(bus, await _member_ids(session, room.id))
    return await _detail(session, room)


@service.retry_on_deadlock
async def _add_member(session: AsyncSession, room_id: int, user_id: int) -> Room:
    room = await _group_or_404(session, room_id, lock=True)
    # FOR SHARE: người dùng không bị xoá giữa lúc kiểm tra và lúc chèn (như create_group)
    target = (await session.execute(select(User).where(User.id == user_id).with_for_update(read=True))).scalar_one_or_none()
    if target is None or not target.is_active:
        raise HTTPException(status_code=404, detail="user_not_found")
    member_ids = await _member_ids(session, room.id)
    if user_id not in member_ids:
        if len(member_ids) >= get_settings().max_group_members:
            raise HTTPException(status_code=409, detail="group_full")
        # Người mới vào không coi lịch sử là chưa đọc: đặt vị trí đã đọc = tin nhắn mới nhất hiện có.
        latest = (await session.execute(select(func.max(Message.id)).where(Message.room_id == room.id))).scalar()
        session.add(RoomMember(room_id=room.id, user_id=user_id, last_read_message_id=latest))
        try:
            await session.commit()
        except IntegrityError:
            await session.rollback()
            if await session.get(RoomMember, (room_id, user_id)) is None:  # không phải trùng dòng: người dùng bị xoá
                raise HTTPException(status_code=404, detail="user_not_found")
            # đã có dòng thành viên (người khác thêm trước): coi như xong
        room = await _group_or_404(session, room_id)  # commit làm hết hạn đối tượng cũ
    else:
        await session.rollback()  # nhả khoá
        room = await _group_or_404(session, room_id)
    return room


@service.retry_on_deadlock
async def _remove_member(session: AsyncSession, room_id: int, user_id: int) -> tuple[Room, list[int]]:
    """Trả (phòng, id cần báo rooms_changed theo thứ tự: người bị gỡ trước)."""
    room = await _group_or_404(session, room_id, lock=True)
    membership = await session.get(RoomMember, (room.id, user_id))
    if membership is None:
        raise HTTPException(status_code=404, detail="member_not_found")
    was_owner = membership.role == "owner"
    await session.delete(membership)
    await session.flush()
    # Nhóm có chủ (do người dùng tạo): chủ bị gỡ thì chuyển quyền, hết người thì lưu trữ như khi chủ tự rời.
    # Nhóm admin tạo (không có chủ) giữ nguyên hành vi cũ.
    heir, remaining = await service.after_member_removed(
        session, room.id, was_owner=was_owner, archive_if_empty=was_owner
    )
    await session.commit()
    notify = [user_id, *remaining] if was_owner else [user_id]  # chủ đổi: vai trò/số thành viên của mọi người đổi
    room = await _group_or_404(session, room_id, archived=None)
    await session.refresh(room)  # archived_at có thể vừa đổi bằng UPDATE
    return room, notify


@router.post("/{room_id}/members", response_model=AdminRoomDetail)
async def add_member(
    room_id: RoomIdPath,
    body: MemberIn,
    session: AsyncSession = Depends(get_session),
    bus: MessageBus = Depends(get_bus),
) -> AdminRoomDetail:
    room = await _add_member(session, room_id, body.user_id)
    await _notify(bus, [body.user_id])
    return await _detail(session, room)


@router.delete("/{room_id}/members/{user_id}", response_model=AdminRoomDetail)
async def remove_member(
    room_id: RoomIdPath,
    user_id: UserIdPath,
    session: AsyncSession = Depends(get_session),
    bus: MessageBus = Depends(get_bus),
) -> AdminRoomDetail:
    room, notify = await _remove_member(session, room_id, user_id)
    await _notify(bus, notify)
    return await _detail(session, room)
