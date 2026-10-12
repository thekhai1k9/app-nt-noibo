# Plan 3: Backend chat lõi (phòng, tin nhắn, WebSocket) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Backend nhắn tin chạy được: phòng chat 1-1 và nhóm, gửi/nhận tin nhắn thời gian thực qua WebSocket (phát qua Redis), tải lịch sử theo con trỏ, số tin chưa đọc, sửa/xoá tin, API admin quản lý nhóm. Giao diện chat là Plan 4.

**Architecture:** Monolith FastAPI hiện có. Tin nhắn lưu PostgreSQL trước, rồi phát qua giao diện `MessageBus` (cài đặt bằng Redis pub/sub). Mỗi process có một `Hub` giữ các kết nối WebSocket cục bộ, nghe bus và đẩy sự kiện cho kết nối thuộc phòng tương ứng; mỗi kết nối có hàng đợi riêng và bị đóng nếu chậm. Xác thực WebSocket bằng tin nhắn `auth` đầu tiên (trình duyệt không đặt được header). Bộ test chạy migration thật (sinh ra từ `alembic upgrade head`) và so với models.

**Tech Stack:** Python 3.12, FastAPI, SQLAlchemy 2.0 async + asyncpg, Alembic, Redis pub/sub (redis-py asyncio), `websockets` (server do uvicorn, client trong test), pytest + pytest-asyncio.

**Spec:** `docs/superpowers/specs/2026-10-12-internal-messaging-design.md` (mục 2, 3, 5, 6, 9, 10). Backend nền: Plan 1 (đã merge).

## Phạm vi của plan này

Làm: test migration so với models (trước khi thêm migration mới); bảng `rooms`, `room_members`, `messages` (migration `0002`); `MessageBus` + `Hub`; service chat; REST (`/users/directory`, `/rooms`, `/rooms/direct`, `/rooms/{id}/messages`, `/rooms/{id}/read`, sửa/xoá tin); API admin cho nhóm (`/admin/rooms...`); ngắt WebSocket khi khoá tài khoản/đặt lại mật khẩu; endpoint `WS /api/ws`; script kiểm tra đầu-cuối qua Caddy.

**Không làm (các plan sau):** giao diện chat và trang Phòng-và-nhóm của admin (Plan 4); `read`/`typing`/`presence` qua WebSocket, reply, mention, thông báo trình duyệt (Plan 5); file đính kèm và tìm kiếm (Plan 6); HTTPS, thử tải 100.000 tin, sao lưu (Plan 7).

**Điều chỉnh có chủ ý so với spec (cần bạn biết):**
- Ràng buộc chống gửi trùng là `(room_id, sender_id, client_id)` thay vì `(room_id, client_id)`: nếu không có `sender_id`, một người dùng đoán trước `client_id` của người khác trong cùng phòng sẽ khiến tin của người kia bị coi là "gửi trùng".
- Chỉ **admin tạo và quản lý nhóm** (đúng với màn hình "Phòng và nhóm" của admin trong thiết kế); người dùng thường tạo được chat 1-1 qua `POST /rooms/direct`. Admin tạo nhóm **không** tự thành thành viên (chỉ vào nhóm nếu chính họ được thêm), nên admin không đọc được nội dung nhóm mình không tham gia.
- Chat 1-1 hoàn toàn riêng tư: admin không thấy và không quản lý được phòng direct.

## Global Constraints

- Tin nhắn **lưu Postgres trước, phát sau**; nếu Redis lỗi, tin không mất; lỗi phát bus chỉ ghi log (không làm hỏng việc gửi).
- Phân trang con trỏ (keyset), không dùng `OFFSET`; trang mặc định 50, tối đa 100; chỉ mục `messages(room_id, id DESC)`; không N+1 (join lấy tên người gửi).
- Người dùng chỉ đọc/gửi/đánh dấu đã đọc trong phòng mình là thành viên; người ngoài phòng nhận 404 `room_not_found` (không tiết lộ phòng có tồn tại), cả REST lẫn WebSocket. Admin cũng không đọc được tin của phòng mình không phải thành viên.
- Xoá tin nhắn là xoá mềm (`deleted_at`); nội dung không trả về client sau khi xoá.
- Một WebSocket cho mỗi tab, dùng cho mọi phòng của user. Xác thực bằng tin nhắn đầu tiên `{"type":"auth","token":"<access token>"}` trong vòng 5 giây, nếu không bị đóng với mã 4401.
- Mã đóng WebSocket: `4401` chưa xác thực/sai token/tài khoản khoá; `4403` tài khoản bị khoá hoặc đặt lại mật khẩu (ngắt chủ động); `4408` client nhận quá chậm (hàng đợi đầy); `4413` khung tin quá lớn.
- Giới hạn gửi tin trên WebSocket (mặc định 20 tin / 10 giây / kết nối); độ dài tin tối đa 4000 ký tự; khung WebSocket tối đa 16 KB.
- Mã lỗi API là chuỗi máy đọc được, không phải câu tiếng Việt.
- Khi `MessageBus` nghe lại sau khi mất kết nối Redis, server gửi sự kiện `{"type":"resync"}` cho mọi kết nối để client tự tải lại.
- Mọi migration có test chạy thật và so với models (không còn chỉ dựa vào `create_all`).
- Test chạy trong container Python 3.12 qua `bash scripts/test.sh` (xem README); không dùng Python cục bộ.

## Review Focus

Các tình huống spec ngầm đòi hỏi nhưng dễ bị bỏ sót; mỗi dòng có test trong task ghi ở cuối dòng.

- Người không phải thành viên (kể cả admin) đọc, gửi hoặc đánh dấu đã đọc trong phòng đều nhận 404 `room_not_found`, qua REST và WebSocket (Task 5, 7).
- Gửi lại cùng `client_id` không tạo tin trùng và chỉ phát một sự kiện; `client_id` của người khác không va chạm (Task 4, 7).
- Tin rỗng/toàn khoảng trắng/quá dài, JSON hỏng, loại sự kiện lạ không làm đứt kết nối; khung quá lớn thì đóng 4413 (Task 7).
- Bị gỡ khỏi nhóm thì ngừng nhận tin ngay trên kết nối đang mở; bị khoá tài khoản thì kết nối bị đóng 4403 (Task 6, 7).
- Phân trang: phòng rỗng, `before` ở tin cũ nhất, `limit` vượt trần, `around` không tồn tại, hai con trỏ cùng lúc, tin đã xoá không lộ nội dung (Task 4).
- Client nhận chậm bị đóng 4408 mà không làm chậm client khác (Task 3).

---

## File Structure

```
backend/
├── requirements.txt                    # + websockets
├── alembic/versions/0002_chat.py
├── app/
│   ├── chat/
│   │   ├── __init__.py
│   │   ├── bus.py                      # MessageBus, RedisMessageBus, publish_*_safely
│   │   ├── hub.py                      # Connection, Hub
│   │   ├── schemas.py                  # MessageOut, RoomOut, ... + to_message_out
│   │   └── service.py                  # ChatError + toàn bộ logic phòng/tin nhắn
│   ├── config.py                       # + cấu hình WebSocket
│   ├── main.py                         # + routers, ChatError handler, hub trong lifespan
│   ├── models.py                       # + Room, RoomMember, Message
│   ├── redis_client.py                 # + build_listen_redis
│   └── routers/
│       ├── admin_rooms.py
│       ├── admin_users.py              # + ngắt WS khi khoá/đặt lại mật khẩu
│       ├── chat.py                     # REST cho người dùng
│       └── ws.py                       # WS /api/ws
└── tests/
    ├── conftest.py                     # + helper phòng/tin, bus giả, live_server
    ├── helpers.py                      # InMemoryBus, tiện ích WebSocket
    ├── test_admin_rooms.py
    ├── test_bus.py
    ├── test_chat_api.py
    ├── test_chat_models.py
    ├── test_chat_service.py
    ├── test_hub.py
    ├── test_migrations.py
    └── test_ws.py
scripts/
└── e2e_chat_smoke.py                   # kiểm tra đầu-cuối qua Caddy
```

Quy ước chạy lệnh: từ thư mục gốc dự án, Git Bash; `bash scripts/test.sh <đối số pytest>` (đường dẫn tính từ `backend/`).

---

### Task 1: Test migration so với models (trước khi thêm migration mới)

**Files:**
- Create: `backend/tests/test_migrations.py`

**Interfaces:**
- Consumes: `app.config.get_settings`, `app.db.Base`, `alembic.ini` và `alembic/env.py` hiện có.
- Produces: fixture `scratch_alembic` (trong file test) trả `(Config, scratch_url)`, dùng lại ở Task 2; test `test_migrations_match_models`.

- [ ] **Step 1: Viết test**

`backend/tests/test_migrations.py`:
```python
import asyncio
from pathlib import Path

import pytest_asyncio
from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import create_async_engine

from app.config import get_settings
from app.db import Base

SCRATCH_DB = "messaging_migrate_test"
BACKEND_DIR = Path(__file__).resolve().parents[1]


@pytest_asyncio.fixture
async def scratch_alembic(monkeypatch):
    """Tạo một database tạm, trỏ alembic vào đó và trả (Config, URL của database tạm)."""
    base_url = make_url(get_settings().database_url)
    assert base_url.database.endswith("_test"), "refusing to touch a non-test database"
    admin = create_async_engine(base_url.set(database="postgres"), isolation_level="AUTOCOMMIT")
    async with admin.connect() as conn:
        await conn.execute(text(f'DROP DATABASE IF EXISTS "{SCRATCH_DB}" WITH (FORCE)'))
        await conn.execute(text(f'CREATE DATABASE "{SCRATCH_DB}"'))
    await admin.dispose()

    scratch_url = base_url.set(database=SCRATCH_DB)
    monkeypatch.setenv("DATABASE_URL", scratch_url.render_as_string(hide_password=False))
    get_settings.cache_clear()
    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_DIR / "alembic"))
    try:
        yield cfg, scratch_url
    finally:
        monkeypatch.undo()
        get_settings.cache_clear()
        cleanup = create_async_engine(base_url.set(database="postgres"), isolation_level="AUTOCOMMIT")
        async with cleanup.connect() as conn:
            await conn.execute(text(f'DROP DATABASE IF EXISTS "{SCRATCH_DB}" WITH (FORCE)'))
        await cleanup.dispose()


async def _diff_against_models(scratch_url):
    engine = create_async_engine(scratch_url)
    try:
        async with engine.connect() as conn:
            return await conn.run_sync(
                lambda sync_conn: compare_metadata(MigrationContext.configure(sync_conn), Base.metadata)
            )
    finally:
        await engine.dispose()


async def test_migrations_match_models(scratch_alembic):
    cfg, scratch_url = scratch_alembic
    # env.py gọi asyncio.run(), nên phải chạy trong luồng riêng (không có event loop đang chạy).
    await asyncio.to_thread(command.upgrade, cfg, "head")
    diffs = await _diff_against_models(scratch_url)
    assert diffs == [], f"models và migration lệch nhau: {diffs}"


async def test_migrations_roundtrip(scratch_alembic):
    cfg, scratch_url = scratch_alembic
    await asyncio.to_thread(command.upgrade, cfg, "head")
    await asyncio.to_thread(command.downgrade, cfg, "base")
    engine = create_async_engine(scratch_url)
    try:
        async with engine.connect() as conn:
            tables = (
                await conn.execute(
                    text("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'alembic_version'")
                )
            ).scalars().all()
    finally:
        await engine.dispose()
    assert tables == []
    await asyncio.to_thread(command.upgrade, cfg, "head")
```

- [ ] **Step 2: Chạy test**

Run: `bash scripts/test.sh tests/test_migrations.py -v`
Expected: 2 passed (migration `0001` hiện tại khớp với models). Nếu `test_migrations_match_models` báo lệch thật giữa `0001` và models thì đây là phát hiện quan trọng: sửa **migration mới** (không sửa `0001` đã phát hành) bằng một migration `0002a` bù, hoặc báo lại để quyết định, và ghi vào báo cáo. Nếu lệch chỉ do `compare_metadata` báo kiểu/độ dài tương đương (ví dụ `Integer` vs `BigInteger` ở dạng so sánh) thì ghi rõ lý do và thêm đúng một mục bỏ qua có chú thích trong test.

- [ ] **Step 3: Commit**

```bash
git add backend/tests/test_migrations.py
git commit -m "test: verify alembic migrations match the models and roundtrip" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Models và migration 0002 (rooms, room_members, messages)

**Files:**
- Modify: `backend/app/models.py`
- Create: `backend/alembic/versions/0002_chat.py`
- Modify: `backend/tests/conftest.py` (cập nhật `TRUNCATE`, thêm helper phòng/tin)
- Create: `backend/tests/test_chat_models.py`

**Interfaces:**
- Consumes: `Base`, `User`, `Branch` (Plan 1).
- Produces:
  - `models.Room(id, type, name, branch_id, created_by, direct_key, created_at)`; `type` là `'direct'` hoặc `'group'`.
  - `models.RoomMember(room_id, user_id, role, last_read_message_id, joined_at)`; khoá chính `(room_id, user_id)`.
  - `models.Message(id: BigInteger, room_id, sender_id, body, kind, client_id, created_at, edited_at, deleted_at)`; chỉ mục `ix_messages_room_id_id (room_id, id DESC)`; ràng buộc `uq_messages_room_sender_client`.
  - conftest: `create_room(type_="group", name="Phòng", member_ids=(), branch_id=None, created_by=None) -> int`, `create_direct(a: int, b: int) -> int`, `add_message(room_id, sender_id, body="xin chào", client_id=None) -> int`, `token_for(client, username) -> str`, `auth_headers(token) -> dict`.

- [ ] **Step 1: Viết test thất bại**

Trong `backend/tests/conftest.py`, đổi câu `TRUNCATE` thành:
```python
        await conn.execute(
            text("TRUNCATE messages, room_members, rooms, refresh_tokens, users, branches RESTART IDENTITY CASCADE")
        )
```
và thêm vào cuối file (import `Message, Room, RoomMember` từ `app.models` ở đầu file):
```python
async def create_room(
    type_: str = "group",
    name: str | None = "Phòng",
    member_ids: tuple[int, ...] | list[int] = (),
    branch_id: int | None = None,
    created_by: int | None = None,
) -> int:
    async with SessionLocal() as s:
        room = Room(type=type_, name=name if type_ == "group" else None, branch_id=branch_id, created_by=created_by)
        s.add(room)
        await s.flush()
        s.add_all([RoomMember(room_id=room.id, user_id=uid) for uid in member_ids])
        await s.commit()
        return room.id


async def create_direct(a: int, b: int) -> int:
    async with SessionLocal() as s:
        room = Room(type="direct", direct_key=f"{min(a, b)}:{max(a, b)}", created_by=a)
        s.add(room)
        await s.flush()
        s.add_all([RoomMember(room_id=room.id, user_id=a), RoomMember(room_id=room.id, user_id=b)])
        await s.commit()
        return room.id


async def add_message(room_id: int, sender_id: int, body: str = "xin chào", client_id: str | None = None) -> int:
    async with SessionLocal() as s:
        msg = Message(room_id=room_id, sender_id=sender_id, body=body, client_id=client_id)
        s.add(msg)
        await s.commit()
        return msg.id


async def token_for(client, username: str) -> str:
    r = await login(client, username)
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


def auth_headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}
```

`backend/tests/test_chat_models.py`:
```python
import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError

from app.db import SessionLocal
from app.models import Message, Room, RoomMember
from tests.conftest import add_message, create_direct, create_room, create_user


async def test_direct_key_is_unique():
    a, b = await create_user("alice"), await create_user("bob")
    await create_direct(a, b)
    with pytest.raises(IntegrityError):
        await create_direct(a, b)


async def test_client_id_unique_per_room_and_sender_but_not_across_senders():
    a, b = await create_user("alice"), await create_user("bob")
    room = await create_room(member_ids=[a, b])
    await add_message(room, a, client_id="c1")
    await add_message(room, b, client_id="c1")  # người khác dùng cùng client_id: được phép
    with pytest.raises(IntegrityError):
        await add_message(room, a, client_id="c1")


async def test_null_client_ids_do_not_collide():
    a = await create_user("alice")
    room = await create_room(member_ids=[a])
    await add_message(room, a)
    await add_message(room, a)


async def test_deleting_a_room_cascades_to_members_and_messages():
    a = await create_user("alice")
    room = await create_room(member_ids=[a])
    await add_message(room, a)
    async with SessionLocal() as s:
        await s.delete(await s.get(Room, room))
        await s.commit()
        assert (await s.execute(select(RoomMember))).first() is None
        assert (await s.execute(select(Message))).first() is None


async def test_message_ids_are_bigint_and_increasing():
    a = await create_user("alice")
    room = await create_room(member_ids=[a])
    first, second = await add_message(room, a), await add_message(room, a)
    assert second > first


