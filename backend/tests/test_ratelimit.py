from app.ratelimit import clear, is_blocked, register_failure
from app.redis_client import get_redis


async def test_not_blocked_initially():
    assert await is_blocked(get_redis(), "k1", 3) is False


async def test_blocked_after_max_failures():
    redis = get_redis()
    for _ in range(2):
        await register_failure(redis, "k2", 60)
    assert await is_blocked(redis, "k2", 3) is False
    await register_failure(redis, "k2", 60)
    assert await is_blocked(redis, "k2", 3) is True


async def test_clear_resets_counter():
    redis = get_redis()
    for _ in range(3):
        await register_failure(redis, "k3", 60)
    await clear(redis, "k3")
    assert await is_blocked(redis, "k3", 3) is False


async def test_failure_counter_expires():
    redis = get_redis()
    await register_failure(redis, "k4", 60)
    ttl = await redis.ttl("k4")
    assert 0 < ttl <= 60
