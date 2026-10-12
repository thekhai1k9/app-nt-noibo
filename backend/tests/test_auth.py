import asyncio
from datetime import datetime, timedelta, timezone

import jwt
from sqlalchemy import update

from app.db import SessionLocal
from app.models import RefreshToken, User

from tests.conftest import TEST_PASSWORD, create_user, login


async def test_login_success_sets_cookie_and_returns_token(client):
    await create_user("alice")
    r = await login(client, "alice")
    assert r.status_code == 200
    body = r.json()
    assert body["token_type"] == "bearer"
    assert body["must_change_password"] is False
    cookie = r.headers["set-cookie"].lower()
    assert "refresh_token=" in cookie
    assert "httponly" in cookie
    assert "path=/api/auth" in cookie
    assert "samesite=lax" in cookie


async def test_login_normalizes_username(client):
    await create_user("long.pham")
    r = await client.post("/api/auth/login", json={"username": "  Long.Pham ", "password": TEST_PASSWORD})
    assert r.status_code == 200


async def test_login_wrong_password(client):
    await create_user("alice")
    r = await login(client, "alice", "wrong-password")
    assert r.status_code == 401
    assert r.json()["detail"] == "invalid_credentials"


async def test_login_unknown_user_same_error(client):
    r = await login(client, "nobody")
    assert r.status_code == 401
    assert r.json()["detail"] == "invalid_credentials"


async def test_login_inactive_user_rejected(client):
    await create_user("alice", active=False)
    r = await login(client, "alice")
    assert r.status_code == 401
    assert r.json()["detail"] == "invalid_credentials"


async def test_login_rejects_huge_password(client):
    await create_user("alice")
    r = await client.post("/api/auth/login", json={"username": "alice", "password": "x" * 10_000})
    assert r.status_code == 422


async def test_login_rate_limited_after_failures(client):
    await create_user("alice")
    for _ in range(3):  # LOGIN_MAX_ATTEMPTS=3 trong conftest
        assert (await login(client, "alice", "bad")).status_code == 401
    r = await login(client, "alice", "bad")
    assert r.status_code == 429
    assert r.json()["detail"] == "too_many_attempts"
    # Đúng mật khẩu nhưng đang bị khoá thì vẫn bị chặn.
    assert (await login(client, "alice")).status_code == 429


async def test_successful_login_resets_failure_counter(client):
    await create_user("alice")
    for _ in range(2):
        await login(client, "alice", "bad")
    assert (await login(client, "alice")).status_code == 200
    for _ in range(2):
        assert (await login(client, "alice", "bad")).status_code == 401


async def test_me_requires_token(client):
    r = await client.get("/api/auth/me")
    assert r.status_code == 401
    assert r.json()["detail"] == "not_authenticated"


async def test_me_returns_profile(client):
    await create_user("alice")
    token = (await login(client, "alice")).json()["access_token"]
    r = await client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    assert r.json()["username"] == "alice"
    assert "password_hash" not in r.json()


async def test_expired_access_token_rejected(client):
    uid = await create_user("alice")
    token = jwt.encode(
        {"sub": str(uid), "typ": "access", "exp": datetime.now(timezone.utc) - timedelta(seconds=1)},
        "test-secret",
        algorithm="HS256",
    )
    r = await client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 401
    assert r.json()["detail"] == "not_authenticated"


async def test_refresh_rotates_token_and_old_one_is_dead(client):
    await create_user("alice")
    await login(client, "alice")
    old_cookie = client.cookies.get("refresh_token")

    r = await client.post("/api/auth/refresh")
    assert r.status_code == 200
    assert r.json()["access_token"]
    assert client.cookies.get("refresh_token") != old_cookie

    reuse = await client.post("/api/auth/refresh", headers={"cookie": f"refresh_token={old_cookie}"})
    assert reuse.status_code == 401
    assert reuse.json()["detail"] == "invalid_refresh"


async def test_refresh_without_cookie(client):
    r = await client.post("/api/auth/refresh")
    assert r.status_code == 401
    assert r.json()["detail"] == "invalid_refresh"


async def test_logout_revokes_refresh_token(client):
    await create_user("alice")
    await login(client, "alice")
    cookie = client.cookies.get("refresh_token")
    r = await client.post("/api/auth/logout")
    assert r.status_code == 204
    again = await client.post("/api/auth/refresh", headers={"cookie": f"refresh_token={cookie}"})
    assert again.status_code == 401


async def test_must_change_password_blocks_other_endpoints(client):
    await create_user("alice", must_change=True)
    r = await login(client, "alice")
    assert r.json()["must_change_password"] is True
    headers = {"Authorization": f"Bearer {r.json()['access_token']}"}
    assert (await client.get("/api/auth/me", headers=headers)).status_code == 200
    blocked = await client.get("/api/admin/users", headers=headers)
    assert blocked.status_code == 403
    assert blocked.json()["detail"] == "password_change_required"