async def test_pagination_index_exists():
    async with SessionLocal() as s:
        row = (
            await s.execute(text("SELECT indexdef FROM pg_indexes WHERE indexname = 'ix_messages_room_id_id'"))
        ).scalar_one()
    assert "room_id" in row and "id DESC" in row
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `bash scripts/test.sh tests/test_chat_models.py -v`
Expected: lỗi `ImportError` (chưa có `Room`, `RoomMember`, `Message`).

- [ ] **Step 3: Thêm models**

Sửa dòng import đầu `backend/app/models.py`:
```python
from sqlalchemy import BigInteger, Boolean, DateTime, ForeignKey, Index, String, Text, UniqueConstraint, func, text, true
```
Thêm vào cuối file:
```python
class Room(Base):
    __tablename__ = "rooms"

    id: Mapped[int] = mapped_column(primary_key=True)
    type: Mapped[str] = mapped_column(String(16))  # 'direct' | 'group'
    name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    branch_id: Mapped[int | None] = mapped_column(ForeignKey("branches.id", ondelete="SET NULL"), nullable=True)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    direct_key: Mapped[str | None] = mapped_column(String(32), unique=True, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class RoomMember(Base):
    __tablename__ = "room_members"

    room_id: Mapped[int] = mapped_column(ForeignKey("rooms.id", ondelete="CASCADE"), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True, index=True)
    role: Mapped[str] = mapped_column(String(16), default="member", server_default="member")
    last_read_message_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    joined_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Message(Base):
    __tablename__ = "messages"
    __table_args__ = (
        Index("ix_messages_room_id_id", "room_id", text("id DESC")),
        UniqueConstraint("room_id", "sender_id", "client_id", name="uq_messages_room_sender_client"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    room_id: Mapped[int] = mapped_column(ForeignKey("rooms.id", ondelete="CASCADE"))
    sender_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    body: Mapped[str] = mapped_column(Text)
    kind: Mapped[str] = mapped_column(String(16), default="text", server_default="text")
    client_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    edited_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
```

- [ ] **Step 4: Viết migration 0002**

`backend/alembic/versions/0002_chat.py`:
```python
"""chat: rooms, room_members, messages

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-14
"""
import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "rooms",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("type", sa.String(16), nullable=False),
        sa.Column("name", sa.String(100), nullable=True),
        sa.Column("branch_id", sa.Integer, sa.ForeignKey("branches.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_by", sa.Integer, sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("direct_key", sa.String(32), nullable=True, unique=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_table(
        "room_members",
        sa.Column("room_id", sa.Integer, sa.ForeignKey("rooms.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("user_id", sa.Integer, sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("role", sa.String(16), nullable=False, server_default="member"),
        sa.Column("last_read_message_id", sa.BigInteger, nullable=True),
        sa.Column("joined_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_room_members_user_id", "room_members", ["user_id"])
    op.create_table(
        "messages",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("room_id", sa.Integer, sa.ForeignKey("rooms.id", ondelete="CASCADE"), nullable=False),
        sa.Column("sender_id", sa.Integer, sa.ForeignKey("users.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("body", sa.Text, nullable=False),
        sa.Column("kind", sa.String(16), nullable=False, server_default="text"),
        sa.Column("client_id", sa.String(64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("edited_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("room_id", "sender_id", "client_id", name="uq_messages_room_sender_client"),
    )
    op.create_index("ix_messages_room_id_id", "messages", ["room_id", sa.text("id DESC")])


def downgrade() -> None:
    op.drop_table("messages")
    op.drop_table("room_members")
    op.drop_table("rooms")
```

- [ ] **Step 5: Chạy test**

Run: `bash scripts/test.sh tests/test_chat_models.py tests/test_migrations.py -v`
Expected: tất cả pass. Nếu `test_migrations_match_models` báo lệch chỉ ở chỉ mục biểu thức `ix_messages_room_id_id` (alembic không so sánh được chỉ mục có biểu thức), thêm vào test đúng một bộ lọc có chú thích loại bỏ chênh lệch `add_index`/`remove_index` của chỉ mục này, và giữ nguyên `test_pagination_index_exists` làm bằng chứng chỉ mục tồn tại ở cả `create_all` lẫn migration (thêm một assertion tương tự trên database tạm trong `test_migrations_match_models` bằng truy vấn `pg_indexes`). Mọi lệch khác phải được sửa, không bỏ qua.

- [ ] **Step 6: Chạy toàn bộ test và commit**

Run: `bash scripts/test.sh -q`
Expected: tất cả pass (không test cũ nào hỏng).

```bash
git add backend
git commit -m "feat: add rooms, room members and messages tables with migration 0002" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Cấu hình, MessageBus, Hub

**Files:**
- Modify: `backend/app/config.py`, `backend/app/redis_client.py`, `backend/requirements.txt`, `backend/tests/conftest.py` (biến môi trường test)
- Create: `backend/app/chat/__init__.py`, `backend/app/chat/bus.py`, `backend/app/chat/hub.py`
- Create: `backend/tests/helpers.py`, `backend/tests/test_bus.py`, `backend/tests/test_hub.py`

**Interfaces:**
- Consumes: `get_redis()` (Plan 1), `SessionLocal`, `RoomMember`.
- Produces:
  - `config.Settings` thêm: `ws_rate_limit_messages: int = 20`, `ws_rate_limit_seconds: int = 10`, `ws_auth_timeout_seconds: float = 5.0`, `max_message_length: int = 4000`.
  - `redis_client.build_listen_redis() -> Redis` (không có `socket_timeout`, dùng riêng cho pub/sub).
  - `bus.BusEvent(scope: str, target_id: int, payload: dict)` (NamedTuple); `scope` là `"room"`, `"user"` hoặc `"system"`.
  - `bus.MessageBus` (Protocol): `async publish_room(room_id, event)`, `async publish_user(user_id, event)`, `listen() -> AsyncIterator[BusEvent]` (sau khi đăng ký xong phát đúng một `BusEvent("system", 0, {"type": "subscribed"})`).
  - `bus.RedisMessageBus(redis, listen_redis=None)`; `async bus.publish_room_safely(bus, room_id, event) -> bool`, `async bus.publish_user_safely(bus, user_id, event) -> bool` (nuốt `RedisError`, ghi log, trả `False`).
  - `hub.Connection(user_id, room_ids=(), queue_size=100)` có `.user_id`, `.room_ids: set[int]`, `.queue: asyncio.Queue[dict | None]`, `.close_code`, `.offer(event) -> bool`, `.close(code)` (xả hàng đợi rồi đặt sentinel `None`).
  - `hub.Hub(bus, session_factory, reconnect_delay=1.0)` với `.bus`, `.register(conn)`, `.unregister(conn)`, `.broadcast(event)`, `async run()`, `async close_all()`.
  - `tests/helpers.py`: `InMemoryBus` (cùng giao diện `MessageBus`, ghi `.published`, thuộc tính `fail_listens: int`), tiện ích WebSocket (Task 7).
  - Quy ước sự kiện từ user-scope: `{"type": "rooms_changed"}` → Hub nạp lại `room_ids` của mọi kết nối của user đó từ DB rồi chuyển tiếp sự kiện; `{"type": "disconnect"}` → đóng các kết nối đó với mã `4403`.

- [ ] **Step 1: Cấu hình và phụ thuộc**

Thêm vào `backend/requirements.txt` (cuối file): `websockets==13.1`.

Thêm vào class `Settings` trong `backend/app/config.py` (sau `login_window_seconds`):
```python
    ws_rate_limit_messages: int = 20
    ws_rate_limit_seconds: int = 10
    ws_auth_timeout_seconds: float = 5.0
    max_message_length: int = 4000
```

Thêm vào `backend/app/redis_client.py`:
```python
def build_listen_redis() -> Redis:
    """Kết nối riêng cho pub/sub: không đặt socket_timeout vì phải chờ tin vô thời hạn."""
    return Redis.from_url(
        get_settings().redis_url,
        decode_responses=True,
        socket_connect_timeout=3,
        health_check_interval=30,
    )
```

Thêm vào các `os.environ[...]` đầu `backend/tests/conftest.py`:
```python
os.environ["WS_RATE_LIMIT_MESSAGES"] = "5"
os.environ["WS_AUTH_TIMEOUT_SECONDS"] = "1"
```

- [ ] **Step 2: Viết test thất bại**

`backend/tests/helpers.py` (các hàm WebSocket sẽ dùng ở Task 7, thêm ngay bây giờ):
```python
import asyncio
import json

import pytest
from websockets.asyncio.client import connect

from app.chat.bus import BusEvent


class InMemoryBus:
    """MessageBus chạy trong tiến trình, dùng cho test không cần Redis thật."""

    def __init__(self):
        self.published: list[tuple[str, int, dict]] = []
        self.fail_listens = 0
        self._queue: asyncio.Queue[BusEvent] = asyncio.Queue()

    async def publish_room(self, room_id: int, event: dict) -> None:
        self.published.append(("room", room_id, event))
        await self._queue.put(BusEvent("room", room_id, event))

    async def publish_user(self, user_id: int, event: dict) -> None:
        self.published.append(("user", user_id, event))
        await self._queue.put(BusEvent("user", user_id, event))

    async def listen(self):
        if self.fail_listens > 0:
            self.fail_listens -= 1
            raise ConnectionError("bus down")
        yield BusEvent("system", 0, {"type": "subscribed"})
        while True:
            yield await self._queue.get()


async def ws_open(ws_base: str, token: str):
    """Mở WebSocket, gửi tin auth, trả (ws, tin đầu tiên nhận được)."""
    ws = await connect(f"{ws_base}/api/ws")
    await ws.send(json.dumps({"type": "auth", "token": token}))
    first = json.loads(await asyncio.wait_for(ws.recv(), 3))
    return ws, first


async def recv_json(ws, timeout: float = 3):
    return json.loads(await asyncio.wait_for(ws.recv(), timeout))


async def expect_silence(ws, seconds: float = 0.4):
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(ws.recv(), seconds)


async def wait_closed(ws, timeout: float = 3) -> int | None:
    await asyncio.wait_for(ws.wait_closed(), timeout)
    return ws.close_code
```

`backend/tests/test_bus.py`:
```python
import asyncio
import json
from contextlib import aclosing

from redis.exceptions import RedisError

from app.chat.bus import RedisMessageBus, publish_room_safely, publish_user_safely
from app.redis_client import build_listen_redis, get_redis


async def test_redis_bus_delivers_room_and_user_events():
    bus = RedisMessageBus(get_redis(), build_listen_redis())
    received = []

    async def consume():
        async with aclosing(bus.listen()) as events:  # đóng pubsub khi xong
            async for event in events:
                received.append(event)
                if len(received) == 3:
                    return

    task = asyncio.create_task(consume())
    for _ in range(100):
        if received:  # đã nhận sự kiện "subscribed"
            break
        await asyncio.sleep(0.02)
    await bus.publish_room(7, {"type": "message", "n": 1})
    await bus.publish_user(9, {"type": "rooms_changed"})
    await asyncio.wait_for(task, 3)

    assert received[0].scope == "system" and received[0].payload == {"type": "subscribed"}
    assert (received[1].scope, received[1].target_id, received[1].payload) == ("room", 7, {"type": "message", "n": 1})
    assert (received[2].scope, received[2].target_id, received[2].payload) == ("user", 9, {"type": "rooms_changed"})


async def test_redis_bus_publishes_json():
    bus = RedisMessageBus(get_redis())
    pubsub = get_redis().pubsub()
    await pubsub.subscribe("kn:room:5")
    await pubsub.get_message(timeout=1)  # xác nhận subscribe
    await bus.publish_room(5, {"type": "x", "vi": "tiếng Việt"})
    message = None
    for _ in range(50):
        message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=0.1)
        if message:
            break
    await pubsub.aclose()
    assert json.loads(message["data"]) == {"type": "x", "vi": "tiếng Việt"}


class _BrokenBus:
    async def publish_room(self, room_id, event):
        raise RedisError("down")

    async def publish_user(self, user_id, event):
        raise RedisError("down")


async def test_safe_publish_swallows_redis_errors():
    assert await publish_room_safely(_BrokenBus(), 1, {"type": "x"}) is False
    assert await publish_user_safely(_BrokenBus(), 1, {"type": "x"}) is False


async def test_safe_publish_returns_true_on_success():
    from tests.helpers import InMemoryBus

    bus = InMemoryBus()
    assert await publish_room_safely(bus, 1, {"type": "x"}) is True
    assert bus.published == [("room", 1, {"type": "x"})]
```

`backend/tests/test_hub.py`:
```python
import asyncio

from app.chat.bus import BusEvent
from app.chat.hub import Connection, Hub
from app.db import SessionLocal
from app.models import RoomMember
from tests.conftest import create_room, create_user
from tests.helpers import InMemoryBus


def drain(conn: Connection) -> list:
    items = []
    while not conn.queue.empty():
        items.append(conn.queue.get_nowait())
    return items


async def test_room_events_reach_only_connections_in_that_room():
    hub = Hub(InMemoryBus(), SessionLocal)
    in_room, other = Connection(1, [10]), Connection(2, [11])
    hub.register(in_room)
    hub.register(other)
    await hub._dispatch(BusEvent("room", 10, {"type": "message", "n": 1}))
    assert drain(in_room) == [{"type": "message", "n": 1}]
    assert drain(other) == []


async def test_rooms_changed_reloads_membership_from_the_database():
    alice = await create_user("alice")
    room = await create_room(member_ids=[alice])
    hub = Hub(InMemoryBus(), SessionLocal)
    conn = Connection(alice, [])
    hub.register(conn)

    await hub._dispatch(BusEvent("user", alice, {"type": "rooms_changed"}))
    assert conn.room_ids == {room}
    assert drain(conn) == [{"type": "rooms_changed"}]

    async with SessionLocal() as s:
        await s.delete(await s.get(RoomMember, (room, alice)))
        await s.commit()
    await hub._dispatch(BusEvent("user", alice, {"type": "rooms_changed"}))
    assert conn.room_ids == set()
    await hub._dispatch(BusEvent("room", room, {"type": "message"}))
    assert [e for e in drain(conn) if e["type"] == "message"] == []


async def test_disconnect_event_closes_the_users_connections_with_4403():
    hub = Hub(InMemoryBus(), SessionLocal)
    victim, bystander = Connection(1, [10]), Connection(2, [10])
    hub.register(victim)
    hub.register(bystander)
    await hub._dispatch(BusEvent("user", 1, {"type": "disconnect"}))
    assert victim.close_code == 4403
    assert victim.queue.get_nowait() is None
    assert bystander.close_code is None


async def test_slow_consumer_is_closed_without_blocking_others():
    hub = Hub(InMemoryBus(), SessionLocal)
    slow, fast = Connection(1, [10], queue_size=2), Connection(2, [10], queue_size=50)
    hub.register(slow)
    hub.register(fast)
    for n in range(5):
        await hub._dispatch(BusEvent("room", 10, {"type": "message", "n": n}))
    assert slow.close_code == 4408
    assert slow.queue.get_nowait() is None  # chỉ còn sentinel đóng kết nối
    assert [e["n"] for e in drain(fast)] == [0, 1, 2, 3, 4]
    assert fast.close_code is None


async def test_connection_close_is_idempotent_and_blocks_further_offers():
    conn = Connection(1, [10], queue_size=1)
    conn.close(4403)
    conn.close(4401)
    assert conn.close_code == 4403
    assert conn.offer({"type": "x"}) is False


async def test_run_dispatches_bus_events_to_connections():
    bus = InMemoryBus()
    hub = Hub(bus, SessionLocal, reconnect_delay=0.01)
    conn = Connection(1, [10])
    hub.register(conn)
    task = asyncio.create_task(hub.run())
    try:
        await bus.publish_room(10, {"type": "message", "n": 1})
        for _ in range(100):
            if not conn.queue.empty():
                break
            await asyncio.sleep(0.02)
        assert drain(conn) == [{"type": "message", "n": 1}]
    finally:
        task.cancel()


async def test_run_asks_clients_to_resync_after_the_bus_fails_and_recovers():
    bus = InMemoryBus()
    bus.fail_listens = 1
    hub = Hub(bus, SessionLocal, reconnect_delay=0.01)
    conn = Connection(1, [10])
    hub.register(conn)
    task = asyncio.create_task(hub.run())
    try:
        for _ in range(100):
            if not conn.queue.empty():
                break
            await asyncio.sleep(0.02)
        assert {"type": "resync"} in drain(conn)
        await bus.publish_room(10, {"type": "message", "n": 2})  # hub đã nghe lại được
        for _ in range(100):
            if not conn.queue.empty():
                break
            await asyncio.sleep(0.02)
        assert drain(conn) == [{"type": "message", "n": 2}]
    finally:
        task.cancel()
```

- [ ] **Step 3: Chạy test để xác nhận thất bại**

Run: `bash scripts/test.sh tests/test_bus.py tests/test_hub.py -v`
Expected: lỗi `ModuleNotFoundError: No module named 'app.chat'`.

- [ ] **Step 4: Viết `bus.py`**

`backend/app/chat/__init__.py`: file rỗng.

`backend/app/chat/bus.py`:
```python
import json
import logging
from collections.abc import AsyncIterator
from typing import NamedTuple, Protocol

