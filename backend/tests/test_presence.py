import asyncio
import json

from httpx import AsyncClient
from redis.exceptions import RedisError
from sqlalchemy import text

from app.chat.hub import Connection, Hub
from app.chat.presence import Presence
from app.config import get_settings
from app.db import SessionLocal
from app.redis_client import get_redis
from tests.conftest import auth_headers, create_direct, create_room, create_user, login
from tests.helpers import InMemoryBus, expect_silence, recv_json, ws_open


class FakeClock:
    def __init__(self, now: float = 1000.0):
        self.now = now

    def __call__(self) -> float:
        return self.now


def _presence(clock: FakeClock, ttl: float = 10.0) -> Presence:
    return Presence(get_redis(), get_settings().bus_channel_prefix, ttl, clock)


def _key() -> str:
    return f"{get_settings().bus_channel_prefix}:online"


# ---------- Presence (unit) ----------

async def test_touch_makes_user_online_until_ttl():
    clock = FakeClock()
    p = _presence(clock)
    await p.touch(1, "a")
    assert await p.online_user_ids() == {1}
    clock.now += 11
    assert await p.online_user_ids() == set()
    assert await get_redis().zcard(_key()) == 0
    await get_redis().delete(_key())


async def test_two_connections_one_user():
    p = _presence(FakeClock())
    await p.touch(1, "a")
    await p.touch(1, "b")
    await p.remove(1, "a")
    assert await p.online_user_ids() == {1}
    await p.remove(1, "b")
    assert await p.online_user_ids() == set()
    await get_redis().delete(_key())


async def test_touch_refreshes_expiry():
    clock = FakeClock()
    p = _presence(clock)
    await p.touch(1, "a")
    clock.now += 8
    await p.touch(1, "a")
    clock.now += 8
    assert await p.online_user_ids() == {1}
    clock.now += 3
    assert await p.online_user_ids() == set()
    await get_redis().delete(_key())


# ---------- tich hop WS ----------

async def _token(live, username):
    async with AsyncClient(base_url=live.http) as http:
        r = await login(http, username)
        return r.json()["access_token"]


async def _open(live, username):
    ws, first = await ws_open(live.ws, await _token(live, username))
    assert first["type"] == "ready"
    return ws


async def _next_presence(ws, timeout=3):
    while True:
        ev = await recv_json(ws, timeout, include_presence=True)
        if ev.get("type") == "presence":
            return ev


async def test_presence_event_on_connect_and_disconnect(live_server):
    a = await create_user("alice")
    b = await create_user("bob")
    await create_direct(a, b)
    wsb = await _open(live_server, "bob")
    wsa = await _open(live_server, "alice")
    assert await _next_presence(wsb) == {"type": "presence", "user_id": a, "online": True}
    await wsa.close()
    assert await _next_presence(wsb) == {"type": "presence", "user_id": a, "online": False}
    await wsb.close()


async def test_second_tab_close_keeps_user_online(live_server):
    a = await create_user("alice")
    b = await create_user("bob")
    await create_direct(a, b)
    wsb = await _open(live_server, "bob")
    wsa1 = await _open(live_server, "alice")
    assert (await _next_presence(wsb))["online"] is True
    wsa2 = await _open(live_server, "alice")
    await expect_silence(wsb, 0.8, include_presence=True)  # tab thu hai khong phat lai online:true
    await wsa1.close()
    await expect_silence(wsb, 1.0, include_presence=True)  # van con tab 2 (qua nhieu chu ky quet)
    await wsa2.close()
    assert await _next_presence(wsb) == {"type": "presence", "user_id": a, "online": False}
    await wsb.close()


async def test_presence_not_sent_to_users_without_shared_room(live_server):
    a = await create_user("alice")
    b = await create_user("bob")
    await create_user("carol")
    await create_direct(a, b)
    wsc = await _open(live_server, "carol")
    wsa = await _open(live_server, "alice")
    await expect_silence(wsc, 0.8, include_presence=True)
    await wsa.close()
    await expect_silence(wsc, 0.8, include_presence=True)
    await wsc.close()


