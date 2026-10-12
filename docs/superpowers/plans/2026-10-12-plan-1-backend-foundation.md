# Plan 1: Nền backend (Compose, DB, đăng nhập, API quản trị) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dựng nền backend chạy được bằng Docker Compose: PostgreSQL + Redis + FastAPI, đăng nhập an toàn, và API quản trị người dùng/chi nhánh, có test đầy đủ.

**Architecture:** Monolith FastAPI async (SQLAlchemy 2.0 + asyncpg), migration bằng Alembic. Phiên đăng nhập gồm access token JWT ngắn hạn (trả trong JSON) và refresh token ngẫu nhiên lưu hash trong DB, gửi qua cookie `httpOnly`. Redis dùng để giới hạn tần suất đăng nhập. Caddy làm reverse proxy phía trước.

**Tech Stack:** Python 3.12, FastAPI 0.115, SQLAlchemy 2.0 (asyncio) + asyncpg, Alembic, argon2-cffi, PyJWT, redis-py (asyncio), pytest + pytest-asyncio + httpx, Docker Compose, Caddy 2.

**Spec:** `docs/superpowers/specs/2026-10-12-internal-messaging-design.md` (mục 2, 3, 4 và phần "Admin" của mục 5, 7).

## Phạm vi của plan này

Làm: Compose 4 container (`caddy`, `api`, `db`, `redis`), bảng `branches`/`users`/`refresh_tokens`, đăng nhập/refresh/logout/đổi mật khẩu, rate limit đăng nhập qua Redis, API admin cho người dùng và chi nhánh, CLI tạo admin đầu tiên, healthcheck, log JSON.

**Không làm (các plan sau):** frontend React (Plan 2), phòng/tin nhắn/WebSocket (Plan 3), reply/mention/thông báo/presence (Plan 4), file và tìm kiếm (Plan 5), HTTPS nội bộ, giới hạn IP cho `/api/admin/*`, sao lưu, thử tải (Plan 6), API admin cho phòng/nhóm (Plan 3, vì bảng `rooms` chưa tồn tại).

## Global Constraints

- Backend viết bằng Python, dùng FastAPI; DB là PostgreSQL; cache và rate limit là Redis; đóng gói bằng Docker Compose.
- 4 container: `caddy`, `api`, `db`, `redis`. Tất cả có `restart: unless-stopped` và healthcheck. Cấu hình qua file `.env`.
- Không có tự đăng ký. Admin tạo tài khoản với mật khẩu tạm; user phải đổi mật khẩu ở lần đăng nhập đầu (`must_change_password`).
- Mật khẩu hash bằng argon2.
- Phiên: access token ngắn hạn + refresh token trong cookie `httpOnly`, `Secure` (bật bằng `COOKIE_SECURE`), `SameSite`.
- Đăng nhập có rate limit qua Redis.
- Mọi endpoint `/api/admin/*` kiểm tra `role = admin` ở backend.
- Khoá tài khoản (`is_active = false`) thu hồi mọi refresh token; access token của tài khoản bị khoá bị từ chối ngay (kiểm tra `is_active` trong DB ở mỗi request).
- Log container ghi stdout dạng JSON.
- Mã lỗi API là chuỗi máy đọc được (ví dụ `invalid_credentials`), không phải câu tiếng Việt; frontend sẽ ánh xạ sang tiếng Việt.
- Quy mô dưới 50 người dùng, nên danh sách không cần phân trang.

## Review Focus

Các tình huống spec ngầm đòi hỏi nhưng dễ bị bỏ sót; mỗi dòng có test trong task ghi ở cuối dòng.

- Username đăng nhập viết hoa hoặc có khoảng trắng thừa ("  Long.Pham ") vẫn đăng nhập được (Task 5).
- Mật khẩu cực dài (10.000 ký tự) khi đăng nhập bị từ chối 422, không làm server tính argon2 vô ích (Task 5).
- Access token đã hết hạn bị 401 (Task 5).
- Dùng lại refresh token cũ sau khi đã xoay vòng bị 401 (Task 5).
- Admin tự hạ vai trò hoặc tự khoá chính mình bị chặn, tránh mất hết quyền quản trị (Task 7).

---

## File Structure

```
app-nt-noibo/
├── .env.example
├── .gitignore
├── Caddyfile
├── README.md
├── docker-compose.yml            # chạy production: docker compose -f docker-compose.yml up -d
├── docker-compose.override.yml   # chỉ cho dev: mở cổng db/redis ở 127.0.0.1
└── backend/
    ├── .dockerignore
    ├── Dockerfile
    ├── alembic.ini
    ├── pytest.ini
    ├── requirements.txt
    ├── requirements-dev.txt
    ├── alembic/
    │   ├── env.py
    │   ├── script.py.mako
    │   └── versions/0001_initial.py
    ├── app/
    │   ├── __init__.py
    │   ├── cli.py               # create-admin
    │   ├── config.py            # Settings từ biến môi trường
    │   ├── db.py                # engine, session, Base
    │   ├── deps.py              # get_current_user / get_ready_user / require_admin
    │   ├── logging_conf.py      # log JSON
    │   ├── main.py              # create_app, lifespan
    │   ├── models.py            # Branch, User, RefreshToken
    │   ├── ratelimit.py         # đếm lần đăng nhập sai
    │   ├── redis_client.py      # get_redis
    │   ├── schemas.py           # Pydantic in/out
    │   ├── security.py          # hash mật khẩu, JWT, refresh token, mật khẩu tạm
    │   ├── sessions.py          # cấp phiên (cookie) và thu hồi refresh token
    │   └── routers/
    │       ├── __init__.py
    │       ├── admin_branches.py
    │       ├── admin_users.py
    │       ├── auth.py
    │       └── health.py
    └── tests/
        ├── __init__.py
        ├── conftest.py
        ├── test_admin_branches.py
        ├── test_admin_users.py
        ├── test_app.py
        ├── test_auth.py
        ├── test_cli.py
        ├── test_health.py
        ├── test_models.py
        ├── test_ratelimit.py
        └── test_security.py
```

Quy ước chạy lệnh: dùng Git Bash, WSL hoặc Ubuntu; cần Docker. Lệnh `pytest` chạy trong `backend/` với virtualenv đã kích hoạt.

---

### Task 1: Khung dự án, Docker Compose và `/api/health` tối thiểu

**Files:**
- Create: `.gitignore`, `.env.example`, `docker-compose.yml`, `docker-compose.override.yml`, `Caddyfile`
- Create: `backend/.dockerignore`, `backend/Dockerfile`, `backend/requirements.txt`, `backend/requirements-dev.txt`, `backend/pytest.ini`
- Create: `backend/app/__init__.py`, `backend/app/config.py`, `backend/app/logging_conf.py`, `backend/app/main.py`, `backend/app/routers/__init__.py`, `backend/app/routers/health.py`
- Create: `backend/tests/__init__.py`, `backend/tests/conftest.py`, `backend/tests/test_app.py`

**Interfaces:**
- Consumes: không có.
- Produces: `app.config.Settings`, `app.config.get_settings()`; `app.main.create_app() -> FastAPI`, `app.main.DEFAULT_SECRET`, `app.main.lifespan`; `app.logging_conf.setup_logging(level)`; fixture pytest `client` (httpx `AsyncClient` gắn vào app).

- [ ] **Step 1: Tạo các file cấu hình gốc**

`.gitignore`:
```
.env
.venv/
__pycache__/
.pytest_cache/
*.pyc
node_modules/
```

`.env.example`:
```
# Sao chép thành .env rồi sửa giá trị trước khi chạy.
POSTGRES_USER=messaging
POSTGRES_PASSWORD=messaging
POSTGRES_DB=messaging

# Chuỗi ngẫu nhiên dài (ví dụ: openssl rand -hex 32). Bắt buộc đổi khi APP_ENV=prod.
JWT_SECRET=change-me-to-a-long-random-string

# dev | prod. Ở prod, server từ chối khởi động nếu JWT_SECRET còn là giá trị mặc định.
APP_ENV=dev

# Đặt true khi đã chạy HTTPS (Plan 6). Trước đó, chạy HTTP thuần phải để false
# nếu không trình duyệt sẽ không lưu cookie refresh token.
COOKIE_SECURE=false

LOG_LEVEL=INFO
```