from redis.asyncio import Redis
from redis.exceptions import RedisError

log = logging.getLogger(__name__)

ROOM_PREFIX = "kn:room:"
USER_PREFIX = "kn:user:"


class BusEvent(NamedTuple):
    scope: str  # "room" | "user" | "system"
    target_id: int
    payload: dict


class MessageBus(Protocol):
    async def publish_room(self, room_id: int, event: dict) -> None: ...

    async def publish_user(self, user_id: int, event: dict) -> None: ...

    def listen(self) -> AsyncIterator[BusEvent]: ...


class RedisMessageBus:
    """MessageBus dùng Redis pub/sub. `listen_redis` phải là kết nối riêng không có socket_timeout."""

    def __init__(self, redis: Redis, listen_redis: Redis | None = None):
        self._redis = redis
        self._listen_redis = listen_redis

    async def publish_room(self, room_id: int, event: dict) -> None:
        await self._redis.publish(f"{ROOM_PREFIX}{room_id}", json.dumps(event, ensure_ascii=False))

    async def publish_user(self, user_id: int, event: dict) -> None:
        await self._redis.publish(f"{USER_PREFIX}{user_id}", json.dumps(event, ensure_ascii=False))

    async def listen(self) -> AsyncIterator[BusEvent]:
        client = self._listen_redis or self._redis
        pubsub = client.pubsub()
        await pubsub.psubscribe(f"{ROOM_PREFIX}*", f"{USER_PREFIX}*")
        try:
            subscribed = False
            async for item in pubsub.listen():
                kind = item["type"]
                if kind == "psubscribe":
                    if not subscribed:
                        subscribed = True
                        yield BusEvent("system", 0, {"type": "subscribed"})
                    continue
                if kind != "pmessage":
                    continue
                channel: str = item["channel"]
                if channel.startswith(ROOM_PREFIX):
                    scope, raw_id = "room", channel[len(ROOM_PREFIX) :]
                else:
                    scope, raw_id = "user", channel[len(USER_PREFIX) :]
                try:
                    yield BusEvent(scope, int(raw_id), json.loads(item["data"]))
                except (ValueError, TypeError):
                    log.warning("dropping malformed bus message on %s", channel)
        finally:
            await pubsub.aclose()


async def publish_room_safely(bus: MessageBus, room_id: int, event: dict) -> bool:
    """Phát sự kiện phòng; lỗi Redis chỉ ghi log (tin nhắn đã nằm trong DB nên không mất)."""
    try:
        await bus.publish_room(room_id, event)
        return True
    except RedisError:
        log.warning("could not publish room event", exc_info=True)
        return False


async def publish_user_safely(bus: MessageBus, user_id: int, event: dict) -> bool:
    try:
        await bus.publish_user(user_id, event)
        return True
    except RedisError:
        log.warning("could not publish user event", exc_info=True)
        return False
```

- [ ] **Step 5: Viết `hub.py`**

`backend/app/chat/hub.py`:
```python
import asyncio
import logging
from collections.abc import Callable, Iterable
from contextlib import AbstractAsyncContextManager

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.chat.bus import BusEvent, MessageBus
from app.models import RoomMember

log = logging.getLogger(__name__)

CLOSE_ACCOUNT_LOCKED = 4403
CLOSE_SLOW_CONSUMER = 4408


class Connection:
    """Trạng thái của một WebSocket: hàng đợi gửi đi và tập phòng đang tham gia."""

    def __init__(self, user_id: int, room_ids: Iterable[int] = (), queue_size: int = 100):
        self.user_id = user_id
        self.room_ids: set[int] = set(room_ids)
        self.queue: asyncio.Queue[dict | None] = asyncio.Queue(maxsize=queue_size)
        self.close_code: int | None = None

    def offer(self, event: dict) -> bool:
        if self.close_code is not None:
            return False
        try:
            self.queue.put_nowait(event)
            return True
        except asyncio.QueueFull:
            return False

    def close(self, code: int) -> None:
        """Đánh dấu đóng: xả hàng đợi rồi đặt sentinel None để writer đóng WebSocket với `code`."""
        if self.close_code is not None:
            return
        self.close_code = code
        while not self.queue.empty():
            self.queue.get_nowait()
        self.queue.put_nowait(None)


class Hub:
    def __init__(
        self,
        bus: MessageBus,
        session_factory: Callable[[], AbstractAsyncContextManager[AsyncSession]],
        reconnect_delay: float = 1.0,
    ):
        self.bus = bus
        self._session_factory = session_factory
        self._reconnect_delay = reconnect_delay
        self._conns: dict[int, set[Connection]] = {}

    def register(self, conn: Connection) -> None:
        self._conns.setdefault(conn.user_id, set()).add(conn)

    def unregister(self, conn: Connection) -> None:
        conns = self._conns.get(conn.user_id)
        if conns:
            conns.discard(conn)
            if not conns:
                del self._conns[conn.user_id]

    def _all(self) -> list[Connection]:
        return [conn for conns in self._conns.values() for conn in conns]

    def _offer(self, conn: Connection, event: dict) -> None:
        if not conn.offer(event) and conn.close_code is None:
            conn.close(CLOSE_SLOW_CONSUMER)

    def broadcast(self, event: dict) -> None:
        for conn in self._all():
            self._offer(conn, event)

    async def _dispatch(self, event: BusEvent) -> None:
        if event.scope == "room":
            for conn in self._all():
                if event.target_id in conn.room_ids:
                    self._offer(conn, event.payload)
            return
        if event.scope != "user":
            return
        conns = list(self._conns.get(event.target_id, ()))
        kind = event.payload.get("type")
        if kind == "disconnect":
            for conn in conns:
                conn.close(CLOSE_ACCOUNT_LOCKED)
        elif kind == "rooms_changed" and conns:
            async with self._session_factory() as session:
                rows = await session.execute(select(RoomMember.room_id).where(RoomMember.user_id == event.target_id))
                room_ids = set(rows.scalars())
            for conn in conns:
                conn.room_ids = set(room_ids)
                self._offer(conn, {"type": "rooms_changed"})

    async def run(self) -> None:
        """Nghe bus mãi mãi; khi bus lỗi thì báo client tải lại (`resync`) rồi nghe lại."""
        delay = self._reconnect_delay
        had_subscription = False
        while True:
            try:
                async for event in self.bus.listen():
                    if event.scope == "system":
                        if had_subscription:
                            self.broadcast({"type": "resync"})
                        had_subscription = True
                        delay = self._reconnect_delay
                        continue
                    await self._dispatch(event)
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("message bus listener failed")
            self.broadcast({"type": "resync"})
            await asyncio.sleep(delay)
            delay = min(delay * 2, 30)

    async def close_all(self, code: int = 1001) -> None:
        for conn in self._all():
            conn.close(code)
```

- [ ] **Step 6: Chạy test**

Run: `bash scripts/test.sh tests/test_bus.py tests/test_hub.py -v` rồi `bash scripts/test.sh -q`
Expected: tất cả pass.

- [ ] **Step 7: Commit**

```bash
git add backend
git commit -m "feat: add message bus, websocket hub and chat settings" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Service chat (phòng, tin nhắn, phân trang, chưa đọc)

**Files:**
- Create: `backend/app/chat/schemas.py`, `backend/app/chat/service.py`
- Create: `backend/tests/test_chat_service.py`

**Interfaces:**
- Consumes: models (Task 2), `get_settings` (Task 3).
- Produces:
  - `schemas.MessageOut(id, room_id, sender_id, sender_name, body, kind, client_id, created_at, edited_at, deleted)`; `schemas.to_message_out(msg: Message, sender_name: str) -> MessageOut` (tin đã xoá trả `body=""`); `schemas.RoomOut(id, type, name, branch_id, member_count, peer_id, last_message, unread_count, last_activity)`; `schemas.MessagePage(items, has_more_before, has_more_after)`.
  - `service.ChatError(status: int, code: str)`; `service.escape_like(text) -> str`.
  - `service.user_room_ids(session, user_id) -> set[int]`; `service.require_member(session, room_id, user_id) -> Room` (404 `room_not_found` nếu không phải thành viên).
  - `service.get_or_create_direct(session, me: User, other_id: int) -> tuple[Room, bool]` (lỗi: 400 `cannot_chat_with_self`, 404 `user_not_found`).
  - `service.send_message(session, user_id, room_id, body, client_id) -> tuple[Message, str, bool]` (`Message`, tên người gửi, `created`; lỗi 400 `empty_message`/`message_too_long`/`invalid_client_id`, 401 `not_authenticated` nếu user bị khoá, 404 `room_not_found`).
  - `service.list_messages(session, room_id, *, before=None, after=None, around=None, limit=50) -> MessagePage` (lỗi 400 `invalid_cursor` khi dùng ≥2 con trỏ, 404 `message_not_found` khi `around` không thuộc phòng). Ý nghĩa cờ: mặc định và `before` → `has_more_before` có nghĩa; `after` → `has_more_after` có nghĩa; `around` → cả hai. Cờ không có nghĩa trả `False`.
  - `service.list_rooms(session, user_id) -> list[RoomOut]` (sắp theo hoạt động mới nhất; tên phòng direct là tên người kia).
  - `service.mark_read(session, room_id, user_id, message_id) -> None` (chỉ tăng, không giảm).
  - `service.edit_message(session, user_id, message_id, body) -> tuple[Message, str]`, `service.delete_message(session, user_id, message_id) -> Message` (chỉ người gửi; lỗi 404 `message_not_found`, 403 `forbidden`).

- [ ] **Step 1: Viết test thất bại**

`backend/tests/test_chat_service.py`:
```python
import time

import pytest
from sqlalchemy import text

from app.chat import service
from app.chat.service import ChatError
from app.db import SessionLocal
from app.models import Message, User
from tests.conftest import add_message, create_direct, create_room, create_user


async def _two_users_room():
    a, b = await create_user("alice"), await create_user("bob")
    return a, b, await create_room(member_ids=[a, b])


# ---------- phòng direct ----------

async def test_direct_room_is_created_once_and_found_again():
    a, b = await create_user("alice"), await create_user("bob")
    async with SessionLocal() as s:
        alice = await s.get(User, a)
        room, created = await service.get_or_create_direct(s, alice, b)
        again, created_again = await service.get_or_create_direct(s, alice, b)
        reverse, _ = await service.get_or_create_direct(s, await s.get(User, b), a)
    assert created is True and created_again is False
    assert room.id == again.id == reverse.id


async def test_direct_room_rejects_self_and_unknown_or_inactive_users():
    a = await create_user("alice")
    ghost = await create_user("ghost", active=False)
    async with SessionLocal() as s:
        alice = await s.get(User, a)
        for other, code in ((a, "cannot_chat_with_self"), (9999, "user_not_found"), (ghost, "user_not_found")):
            with pytest.raises(ChatError) as err:
                await service.get_or_create_direct(s, alice, other)
            assert err.value.code == code


async def test_non_member_gets_room_not_found():
    a, b, room = await _two_users_room()
    outsider = await create_user("carol")
    async with SessionLocal() as s:
        with pytest.raises(ChatError) as err:
            await service.require_member(s, room, outsider)
        assert (err.value.status, err.value.code) == (404, "room_not_found")
        with pytest.raises(ChatError):
            await service.require_member(s, 9999, a)  # phòng không tồn tại trả cùng một lỗi


# ---------- gửi tin ----------

async def test_send_message_is_idempotent_per_sender_and_client_id():
    a, b, room = await _two_users_room()
    async with SessionLocal() as s:
        first, name, created = await service.send_message(s, a, room, "xin chào", "cid-1")
        second, _, created_again = await service.send_message(s, a, room, "xin chào", "cid-1")
        theirs, _, theirs_created = await service.send_message(s, b, room, "chào bạn", "cid-1")
    assert created is True and created_again is False
    assert first.id == second.id
    assert name == "Alice"
    assert theirs_created is True and theirs.id != first.id  # cùng client_id nhưng khác người gửi


@pytest.mark.parametrize(
    ("body", "code"),
    [("", "empty_message"), ("   \n\t ", "empty_message"), ("x" * 4001, "message_too_long")],
)
async def test_send_message_validates_the_body(body, code):
    a, _, room = await _two_users_room()
    async with SessionLocal() as s:
        with pytest.raises(ChatError) as err:
            await service.send_message(s, a, room, body, None)
    assert (err.value.status, err.value.code) == (400, code)


async def test_send_message_trims_edges_and_keeps_inner_text():
    a, _, room = await _two_users_room()
    async with SessionLocal() as s:
        msg, _, _ = await service.send_message(s, a, room, "  dòng 1\ndòng 2  ", None)
    assert msg.body == "dòng 1\ndòng 2"


async def test_send_message_rejects_non_members_and_inactive_senders():
    a, _, room = await _two_users_room()
    outsider = await create_user("carol")
    async with SessionLocal() as s:
        with pytest.raises(ChatError) as err:
            await service.send_message(s, outsider, room, "hi", None)
        assert err.value.code == "room_not_found"
        (await s.get(User, a)).is_active = False
        await s.commit()
        with pytest.raises(ChatError) as err:
            await service.send_message(s, a, room, "hi", None)
        assert (err.value.status, err.value.code) == (401, "not_authenticated")


async def test_client_id_longer_than_64_chars_is_rejected():
    a, _, room = await _two_users_room()
    async with SessionLocal() as s:
        with pytest.raises(ChatError) as err:
            await service.send_message(s, a, room, "hi", "c" * 65)
    assert err.value.code == "invalid_client_id"


# ---------- phân trang ----------

async def _ids(page):
    return [m.id for m in page.items]


async def test_pagination_default_before_and_after():
    a, _, room = await _two_users_room()
    ids = [await add_message(room, a, f"m{i}") for i in range(10)]
    async with SessionLocal() as s:
        newest = await service.list_messages(s, room, limit=4)
        older = await service.list_messages(s, room, before=newest.items[0].id, limit=4)
        oldest = await service.list_messages(s, room, before=older.items[0].id, limit=4)
        after = await service.list_messages(s, room, after=ids[6], limit=2)
        after_rest = await service.list_messages(s, room, after=after.items[-1].id, limit=5)
    assert await _ids(newest) == ids[6:10] and newest.has_more_before is True
    assert await _ids(older) == ids[2:6] and older.has_more_before is True
    assert await _ids(oldest) == ids[0:2] and oldest.has_more_before is False
    assert await _ids(after) == ids[7:9] and after.has_more_after is True
    assert await _ids(after_rest) == ids[9:10] and after_rest.has_more_after is False


async def test_pagination_edges():
    a, _, room = await _two_users_room()
    async with SessionLocal() as s:
        empty = await service.list_messages(s, room)
    assert empty.items == [] and empty.has_more_before is False
    ids = [await add_message(room, a) for _ in range(3)]
    async with SessionLocal() as s:
        before_oldest = await service.list_messages(s, room, before=ids[0])
        clamped = await service.list_messages(s, room, limit=10_000)
        zero = await service.list_messages(s, room, limit=0)
    assert before_oldest.items == [] and before_oldest.has_more_before is False
    assert len(clamped.items) == 3
    assert len(zero.items) == 1  # limit tối thiểu là 1


async def test_pagination_around_and_invalid_cursors():
    a, _, room = await _two_users_room()
    other_room = await create_room(member_ids=[a])
    ids = [await add_message(room, a) for _ in range(9)]
    foreign = await add_message(other_room, a)
    async with SessionLocal() as s:
        page = await service.list_messages(s, room, around=ids[4], limit=4)
        assert await _ids(page) == ids[2:7]  # 2 tin trước, tin đích, 2 tin sau
        assert page.has_more_before is True and page.has_more_after is True
        with pytest.raises(ChatError) as err:
            await service.list_messages(s, room, around=foreign)
        assert (err.value.status, err.value.code) == (404, "message_not_found")
        with pytest.raises(ChatError) as err:
            await service.list_messages(s, room, around=9_999_999)
        assert err.value.code == "message_not_found"
        with pytest.raises(ChatError) as err:
            await service.list_messages(s, room, before=ids[3], after=ids[1])
        assert (err.value.status, err.value.code) == (400, "invalid_cursor")


async def test_pages_are_ascending_and_include_sender_names_in_one_pass():
    a, b, room = await _two_users_room()
    await add_message(room, a, "một")
    await add_message(room, b, "hai")
    async with SessionLocal() as s:
        page = await service.list_messages(s, room)
    assert [(m.sender_name, m.body) for m in page.items] == [("Alice", "một"), ("Bob", "hai")]


async def test_a_20000_message_room_pages_quickly_through_the_index():
    a, _, room = await _two_users_room()
    async with SessionLocal() as s:
        await s.execute(
            text(
                "INSERT INTO messages (room_id, sender_id, body) "
                "SELECT CAST(:room AS integer), CAST(:sender AS integer), 'tin ' || g "
                "FROM generate_series(1, 20000) AS g"
            ),
            {"room": room, "sender": a},
        )
        await s.execute(text("ANALYZE messages"))
        await s.commit()
    async with SessionLocal() as s:
        started = time.perf_counter()
        newest = await service.list_messages(s, room)
        older = await service.list_messages(s, room, before=newest.items[0].id)
        elapsed = time.perf_counter() - started
    assert len(newest.items) == 50 and len(older.items) == 50
    assert older.items[-1].id == newest.items[0].id - 1
    assert elapsed < 1.0, f"hai trang mất {elapsed:.2f}s"


# ---------- tin đã xoá, sửa, xoá ----------

async def test_deleted_messages_stay_in_the_list_without_their_text():
    a, _, room = await _two_users_room()
    msg_id = await add_message(room, a, "bí mật")
    async with SessionLocal() as s:
        await service.delete_message(s, a, msg_id)
        page = await service.list_messages(s, room)
    assert page.items[0].deleted is True and page.items[0].body == ""


async def test_only_the_sender_can_edit_or_delete():
    a, b, room = await _two_users_room()
    msg_id = await add_message(room, a, "gốc")
    async with SessionLocal() as s:
        for action in (service.edit_message(s, b, msg_id, "sửa"), service.delete_message(s, b, msg_id)):
            with pytest.raises(ChatError) as err:
                await action
            assert (err.value.status, err.value.code) == (403, "forbidden")
        msg, _ = await service.edit_message(s, a, msg_id, "  đã sửa  ")
        assert msg.body == "đã sửa" and msg.edited_at is not None
        with pytest.raises(ChatError) as err:
            await service.edit_message(s, a, msg_id, "   ")
        assert err.value.code == "empty_message"
        await service.delete_message(s, a, msg_id)
        with pytest.raises(ChatError) as err:
            await service.edit_message(s, a, msg_id, "sau khi xoá")
        assert err.value.code == "message_not_found"


async def test_edit_and_delete_are_hidden_from_non_members():
    a, _, room = await _two_users_room()
    outsider = await create_user("carol")
    msg_id = await add_message(room, a)
    async with SessionLocal() as s:
        with pytest.raises(ChatError) as err:
            await service.edit_message(s, outsider, msg_id, "x")
        assert err.value.code == "room_not_found"
        with pytest.raises(ChatError) as err:
            await service.delete_message(s, outsider, msg_id)
        assert err.value.code == "room_not_found"


# ---------- danh sách phòng, chưa đọc ----------

async def test_room_list_has_peer_names_last_message_and_unread_counts():
    a, b = await create_user("alice"), await create_user("bob")
    direct = await create_direct(a, b)
    group = await create_room(name="Dự án", member_ids=[a, b, await create_user("carol")])
    await add_message(direct, b, "tin 1")
    await add_message(direct, b, "tin 2")
    last = await add_message(direct, a, "của mình")
    await add_message(group, b, "trong nhóm")
    async with SessionLocal() as s:
        rooms = {r.id: r for r in await service.list_rooms(s, a)}
    assert rooms[direct].name == "Bob" and rooms[direct].peer_id == b and rooms[direct].type == "direct"
    assert rooms[direct].unread_count == 2  # tin của chính mình không tính
    assert rooms[direct].last_message.id == last
    assert rooms[group].name == "Dự án" and rooms[group].member_count == 3 and rooms[group].unread_count == 1


async def test_room_list_is_sorted_by_latest_activity_and_empty_for_new_users():
    a, b = await create_user("alice"), await create_user("bob")
    quiet = await create_room(name="Yên", member_ids=[a])
    busy = await create_room(name="Sôi nổi", member_ids=[a, b])
    await add_message(busy, b)
    async with SessionLocal() as s:
        assert [r.id for r in await service.list_rooms(s, a)] == [busy, quiet]
        assert await service.list_rooms(s, await create_user("newbie")) == []


async def test_mark_read_only_moves_forward_and_clears_unread():
    a, b, room = await _two_users_room()
    ids = [await add_message(room, b) for _ in range(3)]
    async with SessionLocal() as s:
        await service.mark_read(s, room, a, ids[1])
        assert (await service.list_rooms(s, a))[0].unread_count == 1
        await service.mark_read(s, room, a, ids[0])  # lùi lại: bị bỏ qua
        assert (await service.list_rooms(s, a))[0].unread_count == 1
        await service.mark_read(s, room, a, ids[2])
        assert (await service.list_rooms(s, a))[0].unread_count == 0


async def test_mark_read_rejects_non_members_and_foreign_messages():
    a, b, room = await _two_users_room()
    other_room = await create_room(member_ids=[a])
    foreign = await add_message(other_room, a)
    outsider = await create_user("carol")
    async with SessionLocal() as s:
        with pytest.raises(ChatError) as err:
            await service.mark_read(s, room, outsider, 1)
        assert err.value.code == "room_not_found"
        with pytest.raises(ChatError) as err:
            await service.mark_read(s, room, a, foreign)
        assert err.value.code == "message_not_found"


def test_escape_like_escapes_wildcards():
    assert service.escape_like("a_b%c\\d") == "a\\_b\\%c\\\\d"
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `bash scripts/test.sh tests/test_chat_service.py -v`
Expected: lỗi `ImportError: cannot import name 'service'`.

- [ ] **Step 3: Viết `schemas.py`**

`backend/app/chat/schemas.py`:
```python
from datetime import datetime

