from datetime import datetime, timedelta, timezone

from fastapi import Response
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models import RefreshToken, User
from app.schemas import TokenOut
from app.security import create_access_token, new_refresh_token

COOKIE_NAME = "refresh_token"
COOKIE_PATH = "/api/auth"


async def issue_session(session: AsyncSession, response: Response, user: User) -> TokenOut:
    """Tạo refresh token mới, đặt cookie, commit, rồi trả access token."""
    settings = get_settings()
    raw, token_hash = new_refresh_token()
    session.add(
        RefreshToken(
            user_id=user.id,
            token_hash=token_hash,
            expires_at=datetime.now(timezone.utc) + timedelta(days=settings.refresh_token_days),
        )
    )
    await session.commit()
    response.set_cookie(
        COOKIE_NAME,
        raw,
        max_age=settings.refresh_token_days * 86400,
        httponly=True,
        secure=settings.cookie_secure,
        samesite=settings.cookie_samesite,
        path=COOKIE_PATH,
    )
    return TokenOut(access_token=create_access_token(user.id), must_change_password=user.must_change_password)


async def revoke_all_refresh_tokens(session: AsyncSession, user_id: int) -> None:
    """Thu hồi mọi refresh token còn hiệu lực của user. Người gọi tự commit."""
    await session.execute(
        update(RefreshToken)
        .where(RefreshToken.user_id == user_id, RefreshToken.revoked_at.is_(None))
        .values(revoked_at=datetime.now(timezone.utc))
    )
