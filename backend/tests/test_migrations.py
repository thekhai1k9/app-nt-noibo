import asyncio
from pathlib import Path

import pytest_asyncio
from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import create_async_engine

from app.config import get_settings
from app.db import Base

SCRATCH_DB = "messaging_migrate_test"
BACKEND_DIR = Path(__file__).resolve().parents[1]


@pytest_asyncio.fixture
async def scratch_alembic(monkeypatch):
    """Tạo một database tạm, trỏ alembic vào đó và trả (Config, URL của database tạm)."""
    base_url = make_url(get_settings().database_url)
    assert base_url.database.endswith("_test"), "refusing to touch a non-test database"
    admin = create_async_engine(base_url.set(database="postgres"), isolation_level="AUTOCOMMIT")
    async with admin.connect() as conn:
        await conn.execute(text(f'DROP DATABASE IF EXISTS "{SCRATCH_DB}" WITH (FORCE)'))
        await conn.execute(text(f'CREATE DATABASE "{SCRATCH_DB}"'))
    await admin.dispose()

    scratch_url = base_url.set(database=SCRATCH_DB)
    monkeypatch.setenv("DATABASE_URL", scratch_url.render_as_string(hide_password=False))
    get_settings.cache_clear()
    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_DIR / "alembic"))
    try:
        yield cfg, scratch_url
    finally:
        monkeypatch.undo()
        get_settings.cache_clear()
        cleanup = create_async_engine(base_url.set(database="postgres"), isolation_level="AUTOCOMMIT")
        async with cleanup.connect() as conn:
            await conn.execute(text(f'DROP DATABASE IF EXISTS "{SCRATCH_DB}" WITH (FORCE)'))
        await cleanup.dispose()


async def _diff_against_models(scratch_url):
    engine = create_async_engine(scratch_url)
    try:
        async with engine.connect() as conn:
            return await conn.run_sync(
                lambda sync_conn: compare_metadata(MigrationContext.configure(sync_conn), Base.metadata)
            )
    finally:
        await engine.dispose()


async def test_migrations_match_models(scratch_alembic):
    cfg, scratch_url = scratch_alembic
    # env.py gọi asyncio.run(), nên phải chạy trong luồng riêng (không có event loop đang chạy).
    await asyncio.to_thread(command.upgrade, cfg, "head")
    diffs = await _diff_against_models(scratch_url)
    assert diffs == [], f"models và migration lệch nhau: {diffs}"
    # alembic không so sánh được chỉ mục biểu thức, nên kiểm tra trực tiếp trên schema đã migrate.
    engine = create_async_engine(scratch_url)
    try:
        async with engine.connect() as conn:
            indexdef = (
                await conn.execute(text("SELECT indexdef FROM pg_indexes WHERE indexname = 'ix_messages_room_id_id'"))
            ).scalar_one()
            rooms_idx = (
                await conn.execute(text("SELECT indexdef FROM pg_indexes WHERE indexname = 'ix_rooms_archived_at'"))
            ).scalar_one()
            uq = (
                await conn.execute(text("SELECT conname FROM pg_constraint WHERE conname = 'uq_messages_room_sender_client'"))
            ).scalar_one()
    finally:
        await engine.dispose()
    assert "room_id" in indexdef and "id DESC" in indexdef, indexdef
    assert uq == "uq_messages_room_sender_client"
    assert "archived_at" in rooms_idx and "WHERE (archived_at IS NOT NULL)" in rooms_idx, rooms_idx


async def test_migrations_roundtrip(scratch_alembic):
    cfg, scratch_url = scratch_alembic
    await asyncio.to_thread(command.upgrade, cfg, "head")
    await asyncio.to_thread(command.downgrade, cfg, "base")
    engine = create_async_engine(scratch_url)
    try:
        async with engine.connect() as conn:
            tables = (
                await conn.execute(
                    text("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'alembic_version'")
                )
            ).scalars().all()
    finally:
        await engine.dispose()
    assert tables == []
    await asyncio.to_thread(command.upgrade, cfg, "head")