from pydantic import BaseModel

from app.models import Message


class MessageOut(BaseModel):
    id: int
    room_id: int
    sender_id: int
    sender_name: str
    body: str
    kind: str
    client_id: str | None
    created_at: datetime
    edited_at: datetime | None
    deleted: bool


class RoomOut(BaseModel):
    id: int
    type: str
    name: str | None
    branch_id: int | None
    member_count: int
    peer_id: int | None
    last_message: MessageOut | None
    unread_count: int
    last_activity: datetime


class MessagePage(BaseModel):
    items: list[MessageOut]
    has_more_before: bool
    has_more_after: bool


def to_message_out(msg: Message, sender_name: str) -> MessageOut:
    deleted = msg.deleted_at is not None
    return MessageOut(
        id=msg.id,
        room_id=msg.room_id,
        sender_id=msg.sender_id,
        sender_name=sender_name,
        body="" if deleted else msg.body,
        kind=msg.kind,
        client_id=msg.client_id,
        created_at=msg.created_at,
        edited_at=msg.edited_at,
        deleted=deleted,
    )
```

- [ ] **Step 4: Viết `service.py`**

`backend/app/chat/service.py`:
```python
from datetime import datetime, timezone

from sqlalchemy import and_, func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.chat.schemas import MessageOut, MessagePage, RoomOut, to_message_out
from app.config import get_settings
from app.models import Message, Room, RoomMember, User

MAX_PAGE = 100
MAX_CLIENT_ID = 64


class ChatError(Exception):
    def __init__(self, status: int, code: str):
        super().__init__(code)
        self.status = status
        self.code = code


def escape_like(text: str) -> str:
    return text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _direct_key(a: int, b: int) -> str:
    return f"{min(a, b)}:{max(a, b)}"


async def user_room_ids(session: AsyncSession, user_id: int) -> set[int]:
    rows = await session.execute(select(RoomMember.room_id).where(RoomMember.user_id == user_id))
    return set(rows.scalars())


async def require_member(session: AsyncSession, room_id: int, user_id: int) -> Room:
    """Trả phòng nếu user là thành viên; nếu không (kể cả phòng không tồn tại) ném 404 room_not_found."""
    row = await session.execute(
        select(Room)
        .join(RoomMember, RoomMember.room_id == Room.id)
        .where(Room.id == room_id, RoomMember.user_id == user_id)
    )
    room = row.scalar_one_or_none()
    if room is None:
        raise ChatError(404, "room_not_found")
    return room


async def get_or_create_direct(session: AsyncSession, me: User, other_id: int) -> tuple[Room, bool]:
    if other_id == me.id:
        raise ChatError(400, "cannot_chat_with_self")
    other = await session.get(User, other_id)
    if other is None or not other.is_active:
        raise ChatError(404, "user_not_found")
    key = _direct_key(me.id, other_id)
    existing = (await session.execute(select(Room).where(Room.direct_key == key))).scalar_one_or_none()
    if existing is not None:
        return existing, False
    room = Room(type="direct", direct_key=key, created_by=me.id)
    session.add(room)
    try:
        await session.flush()
    except IntegrityError:
        # Người kia vừa tạo cùng lúc: ràng buộc unique đảm bảo chỉ một phòng.
        await session.rollback()
        existing = (await session.execute(select(Room).where(Room.direct_key == key))).scalar_one()
        return existing, False
    session.add_all([RoomMember(room_id=room.id, user_id=me.id), RoomMember(room_id=room.id, user_id=other_id)])
    await session.commit()
    return room, True


def _clean_body(body: str) -> str:
    body = body.strip()
    if not body:
        raise ChatError(400, "empty_message")
    if len(body) > get_settings().max_message_length:
        raise ChatError(400, "message_too_long")
    return body


async def send_message(
    session: AsyncSession, user_id: int, room_id: int, body: str, client_id: str | None
) -> tuple[Message, str, bool]:
    body = _clean_body(body)
    if client_id is not None and len(client_id) > MAX_CLIENT_ID:
        raise ChatError(400, "invalid_client_id")
    user = await session.get(User, user_id)
    if user is None or not user.is_active:
        raise ChatError(401, "not_authenticated")
    await require_member(session, room_id, user_id)
    stmt = (
        pg_insert(Message)
        .values(room_id=room_id, sender_id=user_id, body=body, client_id=client_id)
        .on_conflict_do_nothing(constraint="uq_messages_room_sender_client")
        .returning(Message)
    )
    message = (await session.execute(stmt)).scalar_one_or_none()
    created = message is not None
    if message is None:
        message = (
            await session.execute(
                select(Message).where(
                    Message.room_id == room_id, Message.sender_id == user_id, Message.client_id == client_id
                )
            )
        ).scalar_one()
    await session.commit()
    return message, user.full_name, created


