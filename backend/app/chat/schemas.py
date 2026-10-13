from datetime import datetime

from pydantic import BaseModel

from app.models import Message


class ReplyOut(BaseModel):
    id: int
    sender_id: int
    sender_name: str
    snippet: str  # "" khi tin gốc đã bị xoá
    deleted: bool


class MentionOut(BaseModel):
    user_id: int
    full_name: str


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
    reply_to: ReplyOut | None
    mentions: list[MentionOut]
    mention_all: bool


class RoomOut(BaseModel):
    id: int
    type: str
    name: str | None
    branch_id: int | None
    member_count: int
    peer_id: int | None
    last_message: MessageOut | None
    unread_count: int
    unread_mentions: int
    last_activity: datetime
    my_role: str | None = None  # 'owner' | 'member' cho nhóm, None cho phòng direct


class MemberReceipt(BaseModel):
    user_id: int
    full_name: str
    last_read_message_id: int | None
    role: str


class MessagePage(BaseModel):
    items: list[MessageOut]
    has_more_before: bool
    has_more_after: bool


def to_message_out(
    msg: Message,
    sender_name: str,
    replies: dict[int, ReplyOut],
    mentions: dict[int, list[MentionOut]],
) -> MessageOut:
    """replies/mentions là kết quả của service.load_message_extras (khoá theo id tin nhắn)."""
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
        reply_to=None if deleted else replies.get(msg.id),
        mentions=[] if deleted else list(mentions.get(msg.id, [])),
        mention_all=False if deleted else bool(msg.mention_all),
    )
