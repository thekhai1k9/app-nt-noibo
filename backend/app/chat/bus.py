import json
import logging
from collections.abc import AsyncIterator
from typing import NamedTuple, Protocol

from redis.asyncio import Redis
from redis.exceptions import RedisError

from app.config import get_settings

log = logging.getLogger(__name__)


class BusEvent(NamedTuple):
    scope: str  # "room" | "user" | "system"
    target_id: int
    payload: dict


class MessageBus(Protocol):
    async def publish_room(self, room_id: int, event: dict) -> None: ...

    async def publish_user(self, user_id: int, event: dict) -> None: ...

    def listen(self) -> AsyncIterator[BusEvent]: ...


class RedisMessageBus:
    """MessageBus dùng Redis pub/sub. `listen_redis` phải là kết nối riêng không có socket_timeout."""

    def __init__(self, redis: Redis, listen_redis: Redis | None = None, prefix: str | None = None):
        self._redis = redis
        self._listen_redis = listen_redis
        prefix = get_settings().bus_channel_prefix if prefix is None else prefix
        self._room_prefix = f"{prefix}:room:"
        self._user_prefix = f"{prefix}:user:"

    async def publish_room(self, room_id: int, event: dict) -> None:
        await self._redis.publish(f"{self._room_prefix}{room_id}", json.dumps(event, ensure_ascii=False))

    async def publish_user(self, user_id: int, event: dict) -> None:
        await self._redis.publish(f"{self._user_prefix}{user_id}", json.dumps(event, ensure_ascii=False))

    async def listen(self) -> AsyncIterator[BusEvent]:
        if self._listen_redis is None:
            raise RuntimeError("listen() needs a dedicated listen_redis connection without socket_timeout")
        pubsub = self._listen_redis.pubsub()
        try:
            await pubsub.psubscribe(f"{self._room_prefix}*", f"{self._user_prefix}*")
            subscribed = False
            async for item in pubsub.listen():
                kind = item["type"]
                if kind == "psubscribe":
                    if not subscribed:
                        subscribed = True
                        yield BusEvent("system", 0, {"type": "subscribed"})
                    continue
                if kind != "pmessage":
                    continue
                channel: str = item["channel"]
                if channel.startswith(self._room_prefix):
                    scope, raw_id = "room", channel[len(self._room_prefix) :]
                else:
                    scope, raw_id = "user", channel[len(self._user_prefix) :]
                try:
                    event = BusEvent(scope, int(raw_id), json.loads(item["data"]))
                except (ValueError, TypeError):
                    log.warning("dropping malformed bus message on %s", channel)
                    continue
                yield event
        finally:
            await pubsub.aclose()


async def publish_room_safely(bus: MessageBus, room_id: int, event: dict) -> bool:
    """Phát sự kiện phòng; lỗi Redis chỉ ghi log (tin nhắn đã nằm trong DB nên không mất)."""
    try:
        await bus.publish_room(room_id, event)
        return True
    except (RedisError, TypeError, ValueError):
        log.warning("could not publish room event", exc_info=True)
        return False


async def publish_user_safely(bus: MessageBus, user_id: int, event: dict) -> bool:
    try:
        await bus.publish_user(user_id, event)
        return True
    except (RedisError, TypeError, ValueError):
        log.warning("could not publish user event", exc_info=True)
        return False