async def list_messages(
    session: AsyncSession,
    room_id: int,
    *,
    before: int | None = None,
    after: int | None = None,
    around: int | None = None,
    limit: int = 50,
) -> MessagePage:
    if sum(cursor is not None for cursor in (before, after, around)) > 1:
        raise ChatError(400, "invalid_cursor")
    limit = max(1, min(limit, MAX_PAGE))
    base = (
        select(Message, User.full_name)
        .join(User, User.id == Message.sender_id)
        .where(Message.room_id == room_id)
    )

    def out(rows) -> list[MessageOut]:
        return [to_message_out(msg, name) for msg, name in rows]

    if after is not None:
        rows = (await session.execute(base.where(Message.id > after).order_by(Message.id).limit(limit + 1))).all()
        return MessagePage(items=out(rows[:limit]), has_more_before=False, has_more_after=len(rows) > limit)

    if around is not None:
        target = (await session.execute(base.where(Message.id == around))).first()
        if target is None:
            raise ChatError(404, "message_not_found")
        half = max(1, limit // 2)
        older = (
            await session.execute(base.where(Message.id < around).order_by(Message.id.desc()).limit(half + 1))
        ).all()
        newer = (await session.execute(base.where(Message.id > around).order_by(Message.id).limit(half + 1))).all()
        rows = list(reversed(older[:half])) + [target] + newer[:half]
        return MessagePage(items=out(rows), has_more_before=len(older) > half, has_more_after=len(newer) > half)

    query = base if before is None else base.where(Message.id < before)
    rows = (await session.execute(query.order_by(Message.id.desc()).limit(limit + 1))).all()
    return MessagePage(items=out(list(reversed(rows[:limit]))), has_more_before=len(rows) > limit, has_more_after=False)


async def list_rooms(session: AsyncSession, user_id: int) -> list[RoomOut]:
    mine = (
        await session.execute(
            select(Room).join(RoomMember, RoomMember.room_id == Room.id).where(RoomMember.user_id == user_id)
        )
    ).scalars().all()
    if not mine:
        return []
    room_ids = [room.id for room in mine]

    counts = dict(
        (
            await session.execute(
                select(RoomMember.room_id, func.count()).where(RoomMember.room_id.in_(room_ids)).group_by(RoomMember.room_id)
            )
        ).all()
    )
    direct_ids = [room.id for room in mine if room.type == "direct"]
    peers: dict[int, tuple[int, str]] = {}
    if direct_ids:
        rows = await session.execute(
            select(RoomMember.room_id, User.id, User.full_name)
            .join(User, User.id == RoomMember.user_id)
            .where(RoomMember.room_id.in_(direct_ids), RoomMember.user_id != user_id)
        )
        peers = {room_id: (peer_id, name) for room_id, peer_id, name in rows}

    newest = (
        select(Message.room_id, func.max(Message.id).label("mid"))
        .where(Message.room_id.in_(room_ids))
        .group_by(Message.room_id)
        .subquery()
    )
    last_rows = await session.execute(
        select(Message, User.full_name)
        .join(newest, Message.id == newest.c.mid)
        .join(User, User.id == Message.sender_id)
    )
    last = {msg.room_id: to_message_out(msg, name) for msg, name in last_rows}

    unread_rows = await session.execute(
        select(RoomMember.room_id, func.count(Message.id))
        .select_from(RoomMember)
        .join(
            Message,
            and_(
                Message.room_id == RoomMember.room_id,
                Message.id > func.coalesce(RoomMember.last_read_message_id, 0),
                Message.sender_id != user_id,
                Message.deleted_at.is_(None),
            ),
            isouter=True,
        )
        .where(RoomMember.user_id == user_id)
        .group_by(RoomMember.room_id)
    )
    unread = dict(unread_rows.all())

    result = []
    for room in mine:
        last_message = last.get(room.id)
        peer = peers.get(room.id)
        result.append(
            RoomOut(
                id=room.id,
                type=room.type,
                name=peer[1] if peer else room.name,
                branch_id=room.branch_id,
                member_count=counts.get(room.id, 0),
                peer_id=peer[0] if peer else None,
                last_message=last_message,
                unread_count=unread.get(room.id, 0),
                last_activity=last_message.created_at if last_message else room.created_at,
            )
        )
    result.sort(key=lambda r: r.last_activity, reverse=True)
    return result


async def mark_read(session: AsyncSession, room_id: int, user_id: int, message_id: int) -> None:
    await require_member(session, room_id, user_id)
    message = await session.get(Message, message_id)
    if message is None or message.room_id != room_id:
        raise ChatError(404, "message_not_found")
    await session.execute(
        update(RoomMember)
        .where(RoomMember.room_id == room_id, RoomMember.user_id == user_id)
        .values(last_read_message_id=func.greatest(func.coalesce(RoomMember.last_read_message_id, 0), message_id))
    )
    await session.commit()


async def _own_message(session: AsyncSession, user_id: int, message_id: int) -> Message:
    message = await session.get(Message, message_id)
    if message is None or message.deleted_at is not None:
        raise ChatError(404, "message_not_found")
    await require_member(session, message.room_id, user_id)
    if message.sender_id != user_id:
        raise ChatError(403, "forbidden")
    return message


async def edit_message(session: AsyncSession, user_id: int, message_id: int, body: str) -> tuple[Message, str]:
    message = await _own_message(session, user_id, message_id)
    message.body = _clean_body(body)
    message.edited_at = datetime.now(timezone.utc)
    sender = await session.get(User, user_id)
    await session.commit()
    return message, sender.full_name


async def delete_message(session: AsyncSession, user_id: int, message_id: int) -> Message:
    message = await _own_message(session, user_id, message_id)
    message.deleted_at = datetime.now(timezone.utc)
    await session.commit()
    return message
```

- [ ] **Step 5: Chạy test**

Run: `bash scripts/test.sh tests/test_chat_service.py -v` rồi `bash scripts/test.sh -q`
Expected: tất cả pass. Nếu `.returning(Message)` với `on_conflict_do_nothing` không trả đối tượng ORM trong phiên bản SQLAlchemy đã ghim, đổi sang `.returning(Message.id)` rồi `await session.get(Message, new_id)`, giữ nguyên hành vi và ghi vào báo cáo.

- [ ] **Step 6: Commit**

```bash
git add backend
git commit -m "feat: add chat service for rooms, messages, pagination and unread counts" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: REST cho người dùng (thư mục người dùng, phòng, tin nhắn)

**Files:**
- Create: `backend/app/routers/chat.py`
- Modify: `backend/app/main.py` (router, handler `ChatError`), `backend/tests/conftest.py` (bus giả cho `client`)
- Create: `backend/tests/test_chat_api.py`

**Interfaces:**
- Consumes: `service.*`, `get_ready_user`, `publish_*_safely`, `RedisMessageBus`, `get_redis`.
- Produces:
  - `get_bus() -> MessageBus` (dependency FastAPI; trả `RedisMessageBus(get_redis())`) định nghĩa trong `app/routers/chat.py`; các router khác import từ đó.
  - Endpoint (tiền tố `/api`): `GET /users/directory?q=` → `list[DirectoryUser]` (`id, username, full_name, branch_id, branch_name`, tối đa 50, loại chính mình và người bị khoá); `GET /rooms` → `list[RoomOut]`; `POST /rooms/direct` `{user_id}` → `RoomOut` (201 nếu mới, 200 nếu đã có); `GET /rooms/{id}/messages?before=&after=&around=&limit=` → `MessagePage`; `POST /rooms/{id}/read` `{message_id}` → 204; `PATCH /messages/{id}` `{body}` → `MessageOut`; `DELETE /messages/{id}` → 204.
  - `ChatError` được ánh xạ thành JSON `{"detail": "<code>"}` với status của lỗi (handler trong `main.py`).
  - Sửa/xoá tin phát sự kiện phòng `{"type": "message_updated", "message": {...}}` / `{"type": "message_deleted", "room_id": int, "message_id": int}`; mở phòng direct mới phát `{"type": "rooms_changed"}` cho cả hai người (đều best-effort).
  - Fixture `bus` trong conftest (một `InMemoryBus` mỗi test) và `client` ghi đè `get_bus` bằng nó.

- [ ] **Step 1: Viết test thất bại**

Trong `backend/tests/conftest.py`: thêm import `from app.routers.chat import get_bus` và `from tests.helpers import InMemoryBus`, rồi thay fixture `client` bằng:
```python
@pytest_asyncio.fixture
async def bus():
    return InMemoryBus()


@pytest_asyncio.fixture
async def client(bus):
    app = create_app()
    app.dependency_overrides[get_bus] = lambda: bus
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c
```
(`tests/helpers.py` import `app.chat.bus`; tránh vòng import bằng cách để `tests/helpers.py` không import `conftest`.)

`backend/tests/test_chat_api.py`:
```python
from tests.conftest import add_message, auth_headers, create_branch, create_direct, create_room, create_user, token_for


async def _setup(client):
    a, b = await create_user("alice"), await create_user("bob")
    room = await create_room(member_ids=[a, b])
    ta, tb = await token_for(client, "alice"), await token_for(client, "bob")
    return a, b, room, auth_headers(ta), auth_headers(tb)


# ---------- thư mục người dùng ----------

async def test_directory_lists_active_colleagues_except_self(client):
    hn = await create_branch("Hà Nội", "HN")
    await create_user("alice", branch_id=hn)
    await create_user("bob", branch_id=hn)
    await create_user("ghost", branch_id=hn, active=False)
    headers = auth_headers(await token_for(client, "alice"))
    r = await client.get("/api/users/directory", headers=headers)
    assert r.status_code == 200
    assert [u["username"] for u in r.json()] == ["bob"]
    assert r.json()[0]["branch_name"] == "Hà Nội"
    assert "password_hash" not in r.json()[0]


async def test_directory_search_escapes_like_wildcards(client):
    await create_user("alice")
    await create_user("ha_le")
    await create_user("haxle")
    headers = auth_headers(await token_for(client, "alice"))
    r = await client.get("/api/users/directory", params={"q": "ha_le"}, headers=headers)
    assert [u["username"] for u in r.json()] == ["ha_le"]


async def test_directory_requires_login_and_a_changed_password(client):
    assert (await client.get("/api/users/directory")).status_code == 401
    await create_user("temp", must_change=True)
    headers = auth_headers(await token_for(client, "temp"))
    r = await client.get("/api/users/directory", headers=headers)
    assert (r.status_code, r.json()["detail"]) == (403, "password_change_required")


# ---------- phòng ----------

async def test_open_direct_room_creates_then_reuses_and_notifies_both_users(client, bus):
    a, b = await create_user("alice"), await create_user("bob")
    headers = auth_headers(await token_for(client, "alice"))
    first = await client.post("/api/rooms/direct", json={"user_id": b}, headers=headers)
    again = await client.post("/api/rooms/direct", json={"user_id": b}, headers=headers)
    assert (first.status_code, again.status_code) == (201, 200)
    assert first.json()["id"] == again.json()["id"]
    assert first.json()["type"] == "direct" and first.json()["name"] == "Bob" and first.json()["peer_id"] == b
    notified = {(scope, target) for scope, target, event in bus.published if event == {"type": "rooms_changed"}}
    assert notified == {("user", a), ("user", b)}


async def test_open_direct_room_errors(client):
    a = await create_user("alice")
    ghost = await create_user("ghost", active=False)
    headers = auth_headers(await token_for(client, "alice"))
    for payload, status, code in (
        ({"user_id": a}, 400, "cannot_chat_with_self"),
        ({"user_id": 9999}, 404, "user_not_found"),
        ({"user_id": ghost}, 404, "user_not_found"),
        ({}, 422, "validation_error"),
    ):
        r = await client.post("/api/rooms/direct", json=payload, headers=headers)
        assert r.status_code == status, payload
        if status != 422:
            assert r.json()["detail"] == code


async def test_room_list_for_the_caller(client):
    a, b, room, ha, hb = await _setup(client)
    await add_message(room, b, "chào")
    r = await client.get("/api/rooms", headers=ha)
    assert r.status_code == 200
    assert [(x["id"], x["unread_count"]) for x in r.json()] == [(room, 1)]
    assert r.json()[0]["last_message"]["body"] == "chào"
    assert (await client.get("/api/rooms")).status_code == 401


# ---------- tin nhắn: đọc ----------

async def test_messages_page_with_cursors(client):
    a, b, room, ha, hb = await _setup(client)
    ids = [await add_message(room, a, f"m{i}") for i in range(6)]
    r = await client.get(f"/api/rooms/{room}/messages", params={"limit": 3}, headers=ha)
    body = r.json()
    assert [m["id"] for m in body["items"]] == ids[3:6] and body["has_more_before"] is True
    r = await client.get(f"/api/rooms/{room}/messages", params={"before": ids[3], "limit": 3}, headers=ha)
    assert [m["id"] for m in r.json()["items"]] == ids[0:3] and r.json()["has_more_before"] is False
    r = await client.get(f"/api/rooms/{room}/messages", params={"after": ids[4]}, headers=ha)
    assert [m["id"] for m in r.json()["items"]] == ids[5:6]
    r = await client.get(f"/api/rooms/{room}/messages", params={"around": ids[2], "limit": 2}, headers=ha)
    assert [m["id"] for m in r.json()["items"]] == ids[1:4]


async def test_messages_validation_errors(client):
    a, b, room, ha, hb = await _setup(client)
    url = f"/api/rooms/{room}/messages"
    assert (await client.get(url, params={"limit": 0}, headers=ha)).status_code == 422
    assert (await client.get(url, params={"limit": 101}, headers=ha)).status_code == 422
    r = await client.get(url, params={"before": 5, "after": 1}, headers=ha)
    assert (r.status_code, r.json()["detail"]) == (400, "invalid_cursor")
    r = await client.get(url, params={"around": 424242}, headers=ha)
    assert (r.status_code, r.json()["detail"]) == (404, "message_not_found")


async def test_non_members_including_admins_get_404_on_every_room_endpoint(client):
    a, b, room, ha, hb = await _setup(client)
    msg = await add_message(room, a)
    await create_user("carol")
    await create_user("root", role="admin")
    for who in ("carol", "root"):
        headers = auth_headers(await token_for(client, who))
        for method, url, kwargs in (
            ("get", f"/api/rooms/{room}/messages", {}),
            ("post", f"/api/rooms/{room}/read", {"json": {"message_id": msg}}),
            ("patch", f"/api/messages/{msg}", {"json": {"body": "x"}}),
            ("delete", f"/api/messages/{msg}", {}),
        ):
            r = await getattr(client, method)(url, headers=headers, **kwargs)
            assert (r.status_code, r.json()["detail"]) == (404, "room_not_found"), (who, method, url)
    # phòng không tồn tại trả đúng cùng một lỗi
    r = await client.get("/api/rooms/987654/messages", headers=ha)
    assert (r.status_code, r.json()["detail"]) == (404, "room_not_found")


# ---------- đã đọc ----------

async def test_mark_read_updates_the_unread_count(client):
    a, b, room, ha, hb = await _setup(client)
    ids = [await add_message(room, b) for _ in range(2)]
    assert (await client.get("/api/rooms", headers=ha)).json()[0]["unread_count"] == 2
    r = await client.post(f"/api/rooms/{room}/read", json={"message_id": ids[1]}, headers=ha)
    assert r.status_code == 204
    assert (await client.get("/api/rooms", headers=ha)).json()[0]["unread_count"] == 0


# ---------- sửa, xoá ----------

async def test_edit_message_updates_and_broadcasts(client, bus):
    a, b, room, ha, hb = await _setup(client)
    msg = await add_message(room, a, "gốc")
    r = await client.patch(f"/api/messages/{msg}", json={"body": "  đã sửa "}, headers=ha)
    assert r.status_code == 200 and r.json()["body"] == "đã sửa" and r.json()["edited_at"] is not None
    scope, target, event = bus.published[-1]
    assert (scope, target, event["type"], event["message"]["id"]) == ("room", room, "message_updated", msg)
    forbidden = await client.patch(f"/api/messages/{msg}", json={"body": "x"}, headers=hb)
    assert (forbidden.status_code, forbidden.json()["detail"]) == (403, "forbidden")
    empty = await client.patch(f"/api/messages/{msg}", json={"body": "   "}, headers=ha)
    assert (empty.status_code, empty.json()["detail"]) == (400, "empty_message")


async def test_delete_message_hides_the_text_and_broadcasts(client, bus):
    a, b, room, ha, hb = await _setup(client)
    msg = await add_message(room, a, "bí mật")
    assert (await client.delete(f"/api/messages/{msg}", headers=hb)).status_code == 403
    assert (await client.delete(f"/api/messages/{msg}", headers=ha)).status_code == 204
    assert bus.published[-1] == ("room", room, {"type": "message_deleted", "room_id": room, "message_id": msg})
    page = (await client.get(f"/api/rooms/{room}/messages", headers=hb)).json()
    assert page["items"][0]["deleted"] is True and page["items"][0]["body"] == ""
    again = await client.delete(f"/api/messages/{msg}", headers=ha)
    assert (again.status_code, again.json()["detail"]) == (404, "message_not_found")
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `bash scripts/test.sh tests/test_chat_api.py -v`
Expected: lỗi `ImportError` (chưa có `app.routers.chat`).

- [ ] **Step 3: Viết router**

`backend/app/routers/chat.py`:
```python
from fastapi import APIRouter, Depends, Query, Response
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.chat import service
from app.chat.bus import MessageBus, RedisMessageBus, publish_room_safely, publish_user_safely
from app.chat.schemas import MessageOut, MessagePage, RoomOut, to_message_out
from app.db import get_session
from app.deps import get_ready_user
from app.models import Branch, User
from app.redis_client import get_redis

router = APIRouter(tags=["chat"])


def get_bus() -> MessageBus:
    return RedisMessageBus(get_redis())


class DirectoryUser(BaseModel):
    id: int
    username: str
    full_name: str
    branch_id: int
    branch_name: str


class DirectRoomIn(BaseModel):
    user_id: int


class ReadIn(BaseModel):
    message_id: int


class MessageEditIn(BaseModel):
    body: str = Field(max_length=10_000)


@router.get("/users/directory", response_model=list[DirectoryUser])
async def directory(
    q: str | None = None,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_ready_user),
) -> list[DirectoryUser]:
    query = (
        select(User, Branch.name)
        .join(Branch, Branch.id == User.branch_id)
        .where(User.is_active.is_(True), User.id != user.id)
        .order_by(User.full_name)
        .limit(50)
    )
    if q and q.strip():
        like = f"%{service.escape_like(q.strip())}%"
        query = query.where(
            or_(User.full_name.ilike(like, escape="\\"), User.username.ilike(like, escape="\\"))
        )
    rows = (await session.execute(query)).all()
    return [
        DirectoryUser(
            id=u.id, username=u.username, full_name=u.full_name, branch_id=u.branch_id, branch_name=branch_name
        )
        for u, branch_name in rows
    ]


@router.get("/rooms", response_model=list[RoomOut])
async def list_rooms(
    session: AsyncSession = Depends(get_session), user: User = Depends(get_ready_user)
) -> list[RoomOut]:
    return await service.list_rooms(session, user.id)


@router.post("/rooms/direct", response_model=RoomOut)
async def open_direct_room(
    body: DirectRoomIn,
    response: Response,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_ready_user),
    bus: MessageBus = Depends(get_bus),
) -> RoomOut:
    room, created = await service.get_or_create_direct(session, user, body.user_id)
    if created:
        response.status_code = 201
        for member_id in (user.id, body.user_id):
            await publish_user_safely(bus, member_id, {"type": "rooms_changed"})
    rooms = await service.list_rooms(session, user.id)
    return next(r for r in rooms if r.id == room.id)


@router.get("/rooms/{room_id}/messages", response_model=MessagePage)
async def get_messages(
    room_id: int,
    before: int | None = None,
    after: int | None = None,
    around: int | None = None,
    limit: int = Query(50, ge=1, le=100),
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_ready_user),
) -> MessagePage:
    await service.require_member(session, room_id, user.id)
    return await service.list_messages(session, room_id, before=before, after=after, around=around, limit=limit)


@router.post("/rooms/{room_id}/read", status_code=204)
async def mark_read(
    room_id: int,
    body: ReadIn,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_ready_user),
) -> None:
    await service.mark_read(session, room_id, user.id, body.message_id)


@router.patch("/messages/{message_id}", response_model=MessageOut)
async def edit_message(
    message_id: int,
    body: MessageEditIn,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_ready_user),
    bus: MessageBus = Depends(get_bus),
) -> MessageOut:
    message, sender_name = await service.edit_message(session, user.id, message_id, body.body)
    out = to_message_out(message, sender_name)
    await publish_room_safely(bus, message.room_id, {"type": "message_updated", "message": out.model_dump(mode="json")})
    return out


@router.delete("/messages/{message_id}", status_code=204)
async def delete_message(
    message_id: int,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_ready_user),
    bus: MessageBus = Depends(get_bus),
) -> None:
    message = await service.delete_message(session, user.id, message_id)
    await publish_room_safely(
        bus, message.room_id, {"type": "message_deleted", "room_id": message.room_id, "message_id": message.id}
    )
```

Trong `backend/app/main.py`: thêm import `from fastapi.responses import JSONResponse` (đã có), `from app.chat.service import ChatError`, `from app.routers import ... chat`, handler và include:
```python
async def chat_error(request: Request, exc: ChatError) -> JSONResponse:
    return JSONResponse(status_code=exc.status, content={"detail": exc.code})
```
và trong `create_app()` thêm `app.add_exception_handler(ChatError, chat_error)` và `app.include_router(chat.router, prefix="/api")`.

- [ ] **Step 4: Chạy test**

Run: `bash scripts/test.sh tests/test_chat_api.py -v` rồi `bash scripts/test.sh -q`
Expected: tất cả pass (kể cả toàn bộ test cũ, nhờ `client` mới vẫn dùng chung giao diện).

- [ ] **Step 5: Commit**

```bash
git add backend
git commit -m "feat: add chat REST endpoints (directory, rooms, messages, read, edit, delete)" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: API admin cho nhóm và ngắt WebSocket khi khoá/đặt lại mật khẩu

**Files:**
- Create: `backend/app/routers/admin_rooms.py`
- Modify: `backend/app/routers/admin_users.py`, `backend/app/main.py`
- Create: `backend/tests/test_admin_rooms.py`
- Modify: `backend/tests/test_admin_users.py` (thêm test ngắt kết nối)

**Interfaces:**
- Consumes: `require_admin`, `get_bus`, `publish_user_safely`, models.
- Produces (tiền tố `/api/admin`, tất cả cần admin):
  - `GET /rooms?q=&branch_id=` → `list[AdminRoomOut]` (chỉ nhóm; `id, name, branch_id, member_count, created_at`).
  - `POST /rooms` `{name, branch_id?, member_ids}` → 201 `AdminRoomDetail` (`AdminRoomOut` + `members: list[MemberOut]`; `MemberOut(user_id, full_name, username, branch_id)`). Admin **không** tự thành thành viên. Lỗi: 404 `branch_not_found`, 404 `user_not_found` (id không tồn tại hoặc bị khoá).
  - `GET /rooms/{id}` → `AdminRoomDetail`; `PATCH /rooms/{id}` `{name}` → `AdminRoomDetail`; `DELETE /rooms/{id}` → 204 (xoá cả tin nhắn); `POST /rooms/{id}/members` `{user_id}` → `AdminRoomDetail` (idempotent); `DELETE /rooms/{id}/members/{user_id}` → `AdminRoomDetail` (404 `member_not_found`). Phòng direct hoặc không tồn tại: 404 `room_not_found`.
  - Mọi thay đổi thành viên/xoá phòng phát `{"type":"rooms_changed"}` cho từng người liên quan (best-effort).
  - Không có endpoint admin nào trả nội dung tin nhắn.
  - `PATCH /admin/users/{id}` với `is_active=false` và `POST /admin/users/{id}/reset-password` phát `{"type":"disconnect"}` cho user đó (best-effort, sau commit).

