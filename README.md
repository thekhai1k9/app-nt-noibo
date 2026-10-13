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

## Giao diện chat

**Bố cục.** Cột trái là danh sách cuộc trò chuyện (nhóm và nhắn riêng, xếp theo hoạt động mới nhất, kèm tin cuối và số chưa đọc), ô "Lọc theo tên" và nút **"+ Mới"** để tìm đồng nghiệp theo tên hoặc tên đăng nhập rồi nhắn riêng. Chân cột trái có lời chào, "Quản trị" (chỉ admin), "Đổi mật khẩu", "Đăng xuất". Cột phải là hội thoại đang mở với ô soạn tin ở dưới (Enter để gửi, Shift+Enter xuống dòng; Enter của bộ gõ tiếng Việt khi đang soạn chữ không gửi tin). Trên điện thoại (màn hình hẹp) chỉ hiện một trong hai: danh sách, hoặc hội thoại có nút "←" (Về danh sách).

**Hành vi.**
- Tin vừa gửi hiện ngay với trạng thái "Đang gửi…". Mất mạng thì tin chờ gửi và tự gửi lại khi kết nối có lại (mỗi tin có `client_id` nên không bao giờ bị lưu hai lần); quá 15 giây chưa gửi được thì hiện "Gửi lỗi" với nút "Thử lại"/"Bỏ". Trong lúc mất kết nối có dải "Đang kết nối lại…"; khi nối lại, tin bị lỡ được tải bù.
- Số chưa đọc cập nhật trực tiếp, không cần tải lại trang; mở phòng thì được đánh dấu đã đọc. Nhóm mới, thành viên thay đổi hay phòng nhắn riêng mới hiện ra ngay (sự kiện `rooms_changed`).
- Mở phòng thì nhảy tới tin mới nhất; cuộn lên đầu để tải thêm tin cũ (vị trí đang đọc giữ nguyên). Đang đọc tin cũ mà có tin mới thì hiện nút "↓ N tin mới" thay vì kéo xuống.
- Sửa ("(đã sửa)") và xoá ("Tin nhắn đã bị xoá", nội dung bị bỏ với mọi người) được với tin của chính mình.
- Tin nhắn chỉ là văn bản thuần: không hiển thị HTML; chỉ địa chỉ `http://` và `https://` được tự nhận thành liên kết (mở tab mới, `rel="noopener noreferrer nofollow"`).
- **Đã xem:** chỉ hiện dưới **tin cuối cùng của chính mình** trong phòng (không hiện trên mọi tin, không hiện cho tin đã xoá). Chat 1-1: "Đã xem" khi người kia đã đọc tới tin đó. Nhóm: "Đã xem bởi N người" (N chỉ tính người khác mình; rê chuột để thấy tên). Nhãn cập nhật tức thì khi người khác mở phòng, và được tải lại đúng sau khi mất kết nối rồi nối lại.
- **Đang soạn tin:** dòng "<Tên> đang soạn tin…" ngay trên ô soạn khi người khác trong phòng đang gõ (hai người: "A và B đang soạn tin…", nhiều hơn: "Nhiều người đang soạn tin…"). Dòng tự mất 5 giây sau tín hiệu cuối, hoặc ngay khi người đó gửi tin. Trình duyệt báo "đang soạn" tối đa 1 lần/3 giây mỗi phòng và không báo khi ô soạn trống; không bao giờ hiện chính mình.
- **Online:** chấm xanh ở ảnh đại diện của phòng 1-1 và dòng "Đang hoạt động" ở đầu hội thoại 1-1 khi người kia đang mở ứng dụng (ít nhất một tab). Đóng tab cuối cùng thì chấm mất ngay; tab/máy bị treo hoặc mất mạng thì chấm mất sau khoảng 45-60 giây (`PRESENCE_TTL_SECONDS` + một chu kỳ quét). **Quyền riêng tư:** chỉ thấy trạng thái online của người **chung ít nhất một phòng chưa lưu trữ** với mình; không có danh sách online toàn công ty, admin cũng không được thấy thêm. Không có "lần cuối online".

