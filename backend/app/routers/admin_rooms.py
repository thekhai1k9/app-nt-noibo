from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.chat import service
from app.chat.bus import MessageBus, publish_user_safely
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


async def _group_or_404(session: AsyncSession, room_id: int) -> Room:
    room = await session.get(Room, room_id)
    if room is None or room.type != "group":
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
        members=members,
    )


async def _notify(bus: MessageBus, user_ids: list[int]) -> None:
    for user_id in user_ids:
        await publish_user_safely(bus, user_id, {"type": "rooms_changed"})


async def _active_user_or_404(session: AsyncSession, user_id: int) -> User:
    user = await session.get(User, user_id)
    if user is None or not user.is_active:
        raise HTTPException(status_code=404, detail="user_not_found")
    return user


@router.get("", response_model=list[AdminRoomOut])
async def list_rooms(
    q: str | None = None, branch_id: BranchIdQuery = None, session: AsyncSession = Depends(get_session)
) -> list[AdminRoomOut]:
    counts = select(RoomMember.room_id, func.count().label("n")).group_by(RoomMember.room_id).subquery()
    query = (
        select(Room, func.coalesce(counts.c.n, 0))
        .outerjoin(counts, counts.c.room_id == Room.id)
        .where(Room.type == "group")
        .order_by(Room.name)
    )
    if branch_id is not None:
        query = query.where(Room.branch_id == branch_id)
    if q and q.strip():
        query = query.where(Room.name.ilike(f"%{service.escape_like(q.strip())}%", escape="\\"))
    rows = (await session.execute(query)).all()
    return [
        AdminRoomOut(id=r.id, name=r.name or "", branch_id=r.branch_id, member_count=n, created_at=r.created_at)
        for r, n in rows
    ]


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
    return await _detail(session, await _group_or_404(session, room_id))


@router.patch("/{room_id}", response_model=AdminRoomDetail)
async def rename_room(
    room_id: RoomIdPath, body: RoomRenameIn, session: AsyncSession = Depends(get_session)
) -> AdminRoomDetail:
    room = await _group_or_404(session, room_id)
    room.name = body.name
    await session.commit()
    return await _detail(session, room)


@router.delete("/{room_id}", status_code=204)
async def delete_room(
    room_id: RoomIdPath, session: AsyncSession = Depends(get_session), bus: MessageBus = Depends(get_bus)
) -> None:
    room = await _group_or_404(session, room_id)
    member_ids = await _member_ids(session, room.id)
    await session.delete(room)
    await session.commit()
    await _notify(bus, member_ids)


@router.post("/{room_id}/members", response_model=AdminRoomDetail)
async def add_member(
    room_id: RoomIdPath,
    body: MemberIn,
    session: AsyncSession = Depends(get_session),
    bus: MessageBus = Depends(get_bus),
) -> AdminRoomDetail:
    room = await _group_or_404(session, room_id)
    await _active_user_or_404(session, body.user_id)
    if body.user_id not in await _member_ids(session, room.id):
        # Người mới vào không coi lịch sử là chưa đọc: đặt vị trí đã đọc = tin nhắn mới nhất hiện có.
        latest = (await session.execute(select(func.max(Message.id)).where(Message.room_id == room.id))).scalar()
        session.add(RoomMember(room_id=room.id, user_id=body.user_id, last_read_message_id=latest))
        await session.commit()
    await _notify(bus, [body.user_id])
    return await _detail(session, room)


@router.delete("/{room_id}/members/{user_id}", response_model=AdminRoomDetail)
async def remove_member(
    room_id: RoomIdPath,
    user_id: UserIdPath,
    session: AsyncSession = Depends(get_session),
    bus: MessageBus = Depends(get_bus),
) -> AdminRoomDetail:
    room = await _group_or_404(session, room_id)
    membership = await session.get(RoomMember, (room.id, user_id))
    if membership is None:
        raise HTTPException(status_code=404, detail="member_not_found")
    await session.delete(membership)
    await session.commit()
    await _notify(bus, [user_id])
    return await _detail(session, room)
