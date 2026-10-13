import asyncio
from contextlib import suppress

from app.chat.bus import BusEvent
from app.chat.hub import Connection, Hub, apply_room_snapshot
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
    alice = await create_user("alice")
    room = await create_room(member_ids=[alice])  # sau resync hub nạp lại thành viên từ DB
    bus = InMemoryBus()
    bus.fail_after_subscribe = 1
    hub = Hub(bus, SessionLocal, reconnect_delay=0.01)
    conn = Connection(alice, [room])
    hub.register(conn)
    task = asyncio.create_task(hub.run())
    try:
        await wait_for_queue(conn)
        await asyncio.sleep(0.1)
        assert drain(conn) == [{"type": "resync"}]
        await bus.publish_room(room, {"type": "message", "n": 2})  # hub đã nghe lại được
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


async def test_apply_room_snapshot_skips_a_stale_snapshot_after_the_hub_reloaded():
    alice = await create_user("alice")
    room = await create_room(member_ids=[alice])
    hub = Hub(InMemoryBus(), SessionLocal)
    conn = Connection(alice, [])
    hub.register(conn)
    seen = conn.version  # endpoint đọc snapshot cũ (rỗng) rồi bị hub vượt mặt
    await hub._dispatch(BusEvent("user", alice, {"type": "rooms_changed"}))
    assert conn.room_ids == {room} and conn.version == seen + 1
    assert apply_room_snapshot(conn, seen, set()) is False
    assert conn.room_ids == {room}
    assert apply_room_snapshot(conn, conn.version, {room, 99}) is True
    assert conn.room_ids == {room, 99}


async def test_resubscribing_reloads_membership_for_all_connections():
    alice, bob = await create_user("alice"), await create_user("bob")
    room = await create_room(member_ids=[alice])
    bus = InMemoryBus()
    bus.fail_after_subscribe = 1
    hub = Hub(bus, SessionLocal, reconnect_delay=0.01)
    stale_a, stale_b, tab2 = Connection(alice, [12345]), Connection(bob, [room]), Connection(alice, [])
    for c in (stale_a, stale_b, tab2):
        hub.register(c)
    task = asyncio.create_task(hub.run())
    try:
        await wait_for_queue(stale_a)
        await asyncio.sleep(0.1)
        assert stale_a.room_ids == {room} and tab2.room_ids == {room}
        assert stale_b.room_ids == set()
        assert drain(stale_a) == [{"type": "rooms_changed"}, {"type": "resync"}]  # reconcile báo phòng đổi, rồi resync
    finally:
        await stop(task)


async def test_a_failing_membership_reload_does_not_kill_the_listener():
    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def broken_session():
        raise ConnectionError("db down")
        yield

    bus = InMemoryBus()
    bus.fail_after_subscribe = 1
    hub = Hub(bus, broken_session, reconnect_delay=0.01)
    conn = Connection(1, [10])
    hub.register(conn)
    task = asyncio.create_task(hub.run())
    try:
        await wait_for_queue(conn)
        await asyncio.sleep(0.1)
        assert drain(conn) == [{"type": "resync"}]
        assert conn.room_ids == {10}
        await bus.publish_room(10, {"type": "message", "n": 3})
        await wait_for_queue(conn)
        assert drain(conn) == [{"type": "message", "n": 3}]
    finally:
        await stop(task)


# ---------- reconcile ----------

async def test_reconcile_heals_a_missed_rooms_changed():
    alice = await create_user("alice")
    room = await create_room(member_ids=[alice])
    hub = Hub(InMemoryBus(), SessionLocal)
    conn = Connection(alice, [room, 777])  # 777: phòng đã bị gỡ mà sự kiện rooms_changed bị lỡ
    hub.register(conn)
    async with SessionLocal() as s:
        await s.delete(await s.get(RoomMember, (room, alice)))
        await s.commit()
    seen = conn.version
    await hub.reconcile()
    assert conn.room_ids == set()
    assert conn.version == seen + 1
    assert conn.close_code is None


