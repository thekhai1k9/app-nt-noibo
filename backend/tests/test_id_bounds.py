import pytest

BIG32 = 2**31
BIG64 = 2**63
VALID_USER_BODY = {"username": "newbie", "full_name": "Newbie", "branch_id": 1}

# (role, method, url, json) - mọi id vượt cận phải trả 422, không bao giờ 500
OVERSIZED = [
    ("member", "GET", f"/api/rooms/{BIG32}/messages", None),
    ("member", "GET", f"/api/rooms/1/messages?before={BIG64}", None),
    ("member", "GET", f"/api/rooms/1/messages?after={BIG64}", None),
    ("member", "GET", f"/api/rooms/1/messages?around={BIG64}", None),
    ("member", "POST", "/api/rooms/direct", {"user_id": BIG32}),
    ("member", "POST", f"/api/rooms/{BIG32}/read", {"message_id": 1}),
    ("member", "POST", "/api/rooms/1/read", {"message_id": BIG64}),
    ("member", "PATCH", f"/api/messages/{BIG64}", {"body": "x"}),
    ("member", "DELETE", f"/api/messages/{BIG64}", None),
    ("admin", "GET", f"/api/admin/rooms/{BIG32}", None),
    ("admin", "PATCH", f"/api/admin/rooms/{BIG32}", {"name": "x"}),
    ("admin", "DELETE", f"/api/admin/rooms/{BIG32}", None),
    ("admin", "POST", f"/api/admin/rooms/{BIG32}/members", {"user_id": 1}),
    ("admin", "POST", "/api/admin/rooms/1/members", {"user_id": BIG32}),
    ("admin", "DELETE", f"/api/admin/rooms/{BIG32}/members/1", None),
    ("admin", "DELETE", f"/api/admin/rooms/1/members/{BIG32}", None),
    ("admin", "POST", "/api/admin/rooms", {"name": "x", "branch_id": BIG32}),
    ("admin", "POST", "/api/admin/rooms", {"name": "x", "member_ids": [BIG32]}),
    ("admin", "GET", f"/api/admin/rooms?branch_id={BIG32}", None),
    ("admin", "GET", f"/api/admin/users?branch_id={BIG32}", None),
    ("admin", "POST", "/api/admin/users", {**VALID_USER_BODY, "branch_id": BIG32}),
    ("admin", "PATCH", f"/api/admin/users/{BIG32}", {"full_name": "x"}),
    ("admin", "PATCH", "/api/admin/users/1", {"branch_id": BIG32}),
    ("admin", "POST", f"/api/admin/users/{BIG32}/reset-password", None),
    ("admin", "PATCH", f"/api/admin/branches/{BIG32}", {"name": "x"}),
    ("admin", "DELETE", f"/api/admin/branches/{BIG32}", None),
]

# GET có id trên path: 0 và số âm cũng là 422
NON_POSITIVE = [
    ("member", "/api/rooms/{x}/messages"),
    ("admin", "/api/admin/rooms/{x}"),
]


@pytest.mark.parametrize("role,method,url,body", OVERSIZED, ids=[f"{m} {u}" for _, m, u, _ in OVERSIZED])
async def test_oversized_ids_return_422(client, admin_headers, member_headers, role, method, url, body):
    headers = admin_headers if role == "admin" else member_headers
    r = await client.request(method, url, json=body, headers=headers)
    assert r.status_code == 422, r.text


@pytest.mark.parametrize("role,template", NON_POSITIVE)
@pytest.mark.parametrize("value", [0, -1])
async def test_non_positive_path_ids_return_422(client, admin_headers, member_headers, role, template, value):
    headers = admin_headers if role == "admin" else member_headers
    r = await client.get(template.format(x=value), headers=headers)
    assert r.status_code == 422, r.text


async def test_the_largest_valid_ids_still_reach_the_handlers(client, admin_headers, member_headers):
    assert (await client.get(f"/api/rooms/{2**31 - 1}/messages", headers=member_headers)).status_code == 404
    assert (await client.get(f"/api/rooms/1/messages?before={2**63 - 1}", headers=member_headers)).status_code == 404
    assert (await client.get(f"/api/admin/rooms/{2**31 - 1}", headers=admin_headers)).status_code == 404