async def test_get_presence_scope(live_server):
    a = await create_user("alice")
    b = await create_user("bob")
    c = await create_user("carol")
    await create_user("dave")
    e = await create_user("erin")
    await create_direct(a, b)
    await create_direct(b, c)
    archived = await create_room(member_ids=[a, e])
    async with SessionLocal() as s:
        await s.execute(text("UPDATE rooms SET archived_at = now() WHERE id = :i"), {"i": archived})
        await s.commit()
    sockets = [await _open(live_server, n) for n in ("alice", "bob", "carol", "dave", "erin")]
    token = await _token(live_server, "alice")
    async with AsyncClient(base_url=live_server.http) as http:
        r = await http.get("/api/presence", headers=auth_headers(token))
    assert r.status_code == 200
    assert r.json() == {"online_user_ids": [b]}
    for ws in sockets:
        await ws.close()


async def test_get_presence_requires_auth(client):
    r = await client.get("/api/presence")
    assert r.status_code == 401


# ---------- announcer / sweeper ----------

class FlakyPresence(Presence):
    fail_next = 0

    async def online_user_ids(self):
        if self.fail_next:
            self.fail_next -= 1
            raise RedisError("boom")
        return await super().online_user_ids()


class DelayBus(InMemoryBus):
    """Bus cho phep tre/loi publish theo tung lan."""

    def __init__(self, delays=(), fail_first=0, per_publish=0.0):
        super().__init__()
        self.delays = list(delays)
        self.fail_first = fail_first
        self.per_publish = per_publish
        self.attempts = 0

    async def publish_room(self, room_id, event):
        self.attempts += 1
        if self.delays:
            await asyncio.sleep(self.delays.pop(0))
        if self.per_publish:
            await asyncio.sleep(self.per_publish)
        if self.fail_first > 0:
            self.fail_first -= 1
            raise RedisError("publish down")
        await super().publish_room(room_id, event)


def _events(bus, user_id=None):
    return [e for _, _, e in bus.published if e.get("type") == "presence" and user_id in (None, e["user_id"])]


async def _until(cond, timeout=5.0):
    for _ in range(int(timeout / 0.02)):
        if cond():
            return
        await asyncio.sleep(0.02)
    raise AssertionError("condition not met in time")


async def _setup_pair():
    a = await create_user("alice")
    b = await create_user("bob")
    room = await create_direct(a, b)
    return a, b, room


async def test_sweeper_announces_expiry_and_survives_errors():
    a, _, room = await _setup_pair()
    clock = FakeClock()
    p = FlakyPresence(get_redis(), get_settings().bus_channel_prefix, 10.0, clock)
    bus = InMemoryBus()
    hub = Hub(bus, SessionLocal, presence=p)
    await p.touch(a, "x")
    await hub.sweep_presence()  # duong co so
    assert bus.published == []
    clock.now += 11
    p.fail_next = 1
    task = asyncio.create_task(hub.run_presence_sweeper(0.05))
    try:
        await _until(lambda: _events(bus))
        assert not task.done()
        assert bus.published == [("room", room, {"type": "presence", "user_id": a, "online": False})]
        await asyncio.sleep(0.3)
        assert len(bus.published) == 1  # khong lap lai
    finally:
        task.cancel()
        await hub.close_all()
    assert await get_redis().zcard(_key()) == 0


async def test_sweeper_does_not_flap_for_own_live_connections():
    a, _, _ = await _setup_pair()
    clock = FakeClock()
    p = _presence(clock)
    bus = InMemoryBus()
    hub = Hub(bus, SessionLocal, presence=p)
    conn = Connection(a)
    hub.register(conn)
    await hub.on_connected(conn)
    await _until(lambda: _events(bus))
    await hub.sweep_presence()
    clock.now += 11  # phan tu da het han nhung ket noi van mo tren worker nay
    await hub.sweep_presence()
    await asyncio.sleep(0.2)
    assert [e["online"] for e in _events(bus)] == [True]
    assert await p.online_user_ids() == {a}
    await get_redis().delete(_key())
    await hub.close_all()


