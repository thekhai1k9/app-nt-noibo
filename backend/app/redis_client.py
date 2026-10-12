from functools import lru_cache

from redis.asyncio import Redis

from app.config import get_settings


@lru_cache
def get_redis() -> Redis:
    return Redis.from_url(
        get_settings().redis_url,
        decode_responses=True,
        socket_timeout=3,
        socket_connect_timeout=3,
    )


def build_listen_redis() -> Redis:
    """Kết nối riêng cho pub/sub: không đặt socket_timeout vì phải chờ tin vô thời hạn."""
    return Redis.from_url(
        get_settings().redis_url,
        decode_responses=True,
        socket_connect_timeout=3,
        health_check_interval=30,
        socket_keepalive=True,  # phát hiện kết nối nửa mở (TCP half-open) khi không có socket_timeout
    )
