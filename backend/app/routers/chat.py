from fastapi import APIRouter, Depends, Query, Response
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.chat import service
from app.chat.presence import Presence
from app.chat.bus import MessageBus, RedisMessageBus, publish_room_safely, publish_user_safely
from app.chat.schemas import MemberReceipt, MessageOut, MessagePage, RoomOut, to_message_out
from app.db import get_session
from app.deps import get_ready_user
from app.ids import MessageId, MessageIdPath, MessageIdQuery, RoomIdPath, UserId
from app.config import get_settings
from app.models import Branch, Room, RoomMember, User
from app.redis_client import get_redis

router = APIRouter(tags=["chat"])


def get_bus() -> MessageBus:
    return RedisMessageBus(get_redis())


def get_presence() -> Presence:
    settings = get_settings()
    return Presence(get_redis(), settings.bus_channel_prefix, settings.presence_ttl_seconds)


class PresenceOut(BaseModel):
    online_user_ids: list[int]


class DirectoryUser(BaseModel):
    id: int
    username: str
    full_name: str
    branch_id: int
    branch_name: str


class DirectRoomIn(BaseModel):
    user_id: UserId


class ReadIn(BaseModel):
    message_id: MessageId


class MessageEditIn(BaseModel):
    body: str = Field(max_length=10_000)


@router.get("/users/directory", response_model=list[DirectoryUser])
async def directory(
    q: str | None = None,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_ready_user),
) -> list[DirectoryUser]:
    query = (
        select(User, Branch.name)
        .join(Branch, Branch.id == User.branch_id)
        .where(User.is_active.is_(True), User.id != user.id)
        .order_by(User.full_name)
        .limit(50)
    )
    if q and q.strip():
        like = f"%{service.escape_like(q.strip())}%"
        query = query.where(
            or_(User.full_name.ilike(like, escape="\\"), User.username.ilike(like, escape="\\"))
        )
    rows = (await session.execute(query)).all()
    return [
        DirectoryUser(
            id=u.id, username=u.username, full_name=u.full_name, branch_id=u.branch_id, branch_name=branch_name
        )
        for u, branch_name in rows
    ]


@router.get("/presence", response_model=PresenceOut)
async def get_presence_snapshot(
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_ready_user),
    presence: Presence = Depends(get_presence),
) -> PresenceOut:
    mine = (
        select(RoomMember.room_id)
        .join(Room, Room.id == RoomMember.room_id)
        .where(RoomMember.user_id == user.id, Room.archived_at.is_(None))
    )
    rows = await session.execute(
        select(RoomMember.user_id).where(RoomMember.room_id.in_(mine), RoomMember.user_id != user.id).distinct()
    )
    peers = set(rows.scalars())
    online = await presence.online_user_ids() if peers else set()
    return PresenceOut(online_user_ids=sorted(online & peers))


@router.get("/rooms", response_model=list[RoomOut])
async def list_rooms(
    session: AsyncSession = Depends(get_session), user: User = Depends(get_ready_user)
) -> list[RoomOut]:
    return await service.list_rooms(session, user.id)


@router.post("/rooms/direct", response_model=RoomOut)
async def open_direct_room(
    body: DirectRoomIn,
    response: Response,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_ready_user),
    bus: MessageBus = Depends(get_bus),
) -> RoomOut:
    room, created = await service.get_or_create_direct(session, user, body.user_id)
    if created:
        response.status_code = 201
        for member_id in (user.id, body.user_id):
            await publish_user_safely(bus, member_id, {"type": "rooms_changed"})
    rooms = await service.list_rooms(session, user.id)
    return next(r for r in rooms if r.id == room.id)


@router.get("/rooms/{room_id}/messages", response_model=MessagePage)
async def get_messages(
    room_id: RoomIdPath,
    before: MessageIdQuery = None,
    after: MessageIdQuery = None,
    around: MessageIdQuery = None,
    limit: int = Query(50, ge=1, le=100),
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_ready_user),
) -> MessagePage:
    await service.require_member(session, room_id, user.id)
    return await service.list_messages(session, room_id, before=before, after=after, around=around, limit=limit)


@router.post("/rooms/{room_id}/read", status_code=204)
async def mark_read(
    room_id: RoomIdPath,
    body: ReadIn,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_ready_user),
    bus: MessageBus = Depends(get_bus),
) -> None:
    advanced = await service.mark_read(session, room_id, user.id, body.message_id)
    if advanced is not None:
        await publish_room_safely(
            bus, room_id, {"type": "read", "room_id": room_id, "user_id": user.id, "message_id": advanced}
        )


@router.get("/rooms/{room_id}/members", response_model=list[MemberReceipt])
async def room_members(
    room_id: RoomIdPath,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_ready_user),
) -> list[MemberReceipt]:
    return await service.list_members(session, room_id, user.id)


@router.patch("/messages/{message_id}", response_model=MessageOut)
async def edit_message(
    message_id: MessageIdPath,
    body: MessageEditIn,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_ready_user),
    bus: MessageBus = Depends(get_bus),
) -> MessageOut:
    message, sender_name = await service.edit_message(session, user.id, message_id, body.body)
    out = to_message_out(message, sender_name)
    await publish_room_safely(bus, message.room_id, {"type": "message_updated", "message": out.model_dump(mode="json")})
    return out


@router.delete("/messages/{message_id}", status_code=204)
async def delete_message(
    message_id: MessageIdPath,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_ready_user),
    bus: MessageBus = Depends(get_bus),
) -> None:
    message = await service.delete_message(session, user.id, message_id)
    await publish_room_safely(
        bus, message.room_id, {"type": "message_deleted", "room_id": message.room_id, "message_id": message.id}
    )
