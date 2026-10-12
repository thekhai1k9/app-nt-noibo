"""room archive: rooms.archived_at

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-15
"""
import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("rooms", sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True))
    op.create_index(
        "ix_rooms_archived_at", "rooms", ["archived_at"], postgresql_where=sa.text("archived_at IS NOT NULL")
    )


def downgrade() -> None:
    op.drop_index("ix_rooms_archived_at", table_name="rooms")
    op.drop_column("rooms", "archived_at")
