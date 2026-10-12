# Kết Nối: app nhắn tin nội bộ

Thiết kế: `docs/superpowers/specs/2026-10-12-internal-messaging-design.md`

## Chạy lần đầu (dev hoặc server Ubuntu)

```bash
cp .env.example .env          # BẮT BUỘC sửa JWT_SECRET (openssl rand -hex 32) và mật khẩu DB (nên dùng openssl rand -hex 32)
docker compose up -d --build  # dev: tự dùng thêm docker-compose.override.yml (mở cổng DB/Redis ở localhost)
docker compose ps             # đợi các service healthy
```

Triển khai thật (không mở cổng DB/Redis ra ngoài):

```bash
docker compose -f docker-compose.yml up -d --build
```

## Giao diện web

Sau khi `docker compose up -d --build`, mở `http://<địa-chỉ-máy-chủ>/` trong trình duyệt. Đăng nhập bằng tài khoản admin tạo ở bước trên; lần đầu hệ thống bắt đổi mật khẩu.

Phát triển giao diện (cần Node 22+; stack docker compose đang chạy để có API):

```bash
cd frontend
npm install
npm run dev      # http://localhost:5173, /api được proxy sang http://localhost:80
npm test         # chạy test (Vitest)
npm run build    # kiểm tra kiểu và build ra frontend/dist
```

## Tạo tài khoản quản trị đầu tiên

```bash
docker compose exec api python -m app.cli create-admin \
  --username long.pham --full-name "Phạm Đức Long" \
  --branch-name "Hà Nội" --branch-code HN
```

Lệnh in mật khẩu tạm một lần duy nhất và không thể xem lại sau đó, hãy sao chép ngay. Người dùng phải đổi mật khẩu khi đăng nhập lần đầu.

## Chạy test backend

```bash
bash scripts/test.sh -v
```

Lệnh này chỉ dành cho máy phát triển: nó khởi động db/redis cùng `docker-compose.override.yml` (mở cổng ở localhost), chạy pytest trong container python:3.12 nối vào mạng compose, không cần cài Python trên máy. Script đọc `POSTGRES_USER`/`POSTGRES_PASSWORD` từ `.env` và tự tạo database `messaging_test` nếu chưa có. Nên đặt `POSTGRES_PASSWORD` bằng `openssl rand -hex 32` (chuỗi hex an toàn trong `DATABASE_URL`; mật khẩu base64 có thể làm hỏng URL).

Nếu máy đã có Python 3.12 (cần Python 3.12), có thể chạy trực tiếp:

```bash
docker compose up -d db redis
docker compose exec db createdb -U messaging messaging_test   # chỉ lần đầu
cd backend
python -m venv .venv && source .venv/bin/activate              # Git Bash: source .venv/Scripts/activate
pip install -r requirements-dev.txt
pytest -v
```

## Cấu hình môi trường: `APP_ENV` và `COOKIE_SECURE`

Hai biến này độc lập với nhau.

- `APP_ENV` (`dev` | `test` | `prod`, mặc định trong `.env.example` là `prod`). Ở `prod`, api từ chối khởi động nếu `JWT_SECRET` là giá trị mẫu hoặc ngắn hơn 32 ký tự (xem `docker compose logs api`), và `/api/docs` bị tắt. Đặt `dev` khi phát triển cục bộ. Giá trị khác ba giá trị trên bị từ chối.
- Phải đặt `JWT_SECRET` thật (`openssl rand -hex 32`) trước lần khởi động đầu tiên. Giá trị mẫu trong `.env.example` cố ý bị từ chối ở `prod` để quên đổi thì lỗi ngay.
- `COOKIE_SECURE` điều khiển cờ `Secure` của cookie đăng nhập, không phụ thuộc `APP_ENV`. Khi chưa có HTTPS, Caddy chỉ nghe cổng 80 (HTTP), nên giữ `COOKIE_SECURE=false`, nếu không trình duyệt sẽ không lưu cookie. Khi bật HTTPS, đổi thành `COOKIE_SECURE=true`.
