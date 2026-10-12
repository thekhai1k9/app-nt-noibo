# Thiết kế: App nhắn tin nội bộ nhiều chi nhánh

Ngày: 2026-10-12
Trạng thái: chờ người dùng duyệt

## 1. Mục tiêu và phạm vi

App nhắn tin nội bộ cho một công ty có nhiều chi nhánh, truy cập bằng trình duyệt.

**Quy mô:** dưới 50 người dùng, 2-5 chi nhánh.
**Triển khai:** giai đoạn đầu chạy trên một PC Ubuntu Server trong mạng WAN nội bộ. Sau này chuyển sang VPS hoặc cloud bằng cách đổi cấu hình, không đổi code.
**Công nghệ:** Python (FastAPI), PostgreSQL, Redis, React + TypeScript, Docker Compose.

### Trong phạm vi bản đầu
- Chat 1-1 và chat nhóm (nhóm có thể theo chi nhánh hoặc liên chi nhánh)
- Trạng thái online, đang gõ, đã xem
- Lưu lịch sử lâu dài, tìm kiếm tin nhắn
- Gửi file và ảnh cơ bản
- Reply một tin cụ thể và @mention
- Thông báo trong trình duyệt (Web Notification, âm báo, badge số chưa đọc trên tiêu đề tab)
- Đồng bộ nhiều tab/thiết bị của cùng một user
- Trang quản trị (user, chi nhánh, phòng) trong cùng app
- Sao lưu tự động, HTTPS (kể cả trong mạng nội bộ), healthcheck và log

### Ngoài phạm vi (làm sau nếu cần)
Gọi thoại/video, push khi đóng hẳn trình duyệt, app mobile/desktop riêng, mã hoá đầu-cuối, chính sách lưu trữ và xoá tin tự động, quét virus file upload (ClamAV), 2FA, nhật ký kiểm toán admin, giám sát Prometheus/Grafana, microservice, nhiều server.

### Quyết định đã chốt
- Một server trung tâm; chi nhánh chỉ là thuộc tính của user và phòng, không phải node riêng.
- Monolith FastAPI với ranh giới module rõ ràng, không dùng microservice.
- Có Redis ngay từ đầu (pub/sub, presence, rate limit). Redis **không** phải giải pháp chống lag; chống lag nằm ở phân trang, index và virtualized list (mục 6).
- **Admin không đọc được nội dung chat riêng** của người khác. Không có endpoint nào trả `messages` của phòng mà admin không phải thành viên.
- Trang quản trị nằm trong cùng app React, route `/admin`, không tách app riêng.

## 2. Kiến trúc

```
Trình duyệt (React SPA)
        │ HTTPS + WSS
        ▼
   Caddy (reverse proxy, TLS, phục vụ file React đã build)
        │
        ▼
   FastAPI (REST + WebSocket) ──► PostgreSQL (dữ liệu, full-text search)
        │            └──────────► Redis (pub/sub, presence, rate limit)
        └─ volume lưu file/ảnh upload
```

- 4 container: `caddy`, `api`, `db`, `redis`. Tất cả `restart: unless-stopped`, có healthcheck. Cấu hình bằng `.env`.
- Phát tin qua giao diện `MessageBus` (triển khai bằng Redis pub/sub), nên chạy nhiều worker hoặc nhiều server không cần sửa logic chat.
- Chuyển cloud: đổi tên miền trong `.env`, gắn volume vào ổ của cloud, chạy lại `docker compose up -d`.
- Log container ghi stdout dạng JSON, có xoay vòng log.

## 3. Mô hình dữ liệu (PostgreSQL)