async def test_change_password_flow(client):
    await create_user("alice", must_change=True)
    token = (await login(client, "alice")).json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}

    wrong = await client.post(
        "/api/auth/change-password",
        headers=headers,
        json={"current_password": "nope", "new_password": "NewPassw0rd!"},
    )
    assert wrong.status_code == 400
    assert wrong.json()["detail"] == "wrong_current_password"

    same = await client.post(
        "/api/auth/change-password",
        headers=headers,
        json={"current_password": TEST_PASSWORD, "new_password": TEST_PASSWORD},
    )
    assert same.status_code == 400
    assert same.json()["detail"] == "password_unchanged"

    short = await client.post(
        "/api/auth/change-password",
        headers=headers,
        json={"current_password": TEST_PASSWORD, "new_password": "short"},
    )
    assert short.status_code == 422

    ok = await client.post(
        "/api/auth/change-password",
        headers=headers,
        json={"current_password": TEST_PASSWORD, "new_password": "NewPassw0rd!"},
    )
    assert ok.status_code == 200
    assert ok.json()["must_change_password"] is False

    assert (await login(client, "alice", TEST_PASSWORD)).status_code == 401
    assert (await login(client, "alice", "NewPassw0rd!")).status_code == 200


async def test_change_password_revokes_other_sessions(client):
    await create_user("alice")
    await login(client, "alice")
    old_cookie = client.cookies.get("refresh_token")
    token = (await login(client, "alice")).json()["access_token"]
    r = await client.post(
        "/api/auth/change-password",
        headers={"Authorization": f"Bearer {token}"},
        json={"current_password": TEST_PASSWORD, "new_password": "NewPassw0rd!"},
    )
    assert r.status_code == 200
    stale = await client.post("/api/auth/refresh", headers={"cookie": f"refresh_token={old_cookie}"})
    assert stale.status_code == 401


async def test_deactivated_user_loses_access(client):
    uid = await create_user("alice")
    token = (await login(client, "alice")).json()["access_token"]
    async with SessionLocal() as s:
        await s.execute(update(User).where(User.id == uid).values(is_active=False))
        await s.commit()
    me = await client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert me.status_code == 401
    assert me.json()["detail"] == "not_authenticated"
    r = await client.post("/api/auth/refresh")
    assert r.status_code == 401
    assert r.json()["detail"] == "invalid_refresh"


async def test_expired_refresh_token_rejected(client):
    await create_user("alice")
    await login(client, "alice")
    async with SessionLocal() as s:
        await s.execute(update(RefreshToken).values(expires_at=datetime.now(timezone.utc) - timedelta(seconds=1)))
        await s.commit()
    r = await client.post("/api/auth/refresh")
    assert r.status_code == 401
    assert r.json()["detail"] == "invalid_refresh"


async def test_logout_without_cookie(client):
    assert (await client.post("/api/auth/logout")).status_code == 204


async def test_username_spellings_share_rate_limit_counter(client):
    await create_user("alice")
    for name in ("  ALICE ", "alice"):
        assert (await login(client, name, "bad")).status_code == 401
    assert (await login(client, "Alice", "bad")).status_code == 401
    assert (await login(client, "alice", "bad")).status_code == 429


async def test_change_password_new_cookie_still_refreshes(client):
    await create_user("alice")
    await login(client, "alice")
    old_cookie = client.cookies.get("refresh_token")
    token = (await login(client, "alice")).json()["access_token"]
    r = await client.post(
        "/api/auth/change-password",
        headers={"Authorization": f"Bearer {token}"},
        json={"current_password": TEST_PASSWORD, "new_password": "NewPassw0rd!"},
    )
    assert r.status_code == 200
    new_cookie = client.cookies.get("refresh_token")
    assert new_cookie != old_cookie
    ok = await client.post("/api/auth/refresh", headers={"cookie": f"refresh_token={new_cookie}"})
    assert ok.status_code == 200
    old = await client.post("/api/auth/refresh", headers={"cookie": f"refresh_token={old_cookie}"})
    assert old.status_code == 401


async def test_concurrent_refresh_only_one_wins(client):
    await create_user("alice")
    await login(client, "alice")
    cookie = client.cookies.get("refresh_token")
    client.cookies.clear()
    rs = await asyncio.gather(
        *[client.post("/api/auth/refresh", headers={"cookie": f"refresh_token={cookie}"}) for _ in range(2)]
    )
    assert sorted(r.status_code for r in rs) == [200, 401]


async def test_concurrent_login_burst_is_capped(client):
    await create_user("alice")
    rs = await asyncio.gather(*[login(client, "alice", "bad") for _ in range(10)])
    codes = [r.status_code for r in rs]
    assert codes.count(401) == 3
    assert codes.count(429) == 7