async def test_reconcile_closes_a_user_deactivated_in_the_database_with_4403():
    from app.models import User

    alice, bob = await create_user("alice"), await create_user("bob")
    hub = Hub(InMemoryBus(), SessionLocal)
    locked, other = Connection(alice, []), Connection(bob, [])
    hub.register(locked)
    hub.register(other)
    async with SessionLocal() as s:
        (await s.get(User, alice)).is_active = False
        await s.commit()
    await hub.reconcile()
    assert locked.close_code == 4403
    assert other.close_code is None


async def test_reconcile_closes_must_change_password_users_with_4401():
    from app.models import User

    alice, bob = await create_user("alice"), await create_user("bob")
    hub = Hub(InMemoryBus(), SessionLocal)
    conn, locked = Connection(alice, []), Connection(bob, [])
    hub.register(conn)
    hub.register(locked)
    async with SessionLocal() as s:
        (await s.get(User, alice)).must_change_password = True
        bob_user = await s.get(User, bob)
        bob_user.must_change_password = True
        bob_user.is_active = False
        await s.commit()
    await hub.reconcile()
    assert conn.close_code == 4401
    assert locked.close_code == 4403


async def test_reconcile_tells_the_client_to_reload_rooms_when_membership_changed():
    alice = await create_user("alice")
    room = await create_room(member_ids=[alice])
    hub = Hub(InMemoryBus(), SessionLocal)
    conn = Connection(alice, {999})
    hub.register(conn)
    await hub.reconcile()
    assert conn.room_ids == {room}
    assert drain(conn) == [{"type": "rooms_changed"}]
    await hub.reconcile()  # đã khớp DB: không ồn
    assert conn.room_ids == {room}
    assert drain(conn) == []


async def test_reconcile_does_not_raise_when_the_database_fails():
    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def broken_session():
        raise ConnectionError("db down")
        yield

    hub = Hub(InMemoryBus(), broken_session)
    conn = Connection(1, [10])
    hub.register(conn)
    await hub.reconcile()
    assert conn.room_ids == {10} and conn.close_code is None


async def test_periodic_reconciler_runs_repeatedly_and_stops_cleanly_on_cancel():
    hub = Hub(InMemoryBus(), SessionLocal)
    calls = 0

    async def fake_reconcile():
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("boom")  # một lần lỗi không được giết vòng lặp

    hub.reconcile = fake_reconcile
    task = asyncio.create_task(hub.run_reconciler(0.01))
    for _ in range(100):
        if calls >= 3:
            break
        await asyncio.sleep(0.02)
    assert calls >= 3
    task.cancel()
    with suppress(asyncio.CancelledError):
        await task
    assert task.cancelled()
    seen = calls
    await asyncio.sleep(0.1)
    assert calls == seen


async def test_disconnect_event_honours_an_allowed_close_code_and_defaults_to_4403():
    hub = Hub(InMemoryBus(), SessionLocal)
    conns = {code: Connection(n, []) for n, code in enumerate([4401, 4403, 1000, "4401", None], start=1)}
    for c in conns.values():
        hub.register(c)
    for n, code in enumerate([4401, 4403, 1000, "4401", None], start=1):
        payload = {"type": "disconnect"} if code is None else {"type": "disconnect", "code": code}
        await hub._dispatch(BusEvent("user", n, payload))
    assert [c.close_code for c in conns.values()] == [4401, 4403, 4403, 4403, 4403]


async def test_ephemeral_events_are_dropped_instead_of_closing_a_full_queue():
    hub = Hub(InMemoryBus(), SessionLocal)
    conn = Connection(1, [10], queue_size=10)
    hub.register(conn)
    for n in range(8):
        await hub._dispatch(BusEvent("room", 10, {"type": "message", "n": n}))
    for kind in ("read", "typing", "presence"):
        await hub._dispatch(BusEvent("room", 10, {"type": kind, "user_id": 2}))
    assert conn.close_code is None and conn.queue.qsize() == 8  # da bo, khong dong
    await hub._dispatch(BusEvent("room", 10, {"type": "message", "n": 8}))
    await hub._dispatch(BusEvent("room", 10, {"type": "message", "n": 9}))
    assert conn.close_code is None and conn.queue.qsize() == 10
    await hub._dispatch(BusEvent("room", 10, {"type": "read", "user_id": 2}))
    assert conn.close_code is None
    await hub._dispatch(BusEvent("room", 10, {"type": "message", "n": 10}))
    assert conn.close_code == 4408  # tin that van dong ket noi khi tran