| Bảng | Nội dung chính |
|---|---|
| `branches` | id, tên, mã chi nhánh |
| `users` | id, username, họ tên, `branch_id`, `role` (admin / member), `password_hash`, `is_active`, `must_change_password` |
| `rooms` | id, `type` (direct / group), tên, `branch_id` (null nếu liên chi nhánh), `created_by` |
| `room_members` | `room_id`, `user_id`, vai trò trong phòng (owner / member), `last_read_message_id` |
| `messages` | id (bigserial), `room_id`, `sender_id`, `body`, `kind` (text / file), `reply_to_id`, `client_id`, `created_at`, `edited_at`, `deleted_at`, cột `tsvector` |
| `message_mentions` | `message_id`, `user_id` |
| `attachments` | `message_id`, đường dẫn file (tên uuid), tên gốc, mime, kích thước, đường dẫn thumbnail |

**Quy tắc:**
- Chat 1-1 là `room` loại direct với đúng 2 thành viên. Ràng buộc unique để mỗi cặp user chỉ có một phòng direct.
- "Đã xem" dùng `last_read_message_id` mỗi thành viên. Số tin chưa đọc tính bằng so sánh id.
- Xoá tin nhắn là xoá mềm (`deleted_at`); nội dung không trả về client sau khi xoá.
- `(room_id, client_id)` unique để gửi lặp không tạo tin trùng.
- **Index bắt buộc:** `messages(room_id, id DESC)`, `room_members(user_id)`, GIN trên `tsvector`.
- **Tìm kiếm tiếng Việt:** `tsvector` cấu hình `simple` kết hợp `unaccent`, nên "nguyen" khớp "Nguyễn". Chỉ tìm trong các phòng user là thành viên.

## 4. Xác thực và phân quyền

- Không có tự đăng ký. Admin tạo tài khoản và đặt mật khẩu tạm; user phải đổi mật khẩu ở lần đăng nhập đầu.
- Mật khẩu hash bằng argon2. Phiên: access token ngắn hạn + refresh token trong cookie `httpOnly`. Đăng nhập có rate limit qua Redis.
- User chỉ đọc và gửi vào phòng mình là thành viên. Kiểm tra ở cả REST và lúc đăng ký nhận tin qua WebSocket.
- Khoá tài khoản (`is_active = false`) ngắt WebSocket đang mở và thu hồi refresh token.
- Mọi endpoint `/api/admin/*` kiểm tra `role = admin` ở backend; ẩn menu ở frontend không được coi là bảo mật.
- Tuỳ chọn cấu hình trong `.env`: Caddy chỉ cho phép `/api/admin/*` từ dải IP của trụ sở.

## 5. Luồng thời gian thực và API

### Gửi một tin nhắn
1. React gửi sự kiện `send` qua WebSocket, kèm `client_id`.
2. FastAPI kiểm tra user là thành viên phòng.
3. INSERT vào `messages` (Postgres), có `id` và `created_at`.
4. Publish lên Redis channel `room:{id}`.
5. Mọi worker nhận từ Redis và đẩy sự kiện `message` cho các WebSocket đang mở của thành viên phòng.

Lưu Postgres trước, phát sau: nếu Redis lỗi, tin nhắn không mất. Server trả lại `client_id` cùng `id` thật để UI khớp tin optimistic.

### Sự kiện WebSocket
| Hướng | Sự kiện |
|---|---|
| Client → server | `send`, `typing`, `read` |
| Server → client | `message`, `typing`, `read`, `presence`, `room_updated` |

- Một WebSocket cho mỗi tab, dùng chung cho tất cả phòng của user.
- Online và "đang gõ" lưu trong Redis với TTL ngắn, tự hết hạn khi mất kết nối.
- Heartbeat ping/pong để phát hiện kết nối chết.
- Trạng thái đã đọc đồng bộ giữa các tab/thiết bị của cùng user qua sự kiện `read`.

### Kết nối lại
Client tự kết nối lại với backoff. Sau khi nối lại, client gửi id tin cuối đã nhận; server trả phần còn thiếu qua REST.

### REST API (tiền tố `/api`)
| Nhóm | Endpoint chính |
|---|---|
| Auth | `POST /auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/change-password` |
| Phòng | `GET /rooms` (kèm số chưa đọc), `POST /rooms` (tạo nhóm hoặc mở direct), thêm/bớt thành viên |
| Tin nhắn | `GET /rooms/{id}/messages?before=<id>&limit=50` (và `after`, `around`), sửa, xoá mềm |
| Tìm kiếm | `GET /search?q=` |
| File | `POST /rooms/{id}/files`, `GET /files/{id}` |
| Admin | CRUD `/admin/users`, `/admin/branches`, `/admin/rooms` |