- [ ] **Step 1: Viết test thất bại**

`backend/tests/test_admin_rooms.py`:
```python
from sqlalchemy import select

from app.db import SessionLocal
from app.models import Message, Room, RoomMember
from tests.conftest import add_message, auth_headers, create_branch, create_direct, create_room, create_user, token_for


def room_changed_targets(bus):
    return sorted(target for scope, target, event in bus.published if scope == "user" and event == {"type": "rooms_changed"})


async def test_admin_room_endpoints_require_an_admin(client, member_headers):
    for method, url, kwargs in (
        ("get", "/api/admin/rooms", {}),
        ("post", "/api/admin/rooms", {"json": {"name": "X", "member_ids": []}}),
        ("get", "/api/admin/rooms/1", {}),
        ("patch", "/api/admin/rooms/1", {"json": {"name": "Y"}}),
        ("delete", "/api/admin/rooms/1", {}),
        ("post", "/api/admin/rooms/1/members", {"json": {"user_id": 1}}),
        ("delete", "/api/admin/rooms/1/members/1", {}),
    ):
        r = await getattr(client, method)(url, headers=member_headers, **kwargs)
        assert (r.status_code, r.json()["detail"]) == (403, "forbidden"), (method, url)
        assert (await getattr(client, method)(url, **kwargs)).status_code == 401


async def test_create_group_does_not_add_the_admin_and_notifies_members(client, admin_headers, bus):
    hn = await create_branch("Hà Nội", "HN")
    a, b = await create_user("alice", branch_id=hn), await create_user("bob", branch_id=hn)
    r = await client.post(
        "/api/admin/rooms",
        json={"name": "Dự án kho", "branch_id": hn, "member_ids": [a, b, a]},
        headers=admin_headers,
    )
    assert r.status_code == 201
    body = r.json()
    assert body["name"] == "Dự án kho" and body["member_count"] == 2
    assert sorted(m["user_id"] for m in body["members"]) == sorted([a, b])
    assert all(m["username"] in ("alice", "bob") for m in body["members"])
    assert room_changed_targets(bus) == sorted([a, b])


async def test_create_group_validation(client, admin_headers):
    a = await create_user("alice")
    ghost = await create_user("ghost", active=False)
    cases = (
        ({"name": "", "member_ids": []}, 422),
        ({"name": "x" * 101, "member_ids": []}, 422),
        ({"name": "A", "member_ids": [9999]}, 404),
        ({"name": "A", "member_ids": [ghost]}, 404),
        ({"name": "A", "branch_id": 9999, "member_ids": [a]}, 404),
    )
    for payload, status in cases:
        r = await client.post("/api/admin/rooms", json=payload, headers=admin_headers)
        assert r.status_code == status, payload
    assert (await client.post("/api/admin/rooms", json={"name": "A", "member_ids": [9999]}, headers=admin_headers)).json()["detail"] == "user_not_found"


async def test_list_shows_groups_only_with_member_counts_and_filters(client, admin_headers):
    hn, dn = await create_branch("Hà Nội", "HN"), await create_branch("Đà Nẵng", "DN")
    a, b = await create_user("alice"), await create_user("bob")
    await create_room(name="Kinh doanh", member_ids=[a, b], branch_id=hn)
    await create_room(name="Kho", member_ids=[a], branch_id=dn)
    await create_direct(a, b)
    r = await client.get("/api/admin/rooms", headers=admin_headers)
    assert sorted((x["name"], x["member_count"]) for x in r.json()) == [("Kho", 1), ("Kinh doanh", 2)]
    by_branch = await client.get("/api/admin/rooms", params={"branch_id": dn}, headers=admin_headers)
    assert [x["name"] for x in by_branch.json()] == ["Kho"]
    search = await client.get("/api/admin/rooms", params={"q": "kinh"}, headers=admin_headers)
    assert [x["name"] for x in search.json()] == ["Kinh doanh"]


async def test_direct_rooms_are_invisible_and_unmanageable_for_admins(client, admin_headers):
    a, b = await create_user("alice"), await create_user("bob")
    direct = await create_direct(a, b)
    await add_message(direct, a, "riêng tư")
    for method, url, kwargs in (
        ("get", f"/api/admin/rooms/{direct}", {}),
        ("patch", f"/api/admin/rooms/{direct}", {"json": {"name": "x"}}),
        ("delete", f"/api/admin/rooms/{direct}", {}),
        ("post", f"/api/admin/rooms/{direct}/members", {"json": {"user_id": a}}),
        ("delete", f"/api/admin/rooms/{direct}/members/{a}", {}),
    ):
        r = await getattr(client, method)(url, headers=admin_headers, **kwargs)
        assert (r.status_code, r.json()["detail"]) == (404, "room_not_found"), (method, url)


async def test_admin_cannot_read_messages_of_groups_they_are_not_in(client, admin_headers):
    a = await create_user("alice")
    room = await create_room(name="Kín", member_ids=[a])
    await add_message(room, a, "nội dung nhóm")
    detail = (await client.get(f"/api/admin/rooms/{room}", headers=admin_headers)).json()
    assert "nội dung nhóm" not in str(detail)
    r = await client.get(f"/api/rooms/{room}/messages", headers=admin_headers)
    assert (r.status_code, r.json()["detail"]) == (404, "room_not_found")


async def test_rename_add_and_remove_members(client, admin_headers, bus):
    a, b, c = await create_user("alice"), await create_user("bob"), await create_user("carol")
    room = await create_room(name="Cũ", member_ids=[a])
    renamed = await client.patch(f"/api/admin/rooms/{room}", json={"name": " Mới "}, headers=admin_headers)
    assert renamed.json()["name"] == "Mới"

    added = await client.post(f"/api/admin/rooms/{room}/members", json={"user_id": b}, headers=admin_headers)
    assert added.status_code == 200 and added.json()["member_count"] == 2
    again = await client.post(f"/api/admin/rooms/{room}/members", json={"user_id": b}, headers=admin_headers)
    assert again.json()["member_count"] == 2  # thêm lại không báo lỗi, không nhân đôi
    assert (await client.post(f"/api/admin/rooms/{room}/members", json={"user_id": 9999}, headers=admin_headers)).status_code == 404
    assert room_changed_targets(bus).count(b) == 2

    bus.published.clear()
    removed = await client.delete(f"/api/admin/rooms/{room}/members/{b}", headers=admin_headers)
    assert removed.status_code == 200 and removed.json()["member_count"] == 1
    assert room_changed_targets(bus) == [b]
    missing = await client.delete(f"/api/admin/rooms/{room}/members/{c}", headers=admin_headers)
    assert (missing.status_code, missing.json()["detail"]) == (404, "member_not_found")


async def test_delete_group_removes_messages_and_notifies_every_member(client, admin_headers, bus):
    a, b = await create_user("alice"), await create_user("bob")
    room = await create_room(name="Bỏ", member_ids=[a, b])
    await add_message(room, a)
    r = await client.delete(f"/api/admin/rooms/{room}", headers=admin_headers)
    assert r.status_code == 204
    assert room_changed_targets(bus) == sorted([a, b])
    async with SessionLocal() as s:
        assert (await s.execute(select(Room))).first() is None
        assert (await s.execute(select(RoomMember))).first() is None
        assert (await s.execute(select(Message))).first() is None
    assert (await client.delete(f"/api/admin/rooms/{room}", headers=admin_headers)).status_code == 404
```

Thêm vào cuối `backend/tests/test_admin_users.py`:
```python
async def test_locking_a_user_disconnects_their_websockets(client, admin_headers, bus):
    from tests.conftest import create_user

    uid = await create_user("victim")
    r = await client.patch(f"/api/admin/users/{uid}", json={"is_active": False}, headers=admin_headers)
    assert r.status_code == 200
    assert ("user", uid, {"type": "disconnect"}) in bus.published


async def test_updating_other_fields_does_not_disconnect_anyone(client, admin_headers, bus):
    from tests.conftest import create_user

    uid = await create_user("alice")
    await client.patch(f"/api/admin/users/{uid}", json={"full_name": "Tên Mới"}, headers=admin_headers)
    assert not any(event == {"type": "disconnect"} for _, _, event in bus.published)


async def test_resetting_a_password_disconnects_their_websockets(client, admin_headers, bus):
    from tests.conftest import create_user

    uid = await create_user("alice")
    r = await client.post(f"/api/admin/users/{uid}/reset-password", headers=admin_headers)
    assert r.status_code == 200
    assert ("user", uid, {"type": "disconnect"}) in bus.published
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `bash scripts/test.sh tests/test_admin_rooms.py tests/test_admin_users.py -v`
Expected: các test mới thất bại (404 vì chưa có route; thiếu sự kiện `disconnect`).

- [ ] **Step 3: Viết `admin_rooms.py`**

`backend/app/routers/admin_rooms.py`:
```python
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.chat import service
from app.chat.bus import MessageBus, publish_user_safely
from app.db import get_session
from app.deps import require_admin
from app.models import Branch, Room, RoomMember, User
from app.routers.chat import get_bus

router = APIRouter(prefix="/admin/rooms", tags=["admin"], dependencies=[Depends(require_admin)])


class MemberOut(BaseModel):
    user_id: int
    full_name: str
    username: str
    branch_id: int


class AdminRoomOut(BaseModel):
    id: int
    name: str
    branch_id: int | None
    member_count: int
    created_at: datetime


class AdminRoomDetail(AdminRoomOut):
    members: list[MemberOut]


