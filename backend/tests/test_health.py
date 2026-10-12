from app.main import create_app
from app.redis_client import get_redis
from httpx import ASGITransport, AsyncClient


async def test_health_ok(client):
    r = await client.get("/api/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


async def test_health_503_when_redis_down():
    class BrokenRedis:
        async def ping(self):
            raise ConnectionError("redis down")

    app = create_app()
    app.dependency_overrides[get_redis] = lambda: BrokenRedis()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        r = await c.get("/api/health")
    assert r.status_code == 503
    assert r.json()["detail"] == "unhealthy"
