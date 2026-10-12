import pytest
from httpx import ASGITransport, AsyncClient
from pydantic import ValidationError
from redis.exceptions import ConnectionError as RedisConnectionError

from app.config import Settings, get_settings
from app.main import DEFAULT_SECRET, ENV_EXAMPLE_SECRET, create_app, lifespan
from app.redis_client import get_redis
from tests.conftest import create_user

GOOD_SECRET = "a1" * 32  # 64 ký tự hex


@pytest.fixture
def prod_env(monkeypatch):
    def _set(secret: str):
        monkeypatch.setenv("APP_ENV", "prod")
        monkeypatch.setenv("JWT_SECRET", secret)
        get_settings.cache_clear()

    yield _set
    monkeypatch.undo()
    get_settings.cache_clear()


async def _start(app):
    async with lifespan(app):
        pass


async def test_prod_refuses_default_secret(prod_env):
    prod_env(DEFAULT_SECRET)
    with pytest.raises(RuntimeError):
        await _start(create_app())


async def test_prod_refuses_env_example_placeholder(prod_env):
    prod_env(ENV_EXAMPLE_SECRET)
    with pytest.raises(RuntimeError):
        await _start(create_app())


async def test_prod_refuses_short_secret(prod_env):
    prod_env("x" * 31)
    with pytest.raises(RuntimeError):
        await _start(create_app())


async def test_prod_accepts_strong_secret(prod_env):
    prod_env(GOOD_SECRET)
    await _start(create_app())


def test_settings_reject_unknown_app_env(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    with pytest.raises(ValidationError):
        Settings()


async def test_docs_disabled_in_prod_enabled_in_test(prod_env, monkeypatch):
    async with AsyncClient(transport=ASGITransport(app=create_app()), base_url="http://test") as c:
        assert (await c.get("/api/docs")).status_code == 200
        assert (await c.get("/api/openapi.json")).status_code == 200
    prod_env(GOOD_SECRET)
    async with AsyncClient(transport=ASGITransport(app=create_app()), base_url="http://test") as c:
        assert (await c.get("/api/docs")).status_code == 404
        assert (await c.get("/api/openapi.json")).status_code == 404


class _BrokenRedis:
    def pipeline(self, *args, **kwargs):
        raise RedisConnectionError("redis down")


async def test_redis_down_returns_503():
    await create_user("alice")
    app = create_app()
    app.dependency_overrides[get_redis] = lambda: _BrokenRedis()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        r = await c.post("/api/auth/login", json={"username": "alice", "password": "Passw0rd!"})
    assert r.status_code == 503
    assert r.json() == {"detail": "service_unavailable"}
