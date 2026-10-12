from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.deps import require_admin
from app.models import Branch, User
from app.schemas import BranchIn, BranchOut, BranchUpdate

router = APIRouter(prefix="/admin/branches", tags=["admin"], dependencies=[Depends(require_admin)])


def _out(branch: Branch, user_count: int) -> BranchOut:
    return BranchOut(id=branch.id, name=branch.name, code=branch.code, address=branch.address, user_count=user_count)


async def _user_count(session: AsyncSession, branch_id: int) -> int:
    result = await session.execute(select(func.count()).select_from(User).where(User.branch_id == branch_id))
    return result.scalar_one()


async def _ensure_unique(session: AsyncSession, name: str | None, code: str | None, exclude_id: int | None = None):
    conditions = []
    if name is not None:
        conditions.append(Branch.name == name)
    if code is not None:
        conditions.append(Branch.code == code)
    if not conditions:
        return
    query = select(Branch.id).where(or_(*conditions))
    if exclude_id is not None:
        query = query.where(Branch.id != exclude_id)
    if (await session.execute(query)).first() is not None:
        raise HTTPException(status_code=409, detail="branch_exists")


@router.get("", response_model=list[BranchOut])
async def list_branches(session: AsyncSession = Depends(get_session)) -> list[BranchOut]:
    counts = select(User.branch_id, func.count().label("n")).group_by(User.branch_id).subquery()
    rows = await session.execute(
        select(Branch, func.coalesce(counts.c.n, 0))
        .outerjoin(counts, counts.c.branch_id == Branch.id)
        .order_by(Branch.name)
    )
    return [_out(branch, n) for branch, n in rows.all()]


@router.post("", response_model=BranchOut, status_code=201)
async def create_branch(body: BranchIn, session: AsyncSession = Depends(get_session)) -> BranchOut:
    await _ensure_unique(session, body.name, body.code)
    branch = Branch(name=body.name, code=body.code, address=body.address)
    session.add(branch)
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        raise HTTPException(status_code=409, detail="branch_exists")
    return _out(branch, 0)


@router.patch("/{branch_id}", response_model=BranchOut)
async def update_branch(
    branch_id: int, body: BranchUpdate, session: AsyncSession = Depends(get_session)
) -> BranchOut:
    branch = await session.get(Branch, branch_id)
    if branch is None:
        raise HTTPException(status_code=404, detail="branch_not_found")
    data = {k: v for k, v in body.model_dump(exclude_unset=True).items() if v is not None}
    await _ensure_unique(session, data.get("name"), data.get("code"), exclude_id=branch_id)
    for field, value in data.items():
        setattr(branch, field, value)
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        raise HTTPException(status_code=409, detail="branch_exists")
    return _out(branch, await _user_count(session, branch_id))


@router.delete("/{branch_id}", status_code=204)
async def delete_branch(branch_id: int, session: AsyncSession = Depends(get_session)) -> None:
    branch = await session.get(Branch, branch_id)
    if branch is None:
        raise HTTPException(status_code=404, detail="branch_not_found")
    if await _user_count(session, branch_id) > 0:
        raise HTTPException(status_code=409, detail="branch_has_users")
    await session.delete(branch)
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        raise HTTPException(status_code=409, detail="branch_has_users")
