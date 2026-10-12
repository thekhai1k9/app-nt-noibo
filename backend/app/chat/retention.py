import asyncio
import logging
from collections.abc import Callable
from contextlib import AbstractAsyncContextManager
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Room

log = logging.getLogger(__name__)


async def purge_archived_rooms(
    session_factory: Callable[[], AbstractAsyncContextManager[AsyncSession]],
    retention_days: int,
    now: datetime | None = None,
) -> int:
    """Xoá cứng các nhóm đã lưu trữ quá hạn (tin nhắn, thành viên mất theo ON DELETE CASCADE). Trả số nhóm đã xoá."""
    now = now or datetime.now(timezone.utc)
    cutoff = now - timedelta(days=retention_days)
    async with session_factory() as session:
        result = await session.execute(
            delete(Room).where(Room.type == "group", Room.archived_at.is_not(None), Room.archived_at <= cutoff)
        )
        await session.commit()
    count = result.rowcount or 0
    if count:
        log.info("purged %d archived rooms", count)
    return count


async def run_purger(
    session_factory: Callable[[], AbstractAsyncContextManager[AsyncSession]], retention_days: int, interval: float
) -> None:
    """Chạy ngay khi khởi động rồi mỗi `interval` giây; lỗi một lượt chỉ ghi log."""
    while True:
        try:
            await purge_archived_rooms(session_factory, retention_days)
        except Exception:  # CancelledError là BaseException nên vẫn lan ra ngoài
            log.exception("failed to purge archived rooms")
        await asyncio.sleep(interval)
