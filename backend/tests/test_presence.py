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
    assert await p.touch(1, "a") is False
    assert await p.touch(1, "b") is True
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
    await expect_silence(wsb, 0.8)  # tab thu hai khong phat lai online:true
    await wsa1.close()
    await expect_silence(wsb, 1.0)  # van con tab 2 (qua nhieu chu ky quet)
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
    await expect_silence(wsc, 0.8)
    await wsa.close()
    await expect_silence(wsc, 0.8)
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


# ---------- sweeper ----------

class FlakyPresence(Presence):
    fail_next = 0

    async def online_user_ids(self):
        if self.fail_next:
            self.fail_next -= 1
            raise RedisError("boom")
        return await super().online_user_ids()


def _presence_events(bus, online):
    return [e for _, _, e in bus.published if e.get("type") == "presence" and e["online"] is online]


async def test_sweeper_announces_expiry_and_survives_errors():
    a = await create_user("alice")
    b = await create_user("bob")
    room = await create_direct(a, b)
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
        for _ in range(100):
            if _presence_events(bus, False):
                break
            await asyncio.sleep(0.05)
        assert not task.done()
        assert bus.published == [("room", room, {"type": "presence", "user_id": a, "online": False})]
        await asyncio.sleep(0.3)
        assert len(bus.published) == 1  # khong lap lai
    finally:
        task.cancel()
    assert await get_redis().zcard(_key()) == 0


async def test_sweeper_does_not_flap_for_own_live_connections():
    a = await create_user("alice")
    b = await create_user("bob")
    await create_direct(a, b)
    clock = FakeClock()
    p = _presence(clock)
    bus = InMemoryBus()
    hub = Hub(bus, SessionLocal, presence=p)
    conn = Connection(a)
    hub.register(conn)
    await hub.on_connected(conn)
    await hub.sweep_presence()
    clock.now += 11  # phan tu da het han nhung ket noi van mo tren worker nay
    await hub.sweep_presence()
    assert _presence_events(bus, False) == []
    assert await p.online_user_ids() == {a}
    await get_redis().delete(_key())
    await hub.close_all()


async def test_sweeper_announces_user_online_via_other_worker():
    a = await create_user("alice")
    b = await create_user("bob")
    room = await create_direct(a, b)
    p = _presence(FakeClock())
    bus = InMemoryBus()
    hub = Hub(bus, SessionLocal, presence=p)
    await hub.sweep_presence()
    await p.touch(a, "other-worker")
    await hub.sweep_presence()
    assert bus.published == [("room", room, {"type": "presence", "user_id": a, "online": True})]
    await get_redis().delete(_key())


async def test_announce_skips_archived_rooms_and_non_members():
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
    await hub._announce(a, True)
    assert [(r, e["user_id"]) for _, r, e in bus.published] == [(live_room, a)]


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
