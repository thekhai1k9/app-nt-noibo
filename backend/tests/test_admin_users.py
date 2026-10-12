from tests.conftest import create_branch, create_user, login


async def test_requires_admin(client, member_headers):
    assert (await client.get("/api/admin/users")).status_code == 401
    r = await client.get("/api/admin/users", headers=member_headers)
    assert r.status_code == 403


async def test_create_user_returns_temp_password_and_can_login(client, admin_headers):
    bid = await create_branch(name="Đà Nẵng", code="ĐN")
    r = await client.post(
        "/api/admin/users",
        headers=admin_headers,
        json={"username": "Ngoc.Vo", "full_name": "Võ Bảo Ngọc", "branch_id": bid},
    )
    assert r.status_code == 201
    body = r.json()
    assert body["username"] == "ngoc.vo"  # chuẩn hoá về chữ thường
    assert body["role"] == "member"
    assert body["must_change_password"] is True
    assert len(body["temp_password"]) == 12
    assert "password_hash" not in body

    first = await login(client, "ngoc.vo", body["temp_password"])
    assert first.status_code == 200
    assert first.json()["must_change_password"] is True


async def test_temp_password_not_exposed_by_list(client, admin_headers):
    listing = await client.get("/api/admin/users", headers=admin_headers)
    assert all("temp_password" not in u for u in listing.json())


async def test_create_duplicate_username(client, admin_headers):
    bid = await create_branch(name="B", code="B")
    payload = {"username": "dup.user", "full_name": "A", "branch_id": bid}
    assert (await client.post("/api/admin/users", headers=admin_headers, json=payload)).status_code == 201
    r = await client.post("/api/admin/users", headers=admin_headers, json=payload)
    assert r.status_code == 409
    assert r.json()["detail"] == "username_taken"


async def test_create_with_unknown_branch(client, admin_headers):
    r = await client.post(
        "/api/admin/users",
        headers=admin_headers,
        json={"username": "someone", "full_name": "A", "branch_id": 9999},
    )
    assert r.status_code == 404
    assert r.json()["detail"] == "branch_not_found"


async def test_create_validates_username_and_role(client, admin_headers):
    bid = await create_branch(name="B", code="B")
    bad_name = await client.post(
        "/api/admin/users", headers=admin_headers, json={"username": "a b", "full_name": "A", "branch_id": bid}
    )
    assert bad_name.status_code == 422
    bad_role = await client.post(
        "/api/admin/users",
        headers=admin_headers,
        json={"username": "valid.name", "full_name": "A", "branch_id": bid, "role": "root"},
    )
    assert bad_role.status_code == 422


async def test_list_filters(client, admin_headers):
    hn = await create_branch(name="Hà Nội", code="HN")
    dn = await create_branch(name="Đà Nẵng", code="ĐN")
    await create_user("anh.nguyen", branch_id=hn)
    await create_user("ha.le", branch_id=dn)
    await create_user("khoa.user", branch_id=dn, active=False)

    by_branch = await client.get(f"/api/admin/users?branch_id={dn}", headers=admin_headers)
    assert {u["username"] for u in by_branch.json()} == {"ha.le", "khoa.user"}

    active_only = await client.get(f"/api/admin/users?branch_id={dn}&is_active=true", headers=admin_headers)
    assert {u["username"] for u in active_only.json()} == {"ha.le"}

    search = await client.get("/api/admin/users?q=anh", headers=admin_headers)
    assert [u["username"] for u in search.json()] == ["anh.nguyen"]


