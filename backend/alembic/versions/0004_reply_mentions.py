"""reply and mentions: messages.reply_to_id, message_mentions

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-18
"""
import sqlalchemy as sa
from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "messages",
        sa.Column("reply_to_id", sa.BigInteger(), sa.ForeignKey("messages.id", ondelete="SET NULL"), nullable=True),
    )
    op.add_column("messages", sa.Column("mention_all", sa.Boolean(), nullable=False, server_default=sa.false()))
    op.create_index(
        "ix_messages_reply_to_id", "messages", ["reply_to_id"], postgresql_where=sa.text("reply_to_id IS NOT NULL")
    )
    op.create_table(
        "message_mentions",
        sa.Column("message_id", sa.BigInteger(), sa.ForeignKey("messages.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.PrimaryKeyConstraint("message_id", "user_id"),
    )
    op.create_index("ix_message_mentions_user_message", "message_mentions", ["user_id", sa.text("message_id DESC")])


def downgrade() -> None:
    op.drop_index("ix_message_mentions_user_message", table_name="message_mentions")
    op.drop_table("message_mentions")
    op.drop_index("ix_messages_reply_to_id", table_name="messages")
    op.drop_column("messages", "mention_all")
    op.drop_column("messages", "reply_to_id")
