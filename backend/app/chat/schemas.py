from datetime import datetime

from pydantic import BaseModel

from app.models import Message


class MessageOut(BaseModel):
    id: int
    room_id: int
    sender_id: int
    sender_name: str
    body: str
    kind: str
    client_id: str | None
    created_at: datetime
    edited_at: datetime | None
    deleted: bool


class RoomOut(BaseModel):
    id: int
    type: str
    name: str | None
    branch_id: int | None
    member_count: int
    peer_id: int | None
    last_message: MessageOut | None
    unread_count: int
    last_activity: datetime


class MessagePage(BaseModel):
    items: list[MessageOut]
    has_more_before: bool
    has_more_after: bool


def to_message_out(msg: Message, sender_name: str) -> MessageOut:
    deleted = msg.deleted_at is not None
    return MessageOut(
        id=msg.id,
        room_id=msg.room_id,
        sender_id=msg.sender_id,
        sender_name=sender_name,
        body="" if deleted else msg.body,
        kind=msg.kind,
        client_id=msg.client_id,
        created_at=msg.created_at,
        edited_at=msg.edited_at,
        deleted=deleted,
    )
