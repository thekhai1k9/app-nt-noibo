import asyncio

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.chat.bus import MessageBus, publish_user_safely
from app.db import get_session
from app.deps import require_admin
from app.ids import BranchIdQuery, UserIdPath
from app.models import Branch, User
from app.routers.chat import get_bus
from app.schemas import ResetPasswordOut, UserCreate, UserCreated, UserOut, UserUpdate
from app.security import generate_temp_password, hash_password
from app.sessions import revoke_all_refresh_tokens

router = APIRouter(prefix="/admin/users", tags=["admin"])


async def _get_user_or_404(session: AsyncSession, user_id: int) -> User:
    user = await session.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="user_not_found")
    return user


async def _ensure_branch(session: AsyncSession, branch_id: int) -> None:
    if await session.get(Branch, branch_id) is None:
        raise HTTPException(status_code=404, detail="branch_not_found")


@router.get("", response_model=list[UserOut])
async def list_users(
    q: str | None = None,
    branch_id: BranchIdQuery = None,
    is_active: bool | None = None,
    session: AsyncSession = Depends(get_session),
    _admin: User = Depends(require_admin),
) -> list[User]:
    query = select(User).order_by(User.full_name)
    if q:
        like = f"%{q.strip()}%"
        query = query.where(or_(User.username.ilike(like), User.full_name.ilike(like)))
    if branch_id is not None:
        query = query.where(User.branch_id == branch_id)
    if is_active is not None:
        query = query.where(User.is_active == is_active)
    return list((await session.execute(query)).scalars().all())


@router.post("", response_model=UserCreated, status_code=201)
async def create_user(
    body: UserCreate,
    session: AsyncSession = Depends(get_session),
    _admin: User = Depends(require_admin),
) -> UserCreated:
    await _ensure_branch(session, body.branch_id)
    taken = (await session.execute(select(User.id).where(User.username == body.username))).first()
    if taken is not None:
        raise HTTPException(status_code=409, detail="username_taken")
    temp_password = generate_temp_password()
    user = User(
        username=body.username,
        full_name=body.full_name,
        branch_id=body.branch_id,
        role=body.role,
        password_hash=await asyncio.to_thread(hash_password, temp_password),
        must_change_password=True,
    )
    session.add(user)
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        raise HTTPException(status_code=409, detail="username_taken")
    await session.refresh(user)
    return UserCreated(**UserOut.model_validate(user).model_dump(), temp_password=temp_password)


@router.patch("/{user_id}", response_model=UserOut)
async def update_user(
    user_id: UserIdPath,
    body: UserUpdate,
    session: AsyncSession = Depends(get_session),
    admin: User = Depends(require_admin),
    bus: MessageBus = Depends(get_bus),
) -> User:
    user = await _get_user_or_404(session, user_id)
    data = body.model_dump(exclude_unset=True)
    data = {k: v for k, v in data.items() if v is not None}

    if user.id == admin.id:
        demoting = "role" in data and data["role"] != "admin"
        locking = "is_active" in data and data["is_active"] is False
        if demoting or locking:
            raise HTTPException(status_code=409, detail="cannot_modify_self")

    if "branch_id" in data:
        await _ensure_branch(session, data["branch_id"])

    for field, value in data.items():
        setattr(user, field, value)
    if data.get("is_active") is False:
        await revoke_all_refresh_tokens(session, user.id)
    await session.commit()
    if data.get("is_active") is False:
        await publish_user_safely(bus, user.id, {"type": "disconnect"})
    return user


@router.post("/{user_id}/reset-password", response_model=ResetPasswordOut)
async def reset_password(
    user_id: UserIdPath,
    session: AsyncSession = Depends(get_session),
    _admin: User = Depends(require_admin),
    bus: MessageBus = Depends(get_bus),
) -> ResetPasswordOut:
    user = await _get_user_or_404(session, user_id)
    temp_password = generate_temp_password()
    user.password_hash = await asyncio.to_thread(hash_password, temp_password)
    user.must_change_password = True
    await revoke_all_refresh_tokens(session, user.id)
    await session.commit()
    await publish_user_safely(bus, user.id, {"type": "disconnect", "code": 4401})
    return ResetPasswordOut(temp_password=temp_password)
