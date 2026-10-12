from redis.asyncio import Redis


async def is_blocked(redis: Redis, key: str, max_attempts: int) -> bool:
    value = await redis.get(key)
    return value is not None and int(value) >= max_attempts


async def register_failure(redis: Redis, key: str, window_seconds: int) -> None:
    count = await redis.incr(key)
    if count == 1:
        await redis.expire(key, window_seconds)


async def clear(redis: Redis, key: str) -> None:
    await redis.delete(key)