- File không phục vụ trực tiếp từ thư mục tĩnh; mọi lượt tải đều kiểm tra quyền thành viên.
- Giới hạn kích thước tin nhắn và file, kiểm tra loại file, chặn file thực thi, đặt tên lưu bằng uuid để tránh path traversal.

## 6. Tải lịch sử tin nhắn (yêu cầu bắt buộc, chống lag)

**Backend:**
- Phân trang theo con trỏ (keyset), không dùng `OFFSET`: `WHERE room_id = ? AND id < ? ORDER BY id DESC LIMIT 50`, dựa trên index `(room_id, id DESC)`.
- Mở phòng trả 50 tin mới nhất (hoặc 50 tin quanh tin chưa đọc đầu tiên). Response có cờ `has_more`.
- Truy vấn dùng join lấy thông tin người gửi trong một lần, không N+1.
- `around=<id>` để nhảy tới một tin cụ thể (từ kết quả tìm kiếm hoặc reply).

**Frontend:**
- Mở phòng chỉ tải một trang; kéo lên gần đầu danh sách thì tải trang cũ hơn bằng `useInfiniteQuery` (infinite scroll ngược).
- Danh sách ảo hoá (virtualized): DOM chỉ giữ vài chục tin đang hiển thị.
- Chèn tin cũ lên đầu phải giữ nguyên vị trí cuộn.
- Tin mới qua WebSocket: tự cuộn xuống nếu user đang ở cuối; nếu đang đọc tin cũ thì hiện nút "↓ N tin mới".

## 7. Frontend (React + TypeScript + Vite)

- Cấu trúc: `auth`, `chat`, `admin`, `lib` (client REST, client WebSocket).
- State: TanStack Query cho dữ liệu REST; Zustand cho kết nối WebSocket, presence, typing.
- Hiển thị tin nhắn bằng text thuần (React tự escape); link tự nhận dạng, chỉ cho `http/https`.
- Optimistic UI bằng `client_id`; WebSocket client tự reconnect và lấy phần còn thiếu.
- Thông báo: Web Notification, âm báo, badge số chưa đọc trên tiêu đề tab. Web Notification cần HTTPS.
- Khu vực `/admin` được tách chunk (lazy-load), chỉ hiện cho `role = admin`.
- Build ra file tĩnh, Caddy phục vụ.

### Màn hình quản trị
| Màn hình | Chức năng |
|---|---|
| Người dùng | Danh sách, tìm kiếm, lọc theo chi nhánh; tạo, sửa, khoá/mở khoá, đặt lại mật khẩu tạm |
| Chi nhánh | Tạo, sửa, xem số người |
| Phòng/nhóm | Tạo nhóm, thêm bớt thành viên, đổi tên, xoá phòng. Không xem được nội dung tin nhắn |
| Tổng quan (tuỳ chọn) | Số user online, dung lượng file, trạng thái lần sao lưu gần nhất |

## 8. Triển khai và vận hành

- Docker Compose với 4 container; dữ liệu trong volume đặt tên `pgdata`, `uploads`.
- **HTTPS:** Caddy tự cấp chứng chỉ nếu có tên miền công khai. Trong WAN nội bộ dùng CA nội bộ của Caddy; kèm hướng dẫn cài chứng chỉ gốc lên máy chi nhánh. Không có HTTPS thì trình duyệt chặn thông báo và một số API.
- **Điểm lỗi duy nhất:** một server. Giảm rủi ro bằng UPS và `restart: unless-stopped`.
- **Sao lưu:** job chạy hằng đêm gồm `pg_dump` nén và đồng bộ thư mục `uploads`, ghi sang ổ hoặc máy khác, giữ 14 bản gần nhất. Có script khôi phục và hướng dẫn. Phải thử khôi phục thật ít nhất một lần.

