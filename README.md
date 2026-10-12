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

Sau khi `docker compose up -d --build`, mở `http://<địa-chỉ-máy-chủ>/` trong trình duyệt. Đăng nhập bằng tài khoản admin tạo ở bước bên dưới; lần đầu hệ thống bắt đổi mật khẩu. Sau khi kéo mã nguồn mới về, hãy chạy lại `docker compose up -d --build` vì giao diện web được đóng gói sẵn trong image.

Phát triển giao diện (cần Node 22.4+; stack docker compose đang chạy để có API):

```bash
cd frontend
npm install
npm run dev      # http://localhost:5173, /api được proxy sang http://localhost:80
npm test         # chạy test (Vitest)
npm run build    # kiểm tra kiểu và build ra frontend/dist
```

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

### Phân trang tin nhắn

`GET /rooms/{id}/messages` nhận tối đa **một** trong `before`, `after`, `around` (nhiều hơn một: `400 invalid_cursor`), cùng `limit` từ 1 đến 100 (mặc định 50). Các tham số `before`/`after`/`around` phải ≥ 1; muốn "từ đầu" thì **bỏ tham số** thay vì gửi `0` (server trả 422). Mọi id phải là số nguyên dương trong khoảng cột DB (phòng/người dùng/chi nhánh tới 2^31-1, tin nhắn tới 2^63-1); ngoài khoảng là `422`.

- Không tham số: trang mới nhất. `before=<id>`: các tin cũ hơn id đó. `after=<id>`: các tin mới hơn id đó (cũ nhất trước). `around=<id>`: tin đó ở giữa cùng tin cũ và mới hơn (`404 message_not_found` nếu không thuộc phòng).
- `items` luôn sắp xếp **tăng dần** theo id.
- `has_more_before` có nghĩa với trang mặc định và `before`; `has_more_after` có nghĩa với `after`; với `around` cả hai đều có nghĩa. Trường còn lại luôn là `false`.

### WebSocket `/api/ws`

Mở kết nối rồi gửi ngay `{"type":"auth","token":"<access token>"}` (trong 5 giây). Sau khi nhận `{"type":"ready","user_id":1}`, gửi tin bằng `{"type":"send","room_id":1,"body":"...","client_id":"<uuid>"}` (`client_id` tối đa 64 ký tự, gửi lại cùng `client_id` là idempotent). Ping: `{"type":"ping"}` trả `{"type":"pong"}`. Server đẩy xuống: `message`, `message_updated`, `message_deleted`, `rooms_changed`, `resync`, `error` (`{"type":"error","code":"...","client_id":...}`).

**Mã đóng kết nối và cách client phản ứng**

| Mã | Ý nghĩa | Client làm gì |
|---|---|---|
| 4401 | Chưa xác thực, token sai/hết hạn, hoặc thông tin đăng nhập vừa đổi (đổi mật khẩu, admin đặt lại mật khẩu) | Làm mới token (`POST /auth/refresh`) rồi kết nối lại; nếu refresh thất bại thì về trang đăng nhập |
| 4403 | Tài khoản bị khoá (đối soát định kỳ chỉ dùng 4403 cho tài khoản bị khoá; tài khoản phải đổi mật khẩu bị đóng 4401) | **Không** kết nối lại, về trang đăng nhập |
| 4408 | Client quá chậm (hàng đợi gửi đầy) | Kết nối lại và tải phần còn thiếu (xem quy tắc catch-up bên dưới) |
| 4413 | Frame quá lớn | Không gửi lại đúng frame đó (kết nối lại được, nhưng đừng retry cùng nội dung) |

**Không mở WebSocket khi người dùng chưa đổi mật khẩu lần đầu** (`must_change_password`): server đóng 4401, mà làm mới token vẫn thành công, nên client sẽ lặp vô hạn nếu không kiểm tra cờ này trước.

Giới hạn frame là **16 KiB tính theo byte UTF-8** (không phải số ký tự; tiếng Việt có dấu tốn nhiều byte hơn), áp dụng cả cho frame `auth`. Trần cứng của tầng transport là 64 KiB (vượt thì đóng với mã 1009).

**Giới hạn tốc độ**: mặc định 20 tin `send` mỗi 10 giây trên mỗi kết nối (`WS_RATE_LIMIT_MESSAGES`, `WS_RATE_LIMIT_SECONDS`). Vượt thì server trả `{"type":"error","code":"rate_limited","client_id":...}` và bỏ tin đó, kết nối vẫn mở.

**Các giá trị `code` lỗi**

