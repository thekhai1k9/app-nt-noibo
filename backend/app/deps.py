from fastapi import Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models import User
from app.security import decode_access_token


async def get_current_user(request: Request, session: AsyncSession = Depends(get_session)) -> User:
    scheme, _, token = request.headers.get("authorization", "").partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(status_code=401, detail="not_authenticated")
    user_id = decode_access_token(token)
    if user_id is None:
        raise HTTPException(status_code=401, detail="not_authenticated")
    user = await session.get(User, user_id)
    if user is None or not user.is_active:
        raise HTTPException(status_code=401, detail="not_authenticated")
    return user


async def get_ready_user(user: User = Depends(get_current_user)) -> User:
    if user.must_change_password:
        raise HTTPException(status_code=403, detail="password_change_required")
    return user


async def require_admin(user: User = Depends(get_ready_user)) -> User:
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="forbidden")
    return user