`docker-compose.yml`:
```yaml
services:
  db:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}"]
      interval: 5s
      timeout: 3s
      retries: 10

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    command: ["redis-server", "--appendonly", "yes"]
    volumes:
      - redisdata:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 10

  api:
    build: ./backend
    restart: unless-stopped
    env_file: .env
    environment:
      DATABASE_URL: postgresql+asyncpg://${POSTGRES_USER}:${POSTGRES_PASSWORD}@db:5432/${POSTGRES_DB}
      REDIS_URL: redis://redis:6379/0
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8000/api/health', timeout=3)"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 15s

  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - "80:80"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - api
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://localhost:80/api/health"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  pgdata:
  redisdata:
  caddy_data:
  caddy_config:
```

`docker-compose.override.yml`:
```yaml
# Chỉ dùng khi phát triển: mở cổng DB/Redis ở localhost để chạy pytest.
# Khi triển khai thật, dùng: docker compose -f docker-compose.yml up -d
services:
  db:
    ports:
      - "127.0.0.1:5432:5432"
  redis:
    ports:
      - "127.0.0.1:6379:6379"
```

`Caddyfile`:
```
:80 {
	handle /api/* {
		reverse_proxy api:8000
	}
	handle {
		respond "Kết Nối: giao diện web chưa được cài đặt." 200
	}
}
```

- [ ] **Step 2: Tạo file backend (dependencies, Docker, pytest)**

`backend/requirements.txt`:
```
fastapi==0.115.5
uvicorn[standard]==0.32.1
sqlalchemy[asyncio]==2.0.36
asyncpg==0.30.0
alembic==1.14.0
pydantic-settings==2.6.1
argon2-cffi==23.1.0
pyjwt==2.10.1
redis==5.2.1
python-json-logger==2.0.7
```

`backend/requirements-dev.txt`:
```
-r requirements.txt
pytest==8.3.4
pytest-asyncio==0.24.0
httpx==0.28.1
```

`backend/pytest.ini`:
```
[pytest]
asyncio_mode = auto
asyncio_default_fixture_loop_scope = session
asyncio_default_test_loop_scope = session
testpaths = tests
```

`backend/.dockerignore`:
```
.venv
__pycache__
.pytest_cache
tests
```

`backend/Dockerfile`:
```dockerfile
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE 8000
# api chỉ được truy cập qua Caddy trong mạng compose (không publish cổng),
# nên tin header X-Forwarded-For là hợp lý để rate limit theo IP thật.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
```

- [ ] **Step 3: Viết test thất bại**

`backend/tests/__init__.py`: file rỗng.

`backend/tests/conftest.py`:
```python
import os

os.environ["JWT_SECRET"] = "test-secret"
os.environ["APP_ENV"] = "test"
os.environ["COOKIE_SECURE"] = "false"

import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from app.main import create_app


@pytest_asyncio.fixture
async def client():
    app = create_app()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c
```

`backend/tests/test_app.py`:
```python
import pytest

from app.config import get_settings
from app.main import DEFAULT_SECRET, create_app, lifespan


async def test_health_ok(client):
    r = await client.get("/api/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


async def test_prod_refuses_default_secret(monkeypatch):
    monkeypatch.setenv("APP_ENV", "prod")
    monkeypatch.setenv("JWT_SECRET", DEFAULT_SECRET)
    get_settings.cache_clear()
    try:
        with pytest.raises(RuntimeError):
            async with lifespan(create_app()):
                pass
    finally:
        monkeypatch.undo()
        get_settings.cache_clear()
```

- [ ] **Step 4: Cài môi trường và xác nhận test thất bại**

Run:
```bash
cd backend
python -m venv .venv
source .venv/bin/activate        # Git Bash trên Windows: source .venv/Scripts/activate
pip install -r requirements-dev.txt
pytest tests/test_app.py -v
```
Expected: lỗi `ModuleNotFoundError: No module named 'app.main'` (hoặc tương tự) khi thu thập test.

- [ ] **Step 5: Viết mã tối thiểu**

`backend/app/__init__.py` và `backend/app/routers/__init__.py`: file rỗng.

`backend/app/config.py`:
```python
from functools import lru_cache

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = "postgresql+asyncpg://messaging:messaging@localhost:5432/messaging"
    redis_url: str = "redis://localhost:6379/0"
    jwt_secret: str = "dev-secret-change-me"
    app_env: str = "dev"
    access_token_minutes: int = 15
    refresh_token_days: int = 14
    cookie_secure: bool = True
    cookie_samesite: str = "lax"
    login_max_attempts: int = 5
    login_window_seconds: int = 300
    log_level: str = "INFO"


@lru_cache
def get_settings() -> Settings:
    return Settings()
```

`backend/app/logging_conf.py`:
```python
import logging

from pythonjsonlogger import jsonlogger


def setup_logging(level: str = "INFO") -> None:
    handler = logging.StreamHandler()
    handler.setFormatter(jsonlogger.JsonFormatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(level)
    # Đưa log của uvicorn qua cùng handler JSON.
    for name in ("uvicorn", "uvicorn.access", "uvicorn.error"):
        logger = logging.getLogger(name)
        logger.handlers = []
        logger.propagate = True
```

`backend/app/routers/health.py`:
```python
from fastapi import APIRouter

router = APIRouter(tags=["health"])


@router.get("/health")
async def health() -> dict:
    return {"status": "ok"}
```

`backend/app/main.py`:
```python
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.config import get_settings
from app.logging_conf import setup_logging
from app.routers import health

DEFAULT_SECRET = "dev-secret-change-me"


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    if settings.app_env == "prod" and settings.jwt_secret == DEFAULT_SECRET:
        raise RuntimeError("JWT_SECRET must be set when APP_ENV=prod")
    yield


def create_app() -> FastAPI:
    setup_logging(get_settings().log_level)
    app = FastAPI(
        title="Kết Nối API",
        lifespan=lifespan,
        docs_url="/api/docs",
        openapi_url="/api/openapi.json",
    )
    app.include_router(health.router, prefix="/api")
    return app


app = create_app()
```

- [ ] **Step 6: Chạy test để xác nhận pass**

Run: `pytest tests/test_app.py -v`
Expected: 2 passed.

- [ ] **Step 7: Kiểm tra Compose khởi động được**

Run (từ thư mục gốc dự án):
```bash
cp .env.example .env
docker compose up -d --build
docker compose ps
curl -s http://localhost/api/health
```
Expected: 4 service ở trạng thái `running`/`healthy` (chờ vài chục giây), `curl` trả `{"status":"ok"}`.

Run: `docker compose down`

- [ ] **Step 8: Commit**

```bash
git add .gitignore .env.example docker-compose.yml docker-compose.override.yml Caddyfile backend
git commit -m "feat: scaffold backend, docker compose and health endpoint" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Kết nối DB, mô hình dữ liệu và migration

**Files:**
- Create: `backend/app/db.py`, `backend/app/models.py`
- Create: `backend/alembic.ini`, `backend/alembic/env.py`, `backend/alembic/script.py.mako`, `backend/alembic/versions/0001_initial.py`
- Modify: `backend/Dockerfile` (CMD chạy migration trước)
- Replace: `backend/tests/conftest.py`
- Create: `backend/tests/test_models.py`

**Interfaces:**
- Consumes: `app.config.get_settings()`.
- Produces:
  - `app.db.Base`, `app.db.engine`, `app.db.SessionLocal` (`async_sessionmaker[AsyncSession]`), `app.db.get_session()` (dependency async generator).
  - `app.models.Branch(id, name, code, address)`, `app.models.User(id, username, full_name, branch_id, role, password_hash, is_active, must_change_password, created_at, last_login_at)`, `app.models.RefreshToken(id, user_id, token_hash, expires_at, revoked_at, created_at)`.
  - conftest helpers: `TEST_PASSWORD = "Passw0rd!"`, `async create_branch(name="Hà Nội", code="HN") -> int`, `async create_user(username, password=TEST_PASSWORD, role="member", branch_id=None, must_change=False, active=True) -> int`, `async login(client, username, password=TEST_PASSWORD) -> Response`, fixtures `client`, `admin_headers`, `member_headers`.

- [ ] **Step 1: Tạo database test**

Run (từ thư mục gốc dự án):
```bash
docker compose up -d db redis
docker compose exec db createdb -U messaging messaging_test
```
Expected: không có lỗi (nếu báo "already exists" thì bỏ qua).

- [ ] **Step 2: Viết conftest đầy đủ và test mô hình (thất bại)**

Thay toàn bộ `backend/tests/conftest.py`:
```python
import os