class RoomCreateIn(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    name: str = Field(min_length=1, max_length=100)
    branch_id: int | None = None
    member_ids: list[int] = Field(default_factory=list, max_length=200)


class RoomRenameIn(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    name: str = Field(min_length=1, max_length=100)


class MemberIn(BaseModel):
    user_id: int


async def _group_or_404(session: AsyncSession, room_id: int) -> Room:
    room = await session.get(Room, room_id)
    if room is None or room.type != "group":
        raise HTTPException(status_code=404, detail="room_not_found")
    return room


async def _member_ids(session: AsyncSession, room_id: int) -> list[int]:
    rows = await session.execute(select(RoomMember.user_id).where(RoomMember.room_id == room_id))
    return list(rows.scalars())


async def _detail(session: AsyncSession, room: Room) -> AdminRoomDetail:
    rows = await session.execute(
        select(User)
        .join(RoomMember, RoomMember.user_id == User.id)
        .where(RoomMember.room_id == room.id)
        .order_by(User.full_name)
    )
    members = [
        MemberOut(user_id=u.id, full_name=u.full_name, username=u.username, branch_id=u.branch_id)
        for u in rows.scalars()
    ]
    return AdminRoomDetail(
        id=room.id,
        name=room.name or "",
        branch_id=room.branch_id,
        member_count=len(members),
        created_at=room.created_at,
        members=members,
    )


async def _notify(bus: MessageBus, user_ids: list[int]) -> None:
    for user_id in user_ids:
        await publish_user_safely(bus, user_id, {"type": "rooms_changed"})


async def _active_user_or_404(session: AsyncSession, user_id: int) -> User:
    user = await session.get(User, user_id)
    if user is None or not user.is_active:
        raise HTTPException(status_code=404, detail="user_not_found")
    return user


@router.get("", response_model=list[AdminRoomOut])
async def list_rooms(
    q: str | None = None, branch_id: int | None = None, session: AsyncSession = Depends(get_session)
) -> list[AdminRoomOut]:
    counts = select(RoomMember.room_id, func.count().label("n")).group_by(RoomMember.room_id).subquery()
    query = (
        select(Room, func.coalesce(counts.c.n, 0))
        .outerjoin(counts, counts.c.room_id == Room.id)
        .where(Room.type == "group")
        .order_by(Room.name)
    )
    if branch_id is not None:
        query = query.where(Room.branch_id == branch_id)
    if q and q.strip():
        query = query.where(Room.name.ilike(f"%{service.escape_like(q.strip())}%", escape="\\"))
    rows = (await session.execute(query)).all()
    return [
        AdminRoomOut(id=r.id, name=r.name or "", branch_id=r.branch_id, member_count=n, created_at=r.created_at)
        for r, n in rows
    ]


@router.post("", response_model=AdminRoomDetail, status_code=201)
async def create_room(
    body: RoomCreateIn,
    session: AsyncSession = Depends(get_session),
    bus: MessageBus = Depends(get_bus),
    admin: User = Depends(require_admin),
) -> AdminRoomDetail:
    if body.branch_id is not None and await session.get(Branch, body.branch_id) is None:
        raise HTTPException(status_code=404, detail="branch_not_found")
    member_ids = list(dict.fromkeys(body.member_ids))
    for user_id in member_ids:
        await _active_user_or_404(session, user_id)
    room = Room(type="group", name=body.name, branch_id=body.branch_id, created_by=admin.id)
    session.add(room)
    await session.flush()
    session.add_all([RoomMember(room_id=room.id, user_id=user_id) for user_id in member_ids])
    await session.commit()
    await session.refresh(room)  # nạp created_at do server đặt
    await _notify(bus, member_ids)
    return await _detail(session, room)


@router.get("/{room_id}", response_model=AdminRoomDetail)
async def get_room(room_id: int, session: AsyncSession = Depends(get_session)) -> AdminRoomDetail:
    return await _detail(session, await _group_or_404(session, room_id))


@router.patch("/{room_id}", response_model=AdminRoomDetail)
async def rename_room(
    room_id: int, body: RoomRenameIn, session: AsyncSession = Depends(get_session)
) -> AdminRoomDetail:
    room = await _group_or_404(session, room_id)
    room.name = body.name
    await session.commit()
    return await _detail(session, room)


@router.delete("/{room_id}", status_code=204)
async def delete_room(
    room_id: int, session: AsyncSession = Depends(get_session), bus: MessageBus = Depends(get_bus)
) -> None:
    room = await _group_or_404(session, room_id)
    member_ids = await _member_ids(session, room.id)
    await session.delete(room)
    await session.commit()
    await _notify(bus, member_ids)


@router.post("/{room_id}/members", response_model=AdminRoomDetail)
async def add_member(
    room_id: int,
    body: MemberIn,
    session: AsyncSession = Depends(get_session),
    bus: MessageBus = Depends(get_bus),
) -> AdminRoomDetail:
    room = await _group_or_404(session, room_id)
    await _active_user_or_404(session, body.user_id)
    if body.user_id not in await _member_ids(session, room.id):
        session.add(RoomMember(room_id=room.id, user_id=body.user_id))
        await session.commit()
    await _notify(bus, [body.user_id])
    return await _detail(session, room)


@router.delete("/{room_id}/members/{user_id}", response_model=AdminRoomDetail)
async def remove_member(
    room_id: int,
    user_id: int,
    session: AsyncSession = Depends(get_session),
    bus: MessageBus = Depends(get_bus),
) -> AdminRoomDetail:
    room = await _group_or_404(session, room_id)
    membership = await session.get(RoomMember, (room.id, user_id))
    if membership is None:
        raise HTTPException(status_code=404, detail="member_not_found")
    await session.delete(membership)
    await session.commit()
    await _notify(bus, [user_id])
    return await _detail(session, room)
```

- [ ] **Step 4: Nối vào `main.py` và `admin_users.py`**

`backend/app/main.py`: import `admin_rooms` cùng các router khác và thêm `app.include_router(admin_rooms.router, prefix="/api")`.

`backend/app/routers/admin_users.py`: thêm import
```python
from app.chat.bus import MessageBus, publish_user_safely
from app.routers.chat import get_bus
```
thêm tham số `bus: MessageBus = Depends(get_bus)` cho `update_user` và `reset_password`, và gọi sau `await session.commit()`:
```python
    # trong update_user, sau commit:
    if data.get("is_active") is False:
        await publish_user_safely(bus, user.id, {"type": "disconnect"})
    # trong reset_password, sau commit:
    await publish_user_safely(bus, user.id, {"type": "disconnect"})
```
(giữ nguyên toàn bộ logic hiện có; chỉ thêm hai lời gọi này và tham số `bus`).

- [ ] **Step 5: Chạy test**

Run: `bash scripts/test.sh tests/test_admin_rooms.py tests/test_admin_users.py -v` rồi `bash scripts/test.sh -q`
Expected: tất cả pass.

- [ ] **Step 6: Commit**

```bash
git add backend
git commit -m "feat: add admin group management and disconnect sockets on lock or reset" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Endpoint WebSocket, nối Hub vào app, test với server thật

**Files:**
- Create: `backend/app/routers/ws.py`
- Modify: `backend/app/main.py` (lifespan khởi động Hub, include router)
- Modify: `backend/tests/conftest.py` (fixture `live_server`)
- Create: `backend/tests/test_ws.py`

**Interfaces:**
- Consumes: `Hub`, `Connection`, `RedisMessageBus`, `build_listen_redis`, `service.send_message`, `to_message_out`, `decode_access_token`, `SessionLocal`, `get_settings`.
- Produces:
  - `WS /api/ws`. Giao thức:
    - Client → server: `{"type":"auth","token":"..."}` (bắt buộc, tin đầu tiên, trong `ws_auth_timeout_seconds`), `{"type":"send","room_id":int,"body":str,"client_id":str|null}`, `{"type":"ping"}`.
    - Server → client: `{"type":"ready","user_id":int}`; `{"type":"message","message":MessageOut}`; `{"type":"message_updated","message":...}`; `{"type":"message_deleted","room_id":int,"message_id":int}`; `{"type":"rooms_changed"}`; `{"type":"resync"}`; `{"type":"pong"}`; `{"type":"error","code":str,"client_id":str|null}`.
    - Mã đóng: 4401, 4403, 4408, 4413 (xem Global Constraints).
  - `app.state.hub` được tạo trong lifespan (`Hub(RedisMessageBus(get_redis(), build_listen_redis()), SessionLocal)`), chạy `hub.run()` nền, huỷ và đóng kết nối khi tắt.
  - fixture `live_server` (trong conftest) khởi động uvicorn thật trên cổng ngẫu nhiên **trong cùng event loop của test** và trả đối tượng có `.http` (`http://127.0.0.1:<port>`) và `.ws` (`ws://127.0.0.1:<port>`).

- [ ] **Step 1: Viết test thất bại**

Thêm vào `backend/tests/conftest.py` (cùng import `asyncio`, `socket`, `uvicorn`, `dataclass`):
```python
@dataclass
class LiveServer:
    http: str
    ws: str


@pytest_asyncio.fixture
async def live_server():
    """Chạy ứng dụng thật (có lifespan, Hub và Redis thật) trên cổng ngẫu nhiên trong cùng event loop."""
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    config = uvicorn.Config(create_app(), host="127.0.0.1", port=port, log_level="warning", lifespan="on")
    server = uvicorn.Server(config)
    task = asyncio.create_task(server.serve())
    for _ in range(200):
        if server.started:
            break
        await asyncio.sleep(0.05)
    else:
        raise RuntimeError("uvicorn không khởi động được")
    try:
        yield LiveServer(http=f"http://127.0.0.1:{port}", ws=f"ws://127.0.0.1:{port}")
    finally:
        server.should_exit = True
        await task
```
Thêm `import asyncio, socket`, `from dataclasses import dataclass`, `import uvicorn` ở đầu file. Nếu việc `uvicorn.Server.serve()` đăng ký signal handler gây xung đột với pytest trong container, ghi đè bằng lớp con có `install_signal_handlers` hoặc `capture_signals` rỗng và ghi vào báo cáo.

`backend/tests/test_ws.py`:
```python
import asyncio
import json

import pytest
from httpx import AsyncClient
from websockets.asyncio.client import connect

from tests.conftest import (
    add_message,
    auth_headers,
    create_direct,
    create_room,
    create_user,
    login,
)
from tests.helpers import expect_silence, recv_json, wait_closed, ws_open


async def _token(live, username):
    async with AsyncClient(base_url=live.http) as http:
        r = await login(http, username)
        return r.json()["access_token"]


async def _send(ws, room_id, body, client_id=None):
    await ws.send(json.dumps({"type": "send", "room_id": room_id, "body": body, "client_id": client_id}))


# ---------- xác thực ----------

async def test_valid_token_gets_ready(live_server):
    uid = await create_user("alice")
    ws, first = await ws_open(live_server.ws, await _token(live_server, "alice"))
    assert first == {"type": "ready", "user_id": uid}
    await ws.close()


async def test_bad_token_is_closed_with_4401(live_server):
    await create_user("alice")
    ws = await connect(f"{live_server.ws}/api/ws")
    await ws.send(json.dumps({"type": "auth", "token": "garbage"}))
    assert await wait_closed(ws) == 4401


async def test_no_auth_message_in_time_is_closed_with_4401(live_server):
    ws = await connect(f"{live_server.ws}/api/ws")
    assert await wait_closed(ws, timeout=4) == 4401


async def test_first_message_must_be_auth(live_server):
    await create_user("alice")
    ws = await connect(f"{live_server.ws}/api/ws")
    await ws.send(json.dumps({"type": "send", "room_id": 1, "body": "x"}))
    assert await wait_closed(ws) == 4401


async def test_a_user_who_must_change_the_password_cannot_connect(live_server):
    await create_user("fresh", must_change=True)
    ws = await connect(f"{live_server.ws}/api/ws")
    await ws.send(json.dumps({"type": "auth", "token": await _token(live_server, "fresh")}))
    assert await wait_closed(ws) == 4401


async def test_a_user_locked_after_login_cannot_connect_with_their_old_token(live_server):
    from app.db import SessionLocal
    from app.models import User

    uid = await create_user("later")
    token = await _token(live_server, "later")
    async with SessionLocal() as s:
        (await s.get(User, uid)).is_active = False
        await s.commit()
    ws = await connect(f"{live_server.ws}/api/ws")
    await ws.send(json.dumps({"type": "auth", "token": token}))
    assert await wait_closed(ws) == 4401


# ---------- gửi và nhận ----------

async def test_message_reaches_all_members_and_nobody_else(live_server):
    a, b, c = await create_user("alice"), await create_user("bob"), await create_user("carol")
    room = await create_room(member_ids=[a, b])
    wa, _ = await ws_open(live_server.ws, await _token(live_server, "alice"))
    wb, _ = await ws_open(live_server.ws, await _token(live_server, "bob"))
    wc, _ = await ws_open(live_server.ws, await _token(live_server, "carol"))
    await _send(wa, room, "  xin chào  ", "cid-1")

    mine, theirs = await recv_json(wa), await recv_json(wb)
    for event in (mine, theirs):
        assert event["type"] == "message"
        message = event["message"]
        assert (message["room_id"], message["sender_id"], message["body"], message["sender_name"]) == (room, a, "xin chào", "Alice")
    assert mine["message"]["client_id"] == "cid-1" and mine["message"]["id"] == theirs["message"]["id"]
    await expect_silence(wc)
    for ws in (wa, wb, wc):
        await ws.close()


async def test_resending_the_same_client_id_stores_and_broadcasts_once(live_server):
    a, b = await create_user("alice"), await create_user("bob")
    room = await create_room(member_ids=[a, b])
    wa, _ = await ws_open(live_server.ws, await _token(live_server, "alice"))
    wb, _ = await ws_open(live_server.ws, await _token(live_server, "bob"))
    await _send(wa, room, "một lần", "dup")
    first = await recv_json(wa)
    await recv_json(wb)
    await _send(wa, room, "một lần", "dup")
    again = await recv_json(wa)  # người gửi nhận lại đúng tin cũ
    assert again["message"]["id"] == first["message"]["id"]
    await expect_silence(wb)  # người khác không nhận bản thứ hai
    async with AsyncClient(base_url=live_server.http) as http:
        headers = auth_headers(await _token(live_server, "bob"))
        page = (await http.get(f"/api/rooms/{room}/messages", headers=headers)).json()
    assert [m["body"] for m in page["items"]] == ["một lần"]
    await wa.close()
    await wb.close()


async def test_non_members_including_admins_cannot_send(live_server):
    a = await create_user("alice")
    await create_user("root", role="admin")
    room = await create_room(member_ids=[a])
    ws, _ = await ws_open(live_server.ws, await _token(live_server, "root"))
    await _send(ws, room, "xâm nhập", "x1")
    error = await recv_json(ws)
    assert error == {"type": "error", "code": "room_not_found", "client_id": "x1"}
    await _send(ws, 987654, "phòng ma", "x2")
    assert (await recv_json(ws))["code"] == "room_not_found"
    await ws.close()
    assert (await _messages_in(room)) == []


async def _messages_in(room_id):
    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import Message

    async with SessionLocal() as s:
        return list((await s.execute(select(Message).where(Message.room_id == room_id))).scalars())


async def test_bad_input_returns_errors_but_keeps_the_connection_open(live_server):
    a = await create_user("alice")
    room = await create_room(member_ids=[a])
    ws, _ = await ws_open(live_server.ws, await _token(live_server, "alice"))

    await ws.send("không phải json")
    assert (await recv_json(ws))["code"] == "invalid_json"
    await ws.send(json.dumps({"type": "bay_len_troi"}))
    assert (await recv_json(ws))["code"] == "unknown_type"
    await ws.send(json.dumps({"type": "send", "room_id": "một", "body": 5}))
    assert (await recv_json(ws))["code"] == "invalid_message"
    await _send(ws, room, "   ", "e1")
    assert await recv_json(ws) == {"type": "error", "code": "empty_message", "client_id": "e1"}
    await _send(ws, room, "x" * 4001, "e2")
    assert (await recv_json(ws))["code"] == "message_too_long"
    await ws.send(json.dumps({"type": "ping"}))
    assert await recv_json(ws) == {"type": "pong"}
    await _send(ws, room, "vẫn gửi được", "ok")
    assert (await recv_json(ws))["message"]["body"] == "vẫn gửi được"
    await ws.close()


async def test_oversized_frame_closes_with_4413(live_server):
    await create_user("alice")
    ws, _ = await ws_open(live_server.ws, await _token(live_server, "alice"))
    await ws.send("x" * 20_000)
    assert await wait_closed(ws) == 4413


async def test_rate_limit_replies_with_an_error_after_the_burst(live_server):
    a = await create_user("alice")
    room = await create_room(member_ids=[a])
    ws, _ = await ws_open(live_server.ws, await _token(live_server, "alice"))
    codes = []
    for n in range(7):  # WS_RATE_LIMIT_MESSAGES=5 trong conftest
        await _send(ws, room, f"tin {n}", f"r{n}")
    for _ in range(7):
        event = await recv_json(ws)
        codes.append(event["code"] if event["type"] == "error" else "ok")
    assert codes.count("ok") == 5 and codes.count("rate_limited") == 2
    await ws.close()


# ---------- thay đổi thành viên và khoá tài khoản ----------

async def test_removing_a_member_stops_delivery_on_their_open_connection(live_server):
    await create_user("root", role="admin")
    a, b = await create_user("alice"), await create_user("bob")
    room = await create_room(name="Nhóm", member_ids=[a, b])
    wa, _ = await ws_open(live_server.ws, await _token(live_server, "alice"))
    wb, _ = await ws_open(live_server.ws, await _token(live_server, "bob"))
    await _send(wa, room, "trước khi bị gỡ", "p1")
    await recv_json(wa)
    assert (await recv_json(wb))["message"]["body"] == "trước khi bị gỡ"

    async with AsyncClient(base_url=live_server.http) as http:
        admin = auth_headers(await _token(live_server, "root"))
        assert (await http.delete(f"/api/admin/rooms/{room}/members/{b}", headers=admin)).status_code == 200
    assert (await recv_json(wb)) == {"type": "rooms_changed"}
    await _send(wa, room, "sau khi bị gỡ", "p2")
    await recv_json(wa)
    await expect_silence(wb)
    await wa.close()
    await wb.close()


async def test_adding_a_member_starts_delivery_on_their_open_connection(live_server):
    await create_user("root", role="admin")
    a, b = await create_user("alice"), await create_user("bob")
    room = await create_room(name="Nhóm", member_ids=[a])
    wa, _ = await ws_open(live_server.ws, await _token(live_server, "alice"))
    wb, _ = await ws_open(live_server.ws, await _token(live_server, "bob"))
    async with AsyncClient(base_url=live_server.http) as http:
        admin = auth_headers(await _token(live_server, "root"))
        await http.post(f"/api/admin/rooms/{room}/members", json={"user_id": b}, headers=admin)
    assert (await recv_json(wb)) == {"type": "rooms_changed"}
    await _send(wa, room, "chào người mới", "n1")
    await recv_json(wa)
    assert (await recv_json(wb))["message"]["body"] == "chào người mới"
    await wa.close()
    await wb.close()


async def test_locking_a_user_closes_their_websocket_with_4403(live_server):
    await create_user("root", role="admin")
    victim = await create_user("victim")
    ws, _ = await ws_open(live_server.ws, await _token(live_server, "victim"))
    async with AsyncClient(base_url=live_server.http) as http:
        admin = auth_headers(await _token(live_server, "root"))
        r = await http.patch(f"/api/admin/users/{victim}", json={"is_active": False}, headers=admin)
        assert r.status_code == 200
    assert await wait_closed(ws) == 4403


async def test_a_message_sent_after_being_locked_is_rejected_even_without_the_disconnect_event(live_server):
    from app.db import SessionLocal
    from app.models import User

    a = await create_user("alice")
    room = await create_room(member_ids=[a])
    ws, _ = await ws_open(live_server.ws, await _token(live_server, "alice"))
    async with SessionLocal() as s:
        (await s.get(User, a)).is_active = False
        await s.commit()
    await _send(ws, room, "sau khi khoá", "l1")
    assert await wait_closed(ws) == 4401
    assert (await _messages_in(room)) == []


async def test_one_user_can_have_several_connections_and_all_receive(live_server):
    a, b = await create_user("alice"), await create_user("bob")
    room = await create_room(member_ids=[a, b])
    token = await _token(live_server, "alice")
    tab1, _ = await ws_open(live_server.ws, token)
    tab2, _ = await ws_open(live_server.ws, token)
    wb, _ = await ws_open(live_server.ws, await _token(live_server, "bob"))
    await _send(wb, room, "gửi cho cả hai tab", "m1")
    await recv_json(wb)
    assert (await recv_json(tab1))["message"]["body"] == "gửi cho cả hai tab"
    assert (await recv_json(tab2))["message"]["body"] == "gửi cho cả hai tab"
    for ws in (tab1, tab2, wb):
        await ws.close()


async def test_rest_edit_and_delete_are_pushed_to_connected_members(live_server):
    a, b = await create_user("alice"), await create_user("bob")
    room = await create_room(member_ids=[a, b])
    msg = await add_message(room, a, "gốc")
    wb, _ = await ws_open(live_server.ws, await _token(live_server, "bob"))
    async with AsyncClient(base_url=live_server.http) as http:
        headers = auth_headers(await _token(live_server, "alice"))
        await http.patch(f"/api/messages/{msg}", json={"body": "đã sửa"}, headers=headers)
        updated = await recv_json(wb)
        assert (updated["type"], updated["message"]["body"]) == ("message_updated", "đã sửa")
        await http.delete(f"/api/messages/{msg}", headers=headers)
        assert await recv_json(wb) == {"type": "message_deleted", "room_id": room, "message_id": msg}
    await wb.close()
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `bash scripts/test.sh tests/test_ws.py -v`
Expected: các test thất bại vì chưa có route `/api/ws` (kết nối bị từ chối/404).

- [ ] **Step 3: Viết endpoint WebSocket**

`backend/app/routers/ws.py`:
```python
import asyncio
import json
import logging
import time
from collections import deque

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.chat import service
from app.chat.bus import publish_room_safely
from app.chat.hub import Connection, Hub
from app.chat.schemas import to_message_out
from app.chat.service import ChatError
from app.config import get_settings
from app.db import SessionLocal
from app.models import User
from app.security import decode_access_token

log = logging.getLogger(__name__)
router = APIRouter()

MAX_FRAME_CHARS = 16_384
CLOSE_UNAUTHENTICATED = 4401
CLOSE_FRAME_TOO_LARGE = 4413


async def _authenticate(websocket: WebSocket) -> User | None:
    settings = get_settings()
    try:
        raw = await asyncio.wait_for(websocket.receive_text(), timeout=settings.ws_auth_timeout_seconds)
        data = json.loads(raw)
    except (asyncio.TimeoutError, ValueError, WebSocketDisconnect, RuntimeError):
        await _close(websocket, CLOSE_UNAUTHENTICATED)
        return None
    token = data.get("token") if isinstance(data, dict) and data.get("type") == "auth" else None
    user_id = decode_access_token(token) if isinstance(token, str) else None
    user = None
    if user_id is not None:
        async with SessionLocal() as session:
            user = await session.get(User, user_id)
    if user is None or not user.is_active or user.must_change_password:
        await _close(websocket, CLOSE_UNAUTHENTICATED)
        return None
    return user


async def _close(websocket: WebSocket, code: int) -> None:
    try:
        await websocket.close(code=code)
    except RuntimeError:
        pass


async def _handle_send(conn: Connection, hub: Hub, data: dict, window: deque) -> None:
    settings = get_settings()
    client_id = data.get("client_id")
    now = time.monotonic()
    while window and now - window[0] > settings.ws_rate_limit_seconds:
        window.popleft()
    if len(window) >= settings.ws_rate_limit_messages:
        conn.offer({"type": "error", "code": "rate_limited", "client_id": client_id})
        return
    window.append(now)

    room_id, body = data.get("room_id"), data.get("body")
    if (
        not isinstance(room_id, int)
        or isinstance(room_id, bool)
        or not isinstance(body, str)
        or not (client_id is None or isinstance(client_id, str))
    ):
        conn.offer({"type": "error", "code": "invalid_message", "client_id": client_id if isinstance(client_id, str) else None})
        return
    try:
        async with SessionLocal() as session:
            message, sender_name, created = await service.send_message(session, conn.user_id, room_id, body, client_id)
    except ChatError as err:
        if err.status == 401:
            conn.close(CLOSE_UNAUTHENTICATED)
            return
        conn.offer({"type": "error", "code": err.code, "client_id": client_id})
        return
    event = {"type": "message", "message": to_message_out(message, sender_name).model_dump(mode="json")}
    if not created:
        conn.offer(event)  # gửi trùng: chỉ trả lại cho người gửi
    elif not await publish_room_safely(hub.bus, room_id, event):
        conn.offer(event)  # bus lỗi: ít nhất người gửi thấy tin của mình; người khác tải lại khi nối lại


async def _reader(websocket: WebSocket, conn: Connection, hub: Hub) -> None:
    window: deque[float] = deque()
    while True:
        raw = await websocket.receive_text()
        if len(raw) > MAX_FRAME_CHARS:
            conn.close(CLOSE_FRAME_TOO_LARGE)
            return
        try:
            data = json.loads(raw)
        except ValueError:
            conn.offer({"type": "error", "code": "invalid_json", "client_id": None})
            continue
        kind = data.get("type") if isinstance(data, dict) else None
        if kind == "ping":
            conn.offer({"type": "pong"})
        elif kind == "send":
            await _handle_send(conn, hub, data, window)
        else:
            conn.offer({"type": "error", "code": "unknown_type", "client_id": None})


async def _writer(websocket: WebSocket, conn: Connection) -> None:
    while True:
        event = await conn.queue.get()
        if event is None:
            await _close(websocket, conn.close_code or 1000)
            return
        await websocket.send_json(event)


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    hub: Hub = websocket.app.state.hub
    await websocket.accept()
    user = await _authenticate(websocket)
    if user is None:
        return
    conn = Connection(user.id)
    hub.register(conn)
    try:
        async with SessionLocal() as session:
            conn.room_ids = await service.user_room_ids(session, user.id)
        await websocket.send_json({"type": "ready", "user_id": user.id})
        tasks = {
            asyncio.create_task(_reader(websocket, conn, hub)),
            asyncio.create_task(_writer(websocket, conn)),
        }
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        for task in done:
            exc = task.exception()
            if exc is not None and not isinstance(exc, (WebSocketDisconnect, RuntimeError)):
                log.error("websocket task failed", exc_info=exc)
        if conn.close_code is not None and conn.queue.qsize():
            # reader tự đóng (ví dụ 4413): để writer kịp đóng WebSocket với mã đã đặt
            await _close(websocket, conn.close_code)
    finally:
        hub.unregister(conn)
```

Trong `backend/app/main.py`, thay `lifespan` bằng bản khởi động Hub (giữ nguyên kiểm tra secret hiện có ở đầu hàm):
```python
import asyncio
from contextlib import asynccontextmanager, suppress

from app.chat.bus import RedisMessageBus
from app.chat.hub import Hub
from app.db import SessionLocal
from app.redis_client import build_listen_redis, get_redis

@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    if settings.app_env == "prod" and (
        settings.jwt_secret in PLACEHOLDER_SECRETS or len(settings.jwt_secret) < MIN_SECRET_LENGTH
    ):
        raise RuntimeError(
            f"JWT_SECRET must be a real secret of at least {MIN_SECRET_LENGTH} characters when APP_ENV=prod "
            "(generate one with: openssl rand -hex 32)"
        )
    listen_redis = build_listen_redis()
    hub = Hub(RedisMessageBus(get_redis(), listen_redis), SessionLocal)
    app.state.hub = hub
    runner = asyncio.create_task(hub.run())
    try:
        yield
    finally:
        runner.cancel()
        with suppress(asyncio.CancelledError):
            await runner
        await hub.close_all()
        await listen_redis.aclose()
```
và thêm `app.include_router(ws.router, prefix="/api")` (import `ws` cùng các router khác). Các test hiện có gọi `lifespan(app)` (ví dụ `test_app.py`) vẫn phải pass: chúng chạy với Redis thật của môi trường test.

- [ ] **Step 4: Chạy test**

Run: `bash scripts/test.sh tests/test_ws.py -v` rồi `bash scripts/test.sh -q`
Expected: tất cả pass. Nếu một test thất bại do thứ tự sự kiện hoặc timing (ví dụ `rooms_changed` đến trước tin nhắn), điều tra nguyên nhân gốc trong mã (không nới lỏng assertion); nếu cần chờ Hub đăng ký xong, có thể thêm một sự kiện `ready` chỉ gửi sau khi `room_ids` đã nạp (đã có) và ghi nhận trong báo cáo.

- [ ] **Step 5: Commit**

```bash
git add backend
git commit -m "feat: add websocket endpoint with hub, auth handshake, rate limit and live tests" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Kiểm tra đầu-cuối qua Docker/Caddy và tài liệu

**Files:**
- Create: `scripts/e2e_chat_smoke.py`
- Modify: `README.md`

**Interfaces:**
- Consumes: toàn bộ API ở các task trước; Caddy (`/api/*` đã proxy, WebSocket đi qua `reverse_proxy` không cần cấu hình thêm).
- Produces: script `python scripts/e2e_chat_smoke.py --base http://caddy --admin-user ... --admin-temp-password ...` chạy **trong container `api`** (có sẵn `websockets`; chỉ dùng thư viện chuẩn + `websockets`), đi qua Caddy, in `OK` hoặc thoát mã khác 0.

- [ ] **Step 1: Viết script**

`scripts/e2e_chat_smoke.py`:
```python
"""Kiểm tra đầu-cuối: admin tạo 2 người dùng và 1 nhóm, hai người nhắn tin qua WebSocket qua Caddy.

Chạy trong container api (có websockets):
    docker compose exec -T api python /dev/stdin --base http://caddy --admin-user X --admin-temp-password Y < scripts/e2e_chat_smoke.py
"""
import argparse
import asyncio
import json
import sys
import urllib.error
import urllib.request

from websockets.asyncio.client import connect


def http(base, method, path, token=None, body=None):
    request = urllib.request.Request(
        f"{base}/api{path}",
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {token}"} if token else {})},
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as err:
        raw = err.read()
        return err.code, json.loads(raw) if raw else None


def login(base, username, password):
    status, body = http(base, "POST", "/auth/login", body={"username": username, "password": password})
    assert status == 200, (status, body)
    return body["access_token"], body["must_change_password"]


def ready_token(base, username, temp_password, new_password):
    token, must_change = login(base, username, temp_password)
    if must_change:
        status, body = http(
            base, "POST", "/auth/change-password", token,
            {"current_password": temp_password, "new_password": new_password},
        )
        assert status == 200, (status, body)
        token = body["access_token"]
    return token


async def open_ws(base, token):
    ws = await connect(base.replace("http", "ws", 1) + "/api/ws")
    await ws.send(json.dumps({"type": "auth", "token": token}))
    ready = json.loads(await asyncio.wait_for(ws.recv(), 5))
    assert ready["type"] == "ready", ready
    return ws


async def main(args):
    base = args.base.rstrip("/")
    admin = ready_token(base, args.admin_user, args.admin_temp_password, "E2eAdminPassw0rd!")

    status, branches = http(base, "GET", "/admin/branches", admin)
    assert status == 200 and branches, (status, branches)
    branch_id = branches[0]["id"]
    users = {}
    for name in ("e2e.alice", "e2e.bob"):
        status, created = http(
            base, "POST", "/admin/users", admin,
            {"username": name, "full_name": name.title(), "branch_id": branch_id, "role": "member"},
        )
        assert status == 201, (status, created)
        users[name] = (created["id"], created["temp_password"])
    tokens = {name: ready_token(base, name, pw, "E2eUserPassw0rd!") for name, (_, pw) in users.items()}

    status, room = http(
        base, "POST", "/admin/rooms", admin,
        {"name": "E2E nhóm", "branch_id": branch_id, "member_ids": [uid for uid, _ in users.values()]},
    )
    assert status == 201, (status, room)
    room_id = room["id"]

    alice, bob = await open_ws(base, tokens["e2e.alice"]), await open_ws(base, tokens["e2e.bob"])
    await alice.send(json.dumps({"type": "send", "room_id": room_id, "body": "xin chào từ Alice", "client_id": "e2e-1"}))
    mine = json.loads(await asyncio.wait_for(alice.recv(), 5))
    theirs = json.loads(await asyncio.wait_for(bob.recv(), 5))
    assert mine["type"] == theirs["type"] == "message", (mine, theirs)
    assert theirs["message"]["body"] == "xin chào từ Alice" and mine["message"]["client_id"] == "e2e-1"

    status, page = http(base, "GET", f"/rooms/{room_id}/messages", tokens["e2e.bob"])
    assert status == 200 and [m["body"] for m in page["items"]] == ["xin chào từ Alice"], (status, page)
    status, rooms = http(base, "GET", "/rooms", tokens["e2e.bob"])
    assert status == 200 and rooms[0]["unread_count"] == 1, (status, rooms)

    status, denied = http(base, "GET", f"/rooms/{room_id}/messages", admin)  # admin không phải thành viên
    assert (status, denied) == (404, {"detail": "room_not_found"}), (status, denied)

    status, _ = http(base, "PATCH", f"/admin/users/{users['e2e.alice'][0]}", admin, {"is_active": False})
    assert status == 200
    await asyncio.wait_for(alice.wait_closed(), 5)
    assert alice.close_code == 4403, alice.close_code
    await bob.close()
    print("OK")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", required=True)
    parser.add_argument("--admin-user", required=True)
    parser.add_argument("--admin-temp-password", required=True)
    try:
        asyncio.run(main(parser.parse_args()))
    except AssertionError as err:
        print("FAIL:", err)
        sys.exit(1)
```

- [ ] **Step 2: Chạy đầu-cuối thật**

Run (từ thư mục gốc; stack thử nghiệm dùng `.env` tạm có `JWT_SECRET` thật 64 ký tự hex và `APP_ENV=prod`, giống cách đã làm ở các plan trước; sao lưu `.env` ra thư mục tạm và khôi phục ở cuối, không in secret):
```bash
docker compose config -q
docker compose up -d --build
# chờ api healthy (khoảng 20-40 giây): docker compose ps
docker compose exec -T api python -m app.cli create-admin --username e2e.admin --full-name "E2E Admin" --branch-name "Hà Nội" --branch-code HN
docker compose exec -T api python /dev/stdin --base http://caddy --admin-user e2e.admin --admin-temp-password <MẬT_KHẨU_TẠM> < scripts/e2e_chat_smoke.py
```
Expected: dòng cuối in `OK`. Nếu `FAIL`, báo lại lỗi cụ thể (đừng sửa test cho khớp lỗi). Sau đó dọn: `docker compose down -v`, khôi phục `.env` gốc.

- [ ] **Step 3: Cập nhật README**

Thêm vào `README.md` một mục "API chat (tóm tắt)" sau mục "Giao diện web":
````markdown
## API chat (tóm tắt)

Tất cả dưới `/api`, cần `Authorization: Bearer <access token>` và đã đổi mật khẩu lần đầu.

| Việc | Endpoint |
|---|---|
| Tìm đồng nghiệp để nhắn riêng | `GET /users/directory?q=` |
| Danh sách phòng của tôi (kèm tin cuối, số chưa đọc) | `GET /rooms` |
| Mở chat 1-1 | `POST /rooms/direct` `{"user_id": 3}` |
| Lịch sử tin nhắn (con trỏ) | `GET /rooms/{id}/messages?before=&after=&around=&limit=` |
| Đánh dấu đã đọc | `POST /rooms/{id}/read` `{"message_id": 10}` |
| Sửa / xoá tin của mình | `PATCH` / `DELETE /messages/{id}` |
| Admin quản lý nhóm | `/admin/rooms` (tạo, đổi tên, thêm/bớt thành viên, xoá) |

Thời gian thực qua **WebSocket** `/api/ws`: mở kết nối rồi gửi ngay `{"type":"auth","token":"<access token>"}` (trong 5 giây). Sau khi nhận `{"type":"ready"}`, gửi tin bằng `{"type":"send","room_id":1,"body":"...","client_id":"<uuid>"}`; nhận `message`, `message_updated`, `message_deleted`, `rooms_changed`, `resync`, `error`. Mất kết nối thì kết nối lại và tải phần còn thiếu bằng `GET /rooms/{id}/messages?after=<id tin cuối đã có>`; khi nhận `resync` cũng làm như vậy.

Kiểm tra nhanh toàn bộ luồng (cần stack đang chạy): xem đầu file `scripts/e2e_chat_smoke.py`.
````

- [ ] **Step 4: Chạy lại toàn bộ test và commit**

Run: `bash scripts/test.sh -q`
Expected: tất cả pass.

```bash
git add scripts/e2e_chat_smoke.py README.md
git commit -m "docs: add chat api overview and end-to-end smoke script" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage (phần thuộc Plan 3):**
- Mục 3 (bảng `rooms`, `room_members`, `messages`; direct = phòng 2 người, unique mỗi cặp; `last_read_message_id`; xoá mềm; chỉ mục `(room_id, id DESC)`): Task 2, 4. Bảng `message_mentions`, `attachments`, cột `reply_to_id`, `tsvector`: Plan 5, 6.
- Mục 5 (lưu Postgres trước, phát sau; `client_id` idempotent; một WebSocket cho mọi phòng; sự kiện `send`/`message`; kết nối lại lấy phần thiếu qua REST; heartbeat): Task 3, 4, 7. Sự kiện `read`/`typing`/`presence` và Redis presence: Plan 5. Heartbeat: có `ping`/`pong` ứng dụng; heartbeat cấp giao thức do uvicorn xử lý.
- Mục 5 (REST: phòng, tin nhắn, đã đọc, sửa/xoá, admin phòng): Task 5, 6. `GET /search` và file: Plan 6.
- Mục 4 (khoá tài khoản ngắt WebSocket; kiểm tra thành viên ở cả REST và WebSocket; admin không đọc tin chat riêng): Task 5, 6, 7.
- Mục 6 (phân trang con trỏ, `around`, `has_more`, không N+1): Task 4, 5. Phần frontend (virtualized list, giữ vị trí cuộn): Plan 4.
- Mục 9 (giới hạn tần suất gửi tin WebSocket): Task 7. Chống XSS và file: Plan 4, 6.
- Mục 10 (test quyền truy cập phòng, phân trang, idempotency, đồng bộ sau mất kết nối, admin không đọc tin riêng, bị khoá bị ngắt): Task 4-7. Đồng bộ sau mất kết nối: `after=` (Task 4/5) và `resync` (Task 3). Thử tải 100.000 tin: Plan 7 (Task 4 có kiểm tra 20.000 tin).

**Quét placeholder:** không có "TBD"/"TODO"; mọi bước mã đều có mã đầy đủ. Có ba chỗ cho phép điều chỉnh có kiểm soát, đều nêu rõ cách xử lý và yêu cầu ghi báo cáo: Task 2 Step 5 (so sánh chỉ mục biểu thức bằng alembic), Task 4 Step 5 (`returning(Message)`), Task 7 Step 1 (tín hiệu hệ thống của uvicorn trong test).

**Nhất quán kiểu và tên:** `ChatError(status, code)`, `service.*`, `to_message_out`, `get_bus` (định nghĩa ở `routers/chat.py`, dùng lại ở `admin_rooms.py`, `admin_users.py`), `publish_*_safely`, `Connection`/`Hub`, mã đóng 4401/4403/4408/4413, tên sự kiện đồng nhất giữa `service`/`routers`/`ws`/`tests`. Mã lỗi: `room_not_found`, `message_not_found`, `user_not_found`, `branch_not_found`, `member_not_found`, `empty_message`, `message_too_long`, `invalid_client_id`, `invalid_cursor`, `cannot_chat_with_self`, `rate_limited`, `invalid_message`, `invalid_json`, `unknown_type`.

**Review Focus:** 6 dòng đều có test: không phải thành viên (Task 5 `test_non_members_including_admins_get_404...`, Task 7 `test_non_members_including_admins_cannot_send`); idempotency (Task 4, Task 7); đầu vào xấu và khung lớn (Task 7); gỡ thành viên và khoá tài khoản (Task 6, Task 7); phân trang biên (Task 4); client chậm (Task 3 `test_slow_consumer...`).

## Các plan tiếp theo (đã đánh số lại)

| Plan | Nội dung |
|---|---|
| 4 | Giao diện chat (React): danh sách phòng, khung hội thoại với danh sách ảo hoá, tải lịch sử khi cuộn, gửi tin lạc quan, kết nối lại và `resync`, mở chat 1-1, trang Phòng-và-nhóm của admin, trạng thái rỗng/đang tải, bố cục màn hình hẹp |
| 5 | Trải nghiệm: đã xem (qua WebSocket), đang gõ, online, reply, mention, thông báo trình duyệt |
| 6 | File đính kèm và tìm kiếm tiếng Việt |
| 7 | Vận hành: HTTPS nội bộ, giới hạn IP admin, sao lưu và khôi phục, thử tải 100.000 tin, dọn `refresh_tokens`, ghim phiên bản |
