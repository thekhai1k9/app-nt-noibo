import pytest
from sqlalchemy.exc import IntegrityError

from app.db import SessionLocal
from app.models import Branch, User
from tests.conftest import create_branch, create_user


async def test_user_defaults():
    uid = await create_user("alice")
    async with SessionLocal() as s:
        user = await s.get(User, uid)
        assert user.role == "member"
        assert user.is_active is True
        assert user.created_at is not None
        assert user.last_login_at is None


async def test_username_must_be_unique():
    bid = await create_branch()
    await create_user("alice", branch_id=bid)
    with pytest.raises(IntegrityError):
        await create_user("alice", branch_id=bid)


async def test_branch_code_must_be_unique():
    await create_branch(name="A", code="X")
    with pytest.raises(IntegrityError):
        await create_branch(name="B", code="X")


async def test_cannot_delete_branch_that_has_users():
    bid = await create_branch()
    await create_user("alice", branch_id=bid)
    async with SessionLocal() as s:
        branch = await s.get(Branch, bid)
        await s.delete(branch)
        with pytest.raises(IntegrityError):
            await s.commit()