os.environ["DATABASE_URL"] = os.environ.get(
    "TEST_DATABASE_URL", "postgresql+asyncpg://messaging:messaging@localhost:5432/messaging_test"
)
os.environ["REDIS_URL"] = os.environ.get("TEST_REDIS_URL", "redis://localhost:6379/1")
os.environ["JWT_SECRET"] = "test-secret"
os.environ["APP_ENV"] = "test"
os.environ["COOKIE_SECURE"] = "false"
os.environ["LOGIN_MAX_ATTEMPTS"] = "3"

import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text

from app import models  # noqa: F401  (đăng ký các bảng vào Base.metadata)
from app.db import Base, SessionLocal, engine
from app.main import create_app
from app.models import Branch, User
from app.security import hash_password

TEST_PASSWORD = "Passw0rd!"


@pytest_asyncio.fixture(scope="session", loop_scope="session", autouse=True)
async def _schema():
    # Chặn chạy nhầm lên database thật.
    assert engine.url.database.endswith("_test"), f"refusing to reset {engine.url.database}"
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
    yield
    await engine.dispose()


@pytest_asyncio.fixture(autouse=True)
async def _clean():
    async with engine.begin() as conn:
        await conn.execute(text("TRUNCATE refresh_tokens, users, branches RESTART IDENTITY CASCADE"))
    yield


@pytest_asyncio.fixture
async def client():
    app = create_app()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


async def create_branch(name: str = "Hà Nội", code: str = "HN") -> int:
    async with SessionLocal() as s:
        branch = Branch(name=name, code=code)
        s.add(branch)
        await s.commit()
        return branch.id


async def create_user(
    username: str,
    password: str = TEST_PASSWORD,
    role: str = "member",
    branch_id: int | None = None,
    must_change: bool = False,
    active: bool = True,
) -> int:
    if branch_id is None:
        branch_id = await create_branch(name=f"CN-{username}", code=username[:10].upper())
    async with SessionLocal() as s:
        user = User(
            username=username,
            full_name=username.title(),
            branch_id=branch_id,
            role=role,
            password_hash=hash_password(password),
            must_change_password=must_change,
            is_active=active,
        )
        s.add(user)
        await s.commit()
        return user.id


async def login(client, username: str, password: str = TEST_PASSWORD):
    return await client.post("/api/auth/login", json={"username": username, "password": password})


@pytest_asyncio.fixture
async def admin_headers(client):
    await create_user("admin", role="admin")
    r = await login(client, "admin")
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest_asyncio.fixture
async def member_headers(client):
    await create_user("member1", role="member")
    r = await login(client, "member1")
    return {"Authorization": f"Bearer {r.json()['access_token']}"}
```

`backend/tests/test_models.py`:
```python
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
```

- [ ] **Step 3: Chạy test để xác nhận thất bại**

Run: `pytest tests/test_models.py -v`
Expected: lỗi `ModuleNotFoundError: No module named 'app.db'`.

- [ ] **Step 4: Viết `db.py` và `models.py`**

`backend/app/db.py`:
```python
from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.config import get_settings


class Base(DeclarativeBase):
    pass


engine = create_async_engine(get_settings().database_url, pool_pre_ping=True)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False)


async def get_session() -> AsyncIterator[AsyncSession]:
    async with SessionLocal() as session:
        yield session
```

`backend/app/models.py`:
```python
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, String, func, true
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class Branch(Base):
    __tablename__ = "branches"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100), unique=True)
    code: Mapped[str] = mapped_column(String(10), unique=True)
    address: Mapped[str] = mapped_column(String(200), default="", server_default="")


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(50), unique=True)
    full_name: Mapped[str] = mapped_column(String(100))
    branch_id: Mapped[int] = mapped_column(ForeignKey("branches.id", ondelete="RESTRICT"))
    role: Mapped[str] = mapped_column(String(16), default="member", server_default="member")
    password_hash: Mapped[str] = mapped_column(String(255))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default=true())
    must_change_password: Mapped[bool] = mapped_column(Boolean, default=True, server_default=true())
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class RefreshToken(Base):
    __tablename__ = "refresh_tokens"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
```

- [ ] **Step 5: Chạy test để xác nhận pass**

Run: `pytest tests/test_models.py -v`
Expected: 4 passed.

- [ ] **Step 6: Thêm Alembic**

`backend/alembic.ini`:
```ini
[alembic]
script_location = alembic
prepend_sys_path = .
```

`backend/alembic/script.py.mako`:
```mako
"""${message}

Revision ID: ${up_revision}
Revises: ${down_revision | comma,n}
Create Date: ${create_date}
"""
from alembic import op
import sqlalchemy as sa
${imports if imports else ""}

revision = ${repr(up_revision)}
down_revision = ${repr(down_revision)}
branch_labels = ${repr(branch_labels)}
depends_on = ${repr(depends_on)}


def upgrade() -> None:
    ${upgrades if upgrades else "pass"}


def downgrade() -> None:
    ${downgrades if downgrades else "pass"}
```

`backend/alembic/env.py`:
```python
import asyncio

from alembic import context
from sqlalchemy.ext.asyncio import create_async_engine

import app.models  # noqa: F401
from app.config import get_settings
from app.db import Base

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    context.configure(url=get_settings().database_url, target_metadata=target_metadata, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection) -> None:
    context.configure(connection=connection, target_metadata=target_metadata)
    with context.begin_transaction():
        context.run_migrations()


async def run_migrations_online() -> None:
    engine = create_async_engine(get_settings().database_url)
    async with engine.connect() as connection:
        await connection.run_sync(do_run_migrations)
    await engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    asyncio.run(run_migrations_online())
