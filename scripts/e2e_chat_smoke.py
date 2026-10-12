"""Kiểm tra đầu-cuối: admin tạo 2 người dùng và 1 nhóm, hai người nhắn tin qua WebSocket qua Caddy.

Chạy trong container api (có websockets):
    docker compose exec -T api python /dev/stdin --base http://caddy --admin-user X --admin-temp-password Y < scripts/e2e_chat_smoke.py
"""
import argparse
import asyncio
import json
import sys
import urllib.error
import urllib.request

from websockets.asyncio.client import connect


def _parse(raw):
    try:
        return json.loads(raw) if raw else None
    except ValueError:
        raise AssertionError(f"response body is not JSON: {raw[:200]!r}") from None


def http(base, method, path, token=None, body=None):
    request = urllib.request.Request(
        f"{base}/api{path}",
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {token}"} if token else {})},
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            raw = response.read()
            return response.status, _parse(raw)
    except urllib.error.HTTPError as err:
        return err.code, _parse(err.read())


def login(base, username, password):
    status, body = http(base, "POST", "/auth/login", body={"username": username, "password": password})
    assert status == 200, (status, body)
    return body["access_token"], body["must_change_password"]


def ready_token(base, username, temp_password, new_password):
    token, must_change = login(base, username, temp_password)
    if must_change:
        status, body = http(
            base, "POST", "/auth/change-password", token,
            {"current_password": temp_password, "new_password": new_password},
        )
        assert status == 200, (status, body)
        token = body["access_token"]
    return token


async def open_ws(base, token):
    ws = await connect(base.replace("http", "ws", 1) + "/api/ws")
    await ws.send(json.dumps({"type": "auth", "token": token}))
    ready = json.loads(await asyncio.wait_for(ws.recv(), 5))
    assert ready["type"] == "ready", ready
    return ws


async def main(args):
    base = args.base.rstrip("/")
    admin = ready_token(base, args.admin_user, args.admin_temp_password, "E2eAdminPassw0rd!")

    status, branches = http(base, "GET", "/admin/branches", admin)
    assert status == 200 and branches, (status, branches)
    branch_id = branches[0]["id"]
    users = {}
    for name in ("e2e.alice", "e2e.bob"):
        status, created = http(
            base, "POST", "/admin/users", admin,
            {"username": name, "full_name": name.title(), "branch_id": branch_id, "role": "member"},
        )
        assert status == 201, (status, created)
        users[name] = (created["id"], created["temp_password"])
    tokens = {name: ready_token(base, name, pw, "E2eUserPassw0rd!") for name, (_, pw) in users.items()}

    status, room = http(
        base, "POST", "/admin/rooms", admin,
        {"name": "E2E nhóm", "branch_id": branch_id, "member_ids": [uid for uid, _ in users.values()]},
    )
    assert status == 201, (status, room)
    room_id = room["id"]

    sockets = []
    try:
        await run_chat_checks(base, admin, users, tokens, room_id, sockets)
    finally:
        for ws in sockets:
            await ws.close()
    print("OK")


async def run_chat_checks(base, admin, users, tokens, room_id, sockets):
    alice = await open_ws(base, tokens["e2e.alice"])
    sockets.append(alice)
    bob = await open_ws(base, tokens["e2e.bob"])
    sockets.append(bob)
    await alice.send(json.dumps({"type": "send", "room_id": room_id, "body": "xin chào từ Alice", "client_id": "e2e-1"}))
    mine = json.loads(await asyncio.wait_for(alice.recv(), 5))
    theirs = json.loads(await asyncio.wait_for(bob.recv(), 5))
    assert mine["type"] == theirs["type"] == "message", (mine, theirs)
    assert theirs["message"]["body"] == "xin chào từ Alice" and mine["message"]["client_id"] == "e2e-1"

    status, page = http(base, "GET", f"/rooms/{room_id}/messages", tokens["e2e.bob"])
    assert status == 200 and [m["body"] for m in page["items"]] == ["xin chào từ Alice"], (status, page)
    status, rooms = http(base, "GET", "/rooms", tokens["e2e.bob"])
    assert status == 200 and rooms[0]["unread_count"] == 1, (status, rooms)

    status, denied = http(base, "GET", f"/rooms/{room_id}/messages", admin)  # admin không phải thành viên
    assert (status, denied) == (404, {"detail": "room_not_found"}), (status, denied)

    status, _ = http(base, "PATCH", f"/admin/users/{users['e2e.alice'][0]}", admin, {"is_active": False})
    assert status == 200
    await asyncio.wait_for(alice.wait_closed(), 5)
    assert alice.protocol.close_code == 4403, alice.protocol.close_code


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", required=True)
    parser.add_argument("--admin-user", required=True)
    parser.add_argument("--admin-temp-password", required=True)
    try:
        asyncio.run(main(parser.parse_args()))
    except AssertionError as err:
        print("FAIL:", err)
        sys.exit(1)
