import argparse
import asyncio

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import SessionLocal
from app.models import Branch, User
from app.security import generate_temp_password, hash_password


async def bootstrap_admin(
    session: AsyncSession, username: str, full_name: str, branch_name: str, branch_code: str
) -> str:
    """Tạo tài khoản admin (và chi nhánh nếu chưa có). Trả về mật khẩu tạm."""
    username = username.strip().lower()
    if (await session.execute(select(User.id).where(User.username == username))).first() is not None:
        raise ValueError("username_taken")
    branch = (await session.execute(select(Branch).where(Branch.code == branch_code))).scalar_one_or_none()
    if branch is None:
        branch = Branch(name=branch_name, code=branch_code)
        session.add(branch)
        await session.flush()
    temp_password = generate_temp_password()
    session.add(
        User(
            username=username,
            full_name=full_name,
            branch_id=branch.id,
            role="admin",
            password_hash=hash_password(temp_password),
            must_change_password=True,
        )
    )
    await session.commit()
    return temp_password


async def _run_create_admin(args: argparse.Namespace) -> None:
    async with SessionLocal() as session:
        try:
            temp_password = await bootstrap_admin(
                session, args.username, args.full_name, args.branch_name, args.branch_code
            )
        except ValueError as exc:
            raise SystemExit(f"Lỗi: {exc}")
    print(f"Đã tạo admin '{args.username.strip().lower()}'.")
    print(f"Mật khẩu tạm (chỉ hiện một lần, phải đổi khi đăng nhập lần đầu): {temp_password}")


def main() -> None:
    parser = argparse.ArgumentParser(prog="python -m app.cli")
    sub = parser.add_subparsers(dest="command", required=True)
    create = sub.add_parser("create-admin", help="Tạo tài khoản quản trị đầu tiên")
    create.add_argument("--username", required=True)
    create.add_argument("--full-name", required=True)
    create.add_argument("--branch-name", required=True)
    create.add_argument("--branch-code", required=True)
    args = parser.parse_args()
    if args.command == "create-admin":
        asyncio.run(_run_create_admin(args))


if __name__ == "__main__":
    main()