```

`backend/alembic/versions/0001_initial.py`:
```python
"""initial schema: branches, users, refresh_tokens

Revision ID: 0001
Revises:
Create Date: 2026-10-12
"""
import sqlalchemy as sa
from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "branches",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("name", sa.String(100), nullable=False, unique=True),
        sa.Column("code", sa.String(10), nullable=False, unique=True),
        sa.Column("address", sa.String(200), nullable=False, server_default=""),
    )
    op.create_table(
        "users",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("username", sa.String(50), nullable=False, unique=True),
        sa.Column("full_name", sa.String(100), nullable=False),
        sa.Column("branch_id", sa.Integer, sa.ForeignKey("branches.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("role", sa.String(16), nullable=False, server_default="member"),
        sa.Column("password_hash", sa.String(255), nullable=False),
        sa.Column("is_active", sa.Boolean, nullable=False, server_default=sa.true()),
        sa.Column("must_change_password", sa.Boolean, nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("last_login_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_table(
        "refresh_tokens",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("user_id", sa.Integer, sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("token_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_refresh_tokens_user_id", "refresh_tokens", ["user_id"])


def downgrade() -> None:
    op.drop_table("refresh_tokens")
    op.drop_table("users")
    op.drop_table("branches")
```

- [ ] **Step 7: Cho container chạy migration khi khởi động**

Sửa dòng `CMD` cuối `backend/Dockerfile` thành:
```dockerfile
CMD ["sh", "-c", "alembic upgrade head && exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --proxy-headers --forwarded-allow-ips '*'"]
```

- [ ] **Step 8: Kiểm tra migration trên DB thật**

Run (từ thư mục gốc):
```bash
docker compose up -d --build api
docker compose logs api | tail -n 20
docker compose exec db psql -U messaging -d messaging -c "\dt"
```
Expected: log có dòng `Running upgrade  -> 0001`; `\dt` liệt kê `alembic_version`, `branches`, `refresh_tokens`, `users`.

- [ ] **Step 9: Chạy lại toàn bộ test**

Run: `cd backend && pytest -v`
Expected: tất cả pass (test_app 2 + test_models 4).

- [ ] **Step 10: Commit**

```bash
git add backend
git commit -m "feat: add database models and alembic migration" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Tiện ích bảo mật (hash mật khẩu, JWT, refresh token, mật khẩu tạm)

**Files:**
- Create: `backend/app/security.py`
- Create: `backend/tests/test_security.py`

**Interfaces:**
- Consumes: `app.config.get_settings()`.
- Produces:
  - `hash_password(password: str) -> str`
  - `verify_password(password_hash: str, password: str) -> bool`
  - `create_access_token(user_id: int) -> str`
  - `decode_access_token(token: str) -> int | None` (trả `user_id`, hoặc `None` nếu sai/hết hạn)
  - `new_refresh_token() -> tuple[str, str]` (`raw`, `sha256 hex`)
  - `hash_refresh_token(raw: str) -> str`
  - `generate_temp_password() -> str` (12 ký tự, bỏ ký tự dễ nhầm)

- [ ] **Step 1: Viết test thất bại**

`backend/tests/test_security.py`:
```python
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
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `pytest tests/test_security.py -v`
Expected: lỗi `ModuleNotFoundError: No module named 'app.security'`.

- [ ] **Step 3: Viết `security.py`**

`backend/app/security.py`:
```python
import hashlib
import secrets
from datetime import datetime, timedelta, timezone

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError

from app.config import get_settings

_hasher = PasswordHasher()
_TEMP_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    try:
        return _hasher.verify(password_hash, password)
    except (VerifyMismatchError, InvalidHashError):
        return False


def create_access_token(user_id: int) -> str:
    settings = get_settings()
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user_id),
        "typ": "access",
        "iat": now,
        "exp": now + timedelta(minutes=settings.access_token_minutes),
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm="HS256")


def decode_access_token(token: str) -> int | None:
    try:
        data = jwt.decode(token, get_settings().jwt_secret, algorithms=["HS256"])
    except jwt.PyJWTError:
        return None
    if data.get("typ") != "access":
        return None
    try:
        return int(data["sub"])
    except (KeyError, ValueError):
        return None


def hash_refresh_token(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def new_refresh_token() -> tuple[str, str]:
    raw = secrets.token_urlsafe(48)
    return raw, hash_refresh_token(raw)


def generate_temp_password() -> str:
    return "".join(secrets.choice(_TEMP_ALPHABET) for _ in range(12))
```

- [ ] **Step 4: Chạy test để xác nhận pass**

Run: `pytest tests/test_security.py -v`
Expected: 9 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/app/security.py backend/tests/test_security.py
git commit -m "feat: add password hashing, jwt and refresh token helpers" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Redis, rate limit và healthcheck thật

**Files:**
- Create: `backend/app/redis_client.py`, `backend/app/ratelimit.py`
- Modify: `backend/app/routers/health.py` (kiểm tra DB và Redis)
- Modify: `backend/tests/conftest.py` (dọn Redis giữa các test)
- Modify: `backend/tests/test_app.py` (chuyển test health sang file riêng)
- Create: `backend/tests/test_ratelimit.py`, `backend/tests/test_health.py`

**Interfaces:**
- Consumes: `app.config.get_settings()`, `app.db.get_session`.
- Produces:
  - `app.redis_client.get_redis() -> redis.asyncio.Redis` (cached, `decode_responses=True`; dùng được như FastAPI dependency)
  - `app.ratelimit.is_blocked(redis, key: str, max_attempts: int) -> bool`
  - `app.ratelimit.register_failure(redis, key: str, window_seconds: int) -> None`
  - `app.ratelimit.clear(redis, key: str) -> None`

- [ ] **Step 1: Viết test thất bại**

`backend/tests/test_ratelimit.py`:
```python
from app.ratelimit import clear, is_blocked, register_failure
from app.redis_client import get_redis


async def test_not_blocked_initially():
    assert await is_blocked(get_redis(), "k1", 3) is False


async def test_blocked_after_max_failures():
    redis = get_redis()
    for _ in range(2):
        await register_failure(redis, "k2", 60)
    assert await is_blocked(redis, "k2", 3) is False
    await register_failure(redis, "k2", 60)
    assert await is_blocked(redis, "k2", 3) is True


async def test_clear_resets_counter():
    redis = get_redis()
    for _ in range(3):
        await register_failure(redis, "k3", 60)
    await clear(redis, "k3")
    assert await is_blocked(redis, "k3", 3) is False


async def test_failure_counter_expires():
    redis = get_redis()
    await register_failure(redis, "k4", 60)
    ttl = await redis.ttl("k4")
    assert 0 < ttl <= 60
```

`backend/tests/test_health.py`:
```python
from app.main import create_app
from app.redis_client import get_redis
from httpx import ASGITransport, AsyncClient


async def test_health_ok(client):
    r = await client.get("/api/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


async def test_health_503_when_redis_down():
    class BrokenRedis:
        async def ping(self):
            raise ConnectionError("redis down")

    app = create_app()
    app.dependency_overrides[get_redis] = lambda: BrokenRedis()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        r = await c.get("/api/health")
    assert r.status_code == 503
    assert r.json()["detail"] == "unhealthy"
```

Trong `backend/tests/test_app.py`, xoá hàm `test_health_ok` (đã chuyển sang `test_health.py`), giữ `test_prod_refuses_default_secret`.

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `pytest tests/test_ratelimit.py tests/test_health.py -v`
Expected: lỗi `ModuleNotFoundError: No module named 'app.ratelimit'`.

- [ ] **Step 3: Viết mã**

`backend/app/redis_client.py`:
```python
from functools import lru_cache

from redis.asyncio import Redis

from app.config import get_settings


@lru_cache
def get_redis() -> Redis:
    return Redis.from_url(get_settings().redis_url, decode_responses=True)
```

`backend/app/ratelimit.py`:
```python
from redis.asyncio import Redis


async def is_blocked(redis: Redis, key: str, max_attempts: int) -> bool:
    value = await redis.get(key)
    return value is not None and int(value) >= max_attempts


async def register_failure(redis: Redis, key: str, window_seconds: int) -> None:
    count = await redis.incr(key)
    if count == 1:
        await redis.expire(key, window_seconds)


async def clear(redis: Redis, key: str) -> None:
    await redis.delete(key)
```

`backend/app/routers/health.py` (thay toàn bộ):
```python
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.redis_client import get_redis

router = APIRouter(tags=["health"])


@router.get("/health")
async def health(session: AsyncSession = Depends(get_session), redis=Depends(get_redis)) -> dict:
    try:
        await session.execute(text("SELECT 1"))
        await redis.ping()
    except Exception:
        raise HTTPException(status_code=503, detail="unhealthy")
    return {"status": "ok"}
```

Trong `backend/tests/conftest.py`, thêm import `from app.redis_client import get_redis` cạnh các import `app.*`, và sửa fixture `_clean` thành:
```python
@pytest_asyncio.fixture(autouse=True)
async def _clean():
    async with engine.begin() as conn:
        await conn.execute(text("TRUNCATE refresh_tokens, users, branches RESTART IDENTITY CASCADE"))
    await get_redis().flushdb()
    yield
```

- [ ] **Step 4: Chạy toàn bộ test**

Run: `pytest -v`
Expected: tất cả pass.

- [ ] **Step 5: Commit**

```bash
git add backend
git commit -m "feat: add redis client, login rate limit helpers and real health check" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Xác thực: đăng nhập, refresh, đăng xuất, đổi mật khẩu

**Files:**
- Create: `backend/app/schemas.py`, `backend/app/sessions.py`, `backend/app/deps.py`, `backend/app/routers/auth.py`
- Modify: `backend/app/main.py` (include router `auth`)
- Create: `backend/tests/test_auth.py`

**Interfaces:**
- Consumes: `app.security.*` (Task 3), `app.ratelimit.*` và `app.redis_client.get_redis` (Task 4), `app.models.*`, `app.db.get_session`, conftest helpers (Task 2).
- Produces:
  - `app.schemas`: `LoginIn`, `TokenOut(access_token, token_type="bearer", must_change_password)`, `ChangePasswordIn(current_password, new_password)`, `UserOut(id, username, full_name, branch_id, role, is_active, must_change_password, last_login_at)`.
  - `app.sessions.COOKIE_NAME = "refresh_token"`, `COOKIE_PATH = "/api/auth"`, `async issue_session(session, response, user) -> TokenOut` (tạo refresh token, đặt cookie, **commit**), `async revoke_all_refresh_tokens(session, user_id) -> None` (không commit).
  - `app.deps.get_current_user` (chỉ cần token hợp lệ và `is_active`), `app.deps.get_ready_user` (thêm điều kiện không còn `must_change_password`), `app.deps.require_admin`.
  - Endpoint: `POST /api/auth/login`, `POST /api/auth/refresh`, `POST /api/auth/logout` (204), `GET /api/auth/me`, `POST /api/auth/change-password`.
  - Mã lỗi: `invalid_credentials` (401), `too_many_attempts` (429), `invalid_refresh` (401), `not_authenticated` (401), `password_change_required` (403), `forbidden` (403), `wrong_current_password` (400), `password_unchanged` (400).

- [ ] **Step 1: Viết test thất bại**

`backend/tests/test_auth.py`:
```python
from datetime import datetime, timedelta, timezone

import jwt

from tests.conftest import TEST_PASSWORD, create_user, login


async def test_login_success_sets_cookie_and_returns_token(client):
    await create_user("alice")
    r = await login(client, "alice")
    assert r.status_code == 200
    body = r.json()
    assert body["token_type"] == "bearer"
    assert body["must_change_password"] is False
    cookie = r.headers["set-cookie"].lower()
    assert "refresh_token=" in cookie
    assert "httponly" in cookie
    assert "path=/api/auth" in cookie
    assert "samesite=lax" in cookie


async def test_login_normalizes_username(client):
    await create_user("long.pham")
    r = await client.post("/api/auth/login", json={"username": "  Long.Pham ", "password": TEST_PASSWORD})
    assert r.status_code == 200


async def test_login_wrong_password(client):
    await create_user("alice")
    r = await login(client, "alice", "wrong-password")
    assert r.status_code == 401
    assert r.json()["detail"] == "invalid_credentials"


async def test_login_unknown_user_same_error(client):
    r = await login(client, "nobody")
    assert r.status_code == 401
    assert r.json()["detail"] == "invalid_credentials"


async def test_login_inactive_user_rejected(client):
    await create_user("alice", active=False)
    r = await login(client, "alice")
    assert r.status_code == 401
    assert r.json()["detail"] == "invalid_credentials"


async def test_login_rejects_huge_password(client):
    await create_user("alice")
    r = await client.post("/api/auth/login", json={"username": "alice", "password": "x" * 10_000})
    assert r.status_code == 422


async def test_login_rate_limited_after_failures(client):
    await create_user("alice")
    for _ in range(3):  # LOGIN_MAX_ATTEMPTS=3 trong conftest
        assert (await login(client, "alice", "bad")).status_code == 401
    r = await login(client, "alice", "bad")
    assert r.status_code == 429
    assert r.json()["detail"] == "too_many_attempts"
    # Đúng mật khẩu nhưng đang bị khoá thì vẫn bị chặn.
    assert (await login(client, "alice")).status_code == 429


async def test_successful_login_resets_failure_counter(client):
    await create_user("alice")
    for _ in range(2):
        await login(client, "alice", "bad")
    assert (await login(client, "alice")).status_code == 200
    for _ in range(2):
        assert (await login(client, "alice", "bad")).status_code == 401


async def test_me_requires_token(client):
    r = await client.get("/api/auth/me")
    assert r.status_code == 401
    assert r.json()["detail"] == "not_authenticated"


async def test_me_returns_profile(client):
    await create_user("alice")
    token = (await login(client, "alice")).json()["access_token"]
    r = await client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    assert r.json()["username"] == "alice"
    assert "password_hash" not in r.json()


async def test_expired_access_token_rejected(client):
    uid = await create_user("alice")
    token = jwt.encode(
        {"sub": str(uid), "typ": "access", "exp": datetime.now(timezone.utc) - timedelta(seconds=1)},
        "test-secret",
        algorithm="HS256",
    )
    r = await client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 401


async def test_refresh_rotates_token_and_old_one_is_dead(client):
    await create_user("alice")
    await login(client, "alice")
    old_cookie = client.cookies.get("refresh_token")

    r = await client.post("/api/auth/refresh")
    assert r.status_code == 200
    assert r.json()["access_token"]
    assert client.cookies.get("refresh_token") != old_cookie

    reuse = await client.post("/api/auth/refresh", headers={"cookie": f"refresh_token={old_cookie}"})
    assert reuse.status_code == 401
    assert reuse.json()["detail"] == "invalid_refresh"


async def test_refresh_without_cookie(client):
    r = await client.post("/api/auth/refresh")
    assert r.status_code == 401
    assert r.json()["detail"] == "invalid_refresh"


async def test_logout_revokes_refresh_token(client):
    await create_user("alice")
    await login(client, "alice")
    cookie = client.cookies.get("refresh_token")
    r = await client.post("/api/auth/logout")
    assert r.status_code == 204
    again = await client.post("/api/auth/refresh", headers={"cookie": f"refresh_token={cookie}"})
    assert again.status_code == 401


async def test_must_change_password_blocks_other_endpoints(client):
    await create_user("alice", must_change=True)
    r = await login(client, "alice")
    assert r.json()["must_change_password"] is True
    headers = {"Authorization": f"Bearer {r.json()['access_token']}"}
    assert (await client.get("/api/auth/me", headers=headers)).status_code == 200
    blocked = await client.get("/api/admin/users", headers=headers)
    assert blocked.status_code == 403
    assert blocked.json()["detail"] == "password_change_required"


async def test_change_password_flow(client):
    await create_user("alice", must_change=True)
    token = (await login(client, "alice")).json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}

    wrong = await client.post(
        "/api/auth/change-password",
        headers=headers,
        json={"current_password": "nope", "new_password": "NewPassw0rd!"},
    )
    assert wrong.status_code == 400
    assert wrong.json()["detail"] == "wrong_current_password"

    same = await client.post(
        "/api/auth/change-password",
        headers=headers,
        json={"current_password": TEST_PASSWORD, "new_password": TEST_PASSWORD},
    )
    assert same.status_code == 400
    assert same.json()["detail"] == "password_unchanged"

    short = await client.post(
        "/api/auth/change-password",
        headers=headers,
        json={"current_password": TEST_PASSWORD, "new_password": "short"},
    )
    assert short.status_code == 422

    ok = await client.post(
        "/api/auth/change-password",
        headers=headers,
        json={"current_password": TEST_PASSWORD, "new_password": "NewPassw0rd!"},
    )
    assert ok.status_code == 200
    assert ok.json()["must_change_password"] is False

    assert (await login(client, "alice", TEST_PASSWORD)).status_code == 401
    assert (await login(client, "alice", "NewPassw0rd!")).status_code == 200


async def test_change_password_revokes_other_sessions(client):
    await create_user("alice")
    await login(client, "alice")
    old_cookie = client.cookies.get("refresh_token")
    token = (await login(client, "alice")).json()["access_token"]
    r = await client.post(
        "/api/auth/change-password",
        headers={"Authorization": f"Bearer {token}"},
        json={"current_password": TEST_PASSWORD, "new_password": "NewPassw0rd!"},
    )
    assert r.status_code == 200
    stale = await client.post("/api/auth/refresh", headers={"cookie": f"refresh_token={old_cookie}"})
    assert stale.status_code == 401
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `pytest tests/test_auth.py -v`
Expected: các test lỗi 404 (chưa có route) hoặc `ModuleNotFoundError`.

- [ ] **Step 3: Viết `schemas.py`**

`backend/app/schemas.py`:
```python
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class LoginIn(BaseModel):
    username: str = Field(min_length=1, max_length=100)
    password: str = Field(min_length=1, max_length=256)


class TokenOut(BaseModel):
    access_token: str
    token_type: Literal["bearer"] = "bearer"
    must_change_password: bool


class ChangePasswordIn(BaseModel):
    current_password: str = Field(min_length=1, max_length=256)
    new_password: str = Field(min_length=8, max_length=128)


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    username: str
    full_name: str
    branch_id: int
    role: str
    is_active: bool
    must_change_password: bool
    last_login_at: datetime | None
```

- [ ] **Step 4: Viết `sessions.py` và `deps.py`**

`backend/app/sessions.py`:
```python
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
```

`backend/app/deps.py`:
```python
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
```

- [ ] **Step 5: Viết router `auth`**

`backend/app/routers/auth.py`:
```python
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
```

Trong `backend/app/main.py` đổi dòng import thành `from app.routers import auth, health` và thêm sau dòng `include_router(health...)`:
```python
    app.include_router(auth.router, prefix="/api")
```

- [ ] **Step 6: Chạy test**

Run: `pytest tests/test_auth.py -v`
Expected: 16 passed, 1 failed. Test fail duy nhất là `test_must_change_password_blocks_other_endpoints`: nó gọi `/api/admin/users`, route chưa tồn tại nên trả 404 thay vì 403. Đây là lỗi đã biết, sẽ hết ở Task 7 khi route admin có mặt. Nếu có test khác fail thì phải sửa trước khi commit.

- [ ] **Step 7: Commit**

```bash
git add backend
git commit -m "feat: add login, refresh, logout and change-password endpoints" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: API quản trị chi nhánh

**Files:**
- Modify: `backend/app/schemas.py` (thêm `BranchIn`, `BranchUpdate`, `BranchOut`)
- Create: `backend/app/routers/admin_branches.py`
- Modify: `backend/app/main.py` (include router)
- Create: `backend/tests/test_admin_branches.py`

**Interfaces:**
- Consumes: `app.deps.require_admin`, `app.db.get_session`, `app.models.Branch/User`, conftest `admin_headers`, `member_headers`, `create_user`.
- Produces:
  - `BranchIn(name, code, address="")`, `BranchUpdate(name?, code?, address?)`, `BranchOut(id, name, code, address, user_count)`.
  - `GET /api/admin/branches` → `list[BranchOut]` (sắp theo tên), `POST /api/admin/branches` (201), `PATCH /api/admin/branches/{id}`, `DELETE /api/admin/branches/{id}` (204).
  - Mã lỗi: `branch_exists` (409), `branch_not_found` (404), `branch_has_users` (409).

- [ ] **Step 1: Viết test thất bại**

`backend/tests/test_admin_branches.py`:
```python
from tests.conftest import create_branch, create_user


async def test_requires_authentication(client):
    assert (await client.get("/api/admin/branches")).status_code == 401


async def test_member_is_forbidden(client, member_headers):
    r = await client.get("/api/admin/branches", headers=member_headers)
    assert r.status_code == 403
    assert r.json()["detail"] == "forbidden"


async def test_create_and_list_with_user_count(client, admin_headers):
    r = await client.post(
        "/api/admin/branches",
        headers=admin_headers,
        json={"name": "Đà Nẵng", "code": "ĐN", "address": "Hải Châu"},
    )
    assert r.status_code == 201
    created = r.json()
    assert created["user_count"] == 0

    await create_user("hanoi.user", branch_id=created["id"])
    listing = await client.get("/api/admin/branches", headers=admin_headers)
    assert listing.status_code == 200
    by_code = {b["code"]: b for b in listing.json()}
    assert by_code["ĐN"]["user_count"] == 1
    assert by_code["ĐN"]["address"] == "Hải Châu"


async def test_create_duplicate_name_or_code(client, admin_headers):
    await create_branch(name="Hà Nội", code="HN")
    r1 = await client.post("/api/admin/branches", headers=admin_headers, json={"name": "Hà Nội", "code": "X"})
    assert r1.status_code == 409
    assert r1.json()["detail"] == "branch_exists"
    r2 = await client.post("/api/admin/branches", headers=admin_headers, json={"name": "Khác", "code": "HN"})
    assert r2.status_code == 409


async def test_create_validates_input(client, admin_headers):
    r = await client.post("/api/admin/branches", headers=admin_headers, json={"name": "", "code": "X"})
    assert r.status_code == 422
    r = await client.post("/api/admin/branches", headers=admin_headers, json={"name": "A", "code": "x" * 11})
    assert r.status_code == 422


async def test_update_branch(client, admin_headers):
    bid = await create_branch(name="Hà Nội", code="HN")
    r = await client.patch(f"/api/admin/branches/{bid}", headers=admin_headers, json={"address": "Cầu Giấy"})
    assert r.status_code == 200
    assert r.json()["address"] == "Cầu Giấy"
    assert r.json()["name"] == "Hà Nội"


async def test_update_to_existing_code_conflicts(client, admin_headers):
    await create_branch(name="Hà Nội", code="HN")
    other = await create_branch(name="Đà Nẵng", code="ĐN")
    r = await client.patch(f"/api/admin/branches/{other}", headers=admin_headers, json={"code": "HN"})
    assert r.status_code == 409


async def test_update_unknown_branch(client, admin_headers):
    r = await client.patch("/api/admin/branches/999", headers=admin_headers, json={"name": "X"})
    assert r.status_code == 404
    assert r.json()["detail"] == "branch_not_found"


async def test_delete_empty_branch(client, admin_headers):
    bid = await create_branch(name="Tạm", code="TMP")
    assert (await client.delete(f"/api/admin/branches/{bid}", headers=admin_headers)).status_code == 204
    listing = await client.get("/api/admin/branches", headers=admin_headers)
    assert "TMP" not in {b["code"] for b in listing.json()}


async def test_delete_branch_with_users_is_blocked(client, admin_headers):
    bid = await create_branch(name="Có người", code="CN")
    await create_user("someone", branch_id=bid)
    r = await client.delete(f"/api/admin/branches/{bid}", headers=admin_headers)
    assert r.status_code == 409
    assert r.json()["detail"] == "branch_has_users"
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `pytest tests/test_admin_branches.py -v`
Expected: các test lỗi 404 vì chưa có route.

- [ ] **Step 3: Thêm schemas**

Thêm vào cuối `backend/app/schemas.py`:
```python
class BranchIn(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    name: str = Field(min_length=1, max_length=100)
    code: str = Field(min_length=1, max_length=10)
    address: str = Field(default="", max_length=200)


class BranchUpdate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    name: str | None = Field(default=None, min_length=1, max_length=100)
    code: str | None = Field(default=None, min_length=1, max_length=10)
    address: str | None = Field(default=None, max_length=200)


class BranchOut(BaseModel):
    id: int
    name: str
    code: str
    address: str
    user_count: int
```

- [ ] **Step 4: Viết router**

`backend/app/routers/admin_branches.py`:
```python
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
    data = body.model_dump(exclude_unset=True)
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
    await session.commit()
```

Trong `backend/app/main.py` đổi import thành `from app.routers import admin_branches, auth, health` và thêm:
```python
    app.include_router(admin_branches.router, prefix="/api")
```

- [ ] **Step 5: Chạy test**

Run: `pytest tests/test_admin_branches.py -v`
Expected: 10 passed.

- [ ] **Step 6: Commit**

```bash
git add backend
git commit -m "feat: add admin branch management api" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: API quản trị người dùng

**Files:**
- Modify: `backend/app/schemas.py` (thêm `UserCreate`, `UserUpdate`, `UserCreated`, `ResetPasswordOut`)
- Create: `backend/app/routers/admin_users.py`
- Modify: `backend/app/main.py` (include router)
- Create: `backend/tests/test_admin_users.py`

**Interfaces:**
- Consumes: `require_admin`, `get_session`, `app.sessions.revoke_all_refresh_tokens`, `app.security.hash_password`, `generate_temp_password`, `app.schemas.UserOut`, conftest helpers.
- Produces:
  - `UserCreate(username, full_name, branch_id, role="member")`, `UserUpdate(full_name?, branch_id?, role?, is_active?)`, `UserCreated(UserOut + temp_password)`, `ResetPasswordOut(temp_password)`.
  - `GET /api/admin/users?q=&branch_id=&is_active=`, `POST /api/admin/users` (201), `PATCH /api/admin/users/{id}`, `POST /api/admin/users/{id}/reset-password`.
  - Mã lỗi: `username_taken` (409), `branch_not_found` (404), `user_not_found` (404), `cannot_modify_self` (409).

- [ ] **Step 1: Viết test thất bại**

`backend/tests/test_admin_users.py`:
```python
from tests.conftest import create_branch, create_user, login


async def test_requires_admin(client, member_headers):
    assert (await client.get("/api/admin/users")).status_code == 401
    r = await client.get("/api/admin/users", headers=member_headers)
    assert r.status_code == 403


async def test_create_user_returns_temp_password_and_can_login(client, admin_headers):
    bid = await create_branch(name="Đà Nẵng", code="ĐN")
    r = await client.post(
        "/api/admin/users",
        headers=admin_headers,
        json={"username": "Ngoc.Vo", "full_name": "Võ Bảo Ngọc", "branch_id": bid},
    )
    assert r.status_code == 201
    body = r.json()
    assert body["username"] == "ngoc.vo"  # chuẩn hoá về chữ thường
    assert body["role"] == "member"
    assert body["must_change_password"] is True
    assert len(body["temp_password"]) == 12
    assert "password_hash" not in body

    first = await login(client, "ngoc.vo", body["temp_password"])
    assert first.status_code == 200
    assert first.json()["must_change_password"] is True


async def test_temp_password_not_exposed_by_list(client, admin_headers):
    listing = await client.get("/api/admin/users", headers=admin_headers)
    assert all("temp_password" not in u for u in listing.json())


async def test_create_duplicate_username(client, admin_headers):
    bid = await create_branch(name="B", code="B")
    payload = {"username": "dup.user", "full_name": "A", "branch_id": bid}
    assert (await client.post("/api/admin/users", headers=admin_headers, json=payload)).status_code == 201
    r = await client.post("/api/admin/users", headers=admin_headers, json=payload)
    assert r.status_code == 409
    assert r.json()["detail"] == "username_taken"


async def test_create_with_unknown_branch(client, admin_headers):
    r = await client.post(
        "/api/admin/users",
        headers=admin_headers,
        json={"username": "someone", "full_name": "A", "branch_id": 9999},
    )
    assert r.status_code == 404
    assert r.json()["detail"] == "branch_not_found"


async def test_create_validates_username_and_role(client, admin_headers):
    bid = await create_branch(name="B", code="B")
    bad_name = await client.post(
        "/api/admin/users", headers=admin_headers, json={"username": "a b", "full_name": "A", "branch_id": bid}
    )
    assert bad_name.status_code == 422
    bad_role = await client.post(
        "/api/admin/users",
        headers=admin_headers,
        json={"username": "valid.name", "full_name": "A", "branch_id": bid, "role": "root"},
    )
    assert bad_role.status_code == 422


async def test_list_filters(client, admin_headers):
    hn = await create_branch(name="Hà Nội", code="HN")
    dn = await create_branch(name="Đà Nẵng", code="ĐN")
    await create_user("anh.nguyen", branch_id=hn)
    await create_user("ha.le", branch_id=dn)
    await create_user("khoa.user", branch_id=dn, active=False)

    by_branch = await client.get(f"/api/admin/users?branch_id={dn}", headers=admin_headers)
    assert {u["username"] for u in by_branch.json()} == {"ha.le", "khoa.user"}

    active_only = await client.get(f"/api/admin/users?branch_id={dn}&is_active=true", headers=admin_headers)
    assert {u["username"] for u in active_only.json()} == {"ha.le"}

    search = await client.get("/api/admin/users?q=anh", headers=admin_headers)
    assert [u["username"] for u in search.json()] == ["anh.nguyen"]


async def test_deactivate_user_revokes_sessions_and_blocks_token(client, admin_headers):
    uid = await create_user("victim")
    # Dùng client riêng để cookie của nạn nhân không lẫn với client của admin.
    from httpx import ASGITransport, AsyncClient

    from app.main import create_app

    async with AsyncClient(transport=ASGITransport(app=create_app()), base_url="http://test") as victim:
        r = await login(victim, "victim")
        token = r.json()["access_token"]
        assert (await victim.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})).status_code == 200

        patch = await client.patch(f"/api/admin/users/{uid}", headers=admin_headers, json={"is_active": False})
        assert patch.status_code == 200
        assert patch.json()["is_active"] is False

        assert (await victim.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})).status_code == 401
        assert (await victim.post("/api/auth/refresh")).status_code == 401
        assert (await login(victim, "victim")).status_code == 401


async def test_update_user_fields(client, admin_headers):
    other = await create_branch(name="TP.HCM", code="HCM")
    uid = await create_user("alice")
    r = await client.patch(
        f"/api/admin/users/{uid}",
        headers=admin_headers,
        json={"full_name": "Alice Mới", "branch_id": other, "role": "admin"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["full_name"] == "Alice Mới"
    assert body["branch_id"] == other
    assert body["role"] == "admin"


async def test_update_unknown_user_and_branch(client, admin_headers):
    assert (await client.patch("/api/admin/users/999", headers=admin_headers, json={"full_name": "X"})).status_code == 404
    uid = await create_user("alice")
    r = await client.patch(f"/api/admin/users/{uid}", headers=admin_headers, json={"branch_id": 9999})
    assert r.status_code == 404
    assert r.json()["detail"] == "branch_not_found"


async def test_admin_cannot_demote_or_lock_self(client, admin_headers):
    me = (await client.get("/api/auth/me", headers=admin_headers)).json()["id"]
    demote = await client.patch(f"/api/admin/users/{me}", headers=admin_headers, json={"role": "member"})
    assert demote.status_code == 409
    assert demote.json()["detail"] == "cannot_modify_self"
    lock = await client.patch(f"/api/admin/users/{me}", headers=admin_headers, json={"is_active": False})
    assert lock.status_code == 409
    # Đổi tên chính mình thì vẫn được.
    rename = await client.patch(f"/api/admin/users/{me}", headers=admin_headers, json={"full_name": "Tên mới"})
    assert rename.status_code == 200


async def test_reset_password(client, admin_headers):
    uid = await create_user("alice")
    r = await client.post(f"/api/admin/users/{uid}/reset-password", headers=admin_headers)
    assert r.status_code == 200
    temp = r.json()["temp_password"]
    assert len(temp) == 12
    assert (await login(client, "alice")).status_code == 401  # mật khẩu cũ không còn dùng được
    again = await login(client, "alice", temp)
    assert again.status_code == 200
    assert again.json()["must_change_password"] is True


async def test_reset_password_unknown_user(client, admin_headers):
    r = await client.post("/api/admin/users/999/reset-password", headers=admin_headers)
    assert r.status_code == 404
    assert r.json()["detail"] == "user_not_found"
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `pytest tests/test_admin_users.py -v`
Expected: các test lỗi 404 vì chưa có route.

- [ ] **Step 3: Thêm schemas**

Sửa dòng import đầu `backend/app/schemas.py` thành:
```python
from pydantic import BaseModel, ConfigDict, Field, field_validator
```
Thêm vào cuối file:
```python
class UserCreate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    username: str = Field(pattern=r"^[a-z0-9._-]{3,50}$")
    full_name: str = Field(min_length=1, max_length=100)
    branch_id: int
    role: Literal["admin", "member"] = "member"

    @field_validator("username", mode="before")
    @classmethod
    def _lowercase_username(cls, value):
        return value.strip().lower() if isinstance(value, str) else value


class UserUpdate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    full_name: str | None = Field(default=None, min_length=1, max_length=100)
    branch_id: int | None = None
    role: Literal["admin", "member"] | None = None
    is_active: bool | None = None


class UserCreated(UserOut):
    temp_password: str


class ResetPasswordOut(BaseModel):
    temp_password: str
```

- [ ] **Step 4: Viết router**

`backend/app/routers/admin_users.py`:
```python
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.deps import require_admin
from app.models import Branch, User
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
    branch_id: int | None = None,
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
        password_hash=hash_password(temp_password),
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
    user_id: int,
    body: UserUpdate,
    session: AsyncSession = Depends(get_session),
    admin: User = Depends(require_admin),
) -> User:
    user = await _get_user_or_404(session, user_id)
    data = body.model_dump(exclude_unset=True)

    if user.id == admin.id:
        demoting = "role" in data and data["role"] != "admin"
        locking = "is_active" in data and data["is_active"] is False
        if demoting or locking:
            raise HTTPException(status_code=409, detail="cannot_modify_self")

    if data.get("branch_id") is not None:
        await _ensure_branch(session, data["branch_id"])

    for field, value in data.items():
        if value is not None:
            setattr(user, field, value)
    if data.get("is_active") is False:
        await revoke_all_refresh_tokens(session, user.id)
    await session.commit()
    return user


@router.post("/{user_id}/reset-password", response_model=ResetPasswordOut)
async def reset_password(
    user_id: int,
    session: AsyncSession = Depends(get_session),
    _admin: User = Depends(require_admin),
) -> ResetPasswordOut:
    user = await _get_user_or_404(session, user_id)
    temp_password = generate_temp_password()
    user.password_hash = hash_password(temp_password)
    user.must_change_password = True
    await revoke_all_refresh_tokens(session, user.id)
    await session.commit()
    return ResetPasswordOut(temp_password=temp_password)
```

Trong `backend/app/main.py` đổi import thành `from app.routers import admin_branches, admin_users, auth, health` và thêm:
```python
    app.include_router(admin_users.router, prefix="/api")
```

- [ ] **Step 5: Chạy test**

Run: `pytest tests/test_admin_users.py -v`
Expected: 13 passed.

- [ ] **Step 6: Chạy lại toàn bộ test (kể cả test Task 5 phụ thuộc route admin)**

Run: `pytest -v`
Expected: tất cả pass, trong đó `test_must_change_password_blocks_other_endpoints` (Task 5) giờ cũng pass.

- [ ] **Step 7: Commit**

```bash
git add backend
git commit -m "feat: add admin user management api" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: CLI tạo admin đầu tiên, README và kiểm tra toàn bộ qua Compose

**Files:**
- Create: `backend/app/cli.py`
- Create: `backend/tests/test_cli.py`
- Create: `README.md`

**Interfaces:**
- Consumes: `app.db.SessionLocal`, `app.models.Branch/User`, `app.security.generate_temp_password/hash_password`.
- Produces: `async bootstrap_admin(session, username, full_name, branch_name, branch_code) -> str` (trả mật khẩu tạm; ném `ValueError("username_taken")` nếu trùng); lệnh `python -m app.cli create-admin --username ... --full-name ... --branch-name ... --branch-code ...`.

- [ ] **Step 1: Viết test thất bại**

`backend/tests/test_cli.py`:
```python
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
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `pytest tests/test_cli.py -v`
Expected: lỗi `ModuleNotFoundError: No module named 'app.cli'`.

- [ ] **Step 3: Viết `cli.py`**

`backend/app/cli.py`:
```python
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
```

- [ ] **Step 4: Chạy test**

Run: `pytest tests/test_cli.py -v`
Expected: 3 passed.

- [ ] **Step 5: Viết README**

`README.md`:
````markdown
# Kết Nối: app nhắn tin nội bộ

Thiết kế: `docs/superpowers/specs/2026-10-12-internal-messaging-design.md`

## Chạy lần đầu (dev hoặc server Ubuntu)

```bash
cp .env.example .env          # sửa mật khẩu DB và JWT_SECRET (openssl rand -hex 32)
docker compose up -d --build  # dev: tự dùng thêm docker-compose.override.yml (mở cổng DB/Redis ở localhost)
docker compose ps             # đợi các service healthy
```

Triển khai thật (không mở cổng DB/Redis ra ngoài):

```bash
docker compose -f docker-compose.yml up -d --build
```

## Tạo tài khoản quản trị đầu tiên

```bash
docker compose exec api python -m app.cli create-admin \
  --username long.pham --full-name "Phạm Đức Long" \
  --branch-name "Hà Nội" --branch-code HN
```

Lệnh in mật khẩu tạm một lần. Người dùng phải đổi mật khẩu khi đăng nhập lần đầu.

## Chạy test backend

```bash
docker compose up -d db redis
docker compose exec db createdb -U messaging messaging_test   # chỉ lần đầu
cd backend
python -m venv .venv && source .venv/bin/activate              # Git Bash: source .venv/Scripts/activate
pip install -r requirements-dev.txt
pytest -v
```

## Lưu ý khi chưa có HTTPS

Giai đoạn này Caddy chỉ nghe cổng 80 (HTTP). Giữ `COOKIE_SECURE=false` trong `.env`, nếu không trình duyệt sẽ không lưu cookie đăng nhập. Khi bật HTTPS (Plan 6), đổi thành `COOKIE_SECURE=true` và `APP_ENV=prod`.
````

- [ ] **Step 6: Kiểm tra end-to-end qua Compose**

Run (từ thư mục gốc dự án):
```bash
docker compose down -v
docker compose up -d --build
sleep 30
docker compose ps
docker compose exec api python -m app.cli create-admin --username long.pham --full-name "Phạm Đức Long" --branch-name "Hà Nội" --branch-code HN
```
Expected: 4 service `healthy`/`running`; CLI in mật khẩu tạm (ghi lại, gọi là `TEMP`).

Run (thay `TEMP` bằng mật khẩu vừa in):
```bash
curl -s -c jar.txt -X POST http://localhost/api/auth/login -H "Content-Type: application/json" -d '{"username":"long.pham","password":"TEMP"}'
```
Expected: JSON có `access_token` và `"must_change_password":true`. Gọi là `TOKEN`.

Run:
```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost/api/admin/users -H "Authorization: Bearer TOKEN"
curl -s -X POST http://localhost/api/auth/change-password -H "Authorization: Bearer TOKEN" -H "Content-Type: application/json" -d '{"current_password":"TEMP","new_password":"MatKhauMoi123"}'
```
Expected: dòng đầu in `403` (bắt buộc đổi mật khẩu trước); lệnh thứ hai trả JSON có `"must_change_password":false` và `access_token` mới (`TOKEN2`).

Run:
```bash
curl -s http://localhost/api/admin/branches -H "Authorization: Bearer TOKEN2"
curl -s -c jar.txt -b jar.txt -X POST http://localhost/api/auth/refresh
```
Expected: danh sách chứa chi nhánh "Hà Nội" với `user_count` 1; refresh trả `access_token` mới.

Run: `rm -f jar.txt && docker compose down`

- [ ] **Step 7: Chạy toàn bộ test lần cuối**

Run: `cd backend && pytest -v`
Expected: tất cả pass (không có test fail hoặc bị bỏ qua).

- [ ] **Step 8: Commit**

```bash
git add backend README.md
git commit -m "feat: add create-admin cli and readme" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage (phần thuộc Plan 1):**
- Mục 2 (4 container, healthcheck, `.env`, log JSON, `MessageBus` để sau): Task 1, 4. `MessageBus` thuộc Plan 3 vì chưa có tin nhắn.
- Mục 3 (bảng `branches`, `users`, `refresh_tokens`): Task 2. Các bảng `rooms`, `room_members`, `messages`, `message_mentions`, `attachments` thuộc Plan 3, 4, 5.
- Mục 4 (không tự đăng ký, argon2, access + refresh cookie, rate limit Redis, `require_admin` ở backend, khoá tài khoản thu hồi token): Task 3, 5, 7. Giới hạn IP của Caddy cho `/api/admin/*` thuộc Plan 6.
- Mục 5, 7 phần admin (CRUD người dùng, chi nhánh, đặt lại mật khẩu): Task 6, 7. CRUD phòng/nhóm thuộc Plan 3.
- Mục 9 (cookie `httpOnly`/`Secure`/`SameSite`): Task 5. Chặn upload file thuộc Plan 5.

**Quét placeholder:** không có "TBD"/"TODO"; mọi bước mã đều có mã đầy đủ. Một chỗ có điều kiện: Task 5 Step 6 nêu rõ một test phụ thuộc route admin, và Task 7 Step 6 xác nhận lại.

**Nhất quán kiểu và tên:** `issue_session`, `revoke_all_refresh_tokens`, `get_current_user`/`get_ready_user`/`require_admin`, `create_branch`/`create_user`/`login` trong conftest, mã lỗi (`branch_exists`, `username_taken`, `cannot_modify_self`...) khớp giữa các task. `UserOut` định nghĩa ở Task 5 và dùng lại ở Task 7.

**Review Focus:** 5 dòng đều có test: username viết hoa/khoảng trắng (`test_login_normalizes_username`), mật khẩu 10.000 ký tự (`test_login_rejects_huge_password`), token hết hạn (`test_expired_access_token_rejected`), dùng lại refresh token cũ (`test_refresh_rotates_token_and_old_one_is_dead`), admin tự hạ quyền (`test_admin_cannot_demote_or_lock_self`).

## Các plan tiếp theo

| Plan | Nội dung |
|---|---|
| 2 | Frontend React: khung dự án, đăng nhập, đổi mật khẩu lần đầu, trang quản trị người dùng/chi nhánh |
| 3 | Chat lõi: bảng phòng/tin nhắn, WebSocket + `MessageBus` (Redis), phân trang theo cuộn, reconnect, API admin cho phòng/nhóm, giao diện chat |
| 4 | Trải nghiệm: đã xem, typing, presence, reply, mention, thông báo trình duyệt |
| 5 | File đính kèm và tìm kiếm tiếng Việt |
| 6 | Vận hành: HTTPS nội bộ, giới hạn IP admin, sao lưu và khôi phục, thử tải, tài liệu triển khai |
