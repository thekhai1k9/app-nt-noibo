import os

os.environ["DATABASE_URL"] = os.environ.get(
    "TEST_DATABASE_URL", "postgresql+asyncpg://messaging:messaging@localhost:5432/messaging_test"
)
os.environ["REDIS_URL"] = os.environ.get("TEST_REDIS_URL", "redis://localhost:6379/1")
os.environ["JWT_SECRET"] = "test-secret"
os.environ["APP_ENV"] = "test"
os.environ["COOKIE_SECURE"] = "false"
os.environ["LOGIN_MAX_ATTEMPTS"] = "3"
os.environ["WS_RATE_LIMIT_MESSAGES"] = "5"
os.environ["WS_AUTH_TIMEOUT_SECONDS"] = "1"
os.environ["WS_RECONCILE_SECONDS"] = "0.3"
os.environ["WS_TYPING_INTERVAL_SECONDS"] = "0.3"
os.environ["PRESENCE_OFFLINE_GRACE_SECONDS"] = "0"
os.environ["PRESENCE_SWEEP_SECONDS"] = "0.3"
os.environ["PRESENCE_TTL_SECONDS"] = "2"
os.environ["BUS_CHANNEL_PREFIX"] = "kn-test"

import asyncio
import socket
from dataclasses import dataclass

import pytest_asyncio
import uvicorn
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text

from app import models  # noqa: F401  (đăng ký các bảng vào Base.metadata)
from app.db import Base, SessionLocal, engine
from app.main import create_app
from app.models import Branch, Message, Room, RoomMember, User
from app.redis_client import get_redis
from app.routers.chat import get_bus
from app.security import hash_password
from tests.helpers import InMemoryBus

TEST_PASSWORD = "Passw0rd!"


@pytest_asyncio.fixture(scope="session", loop_scope="session", autouse=True)
async def _schema():
    # Chặn chạy nhầm lên database thật.
    assert engine.url.database.endswith("_test"), f"refusing to reset {engine.url.database}"
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
    yield
    await engine.dispose()


@pytest_asyncio.fixture(autouse=True)
async def _clean():
    async with engine.begin() as conn:
        await conn.execute(text("TRUNCATE messages, room_members, rooms, refresh_tokens, users, branches RESTART IDENTITY CASCADE"))
    await get_redis().flushdb()
    yield


@pytest_asyncio.fixture
async def bus():
    return InMemoryBus()


@pytest_asyncio.fixture
async def client(bus):
    app = create_app()
    app.dependency_overrides[get_bus] = lambda: bus
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


async def create_branch(name: str = "Hà Nội", code: str = "HN") -> int:
    async with SessionLocal() as s:
        branch = Branch(name=name, code=code)
        s.add(branch)
        await s.commit()
        return branch.id


async def create_user(
    username: str,
    password: str = TEST_PASSWORD,
    role: str = "member",
    branch_id: int | None = None,
    must_change: bool = False,
    active: bool = True,
) -> int:
    if branch_id is None:
        branch_id = await create_branch(name=f"CN-{username}", code=username[:10].upper())
    async with SessionLocal() as s:
        user = User(
            username=username,
            full_name=username.title(),
            branch_id=branch_id,
            role=role,
            password_hash=hash_password(password),
            must_change_password=must_change,
            is_active=active,
        )
        s.add(user)
        await s.commit()
        return user.id


async def login(client, username: str, password: str = TEST_PASSWORD):
    return await client.post("/api/auth/login", json={"username": username, "password": password})


@pytest_asyncio.fixture
async def admin_headers(client):
    await create_user("admin", role="admin")
    r = await login(client, "admin")
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest_asyncio.fixture
async def member_headers(client):
    await create_user("member1", role="member")
    r = await login(client, "member1")
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def create_room(
    type_: str = "group",
    name: str | None = "Phòng",
    member_ids: tuple[int, ...] | list[int] = (),
    branch_id: int | None = None,
    created_by: int | None = None,
) -> int:
    async with SessionLocal() as s:
        room = Room(type=type_, name=name if type_ == "group" else None, branch_id=branch_id, created_by=created_by)
        s.add(room)
        await s.flush()
        s.add_all([RoomMember(room_id=room.id, user_id=uid) for uid in member_ids])
        await s.commit()
        return room.id


async def create_direct(a: int, b: int) -> int:
    async with SessionLocal() as s:
        room = Room(type="direct", direct_key=f"{min(a, b)}:{max(a, b)}", created_by=a)
        s.add(room)
        await s.flush()
        s.add_all([RoomMember(room_id=room.id, user_id=a), RoomMember(room_id=room.id, user_id=b)])
        await s.commit()
        return room.id


async def add_message(room_id: int, sender_id: int, body: str = "xin chào", client_id: str | None = None) -> int:
    async with SessionLocal() as s:
        msg = Message(room_id=room_id, sender_id=sender_id, body=body, client_id=client_id)
        s.add(msg)
        await s.commit()
        return msg.id


async def token_for(client, username: str) -> str:
    r = await login(client, username)
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


def auth_headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


@dataclass
class LiveServer:
    http: str
    ws: str
    app: object = None


@pytest_asyncio.fixture
async def live_server():
    """Chạy ứng dụng thật (có lifespan, Hub và Redis thật) trên cổng ngẫu nhiên trong cùng event loop."""
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    app = create_app()
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", lifespan="on", ws_max_size=65536)
    server = uvicorn.Server(config)
    task = asyncio.create_task(server.serve())
    for _ in range(200):
        if server.started:
            break
        await asyncio.sleep(0.05)
    else:
        raise RuntimeError("uvicorn không khởi động được")
    try:
        yield LiveServer(http=f"http://127.0.0.1:{port}", ws=f"ws://127.0.0.1:{port}", app=app)
    finally:
        server.should_exit = True
        await task
