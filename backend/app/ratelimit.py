from redis.asyncio import Redis


async def is_blocked(redis: Redis, key: str, max_attempts: int) -> bool:
    value = await redis.get(key)
    return value is not None and int(value) >= max_attempts


async def register_failure(redis: Redis, key: str, window_seconds: int) -> None:
    async with redis.pipeline(transaction=True) as pipe:
        pipe.incr(key)
        pipe.expire(key, window_seconds, nx=True)
        await pipe.execute()


async def clear(redis: Redis, key: str) -> None:
    await redis.delete(key)
