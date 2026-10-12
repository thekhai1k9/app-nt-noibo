"""chat: rooms, room_members, messages

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-14
"""
import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "rooms",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("type", sa.String(16), nullable=False),
        sa.Column("name", sa.String(100), nullable=True),
        sa.Column("branch_id", sa.Integer, sa.ForeignKey("branches.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_by", sa.Integer, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("direct_key", sa.String(32), nullable=True, unique=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_table(
        "room_members",
        sa.Column("room_id", sa.Integer, sa.ForeignKey("rooms.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("user_id", sa.Integer, sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("role", sa.String(16), nullable=False, server_default="member"),
        sa.Column("last_read_message_id", sa.BigInteger, nullable=True),
        sa.Column("joined_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_room_members_user_id", "room_members", ["user_id"])
    op.create_table(
        "messages",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("room_id", sa.Integer, sa.ForeignKey("rooms.id", ondelete="CASCADE"), nullable=False),
        sa.Column("sender_id", sa.Integer, sa.ForeignKey("users.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("body", sa.Text, nullable=False),
        sa.Column("kind", sa.String(16), nullable=False, server_default="text"),
        sa.Column("client_id", sa.String(64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("edited_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("room_id", "sender_id", "client_id", name="uq_messages_room_sender_client"),
    )
    op.create_index("ix_messages_room_id_id", "messages", ["room_id", sa.text("id DESC")])


def downgrade() -> None:
    op.drop_table("messages")
    op.drop_table("room_members")
    op.drop_table("rooms")