**Trang admin "Phòng và nhóm"** (`/admin/rooms`): tìm và lọc nhóm theo chi nhánh; tạo nhóm (tên, chi nhánh hoặc liên chi nhánh, chọn thành viên); đổi tên; thêm, gỡ thành viên. Admin không xem được nội dung tin nhắn. **"Xoá" nhóm là lưu trữ**: phải gõ lại đúng tên nhóm để xác nhận; nhóm biến mất ngay với mọi thành viên nhưng được giữ (mặc định 3 ngày) ở tab "Đã lưu trữ" (kèm thời điểm xoá) và có thể **"Khôi phục"** nguyên vẹn cùng tin nhắn trong thời gian đó; hết hạn thì tự động bị **xoá vĩnh viễn cùng toàn bộ tin nhắn**. Số ngày giữ đặt bằng `ROOM_ARCHIVE_RETENTION_DAYS` (mặc định 3), chu kỳ dọn bằng `ROOM_PURGE_INTERVAL_SECONDS` (xem `.env.example`).

### Kiểm tra trên trình duyệt thật: `scripts/e2e_chat_ui.mjs`

**Chỉ chạy trên stack thử nghiệm**: script tạo người dùng và nhóm, đổi mật khẩu admin, khoá một tài khoản. Nó điều khiển Chromium qua Playwright với hai người dùng song song và kiểm: gửi/nhận tức thì, chưa đọc, nhắn riêng mới, mất mạng rồi nối lại (bù tin, không trùng), gửi khi mất mạng, sửa/xoá, cuộn (đúng đáy khi mở, giữ vị trí khi tải tin cũ, "↓ N tin mới"), an toàn liên kết/HTML, token không nằm trong storage hay URL, giao diện điện thoại 390px, lưu trữ và khôi phục nhóm, online (đóng/mở trang, hai tab đóng một), "đang soạn tin" (hiện, tự hết hạn, mất khi gửi), "đã xem" (1-1 và "Đã xem bởi N người" trong nhóm), trạng thái đúng sau khi mất mạng rồi nối lại, quyền riêng tư của online (`GET /presence` không lộ người không chung phòng), khoá tài khoản, không có lỗi JavaScript.

Playwright được cài **ngoài repo** (một lần):

```bash
mkdir /tmp/kn-e2e && cd /tmp/kn-e2e && npm init -y && npm i playwright@1.49.1 && npx playwright install chromium
```

Chạy (từ thư mục gốc repo, Node 22+, stack đã `docker compose up -d --build` và có admin mới tạo bằng `create-admin`):

```bash
PLAYWRIGHT_DIR=/tmp/kn-e2e BASE_URL=http://localhost ADMIN_USER=ui.admin ADMIN_TEMP_PASSWORD=<mật khẩu tạm> \
  node scripts/e2e_chat_ui.mjs
```

Mật khẩu mới của admin do script sinh ngẫu nhiên và in ra một lần ở đầu; chạy lại trên cùng stack **bắt buộc** đặt `E2E_ADMIN_NEW_PASSWORD=<mật khẩu đã in>` (hoặc tự đặt giá trị ngay từ lần đầu).

Ghi chú: script từ chối `BASE_URL` không phải localhost trừ khi đặt `E2E_ALLOW_REMOTE=1`. `context.setOffline` của Chromium không ngắt WebSocket, nên script đưa WebSocket qua proxy của Playwright (`routeWebSocket`) và tự cắt kết nối để mô phỏng mất mạng.

Script in `PASS`/`FAIL` cho từng bước, tổng kết `N/M đạt` và thoát mã 1 nếu có bước hỏng. Tuỳ chọn: `SHOT_DIR=<thư mục>` để lưu ảnh chụp các trang khi một bước hỏng, `HEADED=1` để xem trình duyệt chạy. Tên người dùng và nhóm có hậu tố ngẫu nhiên nên chạy lại được trên cùng stack (admin đã đổi mật khẩu ở lần chạy trước chỉ dùng lại được khi đặt `E2E_ADMIN_NEW_PASSWORD` đúng giá trị đã in).

## API chat (tóm tắt)

Tất cả dưới `/api`, cần `Authorization: Bearer <access token>` và đã đổi mật khẩu lần đầu.

| Việc | Endpoint |
|---|---|
| Tìm đồng nghiệp để nhắn riêng | `GET /users/directory?q=` |
| Danh sách phòng của tôi (kèm tin cuối, số chưa đọc) | `GET /rooms` |
| Mở chat 1-1 | `POST /rooms/direct` `{"user_id": 3}` |
| Lịch sử tin nhắn (con trỏ) | `GET /rooms/{id}/messages?before=&after=&around=&limit=` |
| Đánh dấu đã đọc (phát `read` cho cả phòng khi mốc tăng) | `POST /rooms/{id}/read` `{"message_id": 10}` |
| Thành viên và mốc đã đọc của từng người | `GET /rooms/{id}/members` → `[{"user_id", "full_name", "last_read_message_id" (hoặc null)}]`, sắp theo tên; không phải thành viên hoặc phòng đã lưu trữ → `404 room_not_found` |
| Ai đang online (chỉ người chung phòng với tôi, không gồm chính tôi) | `GET /presence` → `{"online_user_ids": [3, 7]}` |
| Sửa / xoá tin của mình | `PATCH` / `DELETE /messages/{id}` |
| Admin quản lý nhóm | `/admin/rooms` (tạo, đổi tên, thêm/bớt thành viên, lưu trữ = xoá; `?archived=true` xem nhóm đã lưu trữ; `POST /admin/rooms/{id}/restore` khôi phục) |