| `code` | Nơi gặp | Ghi chú |
|---|---|---|
| `empty_message` | WS, REST | Nội dung rỗng sau khi cắt khoảng trắng |
| `message_too_long` | WS, REST | Vượt 4000 ký tự (`MAX_MESSAGE_LENGTH`) khi gửi; khi sửa tin chỉ trong khoảng 4001-10000 ký tự, trên 10000 ký tự REST trả 422 `validation_error` |
| `invalid_client_id` | WS (không có REST gửi tin) | `client_id` rỗng hoặc dài quá 64 ký tự (echo lại `client_id: null`) |
| `invalid_message` | WS, REST | Sai kiểu/khoảng giá trị (`room_id`, `body`, `client_id`...) hoặc chứa ký tự NUL |
| `invalid_json` | WS | Frame không phải JSON |
| `unknown_type` | WS | `type` không hỗ trợ |
| `unsupported_frame` | WS | Frame nhị phân |
| `rate_limited` | WS | Xem trên |
| `internal_error` | WS | Lỗi phía server khi gửi tin; thử lại được |
| `room_not_found` | WS, REST | Không phải thành viên hoặc phòng không tồn tại (admin cũng không đọc/gửi được nếu không là thành viên) |
| `message_not_found` | REST | Tin không tồn tại hoặc không thuộc phòng |
| `user_not_found` | REST | Người dùng không tồn tại hoặc đã bị khoá |
| `cannot_chat_with_self` | REST | Mở chat 1-1 với chính mình |
| `invalid_cursor` | REST | Truyền nhiều hơn một trong `before`/`after`/`around` |
| `forbidden` | REST | Sửa/xoá tin của người khác, hoặc không phải admin |
| `not_authenticated` | REST | Thiếu/sai access token (WS: đóng 4401) |
| `password_change_required` | REST | Phải đổi mật khẩu trước |
| `service_unavailable` | REST (503) | Redis lỗi |
| `member_not_found`, `branch_not_found`, `branch_exists`, `branch_has_users`, `username_taken`, `cannot_modify_self` | REST (admin) | Quản trị người dùng/chi nhánh/nhóm |
| `invalid_credentials`, `too_many_attempts`, `invalid_refresh`, `wrong_current_password`, `password_unchanged` | REST (auth) | Đăng nhập và đổi mật khẩu |

Lỗi REST có dạng `{"detail":"<code>"}`; sai kiểu/khoảng giá trị đầu vào là `422` với `detail` là danh sách lỗi của FastAPI.

**Quy tắc đồng bộ cho client**

- Sau **mỗi** `ready` (không chỉ khi kết nối lại) và khi nhận `resync`: với từng phòng đang mở/đã tải, gọi `GET /rooms/{id}/messages?after=<id tin cuối đã có>` (lặp tới khi `has_more_after` là `false`) và tải lại `GET /rooms`. Tin có thể đã đến giữa lúc tải lịch sử và lúc kết nối xong.
- Nhận `rooms_changed` (được thêm/gỡ khỏi phòng, đổi tên nhóm, phòng bị xoá): tải lại `GET /rooms`.
- Server cũng tự đối soát định kỳ (`WS_RECONCILE_SECONDS`, mặc định 30 giây) và đóng kết nối của tài khoản đã khoá hoặc phải đổi mật khẩu, nên client phải xử lý 4401/4403 bất cứ lúc nào.

**Xoá nhóm là xoá vĩnh viễn**: admin xoá một nhóm (`DELETE /admin/rooms/{id}`) sẽ xoá **toàn bộ tin nhắn** của nhóm đó, không khôi phục được. Giao diện admin phải yêu cầu xác nhận rõ ràng trước khi gọi.

### Kiểm tra đầu-cuối: `scripts/e2e_chat_smoke.py`

> **CẢNH BÁO: chỉ chạy trên stack dùng một lần (throwaway). Không bao giờ chạy trên production.** Script tạo người dùng `e2e.alice`, `e2e.bob` và một nhóm, đặt mật khẩu quản trị đã biết trước (`E2eAdminPassw0rd!`) cho tài khoản admin được chỉ định, và **không chạy lại được** (lần hai sẽ lỗi vì người dùng đã tồn tại). Xong hãy huỷ cả stack và dữ liệu: `docker compose down -v`.

```bash
docker compose up -d --build
docker compose exec api python -m app.cli create-admin --username e2e.root --full-name "E2E Root" --branch-name "E2E" --branch-code E2E
# lấy mật khẩu tạm mà lệnh trên in ra, rồi:
docker compose exec -T api python /dev/stdin --base http://caddy --admin-user e2e.root --admin-temp-password '<mật khẩu tạm>' < scripts/e2e_chat_smoke.py
docker compose down -v
```

In `OK` nếu thành công; nếu không in một dòng `FAIL: ...` và thoát với mã 1.

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
