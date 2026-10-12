from tests.conftest import create_branch, create_user


async def test_requires_authentication(client):
    assert (await client.get("/api/admin/branches")).status_code == 401


async def test_member_is_forbidden(client, member_headers):
    r = await client.get("/api/admin/branches", headers=member_headers)
    assert r.status_code == 403
    assert r.json()["detail"] == "forbidden"


async def test_create_and_list_with_user_count(client, admin_headers):
    r = await client.post(
        "/api/admin/branches",
        headers=admin_headers,
        json={"name": "Đà Nẵng", "code": "ĐN", "address": "Hải Châu"},
    )
    assert r.status_code == 201
    created = r.json()
    assert created["user_count"] == 0

    await create_user("hanoi.user", branch_id=created["id"])
    listing = await client.get("/api/admin/branches", headers=admin_headers)
    assert listing.status_code == 200
    by_code = {b["code"]: b for b in listing.json()}
    assert by_code["ĐN"]["user_count"] == 1
    assert by_code["ĐN"]["address"] == "Hải Châu"


async def test_create_duplicate_name_or_code(client, admin_headers):
    await create_branch(name="Hà Nội", code="HN")
    r1 = await client.post("/api/admin/branches", headers=admin_headers, json={"name": "Hà Nội", "code": "X"})
    assert r1.status_code == 409
    assert r1.json()["detail"] == "branch_exists"
    r2 = await client.post("/api/admin/branches", headers=admin_headers, json={"name": "Khác", "code": "HN"})
    assert r2.status_code == 409
    assert r2.json()["detail"] == "branch_exists"


async def test_create_validates_input(client, admin_headers):
    r = await client.post("/api/admin/branches", headers=admin_headers, json={"name": "", "code": "X"})
    assert r.status_code == 422
    r = await client.post("/api/admin/branches", headers=admin_headers, json={"name": "A", "code": "x" * 11})
    assert r.status_code == 422


async def test_update_branch(client, admin_headers):
    bid = await create_branch(name="Hà Nội", code="HN")
    r = await client.patch(f"/api/admin/branches/{bid}", headers=admin_headers, json={"address": "Cầu Giấy"})
    assert r.status_code == 200
    assert r.json()["address"] == "Cầu Giấy"
    assert r.json()["name"] == "Hà Nội"


async def test_update_to_existing_code_conflicts(client, admin_headers):
    await create_branch(name="Hà Nội", code="HN")
    other = await create_branch(name="Đà Nẵng", code="ĐN")
    r = await client.patch(f"/api/admin/branches/{other}", headers=admin_headers, json={"code": "HN"})
    assert r.status_code == 409


async def test_update_unknown_branch(client, admin_headers):
    r = await client.patch("/api/admin/branches/999", headers=admin_headers, json={"name": "X"})
    assert r.status_code == 404
    assert r.json()["detail"] == "branch_not_found"


async def test_delete_empty_branch(client, admin_headers):
    bid = await create_branch(name="Tạm", code="TMP")
    assert (await client.delete(f"/api/admin/branches/{bid}", headers=admin_headers)).status_code == 204
    listing = await client.get("/api/admin/branches", headers=admin_headers)
    assert "TMP" not in {b["code"] for b in listing.json()}


async def test_delete_branch_with_users_is_blocked(client, admin_headers):
    bid = await create_branch(name="Có người", code="CN")
    await create_user("someone", branch_id=bid)
    r = await client.delete(f"/api/admin/branches/{bid}", headers=admin_headers)
    assert r.status_code == 409
    assert r.json()["detail"] == "branch_has_users"


async def test_member_forbidden_on_write_endpoints(client, member_headers):
    for method, url, kw in [
        ("post", "/api/admin/branches", {"json": {"name": "A", "code": "A"}}),
        ("patch", "/api/admin/branches/1", {"json": {"name": "B"}}),
        ("delete", "/api/admin/branches/1", {}),
    ]:
        r = await getattr(client, method)(url, headers=member_headers, **kw)
        assert r.status_code == 403
        assert r.json()["detail"] == "forbidden"


async def test_write_endpoints_require_authentication(client):
    assert (await client.post("/api/admin/branches", json={"name": "A", "code": "A"})).status_code == 401
    assert (await client.patch("/api/admin/branches/1", json={"name": "B"})).status_code == 401
    assert (await client.delete("/api/admin/branches/1")).status_code == 401


async def test_delete_unknown_branch(client, admin_headers):
    r = await client.delete("/api/admin/branches/999", headers=admin_headers)
    assert r.status_code == 404
    assert r.json()["detail"] == "branch_not_found"


async def test_update_ignores_explicit_nulls(client, admin_headers):
    bid = await create_branch(name="Hà Nội", code="HN")
    r = await client.patch(
        f"/api/admin/branches/{bid}", headers=admin_headers, json={"name": None, "address": "X"}
    )
    assert r.status_code == 200
    assert r.json()["name"] == "Hà Nội"
    assert r.json()["address"] == "X"


async def test_update_to_existing_name_conflicts(client, admin_headers):
    await create_branch(name="Hà Nội", code="HN")
    other = await create_branch(name="Đà Nẵng", code="ĐN")
    r = await client.patch(f"/api/admin/branches/{other}", headers=admin_headers, json={"name": "Hà Nội"})
    assert r.status_code == 409
    assert r.json()["detail"] == "branch_exists"


async def test_update_same_name_and_code_on_same_branch(client, admin_headers):
    bid = await create_branch(name="Hà Nội", code="HN")
    r = await client.patch(
        f"/api/admin/branches/{bid}", headers=admin_headers, json={"name": "Hà Nội", "code": "HN"}
    )
    assert r.status_code == 200