async def test_sweeper_announces_user_online_via_other_worker():
    a, _, room = await _setup_pair()
    p = _presence(FakeClock())
    bus = InMemoryBus()
    hub = Hub(bus, SessionLocal, presence=p)
    await hub.sweep_presence()
    await p.touch(a, "other-worker")
    await hub.sweep_presence()
    await _until(lambda: bus.published)
    assert bus.published == [("room", room, {"type": "presence", "user_id": a, "online": True})]
    await get_redis().delete(_key())
    await hub.close_all()


async def test_publish_skips_archived_rooms_and_non_members():
    a = await create_user("alice")
    b = await create_user("bob")
    live_room = await create_direct(a, b)
    archived = await create_room(member_ids=[a, b])
    await create_room(member_ids=[b])
    async with SessionLocal() as s:
        await s.execute(text("UPDATE rooms SET archived_at = now() WHERE id = :i"), {"i": archived})
        await s.commit()
    bus = InMemoryBus()
    hub = Hub(bus, SessionLocal, presence=_presence(FakeClock()))
    await hub._publish(a, True)
    assert [(r, e["user_id"]) for _, r, e in bus.published] == [(live_room, a)]


async def test_out_of_order_announcements_end_in_real_state():
    a, _, _ = await _setup_pair()
    bus = DelayBus(delays=[0.4])  # lan phat online dau tien bi tre
    hub = Hub(bus, SessionLocal, presence=_presence(FakeClock(), 100))
    conn = Connection(a)
    hub.register(conn)
    await hub.on_connected(conn)
    await _until(lambda: bus.attempts == 1)
    hub.unregister(conn)
    await hub.on_disconnected(conn)  # trong luc online dang duoc phat
    await _until(lambda: _events(bus) and _events(bus)[-1]["online"] is False)
    # chuoi nhanh ket thuc la online
    for _ in range(3):
        c = Connection(a)
        hub.register(c)
        await hub.on_connected(c)
        hub.unregister(c)
        await hub.on_disconnected(c)
    last = Connection(a)
    hub.register(last)
    await hub.on_connected(last)
    await _until(lambda: hub._announced.get(a) is True and not hub._dirty)
    assert _events(bus)[-1]["online"] is True
    await hub.close_all()
    await get_redis().delete(_key())


async def test_failed_publish_is_retried_by_next_sweep():
    a, _, room = await _setup_pair()
    bus = DelayBus(fail_first=1)
    hub = Hub(bus, SessionLocal, presence=_presence(FakeClock(), 100), failure_cooldown=0.05)
    conn = Connection(a)
    hub.register(conn)
    await hub.on_connected(conn)
    await _until(lambda: bus.attempts == 1)
    await asyncio.sleep(0.2)
    assert bus.published == [] and a in hub._dirty
    await hub.sweep_presence()  # luot dau khong duoc coi la "da biet" khi dang cho phat
    await _until(lambda: bus.published)
    assert bus.published == [("room", room, {"type": "presence", "user_id": a, "online": True})]
    await hub.close_all()
    await get_redis().delete(_key())


async def test_db_error_during_announce_is_retried():
    a, _, room = await _setup_pair()
    calls = {"n": 0}

    def flaky_session():
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("db down")
        return SessionLocal()

    bus = InMemoryBus()
    hub = Hub(bus, flaky_session, presence=_presence(FakeClock(), 100), failure_cooldown=0.05)
    conn = Connection(a)
    hub.register(conn)
    await hub.on_connected(conn)
    await _until(lambda: calls["n"] == 1)
    await asyncio.sleep(0.1)
    assert bus.published == []
    await hub.sweep_presence()
    await _until(lambda: bus.published)
    assert bus.published[0][1] == room
    await hub.close_all()
    await get_redis().delete(_key())


async def test_mass_expiry_with_slow_publish_is_not_lost(monkeypatch):
    import app.chat.hub as hub_module

    monkeypatch.setattr(hub_module, "RECONCILE_TIMEOUT_SECONDS", 0.3)
    ids = [await create_user(f"user{i}") for i in range(20)]
    await create_room(member_ids=ids)
    clock = FakeClock()
    p = _presence(clock)
    bus = DelayBus(per_publish=0.05)  # tong ~1s > timeout 0.3s cua luot quet
    hub = Hub(bus, SessionLocal, presence=p)
    for uid in ids:
        await p.touch(uid, "x")
    await hub.sweep_presence()
    clock.now += 11
    await hub._sweep_guarded()
    await _until(lambda: len(_events(bus)) == 20, timeout=10)
    assert {e["user_id"] for e in _events(bus)} == set(ids)
    assert all(e["online"] is False for e in _events(bus))
    await hub.close_all()


