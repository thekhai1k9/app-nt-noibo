from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db import get_session
from app.deps import get_current_user
from app.models import RefreshToken, User
from app.ratelimit import clear, is_blocked, register_failure
from app.redis_client import get_redis
from app.schemas import ChangePasswordIn, LoginIn, TokenOut, UserOut
from app.security import hash_password, hash_refresh_token, verify_password
from app.sessions import COOKIE_NAME, COOKIE_PATH, issue_session, revoke_all_refresh_tokens

router = APIRouter(prefix="/auth", tags=["auth"])

# Dùng khi username không tồn tại, để thời gian phản hồi không lộ việc tài khoản có hay không.
_DUMMY_HASH = hash_password("dummy-password-for-timing")


@router.post("/login", response_model=TokenOut)
async def login(
    body: LoginIn,
    request: Request,
    response: Response,
    session: AsyncSession = Depends(get_session),
    redis=Depends(get_redis),
) -> TokenOut:
    settings = get_settings()
    username = body.username.strip().lower()
    client_ip = request.client.host if request.client else "unknown"
    key = f"login-fail:{username}:{client_ip}"

    if await is_blocked(redis, key, settings.login_max_attempts):
        raise HTTPException(status_code=429, detail="too_many_attempts")

    user = (await session.execute(select(User).where(User.username == username))).scalar_one_or_none()
    password_ok = verify_password(user.password_hash if user else _DUMMY_HASH, body.password)
    if user is None or not user.is_active or not password_ok:
        await register_failure(redis, key, settings.login_window_seconds)
        raise HTTPException(status_code=401, detail="invalid_credentials")

    await clear(redis, key)
    user.last_login_at = datetime.now(timezone.utc)
    return await issue_session(session, response, user)


@router.post("/refresh", response_model=TokenOut)
async def refresh(
    request: Request,
    response: Response,
    session: AsyncSession = Depends(get_session),
) -> TokenOut:
    raw = request.cookies.get(COOKIE_NAME)
    if not raw:
        raise HTTPException(status_code=401, detail="invalid_refresh")
    row = (
        await session.execute(select(RefreshToken).where(RefreshToken.token_hash == hash_refresh_token(raw)))
    ).scalar_one_or_none()
    now = datetime.now(timezone.utc)
    if row is None or row.revoked_at is not None or row.expires_at <= now:
        raise HTTPException(status_code=401, detail="invalid_refresh")
    user = await session.get(User, row.user_id)
    if user is None or not user.is_active:
        raise HTTPException(status_code=401, detail="invalid_refresh")
    row.revoked_at = now  # xoay vòng: token cũ chết ngay khi cấp token mới
    return await issue_session(session, response, user)


@router.post("/logout", status_code=204)
async def logout(
    request: Request,
    response: Response,
    session: AsyncSession = Depends(get_session),
) -> None:
    raw = request.cookies.get(COOKIE_NAME)
    if raw:
        row = (
            await session.execute(select(RefreshToken).where(RefreshToken.token_hash == hash_refresh_token(raw)))
        ).scalar_one_or_none()
        if row is not None and row.revoked_at is None:
            row.revoked_at = datetime.now(timezone.utc)
            await session.commit()
    response.delete_cookie(COOKIE_NAME, path=COOKIE_PATH)


@router.get("/me", response_model=UserOut)
async def me(user: User = Depends(get_current_user)) -> User:
    return user


@router.post("/change-password", response_model=TokenOut)
async def change_password(
    body: ChangePasswordIn,
    response: Response,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> TokenOut:
    # get_current_user và endpoint này dùng chung một AsyncSession trong cùng request
    # (FastAPI cache dependency), nên `user` đã gắn với `session`.
    if not verify_password(user.password_hash, body.current_password):
        raise HTTPException(status_code=400, detail="wrong_current_password")
    if body.new_password == body.current_password:
        raise HTTPException(status_code=400, detail="password_unchanged")
    user.password_hash = hash_password(body.new_password)
    user.must_change_password = False
    await revoke_all_refresh_tokens(session, user.id)
    return await issue_session(session, response, user)