### Phân trang tin nhắn

`GET /rooms/{id}/messages` nhận tối đa **một** trong `before`, `after`, `around` (nhiều hơn một: `400 invalid_cursor`), cùng `limit` từ 1 đến 100 (mặc định 50). Các tham số `before`/`after`/`around` phải ≥ 1; muốn "từ đầu" thì **bỏ tham số** thay vì gửi `0` (server trả 422). Mọi id phải là số nguyên dương trong khoảng cột DB (phòng/người dùng/chi nhánh tới 2^31-1, tin nhắn tới 2^63-1); ngoài khoảng là `422`.

- Không tham số: trang mới nhất. `before=<id>`: các tin cũ hơn id đó. `after=<id>`: các tin mới hơn id đó (cũ nhất trước). `around=<id>`: tin đó ở giữa cùng tin cũ và mới hơn (`404 message_not_found` nếu không thuộc phòng).
- `items` luôn sắp xếp **tăng dần** theo id.
- `has_more_before` có nghĩa với trang mặc định và `before`; `has_more_after` có nghĩa với `after`; với `around` cả hai đều có nghĩa. Trường còn lại luôn là `false`.

### WebSocket `/api/ws`

Mở kết nối rồi gửi ngay `{"type":"auth","token":"<access token>"}` (trong 5 giây). Sau khi nhận `{"type":"ready","user_id":1}`, gửi tin bằng `{"type":"send","room_id":1,"body":"...","client_id":"<uuid>"}` (`client_id` tối đa 64 ký tự, gửi lại cùng `client_id` là idempotent). Ping: `{"type":"ping"}` trả `{"type":"pong"}`. Server đẩy xuống: `message`, `message_updated`, `message_deleted`, `rooms_changed`, `resync`, `typing`, `read`, `presence`, `error` (`{"type":"error","code":"...","client_id":...}`).

**Đã xem, đang soạn tin, online**

| Hướng | Frame | Ghi chú |
|---|---|---|
| Client → server | `{"type":"typing","room_id":1}` | Báo đang gõ. Server giới hạn 1 frame/`WS_TYPING_INTERVAL_SECONDS` (mặc định 2 giây) mỗi phòng mỗi kết nối; vượt giới hạn hoặc phòng không phải của mình thì **bỏ qua im lặng** (không báo lỗi, tránh lộ phòng nào tồn tại); `room_id` sai kiểu/khoảng → `invalid_message`. Không tính vào giới hạn 20 tin/10 giây. |
| Server → client | `{"type":"typing","room_id":1,"user_id":3,"user_name":"Trần Quốc Huy"}` | Phát cho mọi kết nối trong phòng (kể cả các tab của chính người gõ: client tự bỏ qua `user_id` của mình). `user_id`/`user_name` lấy từ kết nối đã xác thực, không tin dữ liệu client gửi. Không lưu ở server: client tự cho hết hạn sau 5 giây và xoá ngay khi nhận `message` của người đó. |
| Server → client | `{"type":"read","room_id":1,"user_id":3,"message_id":42}` | Sau `POST /rooms/{id}/read`, **chỉ khi mốc đã đọc thực sự tăng**. Tới cả các tab khác của chính người đọc (đồng bộ số chưa đọc giữa các tab). |
| Server → client | `{"type":"presence","user_id":3,"online":true}` | Khi một người chuyển online/offline; chỉ tới những người chung phòng với họ. Online = còn ít nhất một kết nối WebSocket chưa hết hạn. |

