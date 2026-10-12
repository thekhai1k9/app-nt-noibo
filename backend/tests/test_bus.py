import asyncio
import json
from contextlib import aclosing

from redis.exceptions import RedisError

from app.chat.bus import RedisMessageBus, publish_room_safely, publish_user_safely
from app.redis_client import build_listen_redis, get_redis


async def test_redis_bus_delivers_room_and_user_events():
    bus = RedisMessageBus(get_redis(), build_listen_redis())
    received = []

    async def consume():
        async with aclosing(bus.listen()) as events:  # đóng pubsub khi xong
            async for event in events:
                received.append(event)
                if len(received) == 3:
                    return

    task = asyncio.create_task(consume())
    for _ in range(100):
        if received:  # đã nhận sự kiện "subscribed"
            break
        await asyncio.sleep(0.02)
    await bus.publish_room(7, {"type": "message", "n": 1})
    await bus.publish_user(9, {"type": "rooms_changed"})
    await asyncio.wait_for(task, 3)

    assert received[0].scope == "system" and received[0].payload == {"type": "subscribed"}
    assert (received[1].scope, received[1].target_id, received[1].payload) == ("room", 7, {"type": "message", "n": 1})
    assert (received[2].scope, received[2].target_id, received[2].payload) == ("user", 9, {"type": "rooms_changed"})


async def test_redis_bus_publishes_json():
    bus = RedisMessageBus(get_redis())
    pubsub = get_redis().pubsub()
    await pubsub.subscribe("kn:room:5")
    await pubsub.get_message(timeout=1)  # xác nhận subscribe
    await bus.publish_room(5, {"type": "x", "vi": "tiếng Việt"})
    message = None
    for _ in range(50):
        message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=0.1)
        if message:
            break
    await pubsub.aclose()
    assert json.loads(message["data"]) == {"type": "x", "vi": "tiếng Việt"}


class _BrokenBus:
    async def publish_room(self, room_id, event):
        raise RedisError("down")

    async def publish_user(self, user_id, event):
        raise RedisError("down")


async def test_safe_publish_swallows_redis_errors():
    assert await publish_room_safely(_BrokenBus(), 1, {"type": "x"}) is False
    assert await publish_user_safely(_BrokenBus(), 1, {"type": "x"}) is False


async def test_safe_publish_returns_true_on_success():
    from tests.helpers import InMemoryBus

    bus = InMemoryBus()
    assert await publish_room_safely(bus, 1, {"type": "x"}) is True
    assert bus.published == [("room", 1, {"type": "x"})]
