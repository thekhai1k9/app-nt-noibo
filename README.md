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
bash scripts/test.sh -v
```

Lệnh này chạy pytest trong container python:3.12 nối vào mạng compose, không cần cài Python trên máy. Script tự khởi động db/redis và tự tạo database `messaging_test` nếu chưa có.

Nếu máy đã có Python 3.12 (cần Python 3.12), có thể chạy trực tiếp:

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