async def test_close_all_cancels_announcer():
    a, _, _ = await _setup_pair()
    gate = asyncio.Event()

    class BlockedBus(InMemoryBus):
        async def publish_room(self, room_id, event):
            await gate.wait()

    hub = Hub(BlockedBus(), SessionLocal, presence=_presence(FakeClock(), 100))
    conn = Connection(a)
    hub.register(conn)
    await hub.on_connected(conn)
    await _until(lambda: hub._announcing == a)
    announcer = hub._announcer
    await hub.close_all()
    assert announcer.cancelled() and hub._announcer is None
    await hub.on_disconnected(conn)  # sau close_all khong tao announcer moi
    assert hub._announcer is None
    await get_redis().delete(_key())


async def test_disconnect_always_removes_even_if_connect_failed():
    a, _, _ = await _setup_pair()
    p = _presence(FakeClock(), 100)
    hub = Hub(InMemoryBus(), SessionLocal, presence=p)
    conn = Connection(a)
    await p.touch(a, conn.conn_id)  # vd. on_connected bi huy sau khi ZADD da toi Redis
    await hub.on_disconnected(conn)
    assert await get_redis().zcard(_key()) == 0
    await hub.close_all()


async def test_inflight_sweep_touch_cannot_undo_disconnect_remove():
    a, _, _ = await _setup_pair()
    wrote, gate = asyncio.Event(), asyncio.Event()

    class SlowTouchMany(Presence):
        async def touch_many(self, pairs):
            await super().touch_many(pairs)
            wrote.set()
            await gate.wait()

    p = SlowTouchMany(get_redis(), get_settings().bus_channel_prefix, 100, FakeClock())
    hub = Hub(InMemoryBus(), SessionLocal, presence=p)
    conn = Connection(a)
    hub.register(conn)
    await hub.on_connected(conn)
    sweep = asyncio.create_task(hub.sweep_presence())
    await wrote.wait()
    hub.unregister(conn)
    await hub.on_disconnected(conn)  # ZREM chay xong, roi sweep moi tiep tuc
    gate.set()
    await sweep
    assert await get_redis().zcard(_key()) == 0
    await hub.close_all()


# ---------- cau hinh / HTTP ----------

def test_config_requires_ttl_greater_than_sweep():
    import pytest
    from pydantic import ValidationError

    from app.config import Settings

    with pytest.raises(ValidationError, match="PRESENCE_TTL_SECONDS"):
        Settings(presence_ttl_seconds=5, presence_sweep_seconds=5)
    Settings(presence_ttl_seconds=6, presence_sweep_seconds=5)


async def test_get_presence_returns_503_when_redis_is_down(client, monkeypatch):
    a = await create_user("alice")
    b = await create_user("bob")
    await create_direct(a, b)

    async def boom(self):
        raise RedisError("down")

    monkeypatch.setattr(Presence, "online_user_ids", boom)
    r = await login(client, "alice")
    r = await client.get("/api/presence", headers=auth_headers(r.json()["access_token"]))
    assert r.status_code == 503
    assert r.json() == {"detail": "service_unavailable"}


# ---------- Redis loi ----------

async def test_redis_failure_does_not_break_websocket(live_server, monkeypatch):
    a = await create_user("alice")
    await create_user("bob")
    room = await create_direct(a, a + 1)

    async def boom(self, *args, **kwargs):
        raise RedisError("down")

    monkeypatch.setattr(Presence, "touch", boom)
    monkeypatch.setattr(Presence, "remove", boom)
    monkeypatch.setattr(Presence, "online_user_ids", boom)
    monkeypatch.setattr(Presence, "touch_many", boom)
    wsa = await _open(live_server, "alice")
    wsb = await _open(live_server, "bob")
    await wsa.send(json.dumps({"type": "ping"}))
    assert await recv_json(wsa) == {"type": "pong"}
    await wsa.send(json.dumps({"type": "send", "room_id": room, "body": "hi", "client_id": "c1"}))
    got = await recv_json(wsb)
    assert got["type"] == "message" and got["message"]["body"] == "hi"
    await wsa.close()
    await wsb.close()


