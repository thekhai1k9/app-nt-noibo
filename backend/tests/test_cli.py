import pytest
from sqlalchemy import select

from app.cli import bootstrap_admin
from app.db import SessionLocal
from app.models import Branch, User
from app.security import verify_password


async def test_bootstrap_creates_branch_and_admin():
    async with SessionLocal() as s:
        temp = await bootstrap_admin(s, "Long.Pham", "Phạm Đức Long", "Hà Nội", "HN")
    async with SessionLocal() as s:
        user = (await s.execute(select(User).where(User.username == "long.pham"))).scalar_one()
        assert user.role == "admin"
        assert user.must_change_password is True
        assert verify_password(user.password_hash, temp)
        branch = await s.get(Branch, user.branch_id)
        assert (branch.name, branch.code) == ("Hà Nội", "HN")


async def test_bootstrap_reuses_existing_branch():
    async with SessionLocal() as s:
        await bootstrap_admin(s, "first.admin", "A", "Hà Nội", "HN")
    async with SessionLocal() as s:
        await bootstrap_admin(s, "second.admin", "B", "Hà Nội", "HN")
    async with SessionLocal() as s:
        branches = (await s.execute(select(Branch))).scalars().all()
        assert len(branches) == 1


async def test_bootstrap_rejects_duplicate_username():
    async with SessionLocal() as s:
        await bootstrap_admin(s, "dup", "A", "Hà Nội", "HN")
    async with SessionLocal() as s:
        with pytest.raises(ValueError, match="username_taken"):
            await bootstrap_admin(s, "dup", "B", "Hà Nội", "HN")
