import time
from collections.abc import Callable, Iterable

from redis.asyncio import Redis


class Presence:
    """Hiện diện online trong một ZSET Redis: phần tử `user_id:conn_id`, điểm = thời điểm hết hạn."""

    def __init__(self, redis: Redis, prefix: str, ttl: float, clock: Callable[[], float] = time.time):
        self._redis = redis
        self._key = f"{prefix}:online"
        self._ttl = ttl
        self._clock = clock

    @staticmethod
    def _member(user_id: int, conn_id: str) -> str:
        return f"{user_id}:{conn_id}"

    @staticmethod
    def _user_ids(members: Iterable[str]) -> set[int]:
        return {int(m.split(":", 1)[0]) for m in members}

    async def touch(self, user_id: int, conn_id: str) -> bool:
        """Gia hạn kết nối; trả True nếu trước đó user đã online (còn kết nối nào chưa hết hạn)."""
        now = self._clock()
        async with self._redis.pipeline(transaction=True) as pipe:
            pipe.zremrangebyscore(self._key, "-inf", now)
            pipe.zrange(self._key, 0, -1)
            pipe.zadd(self._key, {self._member(user_id, conn_id): now + self._ttl})
            _, members, _ = await pipe.execute()
        return user_id in self._user_ids(members)

    async def touch_many(self, pairs: Iterable[tuple[int, str]]) -> None:
        pairs = list(pairs)
        if not pairs:
            return
        now = self._clock()
        async with self._redis.pipeline(transaction=True) as pipe:
            pipe.zadd(self._key, {self._member(u, c): now + self._ttl for u, c in pairs})
            await pipe.execute()

    async def remove(self, user_id: int, conn_id: str) -> None:
        await self._redis.zrem(self._key, self._member(user_id, conn_id))

    async def online_user_ids(self) -> set[int]:
        """Xoá phần tử hết hạn (giữ ZSET bị chặn kích thước) rồi gộp các kết nối theo user."""
        now = self._clock()
        async with self._redis.pipeline(transaction=True) as pipe:
            pipe.zremrangebyscore(self._key, "-inf", now)
            pipe.zrange(self._key, 0, -1)
            _, members = await pipe.execute()
        return self._user_ids(members)