async def test_slow_presence_does_not_stall_frame_processing(live_server, monkeypatch):
    import app.chat.hub as hub_module

    a = await create_user("alice")
    await create_user("bob")
    room = await create_direct(a, a + 1)

    async def slow(self, *args, **kwargs):
        await asyncio.sleep(10)

    monkeypatch.setattr(hub_module, "PRESENCE_OP_TIMEOUT_SECONDS", 0.2)
    monkeypatch.setattr(Presence, "touch", slow)
    wsa = await _open(live_server, "alice")
    wsb = await _open(live_server, "bob")
    loop = asyncio.get_running_loop()
    start = loop.time()
    for _ in range(3):
        await wsa.send(json.dumps({"type": "ping"}))
    await wsa.send(json.dumps({"type": "send", "room_id": room, "body": "hi", "client_id": "c1"}))
    got = await recv_json(wsb, 5)
    assert got["type"] == "message"
    assert loop.time() - start < 3  # moi lan cho toi da 0.2s, khong phai 10s
    await wsa.close()
    await wsb.close()


async def test_announce_timeout_counts_as_failure_and_is_retried():
    a, _, room = await _setup_pair()
    bus = DelayBus(delays=[30])  # lan phat dau treo
    hub = Hub(bus, SessionLocal, presence=_presence(FakeClock(), 100), announce_timeout=0.2, failure_cooldown=0.05)
    conn = Connection(a)
    hub.register(conn)
    await hub.on_connected(conn)
    await _until(lambda: bus.attempts == 1)
    await _until(lambda: a in hub._dirty and hub._announcing is None)
    assert bus.published == []
    await hub.sweep_presence()
    await _until(lambda: bus.published)
    assert bus.published == [("room", room, {"type": "presence", "user_id": a, "online": True})]
    await hub.close_all()
    await get_redis().delete(_key())


async def test_outage_bounds_announce_attempts_across_connect_events():
    ids = [await create_user(f"user{i}") for i in range(5)]
    await create_room(member_ids=ids)
    bus = DelayBus(fail_first=10_000)
    hub = Hub(bus, SessionLocal, presence=_presence(FakeClock(), 100), failure_cooldown=1.5)
    for _ in range(4):
        for uid in ids:
            c = Connection(uid)
            hub.register(c)
            await hub.on_connected(c)
            await asyncio.sleep(0.01)
    await asyncio.sleep(0.3)
    # khong co cooldown: moi su kien chay lai moi user dirty (hang chuc lan); co cooldown: toi da mot luot ~ 5 user
    assert 1 <= bus.attempts <= 5
    assert hub._dirty == set(ids) or hub._dirty <= set(ids)
    await hub.close_all()
    await get_redis().delete(_key())


async def test_offline_entries_are_pruned_and_transitions_still_announced():
    a, _, room = await _setup_pair()
    bus = InMemoryBus()
    hub = Hub(bus, SessionLocal, presence=_presence(FakeClock(), 100))
    for expected in (True, False, True, False):
        if expected:
            conn = Connection(a)
            hub.register(conn)
            await hub.on_connected(conn)
        else:
            hub.unregister(conn)
            await hub.on_disconnected(conn)
        await _until(lambda: len(_events(bus)) and _events(bus)[-1]["online"] is expected and not hub._dirty)
        await _until(lambda: hub._announcer is not None and hub._announcing is None)
    assert [e["online"] for e in _events(bus)] == [True, False, True, False]
    assert a not in hub._announced  # offline va khong dirty: da don
    await hub.sweep_presence()  # khong phat lai offline
    await asyncio.sleep(0.1)
    assert len(_events(bus)) == 4
    await hub.close_all()
    await get_redis().delete(_key())