async def test_deactivate_user_revokes_sessions_and_blocks_token(client, admin_headers):
    uid = await create_user("victim")
    # Dùng client riêng để cookie của nạn nhân không lẫn với client của admin.
    from httpx import ASGITransport, AsyncClient

    from app.main import create_app

    async with AsyncClient(transport=ASGITransport(app=create_app()), base_url="http://test") as victim:
        r = await login(victim, "victim")
        token = r.json()["access_token"]
        assert (await victim.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})).status_code == 200

        patch = await client.patch(f"/api/admin/users/{uid}", headers=admin_headers, json={"is_active": False})
        assert patch.status_code == 200
        assert patch.json()["is_active"] is False

        assert (await victim.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})).status_code == 401
        assert (await victim.post("/api/auth/refresh")).status_code == 401
        assert (await login(victim, "victim")).status_code == 401


async def test_update_user_fields(client, admin_headers):
    other = await create_branch(name="TP.HCM", code="HCM")
    uid = await create_user("alice")
    r = await client.patch(
        f"/api/admin/users/{uid}",
        headers=admin_headers,
        json={"full_name": "Alice Mới", "branch_id": other, "role": "admin"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["full_name"] == "Alice Mới"
    assert body["branch_id"] == other
    assert body["role"] == "admin"


async def test_update_unknown_user_and_branch(client, admin_headers):
    assert (await client.patch("/api/admin/users/999", headers=admin_headers, json={"full_name": "X"})).status_code == 404
    uid = await create_user("alice")
    r = await client.patch(f"/api/admin/users/{uid}", headers=admin_headers, json={"branch_id": 9999})
    assert r.status_code == 404
    assert r.json()["detail"] == "branch_not_found"


async def test_admin_cannot_demote_or_lock_self(client, admin_headers):
    me = (await client.get("/api/auth/me", headers=admin_headers)).json()["id"]
    demote = await client.patch(f"/api/admin/users/{me}", headers=admin_headers, json={"role": "member"})
    assert demote.status_code == 409
    assert demote.json()["detail"] == "cannot_modify_self"
    lock = await client.patch(f"/api/admin/users/{me}", headers=admin_headers, json={"is_active": False})
    assert lock.status_code == 409
    # Đổi tên chính mình thì vẫn được.
    rename = await client.patch(f"/api/admin/users/{me}", headers=admin_headers, json={"full_name": "Tên mới"})
    assert rename.status_code == 200


async def test_reset_password(client, admin_headers):
    uid = await create_user("alice")
    r = await client.post(f"/api/admin/users/{uid}/reset-password", headers=admin_headers)
    assert r.status_code == 200
    temp = r.json()["temp_password"]
    assert len(temp) == 12
    assert (await login(client, "alice")).status_code == 401  # mật khẩu cũ không còn dùng được
    again = await login(client, "alice", temp)
    assert again.status_code == 200
    assert again.json()["must_change_password"] is True


async def test_reset_password_unknown_user(client, admin_headers):
    r = await client.post("/api/admin/users/999/reset-password", headers=admin_headers)
    assert r.status_code == 404
    assert r.json()["detail"] == "user_not_found"


async def test_patch_ignores_null_fields(client, admin_headers):
    me = (await client.get("/api/auth/me", headers=admin_headers)).json()["id"]
    r = await client.patch(
        f"/api/admin/users/{me}", headers=admin_headers, json={"role": None, "full_name": "X"}
    )
    assert r.status_code == 200
    assert r.json()["role"] == "admin"
    assert r.json()["full_name"] == "X"


async def test_write_endpoints_require_admin(client, member_headers):
    uid = await create_user("target")
    calls = [
        ("post", "/api/admin/users", {"username": "newbie", "full_name": "A", "branch_id": 1}),
        ("patch", f"/api/admin/users/{uid}", {"full_name": "Y"}),
        ("post", f"/api/admin/users/{uid}/reset-password", None),
    ]
    for method, url, payload in calls:
        kwargs = {"json": payload} if payload is not None else {}
        anon = await getattr(client, method)(url, **kwargs)
        assert anon.status_code == 401, url
        member = await getattr(client, method)(url, headers=member_headers, **kwargs)
        assert member.status_code == 403, url
        assert member.json()["detail"] == "forbidden", url