## 9. Bảo mật hiển thị

- Không render HTML thô trong tin nhắn (chống XSS).
- Chặn upload file thực thi; trả file với header `Content-Disposition` và `X-Content-Type-Options: nosniff`.
- Cookie refresh token `httpOnly`, `Secure`, `SameSite`.
- Giới hạn tần suất gửi tin trên WebSocket để tránh spam.

## 10. Kiểm thử

- **Backend (pytest):** quyền truy cập phòng (user không phải thành viên bị từ chối cả REST và WebSocket), phân trang, idempotency của `client_id`, đồng bộ sau khi mất kết nối, admin không đọc được tin chat riêng, tài khoản bị khoá bị ngắt kết nối.
- **Frontend:** test component cho danh sách tin nhắn, số chưa đọc, reconnect, giữ vị trí cuộn.
- **End-to-end:** hai người dùng ở hai chi nhánh gửi nhận qua WebSocket.
- **Thử tải:** 50 kết nối đồng thời, một phòng có 100.000 tin; đo thời gian tải trang đầu và đặt ngưỡng chấp nhận (ngưỡng cụ thể chốt trong kế hoạch triển khai).

## 11. Giao diện (bản thiết kế)

Bản thiết kế giao diện nằm tại https://claude.ai/artifact/PjVzNP8trfff76VHVtLGrb (canvas riêng tư, 5 màn hình). Đây là bản tham chiếu tĩnh để dựng React, không phải mã sản phẩm.

| Màn hình | Ghi chú cho việc dựng |
|---|---|
| Chat chính | 3 cột: danh sách phòng, hội thoại, thành viên và tệp gần đây. Có reply, @mention, tệp đính kèm, "đã xem", "đang soạn tin", nút "N tin mới" |
| Đăng nhập | Không có tự đăng ký; ghi chú liên hệ quản trị viên khi quên mật khẩu |
| Quản trị: Người dùng | 4 chỉ số tổng quan (tài khoản, online, dung lượng tệp, lần sao lưu gần nhất), bảng lọc theo chi nhánh/trạng thái, form tạo tài khoản với mật khẩu tạm |
| Quản trị: Chi nhánh | Thẻ từng chi nhánh (số người, số phòng, số online) và form sửa |
| Quản trị: Phòng và nhóm | Bảng nhóm, quản lý thành viên, dòng ghi "Quản trị viên không xem được nội dung tin nhắn" |

**Phong cách:** nền xám lạnh `#F2F4F7`, màu chủ đạo teal `#0B6E7F`, thanh điều hướng admin tối `#101828`, font Be Vietnam Pro (hiển thị tiếng Việt tốt). Chấm online xanh `#12B76A`, huy hiệu chưa đọc đỏ `#D92D20`. Mọi nút và vùng chạm cao tối thiểu 44px.

**Chưa có trong bản thiết kế, cần bổ sung khi dựng:**
- Màn hình đổi mật khẩu bắt buộc ở lần đăng nhập đầu.
- Trạng thái rỗng (chưa có phòng, chưa có tin nhắn, kết quả tìm kiếm trống) và trạng thái mất kết nối ("Đang kết nối lại…").
- Bố cục riêng cho điện thoại. Bản đầu ưu tiên desktop; các cột xếp chồng khi hẹp.
- Tên app "Kết Nối" và dữ liệu người, chi nhánh trong bản thiết kế chỉ là dữ liệu mẫu.

## 12. Các giai đoạn thực hiện

1. **Nền:** Docker Compose, DB, auth, admin tối giản (user, chi nhánh).
2. **Chat lõi:** phòng, gửi nhận realtime, phân trang theo cuộn, reconnect.
3. **Trải nghiệm:** đã xem, typing, presence, reply, mention, thông báo.
4. **File và tìm kiếm.**
5. **Vận hành:** sao lưu, HTTPS nội bộ, healthcheck, thử tải, tài liệu triển khai.

Mỗi giai đoạn chạy được và kiểm thử được độc lập.
