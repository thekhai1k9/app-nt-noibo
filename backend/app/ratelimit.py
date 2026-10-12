from redis.asyncio import Redis


async def register_attempt(redis: Redis, key: str, window_seconds: int) -> int:
    """Đếm một lượt thử (đặt chỗ trước khi kiểm tra) và trả về số lượt trong cửa sổ hiện tại."""
    async with redis.pipeline(transaction=True) as pipe:
        pipe.incr(key)
        pipe.expire(key, window_seconds, nx=True)
        count, _ = await pipe.execute()
    return int(count)


async def clear(redis: Redis, key: str) -> None:
    await redis.delete(key)
