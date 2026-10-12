import pytest

from app.config import get_settings
from app.main import DEFAULT_SECRET, create_app, lifespan


async def test_health_ok(client):
    r = await client.get("/api/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


async def test_prod_refuses_default_secret(monkeypatch):
    monkeypatch.setenv("APP_ENV", "prod")
    monkeypatch.setenv("JWT_SECRET", DEFAULT_SECRET)
    get_settings.cache_clear()
    try:
        with pytest.raises(RuntimeError):
            async with lifespan(create_app()):
                pass
    finally:
        monkeypatch.undo()
        get_settings.cache_clear()
