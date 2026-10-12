from app.ratelimit import clear, register_attempt
from app.redis_client import get_redis


async def test_attempt_counter_increments():
    redis = get_redis()
    assert await register_attempt(redis, "k1", 60) == 1
    assert await register_attempt(redis, "k1", 60) == 2
    assert await register_attempt(redis, "k1", 60) == 3


async def test_clear_resets_counter():
    redis = get_redis()
    for _ in range(3):
        await register_attempt(redis, "k3", 60)
    await clear(redis, "k3")
    assert await register_attempt(redis, "k3", 60) == 1


async def test_attempt_counter_expires():
    redis = get_redis()
    await register_attempt(redis, "k4", 60)
    ttl = await redis.ttl("k4")
    assert 0 < ttl <= 60


async def test_register_attempt_restores_missing_ttl():
    redis = get_redis()
    await redis.set("k5", 2)
    assert await redis.ttl("k5") == -1
    assert await register_attempt(redis, "k5", 60) == 3
    ttl = await redis.ttl("k5")
    assert 0 < ttl <= 60


async def test_second_attempt_does_not_extend_window():
    redis = get_redis()
    await register_attempt(redis, "k6", 60)
    await redis.expire("k6", 30)
    await register_attempt(redis, "k6", 60)
    assert 0 < await redis.ttl("k6") <= 30
