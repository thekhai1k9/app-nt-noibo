import logging

from fastapi import Depends

from app.chat.service import ChatError
from app.config import get_settings
from app.deps import get_ready_user
from app.models import User
from app.ratelimit import register_attempt
from app.redis_client import get_redis

log = logging.getLogger(__name__)
WINDOW_SECONDS = 60


async def _enforce(redis, kind: str, user_id: int, limit: int) -> None:
    """Giới hạn theo người dùng và loại thao tác trong 60 giây; vượt thì 429 rate_limited.
    Redis lỗi thì cho qua (fail open) và ghi log: thao tác nhóm không được hỏng vì bộ đếm."""
    key = f"{get_settings().bus_channel_prefix}:group-rl:{kind}:{user_id}"
    try:
        count = await register_attempt(redis, key, WINDOW_SECONDS)
    except Exception:
        log.warning("group rate limiter unavailable; allowing request", exc_info=True)
        return
    if count > limit:
        raise ChatError(429, "rate_limited")


async def enforce_mention_all(user_id: int) -> None:
    """Giới hạn tin @all theo người gửi (mọi phòng cộng lại); vượt thì 429 rate_limited, Redis lỗi thì cho qua."""
    settings = get_settings()
    key = f"{settings.bus_channel_prefix}:mention-all-rl:{user_id}"
    try:
        count = await register_attempt(get_redis(), key, settings.mention_all_window_seconds)
    except Exception:
        log.warning("mention_all rate limiter unavailable; allowing message", exc_info=True)
        return
    if count > settings.mention_all_per_window:
        raise ChatError(429, "rate_limited")


async def group_create_limit(user: User = Depends(get_ready_user), redis=Depends(get_redis)) -> None:
    await _enforce(redis, "create", user.id, get_settings().group_create_per_minute)


async def group_write_limit(user: User = Depends(get_ready_user), redis=Depends(get_redis)) -> None:
    await _enforce(redis, "write", user.id, get_settings().group_write_per_minute)