`typing`/`read` không bao giờ được gửi cho người không thuộc phòng (kể cả người vừa bị gỡ hoặc phòng đã lưu trữ). Redis lỗi không làm hỏng gửi/nhận tin: các tín hiệu này chỉ bị bỏ và ghi log.

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
- Cũng sau mỗi `ready`/`resync`: tải lại `GET /presence` và `GET /rooms/{id}/members` của phòng đang mở, vì các sự kiện `presence`/`read` trong lúc mất kết nối đã bị lỡ. `typing` không cần bù (tự hết hạn).
- Nhận `rooms_changed` (được thêm/gỡ khỏi phòng, đổi tên nhóm, phòng bị xoá): tải lại `GET /rooms` (và `GET /presence`, vì phòng chung mới có thể thêm người được thấy online).
- Server cũng tự đối soát định kỳ (`WS_RECONCILE_SECONDS`, mặc định 30 giây) và đóng kết nối của tài khoản đã khoá hoặc phải đổi mật khẩu, nên client phải xử lý 4401/4403 bất cứ lúc nào.

**Xoá nhóm = lưu trữ (mặc định 3 ngày) rồi xoá vĩnh viễn**: `DELETE /admin/rooms/{id}` (204) không xoá dữ liệu mà đặt `archived_at`. Nhóm đã lưu trữ biến mất với mọi người dùng thường (danh sách phòng, tin nhắn, gửi/sửa/xoá/đánh dấu đã đọc đều trả `404 room_not_found`, WebSocket không còn nhận tin của nhóm) và các thành viên nhận `rooms_changed`. Admin xem được bằng `GET /admin/rooms?archived=true` (mỗi nhóm có `archived_at` và `purge_at`), xem chi tiết bằng `GET /admin/rooms/{id}`, khôi phục bằng `POST /admin/rooms/{id}/restore` (thành viên thấy lại đủ tin nhắn và số chưa đọc cũ); đổi tên, thêm/gỡ thành viên trên nhóm đã lưu trữ trả `404 room_not_found`. Tiến trình nền (chạy lúc khởi động rồi mỗi `ROOM_PURGE_INTERVAL_SECONDS` giây, mặc định 3600) xoá vĩnh viễn nhóm đã lưu trữ quá `ROOM_ARCHIVE_RETENTION_DAYS` ngày (mặc định 3) cùng toàn bộ tin nhắn. Phòng chat 1-1 không bị ảnh hưởng. Lưu ý: bản sao lưu DB vẫn chứa dữ liệu đã xoá vĩnh viễn cho tới khi hết hạn theo chính sách sao lưu (Plan 7). Giao diện admin vẫn phải xác nhận trước khi lưu trữ.

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

## Cấu hình thời gian thực (tuỳ chọn, xem `.env.example`)

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PRESENCE_TTL_SECONDS` | 45 | Một kết nối được coi là còn online bấy nhiêu giây sau lần gia hạn cuối (kết nối/worker chết mà không kịp gỡ sẽ tự hết hạn). Phải lớn hơn `PRESENCE_SWEEP_SECONDS`. |
| `PRESENCE_SWEEP_SECONDS` | 15 | Chu kỳ mỗi worker gia hạn các kết nối đang mở của mình và đối soát người vừa online/offline. Ngắt kết nối bình thường được gỡ ngay, không chờ chu kỳ này. |
| `PRESENCE_ANNOUNCE_TIMEOUT_SECONDS` | 10 | Thời gian tối đa cho một lượt phát thông báo `presence` của một người. |
| `WS_TYPING_INTERVAL_SECONDS` | 2 | Khoảng tối thiểu giữa hai sự kiện `typing` của một kết nối trong cùng một phòng. |

## Cấu hình môi trường: `APP_ENV` và `COOKIE_SECURE`

Hai biến này độc lập với nhau.

- `APP_ENV` (`dev` | `test` | `prod`, mặc định trong `.env.example` là `prod`). Ở `prod`, api từ chối khởi động nếu `JWT_SECRET` là giá trị mẫu hoặc ngắn hơn 32 ký tự (xem `docker compose logs api`), và `/api/docs` bị tắt. Đặt `dev` khi phát triển cục bộ. Giá trị khác ba giá trị trên bị từ chối.
- Phải đặt `JWT_SECRET` thật (`openssl rand -hex 32`) trước lần khởi động đầu tiên. Giá trị mẫu trong `.env.example` cố ý bị từ chối ở `prod` để quên đổi thì lỗi ngay.
- `COOKIE_SECURE` điều khiển cờ `Secure` của cookie đăng nhập, không phụ thuộc `APP_ENV`. Khi chưa có HTTPS, Caddy chỉ nghe cổng 80 (HTTP), nên giữ `COOKIE_SECURE=false`, nếu không trình duyệt sẽ không lưu cookie. Khi bật HTTPS, đổi thành `COOKIE_SECURE=true`.
