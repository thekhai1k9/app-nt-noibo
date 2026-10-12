import asyncio
from contextlib import suppress

from app.chat.bus import BusEvent
from app.chat.hub import Connection, Hub
from app.db import SessionLocal
from app.models import RoomMember
from tests.conftest import create_room, create_user
from tests.helpers import InMemoryBus


def drain(conn: Connection) -> list:
    items = []
    while not conn.queue.empty():
        items.append(conn.queue.get_nowait())
    return items


async def test_room_events_reach_only_connections_in_that_room():
    hub = Hub(InMemoryBus(), SessionLocal)
    in_room, other = Connection(1, [10]), Connection(2, [11])
    hub.register(in_room)
    hub.register(other)
    await hub._dispatch(BusEvent("room", 10, {"type": "message", "n": 1}))
    assert drain(in_room) == [{"type": "message", "n": 1}]
    assert drain(other) == []


async def test_rooms_changed_reloads_membership_from_the_database():
    alice = await create_user("alice")
    room = await create_room(member_ids=[alice])
    hub = Hub(InMemoryBus(), SessionLocal)
    conn = Connection(alice, [])
    hub.register(conn)

    await hub._dispatch(BusEvent("user", alice, {"type": "rooms_changed"}))
    assert conn.room_ids == {room}
    assert drain(conn) == [{"type": "rooms_changed"}]

    async with SessionLocal() as s:
        await s.delete(await s.get(RoomMember, (room, alice)))
        await s.commit()
    await hub._dispatch(BusEvent("user", alice, {"type": "rooms_changed"}))
    assert conn.room_ids == set()
    await hub._dispatch(BusEvent("room", room, {"type": "message"}))
    assert [e for e in drain(conn) if e["type"] == "message"] == []


async def test_disconnect_event_closes_the_users_connections_with_4403():
    hub = Hub(InMemoryBus(), SessionLocal)
    victim, bystander = Connection(1, [10]), Connection(2, [10])
    hub.register(victim)
    hub.register(bystander)
    await hub._dispatch(BusEvent("user", 1, {"type": "disconnect"}))
    assert victim.close_code == 4403
    assert victim.queue.get_nowait() is None
    assert bystander.close_code is None


async def test_slow_consumer_is_closed_without_blocking_others():
    hub = Hub(InMemoryBus(), SessionLocal)
    slow, fast = Connection(1, [10], queue_size=2), Connection(2, [10], queue_size=50)
    hub.register(slow)
    hub.register(fast)
    for n in range(5):
        await hub._dispatch(BusEvent("room", 10, {"type": "message", "n": n}))
    assert slow.close_code == 4408
    assert slow.queue.get_nowait() is None  # chỉ còn sentinel đóng kết nối
    assert [e["n"] for e in drain(fast)] == [0, 1, 2, 3, 4]
    assert fast.close_code is None


async def test_connection_close_is_idempotent_and_blocks_further_offers():
    conn = Connection(1, [10], queue_size=1)
    conn.close(4403)
    conn.close(4401)
    assert conn.close_code == 4403
    assert conn.offer({"type": "x"}) is False


async def stop(task: asyncio.Task) -> None:
    task.cancel()
    with suppress(asyncio.CancelledError):
        await task


async def wait_for_queue(conn: Connection) -> None:
    for _ in range(100):
        if not conn.queue.empty():
            return
        await asyncio.sleep(0.02)


async def test_run_dispatches_bus_events_to_connections():
    bus = InMemoryBus()
    hub = Hub(bus, SessionLocal, reconnect_delay=0.01)
    conn = Connection(1, [10])
    hub.register(conn)
    task = asyncio.create_task(hub.run())
    try:
        await bus.publish_room(10, {"type": "message", "n": 1})
        await wait_for_queue(conn)
        assert drain(conn) == [{"type": "message", "n": 1}]
    finally:
        await stop(task)


async def test_no_resync_while_the_bus_keeps_failing_before_it_ever_subscribed():
    bus = InMemoryBus()
    bus.fail_listens = 3
    hub = Hub(bus, SessionLocal, reconnect_delay=0.01)
    conn = Connection(1, [10])
    hub.register(conn)
    task = asyncio.create_task(hub.run())
    try:
        await asyncio.sleep(0.3)  # đủ cho 3 lần thất bại (0.01 + 0.02 + 0.04) rồi đăng ký được
        assert bus.fail_listens == 0
        assert drain(conn) == []
        await bus.publish_room(10, {"type": "message", "n": 1})
        await wait_for_queue(conn)
        assert drain(conn) == [{"type": "message", "n": 1}]
    finally:
        await stop(task)


async def test_run_sends_exactly_one_resync_after_resubscribing_and_events_flow_again():
    bus = InMemoryBus()
    bus.fail_after_subscribe = 1
    hub = Hub(bus, SessionLocal, reconnect_delay=0.01)
    conn = Connection(1, [10])
    hub.register(conn)
    task = asyncio.create_task(hub.run())
    try:
        await wait_for_queue(conn)
        await asyncio.sleep(0.1)
        assert drain(conn) == [{"type": "resync"}]
        await bus.publish_room(10, {"type": "message", "n": 2})  # hub đã nghe lại được
        await wait_for_queue(conn)
        assert drain(conn) == [{"type": "message", "n": 2}]
    finally:
        await stop(task)


async def test_a_failing_event_does_not_stop_the_listener_or_trigger_resync():
    calls = 0

    def flaky_session_factory():
        nonlocal calls
        calls += 1
        raise RuntimeError("db down")

    bus = InMemoryBus()
    hub = Hub(bus, flaky_session_factory, reconnect_delay=0.01)
    conn = Connection(1, [10])
    hub.register(conn)
    task = asyncio.create_task(hub.run())
    try:
        await bus.publish_user(1, {"type": "rooms_changed"})
        await bus.publish_room(10, {"type": "message", "n": 3})
        await wait_for_queue(conn)
        await asyncio.sleep(0.1)
        assert calls == 1
        assert drain(conn) == [{"type": "message", "n": 3}]
    finally:
        await stop(task)


async def test_non_dict_payload_is_ignored():
    hub = Hub(InMemoryBus(), SessionLocal)
    conn = Connection(1, [10])
    hub.register(conn)
    await hub._dispatch(BusEvent("room", 10, [1, 2]))
    await hub._dispatch(BusEvent("user", 1, "rooms_changed"))
    assert drain(conn) == []
    assert conn.close_code is None
