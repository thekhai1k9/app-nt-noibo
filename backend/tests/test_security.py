from datetime import datetime, timedelta, timezone

import jwt

from app.security import (
    create_access_token,
    decode_access_token,
    generate_temp_password,
    hash_password,
    hash_refresh_token,
    new_refresh_token,
    verify_password,
)


def test_password_roundtrip():
    h = hash_password("Passw0rd!")
    assert h != "Passw0rd!"
    assert verify_password(h, "Passw0rd!") is True
    assert verify_password(h, "wrong") is False


def test_verify_password_rejects_garbage_hash():
    assert verify_password("not-a-hash", "x") is False


def test_access_token_roundtrip():
    assert decode_access_token(create_access_token(42)) == 42


def test_decode_rejects_garbage():
    assert decode_access_token("garbage") is None


def test_decode_rejects_wrong_signature():
    token = jwt.encode(
        {"sub": "1", "typ": "access", "exp": datetime.now(timezone.utc) + timedelta(minutes=5)},
        "other-secret",
        algorithm="HS256",
    )
    assert decode_access_token(token) is None


def test_decode_rejects_expired():
    token = jwt.encode(
        {"sub": "1", "typ": "access", "exp": datetime.now(timezone.utc) - timedelta(seconds=1)},
        "test-secret",
        algorithm="HS256",
    )
    assert decode_access_token(token) is None


def test_decode_rejects_other_token_type():
    token = jwt.encode(
        {"sub": "1", "typ": "refresh", "exp": datetime.now(timezone.utc) + timedelta(minutes=5)},
        "test-secret",
        algorithm="HS256",
    )
    assert decode_access_token(token) is None


def test_refresh_token_hash_matches():
    raw, hashed = new_refresh_token()
    assert hash_refresh_token(raw) == hashed
    assert len(hashed) == 64
    assert new_refresh_token()[0] != raw


def test_temp_password_shape():
    pw = generate_temp_password()
    assert len(pw) == 12
    assert not set(pw) & set("0O1lI")
    assert generate_temp_password() != pw
