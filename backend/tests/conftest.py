import os

os.environ["DATABASE_URL"] = os.environ.get(
    "TEST_DATABASE_URL", "postgresql+asyncpg://messaging:messaging@localhost:5432/messaging_test"
)
os.environ["REDIS_URL"] = os.environ.get("TEST_REDIS_URL", "redis://localhost:6379/1")
os.environ["JWT_SECRET"] = "test-secret"
os.environ["APP_ENV"] = "test"
os.environ["COOKIE_SECURE"] = "false"
os.environ["LOGIN_MAX_ATTEMPTS"] = "3"

import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text

from app import models  # noqa: F401  (đăng ký các bảng vào Base.metadata)
from app.db import Base, SessionLocal, engine
from app.main import create_app
from app.models import Branch, User
from app.redis_client import get_redis
from app.security import hash_password

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
        await conn.execute(text("TRUNCATE refresh_tokens, users, branches RESTART IDENTITY CASCADE"))
    await get_redis().flushdb()
    yield


@pytest_asyncio.fixture
async def client():
    app = create_app()
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
