# Plan 7: File đính kèm, tìm kiếm tin nhắn và nhảy tới tin ở xa Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Người dùng gửi được ảnh và tệp (kéo thả, dán ảnh, chọn tệp) trong mọi phòng, xem ảnh ngay trong khung chat, tải tệp về; tìm tin nhắn (cả tên tệp) theo tiếng Việt không dấu trong các phòng mình tham gia; bấm kết quả tìm kiếm hoặc bấm trích dẫn của một tin trả lời để **nhảy tới đúng tin ở xa** rồi quay về tin mới nhất khi muốn.

**Architecture:** Tệp lưu trên đĩa (volume `uploads`) với tên uuid; chỉ API phục vụ tệp (kiểm tra quyền thành viên mỗi lượt, `nosniff`, `Content-Disposition`); ảnh raster hợp lệ được tạo ảnh thu nhỏ bằng Pillow. Mỗi tệp là một tin `kind='file'` có bản ghi `attachments`, đi qua đúng luồng `message` hiện có. Tìm kiếm dùng cột `tsvector` sinh tự động (cấu hình `simple` + hàm `unaccent` bọc IMMUTABLE) với chỉ mục GIN, lọc theo phòng người dùng là thành viên. Frontend thêm "cửa sổ nhảy" (chế độ xem tin ở xa, có nút quay về tin mới nhất) vào store/controller, ô tìm kiếm toàn cục, và tải tệp/ảnh bằng `fetch` có header xác thực (thẻ `<img>` không gửi được header) rồi hiện qua blob URL.

**Tech Stack:** FastAPI + SQLAlchemy async + Alembic + PostgreSQL (`unaccent`) + Pillow + python-multipart; React 18 + TypeScript + Vitest; Caddy.

**Spec:** `docs/superpowers/specs/2026-10-12-internal-messaging-design.md` (mục 3 bảng `attachments`/`tsvector`, mục 5 REST file + search, mục 6 `around`, mục 8-9 bảo mật tệp, mục 11 giao diện). Plan này hoàn thành giai đoạn "File và tìm kiếm".

## Quyết định thiết kế đã chốt cho plan này (chủ dự án có thể đổi)

- **Giới hạn tệp:** tối đa **25 MB** mỗi tệp (`MAX_UPLOAD_MB`, mặc định 25); **một tệp cho mỗi tin**; chọn nhiều tệp cùng lúc thì gửi lần lượt (tối đa 5 tệp một lượt, mỗi tệp một tin). Chú thích (caption) tuỳ chọn, tối đa 4000 ký tự như tin thường. Không có hạn mức tổng dung lượng ở bản này (quản trị xem dung lượng ở Plan 8).
- **Loại tệp:** chặn tệp thực thi/script theo **phần mở rộng** (danh sách đen: `exe msi bat cmd com scr pif ps1 psm1 vbs vbe js jse jar sh bash app apk dmg dll sys lnk reg hta wsf cpl`) **và** theo **chữ ký nội dung** (đầu tệp là `MZ`, `\x7fELF`, `#!`, Mach-O). Không quét virus (ngoài phạm vi, theo spec). Tên có nhiều đuôi (`a.pdf.exe`) bị chặn theo đuôi cuối; tên không có đuôi được chấp nhận nếu nội dung không phải thực thi.
- **Ảnh:** chỉ JPEG, PNG, GIF, WebP (kiểm tra bằng Pillow, không tin `Content-Type` của client) được hiện trực tiếp trong khung chat với ảnh thu nhỏ (cạnh dài tối đa 480 px, JPEG/WebP chất lượng 80; GIF động chỉ lấy khung đầu cho ảnh thu nhỏ, bấm vào xem bản gốc). Giới hạn 40 megapixel và chống "decompression bomb". **SVG và mọi loại khác chỉ tải về**, không bao giờ hiện inline.
- **Phục vụ tệp:** chỉ qua `GET /api/files/{id}` (và `?thumb=1`); luôn kiểm tra thành viên phòng chưa lưu trữ và tin chưa bị xoá; header `X-Content-Type-Options: nosniff`, `Cache-Control: private, max-age=3600`, `Content-Disposition: inline` chỉ cho 4 loại ảnh trên, còn lại `attachment`; tên tệp gốc đi trong `filename*=UTF-8''…` đã mã hoá, không tin tên từ client (làm sạch, tối đa 120 ký tự, bỏ ký tự điều khiển/bidi/đường dẫn).
- **Vòng đời tệp:** tin có tệp bị xoá mềm ⇒ tệp không tải được nữa (404) nhưng giữ trên đĩa; tệp bị xoá vật lý **cùng lúc** phòng bị xoá vĩnh viễn (tác vụ dọn nhóm lưu trữ quá hạn) và có tác vụ dọn tệp mồ côi (tải lên nhưng chưa thành tin sau 1 giờ).
- **Tìm kiếm:** tiếng Việt không dấu và không phân biệt hoa thường ("nguyen" khớp "Nguyễn", "duc" khớp "Đức"); các từ khoá nối bằng AND, từ cuối khớp theo tiền tố ("nguy" khớp "nguyen"); chỉ tìm trong **phòng chưa lưu trữ mà mình là thành viên**; tìm cả **tên tệp** và chú thích; bỏ tin đã xoá; kết quả mới nhất trước, 30 kết quả mỗi trang, phân trang bằng `before=<id>`; có thể lọc theo một phòng. Giới hạn 30 lần tìm/phút/người.
- **Nhảy tới tin ở xa:** tải một "cửa sổ" quanh tin đó (`around`, 50 tin); thread chuyển sang chế độ **xem tin cũ** (hiện thanh "Đang xem tin cũ · Quay về tin mới nhất"); trong chế độ này tin mới đến **không** chen vào giữa mà chỉ tăng bộ đếm trên nút quay về; cuộn xuống dưới cửa sổ thì tải tiếp (`after`); gửi tin hoặc bấm "Quay về tin mới nhất" thì tải lại trang mới nhất như bình thường.
- **Không làm:** quét virus, chia sẻ tệp nhiều tệp trong một tin, xem trước PDF/Office, cột "thành viên và tệp gần đây" cố định bên phải (thay bằng nút "Tệp & ảnh" mở bảng liệt kê), tìm theo nội dung bên trong tệp, hạn mức dung lượng, xoá tin tự động.

## Global Constraints

- Mọi giao diện bằng tiếng Việt; nút/vùng bấm tối thiểu 44px; hộp thoại theo mẫu `NewChatDialog` (role=dialog, bẫy focus, Esc, trả focus); tên tệp, tên người, đoạn trích luôn là text thuần.
- Backend test chỉ qua `bash scripts/test.sh <args>`; frontend `npm test`, `npm run typecheck`, `npm run build` trong `frontend/`. Test không dùng mạng ngoài; thư mục tải lên trong test là thư mục tạm, được xoá sau mỗi test.
- Hợp đồng REST mới (tiền tố `/api`, cần `get_ready_user`):
  - `POST /rooms/{id}/files` (`multipart/form-data`: `file` bắt buộc; `body` caption tuỳ chọn; `client_id` tuỳ chọn ≤64 ký tự; `reply_to_id` tuỳ chọn) → 201 `MessageOut` (có `attachment`). Lưu **streaming** (không nạp cả tệp vào bộ nhớ), đếm byte khi ghi và dừng ngay khi vượt giới hạn → 413 `file_too_large`; loại bị chặn → 415 `file_type_not_allowed`; tệp rỗng → 400 `empty_file`; không phải thành viên/phòng lưu trữ → 404 `room_not_found`; vượt tốc độ (20 tệp/phút/người, `UPLOAD_PER_MINUTE`) → 429 `rate_limited`; gửi lặp cùng `client_id` trả lại tin đã tạo (không lưu tệp thứ hai). Sau khi tạo tin, phát sự kiện WebSocket `message` như tin thường.
  - `GET /files/{attachment_id}` và `GET /files/{attachment_id}?thumb=1` → tệp (hoặc ảnh thu nhỏ; không có ảnh thu nhỏ ⇒ 404 `thumbnail_not_found`); header như "Phục vụ tệp" ở trên; người không có quyền, tin đã xoá, id không tồn tại: **cùng một** 404 `file_not_found` (không phân biệt).
  - `GET /rooms/{id}/files?before=<attachment_id>&limit=30&kind=image|file|all` → `{items:[{attachment, message_id, sender_id, sender_name, created_at}], has_more}` (mới nhất trước, chỉ tin chưa xoá), thành viên mới xem được.
  - `GET /search?q=&room_id=&before=&limit=30` → `{items:[{message: MessageOut, room_id, room_name}], has_more}`; `q` rỗng/chỉ ký tự đặc biệt ⇒ 422 `invalid_query`; `q` tối đa 100 ký tự và tối đa 8 từ khoá; vượt tốc độ ⇒ 429 `rate_limited`.
  - `MessageOut.attachment: {id, name, mime, size, is_image, width, height, has_thumb} | null`.
  - `GET /rooms/{id}/messages?around=<id>` đã có từ Plan 3: giữ nguyên hợp đồng (trang quanh tin, `has_more_before/after`).
  - Mã lỗi mới và thông báo tiếng Việt: `file_too_large` ("Tệp quá lớn (tối đa 25 MB)."), `file_type_not_allowed` ("Loại tệp này không được phép gửi."), `empty_file` ("Tệp trống."), `file_not_found` ("Không tìm thấy tệp."), `thumbnail_not_found`, `invalid_query` ("Nhập từ khoá để tìm."), `upload_failed` (lỗi mạng khi tải lên).
- Cấu hình mới (trong `.env.example` + README): `UPLOAD_DIR` (mặc định `/data/uploads`), `MAX_UPLOAD_MB=25`, `UPLOAD_PER_MINUTE=20`, `SEARCH_PER_MINUTE=30`, `ORPHAN_UPLOAD_MINUTES=60`.
- Caddy giới hạn thân yêu cầu `/api/rooms/*/files` ở 26 MB (`request_body { max_size 26MB }`), các đường dẫn khác giữ mặc định hiện tại; `docker-compose.yml` thêm volume `uploads` gắn vào `api:/data/uploads`; `requirements.txt` thêm `Pillow`, `python-multipart` (ghim phiên bản).
- Không ghi tên tệp/nội dung tin vào log; đường dẫn tệp trên đĩa không bao giờ xuất hiện trong phản hồi.

## Review Focus

- Người không phải thành viên, thành viên đã bị gỡ, phòng đã lưu trữ, tin đã xoá: **không** tải được tệp/ảnh thu nhỏ, không thấy trong "Tệp & ảnh", không thấy trong kết quả tìm kiếm; thông báo lỗi không phân biệt "không tồn tại" với "không có quyền" (Task 1, 2, 3).
- Tệp độc hại: `.exe` đổi đuôi, `a.pdf.exe`, chữ ký ELF/MZ/shebang dưới đuôi vô hại, SVG có script, HTML đổi tên thành `.png`, ảnh giả (nội dung không phải ảnh), ảnh "bom" giải nén, tên tệp có `../`, `\`, NUL, bidi, tên quá dài; tệp phục vụ không bao giờ thực thi trong trình duyệt (`nosniff`, `attachment`), không tạo XSS (Task 1).
- Giới hạn kích thước thực sự cắt luồng (không nạp hết vào RAM, không để lại tệp dở trên đĩa khi lỗi/ngắt kết nối), tải đồng thời nhiều tệp không làm cạn bộ nhớ (Task 1).
- Dọn dẹp: xoá nhóm vĩnh viễn xoá tệp trên đĩa; tệp mồ côi bị dọn; không có đường nào để lại bản ghi trỏ vào tệp đã mất mà gây 500 (Task 2).
- Tìm kiếm không dấu/đ/hoa-thường, tiền tố, nhiều từ khoá, ký tự đặc biệt không phá `tsquery` (không lỗi 500, không chèn toán tử), chỉ phòng của mình, không lộ tin phòng khác kể cả qua `room_id` lọc; hiệu năng dùng chỉ mục GIN trên bảng lớn (Task 4).
- Cửa sổ nhảy: tin đến lúc đang xem tin cũ không chen vào giữa, không mất tin khi quay về, không phá luồng bù tin/đọc/chưa đọc của Plan 4-6; gửi tin hoặc mở lại phòng luôn trả về trạng thái bình thường; bấm kết quả tìm kiếm của phòng khác điều hướng đúng (Task 5, 6).
- Giao diện tải tệp: thanh tiến trình, huỷ, lỗi (quá lớn/loại bị chặn/mất mạng) rõ ràng; gửi tin có tệp khi đang offline không biến thành "đã gửi" giả; blob URL được thu hồi, không rò bộ nhớ; ảnh/tệp của người khác tải bằng `fetch` có xác thực (Task 7, 8).

---

## File Structure

```
backend/
├── alembic/versions/0005_attachments.py          # attachments, messages.attachment_name
├── alembic/versions/0006_search.py               # unaccent, f_unaccent, search_vector (generated) + GIN
├── app/models.py                                 # Attachment, Message.attachment_name
├── app/config.py, .env.example                   # cấu hình mới
├── app/chat/files.py                             # (mới) lưu streaming, kiểm tra loại, ảnh thu nhỏ, dọn dẹp
├── app/chat/search.py                            # (mới) dựng tsquery an toàn, truy vấn tìm kiếm
├── app/chat/service.py, schemas.py               # send_file_message, MessageOut.attachment, last_message
├── app/chat/retention.py                         # xoá tệp khi xoá vĩnh viễn phòng; dọn tệp mồ côi
├── app/routers/files.py                          # (mới) upload, download, danh sách tệp phòng
├── app/routers/search.py                         # (mới) /search
├── app/main.py                                   # đăng ký router, tác vụ dọn
├── requirements.txt, Dockerfile                  # Pillow, python-multipart
├── tests/test_files.py, test_search.py           # (mới)
docker-compose.yml, Caddyfile
frontend/src/
├── lib/types.ts, chatApi.ts, errors.ts           # Attachment, SearchHit, upload/search API
├── lib/fileCache.ts                              # (mới) fetch có xác thực → blob URL, LRU, thu hồi
├── lib/upload.ts                                 # (mới) XHR có tiến trình, huỷ, kiểm tra phía client
├── lib/chatStore.ts, chatController.ts           # cửa sổ nhảy (jumpTo, loadNewer, backToLatest), upload
├── components/chat/                              # AttachButton/UploadTray, AttachmentView, ImageLightbox, FilesPanel, SearchPanel, JumpBar; sửa Composer, MessageItem, MessageList, ConversationPane, RoomSidebar, QuoteBlock
scripts/e2e_chat_ui.mjs, README.md
```

---

### Task 1: Backend — tải lên, kiểm tra, lưu và phục vụ tệp

**Files:** Create `backend/alembic/versions/0005_attachments.py`, `backend/app/chat/files.py`, `backend/app/routers/files.py`, `backend/tests/test_files.py`; Modify `backend/app/models.py`, `backend/app/config.py`, `backend/app/chat/service.py`, `backend/app/chat/schemas.py`, `backend/app/main.py`, `backend/requirements.txt`, `.env.example`, `docker-compose.yml`, `Caddyfile`, `backend/Dockerfile` (nếu cần thư viện), các test hiện có so khớp chính xác dict `MessageOut`.

**Interfaces:**
- Consumes: `service.send_message` (cơ chế `client_id`, `reply_to_id`, membership lock, `publish_room_safely`), `limits`/`register_attempt` (giới hạn tốc độ), `load_message_extras`, `require_member`, `get_ready_user`, `get_bus`.
- Produces:
  - Migration `0005`: bảng `attachments(id BIGSERIAL PK, message_id BIGINT UNIQUE NOT NULL REFERENCES messages(id) ON DELETE CASCADE, room_id INT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, storage_key VARCHAR(80) NOT NULL UNIQUE, name VARCHAR(255) NOT NULL, mime VARCHAR(100) NOT NULL, size BIGINT NOT NULL, is_image BOOLEAN NOT NULL DEFAULT false, width INT NULL, height INT NULL, thumb_key VARCHAR(80) NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())` + chỉ mục `(room_id, id DESC)`; cột `messages.attachment_name TEXT NULL` (để tìm theo tên tệp, dùng ở Task 4). Quy tắc: `message_id` chỉ có thể tạo qua `send_file_message` trong cùng giao dịch với tin.
  - `files.py`: `FileStore(base_dir)` với `new_key() -> str` (uuid4 hex + phân thư mục `ab/cd/…`), `path_for(key)` (chống `..`), `async save_stream(upload, max_bytes) -> SavedFile(key, size, sniff_head)` ghi theo từng khối 64 KiB vào tệp tạm cùng thư mục rồi `os.replace`; vượt giới hạn ⇒ xoá tệp tạm và ném `FileTooLarge`; `classify(name, head) -> Classification(mime, is_image, allowed, reason)` (danh sách đen đuôi + chữ ký thực thi + nhận diện ảnh bằng Pillow `Image.open().verify()` rồi mở lại để lấy kích thước; bom giải nén ⇒ không phải ảnh hợp lệ và bị từ chối nếu tên/đuôi là ảnh? — **ghi rõ quyết định**: tệp tự nhận là ảnh nhưng Pillow từ chối ⇒ coi là tệp thường, tải về dạng `attachment`, `application/octet-stream`), `make_thumbnail(path) -> (thumb_key, w, h)` (chạy trong `asyncio.to_thread`), `sanitize_filename(name) -> str`, `delete_keys(keys)`.
  - `service.send_file_message(session, user_id, room_id, saved, classification, name, caption, client_id, reply_to_id) -> (Message, sender_name, created)` dùng cùng khoá thành viên, kiểm tra `reply_to_id`, idempotent theo `client_id` (nếu tin đã có thì **xoá tệp vừa lưu** và trả tin cũ), `kind='file'`, `body=caption` (có thể rỗng), `attachment_name=name`.
  - `routers/files.py`: `POST /rooms/{id}/files`, `GET /files/{id}`, `GET /rooms/{id}/files` đúng hợp đồng ở trên; giới hạn tốc độ tải lên trước khi đọc thân (qua `limits`), fail-open khi Redis lỗi.
  - `MessageOut.attachment` ở **mọi** nơi dựng `MessageOut` (kể cả `last_message`, `message_updated`, `PATCH`); nạp bằng đúng **1 truy vấn thêm** cho cả trang trong `load_message_extras` (hằng số truy vấn theo trang vẫn đúng).

- [ ] **Step 1: Viết test thất bại (`backend/tests/test_files.py`)** (dùng fixture/helper như `test_chat_api.py`, `test_ws.py`, `test_reply_mentions.py`; thư mục tải lên là thư mục tạm qua cấu hình; tạo ảnh thật bằng Pillow trong test):
1. `test_upload_image_creates_file_message_with_thumbnail`: thành viên tải PNG 1000×800 ⇒ 201, `kind='file'`, `attachment.is_image=true`, `width/height` đúng, `has_thumb=true`; tệp gốc và ảnh thu nhỏ (≤480px cạnh dài) tồn tại trên đĩa với tên uuid (không chứa tên gốc); thành viên khác nhận sự kiện WebSocket `message` có `attachment`.
2. `test_upload_plain_file_and_download_headers`: PDF giả ⇒ tải về đúng byte; header `Content-Disposition: attachment; filename*=UTF-8''…` (tên có dấu cách/tiếng Việt mã hoá đúng), `X-Content-Type-Options: nosniff`, `Cache-Control: private`; ảnh hợp lệ ⇒ `inline`; `?thumb=1` trả ảnh thu nhỏ; tệp không phải ảnh + `?thumb=1` ⇒ 404 `thumbnail_not_found`.
3. `test_authorization_is_uniform_404`: người ngoài phòng, thành viên đã bị gỡ, phòng đã lưu trữ, tin đã xoá mềm, id không tồn tại ⇒ cùng 404 `file_not_found` (cùng body); upload vào phòng không phải thành viên/đã lưu trữ ⇒ 404 `room_not_found` và **không** để lại tệp trên đĩa.
4. `test_blocked_types`: `.exe`, `.bat`, `.ps1`, `.sh`, `.js`, `.jar` (hoa/thường, `.EXE`), `a.pdf.exe`, tệp tên `report.pdf` nhưng nội dung `MZ…`/`\x7fELF`/`#!/bin/sh`, `notes` (không đuôi) có chữ ký thực thi ⇒ 415 `file_type_not_allowed`, không tạo tin, không để lại tệp; `.txt`/`.pdf`/`.docx`/không đuôi hợp lệ ⇒ 201.
5. `test_fake_and_dangerous_images`: `evil.png` nội dung HTML/SVG ⇒ chấp nhận như tệp thường nhưng `is_image=false`, `attachment` tải về dạng `attachment` + `application/octet-stream`; `.svg` có `<script>` ⇒ tải về dạng `attachment`, không bao giờ `inline`; ảnh PNG header hợp lệ nhưng khai kích thước khổng lồ (bom giải nén, > giới hạn megapixel) ⇒ không tạo thumbnail, `is_image=false`, không treo/không tốn RAM quá mức (giới hạn bằng `Image.MAX_IMAGE_PIXELS`); ảnh hỏng nửa chừng ⇒ tệp thường.
6. `test_size_limit_streams_and_cleans_up`: `MAX_UPLOAD_MB=1` (qua env test): tệp 1,5 MB ⇒ 413 `file_too_large`, không còn tệp (kể cả tạm) trong thư mục tải lên, bộ nhớ không phình (kiểm tra số byte đọc: spy trên `save_stream` chỉ đọc ≤ giới hạn + một khối); tệp đúng bằng giới hạn ⇒ 201; tệp rỗng ⇒ 400 `empty_file`; ngắt kết nối giữa chừng (mô phỏng stream ném lỗi) ⇒ không để lại tệp tạm.
7. `test_filename_sanitising`: tên `../../etc/passwd`, `C:\x\y.txt`, tên chứa NUL, bidi `\u202e`, ký tự điều khiển, 300 ký tự, tên chỉ gồm dấu chấm/khoảng trắng ⇒ `attachment.name` đã làm sạch (không có dấu phân cách đường dẫn/ký tự điều khiển/bidi, ≤120 ký tự, không rỗng — rỗng thì dùng `tep`), đường dẫn lưu không phụ thuộc tên.
8. `test_idempotent_upload_with_client_id`: hai lần tải cùng `client_id` ⇒ cùng một tin, chỉ một tệp trên đĩa (tệp thứ hai bị xoá); `reply_to_id` hợp lệ/không hợp lệ (phòng khác, đã xoá) hoạt động như tin thường (`invalid_reply`, tệp không được lưu).
9. `test_upload_rate_limit`: `UPLOAD_PER_MINUTE=2` ⇒ lần thứ 3 ⇒ 429 `rate_limited` **trước khi đọc thân** (không tốn băng thông: kiểm tra không có tệp nào được tạo), Redis lỗi ⇒ cho qua.
10. `test_room_files_listing`: `GET /rooms/{id}/files` đúng thứ tự, phân trang `before`, `kind=image|file|all`, bỏ tin đã xoá, người ngoài ⇒ 404 `room_not_found`.
11. `test_message_out_constant_queries_with_attachments`: trang 50 tin trộn tin chữ/tin tệp: số truy vấn SQL không phụ thuộc số tin tệp.
12. `test_deleted_message_blocks_download_but_keeps_file_on_disk`: xoá mềm tin ⇒ tải về 404, tệp vẫn còn trên đĩa.
13. Migration up/down `0005` sạch (kèm `test_migrations`), chỉ mục tồn tại.

- [ ] **Step 2: Chạy để xác nhận thất bại:** `bash scripts/test.sh tests/test_files.py -q`
- [ ] **Step 3: Viết mã.** Lưu ý: `UploadFile` của Starlette đã spool vào tệp tạm khi vượt 1 MB, nhưng vẫn phải **đọc theo khối từ `file.read(64*1024)` và dừng khi vượt giới hạn** (đừng dựa vào `Content-Length`); kiểm tra loại **sau** khi có đủ phần đầu tệp (4 KiB) nhưng trước khi hoàn tất ghi; chạy Pillow trong `asyncio.to_thread`; mọi lỗi sau khi đã ghi tệp phải xoá tệp (try/finally); đọc `Content-Type` của client chỉ để tham khảo, không tin.
- [ ] **Step 4: Chạy toàn bộ hai lần liên tiếp:** `bash scripts/test.sh -q`
- [ ] **Step 5: Commit:** `feat: upload, validate, store and serve file attachments`

---

### Task 2: Backend — vòng đời tệp (xoá nhóm vĩnh viễn, tệp mồ côi)

**Files:** Modify `backend/app/chat/retention.py`, `backend/app/chat/files.py`, `backend/app/main.py`, `backend/app/config.py`; Extend `backend/tests/test_files.py` (hoặc `test_file_lifecycle.py`)

**Interfaces:**
- Consumes: Task 1; `retention.purge_archived_rooms`, `retention.run_purger` (lifespan).
- Produces:
  - `purge_archived_rooms` thu thập `storage_key`/`thumb_key` của mọi tệp thuộc các phòng sắp xoá **trước** khi xoá hàng trong DB, xoá hàng DB trong giao dịch, và **chỉ sau khi commit thành công** mới xoá tệp trên đĩa (lỗi xoá tệp chỉ ghi log, không làm hỏng lượt dọn; tệp còn sót sẽ bị dọn bởi bộ quét mồ côi).
  - `files.sweep_orphans(session_factory, store, older_than_minutes)`: liệt kê tệp trong thư mục tải lên có tuổi > ngưỡng mà **không có** bản ghi `attachments` (khoá chính hoặc thumb) ⇒ xoá; cũng xoá tệp tạm `*.part` quá tuổi; không bao giờ đụng tệp có bản ghi; chạy cùng chu kỳ với tác vụ dọn nhóm (`run_purger`) mỗi `room_purge_interval_seconds`, bọc lỗi như hiện có.
  - Cấu hình `orphan_upload_minutes: int = Field(60, gt=0)`.

- [ ] **Step 1: Viết test thất bại:** (1) phòng có 3 tin tệp (2 ảnh có thumbnail), lưu trữ quá hạn ⇒ `purge_archived_rooms` trả 1, hàng DB biến mất **và** 5 tệp trên đĩa bị xoá, tệp của phòng khác còn nguyên; (2) lỗi xoá một tệp (patch `os.remove` ném `PermissionError`) ⇒ phòng vẫn bị xoá khỏi DB, lượt dọn không dừng, tệp sót bị `sweep_orphans` dọn ở lượt sau; (3) giao dịch xoá DB thất bại (patch) ⇒ **không** xoá tệp nào; (4) `sweep_orphans`: tệp mồ côi cũ bị xoá, tệp mồ côi mới (< ngưỡng) giữ lại (kịp được gắn vào tin), tệp có bản ghi giữ lại dù cũ, tệp `.part` cũ bị xoá, thư mục rỗng được dọn, đường dẫn ngoài thư mục tải lên không bao giờ bị đụng (symlink/`..` trong thư mục: bỏ qua); (5) tải lên song song với quét: tệp vừa lưu nhưng chưa có bản ghi (đang trong giao dịch) không bị xoá (nhờ ngưỡng tuổi); (6) `run_purger` vẫn sống sau lỗi ở bất kỳ bước nào.
- [ ] **Step 2: Chạy để xác nhận thất bại**, **Step 3: Viết mã**, **Step 4: Chạy toàn bộ hai lần** (`bash scripts/test.sh -q`)
- [ ] **Step 5: Commit:** `feat: delete attachments with purged rooms and sweep orphaned uploads`

---

### Task 3: Hạ tầng — Docker, Caddy, phụ thuộc

**Files:** Modify `docker-compose.yml`, `Caddyfile`, `backend/requirements.txt`, `backend/Dockerfile`, `.env.example`, `README.md` (mục triển khai/cấu hình)

**Interfaces:** Produces volume `uploads` (đã nêu ở spec) gắn `api:/data/uploads` với quyền ghi cho người dùng chạy tiến trình; `UPLOAD_DIR` trỏ tới đó; Caddy `request_body` 26MB cho đường dẫn tải lên; `Pillow`, `python-multipart` ghim phiên bản (kiểm tra bản wheel cho `python:3.12-slim`); kiểm tra `docker compose up -d --build` chạy, `alembic upgrade head` chạy 0005-0006 trên cơ sở dữ liệu đang có dữ liệu, tệp tồn tại sau `docker compose restart api` (volume bền). Healthcheck của `api` không đổi.

- [ ] **Step 1: Sửa các tệp trên.** Với Caddy: `@upload path_regexp upload ^/api/rooms/[0-9]+/files$` + `handle @upload { request_body { max_size 26MB } reverse_proxy api:8000 }` đặt **trước** `handle /api/*`; các `/api/*` khác không đổi. Thêm biến `UPLOAD_DIR` vào `.env.example`.
- [ ] **Step 2: Kiểm tra thật trên stack riêng** (`docker compose -p kn-e2e …` như quy trình e2e, `.env` tạm sao lưu/khôi phục, không đụng project demo): build thành công; tải lên bằng `curl -F file=@…` một tệp 1 MB qua Caddy (201), tệp 27 MB (Caddy trả 413 trước khi tới API), tệp 24 MB (201); `docker compose restart api` ⇒ tệp vẫn tải được; dọn (`down -v` project `kn-e2e`). Ghi kết quả vào báo cáo.
- [ ] **Step 3: Commit:** `chore: add uploads volume, request size limit and image dependencies`

---

### Task 4: Backend — tìm kiếm tiếng Việt

**Files:** Create `backend/alembic/versions/0006_search.py`, `backend/app/chat/search.py`, `backend/app/routers/search.py`, `backend/tests/test_search.py`; Modify `backend/app/models.py` (cột sinh tự động chỉ khai báo qua `Computed`/bỏ qua trong ORM nếu cần), `backend/app/main.py`, `backend/app/config.py`, `.env.example`, `backend/tests/conftest.py` (tạo extension/hàm khi `create_all`), `backend/tests/test_migrations.py`

**Interfaces:**
- Consumes: `service.load_message_extras`/`to_message_out`, `require_member`-style truy vấn phòng của người dùng (`user_room_ids`), `limits`.
- Produces:
  - Migration `0006`: `CREATE EXTENSION IF NOT EXISTS unaccent`; hàm `f_unaccent(text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $$ SELECT public.unaccent('public.unaccent', $1) $$` (+ xử lý riêng `đ/Đ` ⇒ `d` nếu từ điển mặc định không làm); cột `messages.search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', f_unaccent(lower(coalesce(body,'') || ' ' || coalesce(attachment_name,''))))) STORED`; chỉ mục `ix_messages_search_vector USING GIN (search_vector)`. Tin cũ được điền tự động khi thêm cột (bảng nhỏ: chấp nhận khoá ghi ngắn; ghi chú về bảng lớn trong README).
  - `search.build_tsquery(q: str) -> str | None`: chuẩn hoá (NFKC, `lower`, bỏ dấu bằng cùng hàm của DB ở phía DB — truy vấn gọi `f_unaccent` lên từ khoá), tách từ khoá theo ký tự không phải chữ/số, bỏ từ rỗng, tối đa 8 từ, mỗi từ cắt tối đa 40 ký tự, ghép `từ1 & từ2 & từ3:*` (từ cuối khớp tiền tố) và truyền qua **tham số** vào `to_tsquery('simple', f_unaccent(:q))` — chỉ gồm chữ/số nên không thể chèn toán tử; không còn từ nào ⇒ `None` ⇒ 422 `invalid_query`.
  - `search.search_messages(session, user_id, q, room_id=None, before=None, limit=30) -> (items, has_more)`: lọc `Room.archived_at IS NULL`, `room_members.user_id = :me`, `messages.deleted_at IS NULL`, `search_vector @@ query`, `id < before`, `ORDER BY messages.id DESC`, lấy `limit+1`; `room_id` không thuộc phòng của mình ⇒ kết quả rỗng (không lỗi, không lộ tồn tại); trả `MessageOut` đầy đủ (reply/mentions/attachment) + `room_name` (phòng 1-1 là tên người kia).
  - `GET /search` đúng hợp đồng; giới hạn tốc độ `SEARCH_PER_MINUTE` (fail-open khi Redis lỗi).

- [ ] **Step 1: Viết test thất bại (`backend/tests/test_search.py`):**
1. `test_vietnamese_without_accents`: tin "Báo cáo của Nguyễn Văn Đức" ⇒ truy vấn `nguyen`, `NGUYỄN`, `duc`, `đức`, `bao cao`, `báo cáo`, `van duc` đều tìm thấy; "doanh thu" không khớp tin trên.
2. `test_prefix_and_multiword`: `nguy` (tiền tố của từ cuối) khớp; `nguyen vă` khớp; hai từ phải cùng có mặt (AND); tiền tố ở từ không phải cuối **không** khớp (`ngu van` không khớp "Nguyễn Văn" theo thiết kế — ghi rõ trong test).
3. `test_special_characters_never_break_the_query`: `"a & b | !c"`, `"'; DROP TABLE messages;--"`, `"*:*"`, `"(((("`, `"<->"`, chuỗi toàn dấu câu, chuỗi rất dài, Unicode lạ ⇒ không 500; chỉ ký tự đặc biệt/rỗng ⇒ 422 `invalid_query`; q > 100 ký tự ⇒ 422; > 8 từ ⇒ chỉ dùng 8 từ đầu (hoặc 422 — chọn một và test).
4. `test_scope_rooms_membership`: tin ở phòng người dùng không thuộc ⇒ không xuất hiện; phòng đã lưu trữ ⇒ không; thành viên đã bị gỡ ⇒ không còn thấy tin cũ của phòng đó; tin đã xoá ⇒ không; `room_id` của phòng không thuộc mình ⇒ kết quả rỗng giống hệt phòng không có kết quả (cùng body); `room_id` hợp lệ lọc đúng.
5. `test_search_includes_file_names_and_captions`: tin tệp "Bảng lương T10.xlsx" tìm được bằng `bang luong`, `xlsx`; caption cũng tìm được; tin tệp bị xoá thì không.
6. `test_edit_updates_search_vector`: sửa tin ⇒ từ cũ không khớp, từ mới khớp (cột sinh tự động).
7. `test_pagination_and_order`: 75 kết quả ⇒ trang 1 có 30 và `has_more`, `before=<id cuối>` tiếp tục không trùng/sót, thứ tự id giảm dần.
8. `test_search_response_shape_and_extras`: kết quả có `reply_to`, `mentions`, `attachment`, `room_name` (1-1 = tên người kia), `sender_name`; số truy vấn SQL cố định theo trang.
9. `test_search_uses_gin_index`: `EXPLAIN` truy vấn (với dữ liệu đủ lớn hoặc `SET enable_seqscan=off`) dùng `ix_messages_search_vector`; test migration up/down `0006`.
10. `test_search_rate_limit_and_fail_open`: `SEARCH_PER_MINUTE=2` ⇒ lần 3 ⇒ 429; Redis lỗi ⇒ cho qua.
11. `test_dong_d_handling`: "Đặng", "ĐẶNG", "dang", "đặng" khớp lẫn nhau (kiểm tra `đ`→`d` thực sự có trong từ điển hoặc bổ sung thủ công).

- [ ] **Step 2: Chạy để xác nhận thất bại:** `bash scripts/test.sh tests/test_search.py -q`
- [ ] **Step 3: Viết mã.** Lưu ý: `conftest.py` tạo schema bằng `Base.metadata.create_all` ⇒ cột sinh tự động, hàm `f_unaccent` và extension phải được tạo cho cả đường test (thêm DDL tương ứng vào fixture khởi tạo hoặc dùng event `after_create`); kiểm tra `unaccent` có sẵn trong image `postgres:16-alpine` (nếu thiếu, đổi sang `postgres:16` hoặc cài `postgresql-contrib` và ghi rõ).
- [ ] **Step 4: Chạy toàn bộ hai lần.**
- [ ] **Step 5: Commit:** `feat: accent-insensitive full-text message search`

---

### Task 5: Frontend — cửa sổ nhảy tới tin ở xa (store + controller)

**Files:** Modify `frontend/src/lib/chatStore.ts`, `chatController.ts`, `types.ts`, `chatApi.ts` (+ test của từng file), `frontend/src/lib/ChatProvider.tsx` (hook `useThread` trả thêm trạng thái), `frontend/src/test/utils.tsx`

**Interfaces:**
- Consumes: `chatApi.messages(roomId, {around})`, `after`, `before` (đã có), `ChatStore`/`ChatController` (luồng bù tin, watermark, đọc, chưa đọc, pending — **đọc toàn bộ controller trước; không được làm hỏng**).
- Produces:
  - `Thread.mode: 'live' | 'detached'` (mặc định `'live'`), `Thread.hasMoreAfter: boolean`, `Thread.newWhileDetached: number`.
  - `controller.jumpTo(roomId, messageId): Promise<'ok'|'not_found'|'error'>`: tải `messages(roomId, {around: messageId, limit: 50})`; thành công ⇒ **thay** `items` của thread bằng cửa sổ (giữ tin đang chờ `pending` ở cuối), `mode='detached'`, `hasMoreBefore/hasMoreAfter` theo phản hồi, `newWhileDetached = 0`; ghi `focusMessageId` để UI cuộn + nháy; tin không tồn tại/không có quyền ⇒ `'not_found'` (UI báo "Không tìm thấy tin nhắn"), không đổi thread; nếu tin đã nằm trong thread `live` đang tải đủ thì **không** chuyển sang detached (chỉ trả `'ok'` và đặt `focusMessageId`).
  - Trong `detached`: tin `message` live **không** được chèn vào `items` (chỉ tăng `newWhileDetached` nếu không phải của mình; tin của mình thì `backToLatest` rồi hiện); `message_updated/deleted` vẫn áp dụng cho tin đang hiển thị; bù tin (`catchUp`, `resync`, watermark) **bỏ qua** thread detached nhưng vẫn cập nhật `Room` (preview/chưa đọc) như bình thường; `markReadIfViewing` **không** đánh dấu đã đọc khi detached (vì chưa thấy tin mới nhất) trừ khi cửa sổ đã chạm tin mới nhất (`hasMoreAfter=false` và id cuối ≥ id tin thật cuối của phòng); `loadOlder` hoạt động bình thường theo cửa sổ.
  - `controller.loadNewer(roomId)`: tải `messages({after: lastRealId, limit: 50})`, nối vào cuối; khi `has_more_after=false` và cửa sổ đã sát tin mới nhất ⇒ tự chuyển về `mode='live'` (khởi tạo lại watermark từ trang đó, `newWhileDetached` được gộp bằng cách tải trang mới nhất một lần để chắc chắn không hở).
  - `controller.backToLatest(roomId)`: tải `messages({limit: 50})` (trang mới nhất), thay thế items, `mode='live'`, `newWhileDetached=0`, watermark đặt lại từ trang đó; gọi tự động khi người dùng gửi tin, hoặc `openRoom` lại (mở phòng luôn bắt đầu ở `live`).
  - Chặn đua nhau: mỗi lần `jumpTo/backToLatest/openRoom` tăng một `epoch` theo phòng; phản hồi đến sau khi epoch đổi bị bỏ; hai lần `jumpTo` chồng nhau ⇒ lần sau thắng.

- [ ] **Step 1: Viết test thất bại:** jumpTo thay cửa sổ và đặt `detached`, giữ pending; tin live đến khi detached không chen vào, tăng `newWhileDetached` (không tăng cho tin của mình; tin của mình ⇒ quay về latest); `message_deleted/updated` áp dụng trong cửa sổ; `resync/ready` khi detached không bù tin vào cửa sổ nhưng cập nhật phòng; không đánh dấu đã đọc khi detached, có đánh dấu khi cửa sổ chạm cuối; `loadNewer` nối đúng, chuyển về `live` khi chạm cuối **và** không để hở với tin đến trong lúc detached (kịch bản: detached, 3 tin live đến, loadNewer tới cuối ⇒ cả 3 tin xuất hiện đúng một lần theo thứ tự); `backToLatest` thay thế cửa sổ; `openRoom` khi đang detached về `live`; epoch: `jumpTo` A rồi `jumpTo` B, phản hồi A đến sau ⇒ bị bỏ; jumpTo tin không tồn tại ⇒ `'not_found'`, thread không đổi; jumpTo tin đã có trong thread live ⇒ không detached; gửi tin khi detached ⇒ về latest rồi gửi; thread `removeThreads` xoá luôn trạng thái detached; mock API **kiểm tra tham số** (id ≥ 1, `around` không đi cùng `before/after`).
- [ ] **Step 2: Chạy để xác nhận thất bại:** `npm test`
- [ ] **Step 3: Viết mã.**
- [ ] **Step 4: Chạy:** `npm test && npm run typecheck && npm run build`
- [ ] **Step 5: Commit:** `feat: jump to a distant message with a detached message window`

---

### Task 6: Frontend — giao diện tìm kiếm và nhảy

**Files:** Create `frontend/src/components/chat/{SearchPanel,JumpBar}.tsx` (+ test), `frontend/src/lib/highlight.ts` (+ test); Modify `chatApi.ts` (`search`), `types.ts` (`SearchHit`), `errors.ts`, `RoomSidebar.tsx`, `ConversationPane.tsx`, `MessageList.tsx`, `QuoteBlock.tsx`, `MessageItem.tsx`, `frontend/src/pages/ChatLayout.tsx` (+ test), `index.css`

**Interfaces:**
- Consumes: Task 4 (API), Task 5 (`jumpTo`, `loadNewer`, `backToLatest`, `Thread.mode`, `focusMessageId`).
- Produces:
  - Ô "Tìm tin nhắn" (`aria-label="Tìm tin nhắn"`) ở đầu thanh bên và phím tắt `Ctrl/⌘+K` mở `SearchPanel` (hộp thoại theo mẫu hiện có, hoặc bảng phủ toàn bộ cột bên trái); gõ ≥ 2 ký tự, debounce 300 ms, bỏ phản hồi cũ (so sánh số thứ tự yêu cầu), lọc "Chỉ trong cuộc trò chuyện này" (hiện khi đang mở phòng), danh sách kết quả: tên phòng, người gửi, thời gian (`listTime`), đoạn trích **tô sáng** từ khoá không phân biệt dấu (`highlight.ts`: ánh xạ chỉ số ký tự sau chuẩn hoá NFD về chuỗi gốc để tô đúng, `đ`=`d`), tên tệp hiện biểu tượng 📎; "Tải thêm" (`before`); trạng thái rỗng "Không tìm thấy tin nhắn nào.", đang tải, lỗi + thử lại, 429 hiển thị tiếng Việt.
  - Bấm kết quả ⇒ đóng bảng, điều hướng `/chat/{roomId}?msg={messageId}`; `ConversationPane` đọc `msg` từ URL: sau `openRoom`, gọi `controller.jumpTo`, cuộn tới tin + nháy sáng, rồi **xoá tham số `msg`** khỏi URL (thay thế lịch sử) để tải lại trang không nhảy lại; `not_found` ⇒ thông báo nhỏ "Không tìm thấy tin nhắn (có thể đã bị xoá)".
  - `QuoteBlock`: khi tin gốc chưa được tải (`!hasLoaded`) thì **vẫn là nút** gọi `jumpTo` (thay cho khối tĩnh hiện tại).
  - `JumpBar` (thanh dưới đầu danh sách khi `mode==='detached'`): "Đang xem tin cũ" + nút "Quay về tin mới nhất" (hiện `({newWhileDetached} tin mới)` khi > 0); cuộn gần cuối cửa sổ ⇒ tự `loadNewer`; nút `↓` hiện cũ của `MessageList` không bị phá. Mất `msg-flash` khi người dùng đã cuộn đi nơi khác không được kéo họ lại (chỉ nháy/ cuộn lúc nhảy do người dùng chủ động).
  - Thanh bên: gõ trong ô lọc phòng hiện có vẫn hoạt động độc lập.

- [ ] **Step 1: Viết test thất bại:** highlight (không dấu, `đ`, nhiều từ, chồng lấn, ký tự đặc biệt/regex trong từ khoá không lỗi, Unicode tổ hợp vs dựng sẵn, kết quả đúng cả khi chuỗi gốc chứa tổ hợp dấu); SearchPanel (debounce, bỏ phản hồi cũ — kịch bản phản hồi đến sai thứ tự, phân trang, bộ lọc phòng, trạng thái rỗng/lỗi/429, phím tắt mở/đóng, Esc, focus, kết quả tệp); điều hướng `?msg=` (nhảy, cuộn+nháy, xoá tham số, `not_found`); QuoteBlock nhảy được khi tin gốc chưa tải; JumpBar (hiện/ẩn, đếm tin mới, `loadNewer` tự động, nút quay về); tích hợp `ChatLayout.test.tsx` (tìm → bấm kết quả ở **phòng khác** → điều hướng + nhảy đúng tin → "Quay về tin mới nhất" → thấy tin mới nhất, có sự kiện live trong lúc detached và tin đó xuất hiện sau khi quay về).
- [ ] **Step 2-4:** chạy test thất bại; viết mã; `npm test && npm run typecheck && npm run build`
- [ ] **Step 5: Commit:** `feat: message search panel and jump-to-message navigation`

---

### Task 7: Frontend — tải lên, hiển thị ảnh/tệp, lightbox, "Tệp & ảnh"

**Files:** Create `frontend/src/lib/{fileCache,upload}.ts` (+ test), `frontend/src/components/chat/{UploadTray,AttachmentView,ImageLightbox,FilesPanel}.tsx` (+ test); Modify `types.ts` (`Attachment`), `chatApi.ts`, `errors.ts`, `chatController.ts`, `Composer.tsx`, `MessageItem.tsx`, `MessageList.tsx`, `ConversationPane.tsx`, `RoomSidebar.tsx` (preview), `index.css`, `frontend/src/test/setup.ts` (giả `XMLHttpRequest`, `URL.createObjectURL`)

**Interfaces:**
- Consumes: Task 1 (API), `api.ts` (`getAccessToken`, làm mới token), controller (pending, `client_id`).
- Produces:
  - `upload.ts`: `uploadFile({roomId, file, caption, clientId, replyToId, onProgress, signal}) -> Promise<Message>` dùng `XMLHttpRequest` (để có tiến trình) với `Authorization: Bearer`; gặp 401 thì làm mới token **một lần** (`refreshSession`) rồi thử lại; `signal.abort()` huỷ; lỗi dịch sang `ApiError` (413/415/400/404/429/mạng ⇒ mã lỗi tiếng Việt); `validateFile(file) -> {ok:true}|{ok:false, code}` kiểm tra phía client (kích thước từ `MAX_UPLOAD_BYTES` = 25 MB, đuôi bị chặn) để báo lỗi sớm — **máy chủ vẫn là nguồn quyết định**.
  - `fileCache.ts`: `getFileUrl(attachmentId, {thumb}) -> Promise<string>` (fetch có header xác thực → blob → `URL.createObjectURL`), LRU ~40 mục hoặc ~64 MB, dùng chung yêu cầu đang bay, **thu hồi** URL khi bị đẩy khỏi LRU hoặc khi `clearFileCache()` (gọi khi đăng xuất/đổi người dùng); `downloadFile(attachment)` tải qua fetch rồi kích hoạt tải về bằng `<a download>` với tên gốc; 404/403 ⇒ lỗi "Không tìm thấy tệp".
  - Composer: nút kẹp giấy `aria-label="Đính kèm tệp"` (chọn nhiều tệp, tối đa 5), kéo thả tệp lên khung hội thoại (lớp phủ "Thả tệp để gửi"), dán ảnh từ clipboard (Ctrl/⌘+V có `clipboardData.files`) — tất cả vào `UploadTray`: mỗi tệp một thẻ (tên, kích thước, xem trước ảnh nhỏ bằng `URL.createObjectURL` cục bộ, thanh tiến trình, nút "Huỷ" `aria-label="Huỷ tải {tên}"`, lỗi hiển thị tiếng Việt + "Thử lại"/"Bỏ"); chú thích dùng ô soạn tin hiện có (gửi cho tệp **đầu tiên**; các tệp sau không chú thích); tải **lần lượt** (một lúc một tệp); chọn tệp bị chặn/quá lớn ⇒ báo lỗi ngay, không tải; khi mất kết nối hoặc socket chưa mở, vẫn cho tải (REST) nhưng tin chỉ hiện khi máy chủ xác nhận; đóng phòng/đổi phòng giữa chừng ⇒ tiếp tục tải ở nền và hiển thị trong phòng đó khi quay lại (hoặc huỷ — **chọn huỷ khi rời phòng**, có `confirm` nếu đang tải; ghi rõ).
  - `AttachmentView` trong `MessageItem`: ảnh ⇒ ảnh thu nhỏ tải lười (`IntersectionObserver`), khung giữ tỉ lệ theo `width/height` (không làm nhảy bố cục), bấm mở `ImageLightbox` (ảnh gốc, nút Tải về, Esc, mũi tên chuyển ảnh trong phòng nếu có thể, bẫy focus); tệp khác ⇒ thẻ (biểu tượng theo đuôi, tên cắt `ellipsis` có `title`, kích thước dễ đọc "1,2 MB", nút "Tải về"); trạng thái tải/lỗi/"Thử lại"; tin đã xoá ⇒ không hiện tệp (đã là "Tin nhắn đã bị xoá"); `alt` của ảnh = tên tệp.
  - Xem trước ở thanh bên và trích dẫn trả lời cho tin tệp: "📎 {tên}" (hoặc "🖼 {tên}" cho ảnh); `makeSnippet` không đổi.
  - `FilesPanel` ("Tệp & ảnh": nút `aria-label="Tệp và ảnh"` ở tiêu đề phòng): hai tab "Ảnh" / "Tệp", lưới ảnh nhỏ / danh sách tệp, phân trang "Tải thêm", bấm ảnh mở lightbox, bấm tệp tải về, bấm biểu tượng "Đến tin nhắn" gọi `jumpTo` (Task 5); trạng thái rỗng/lỗi/đang tải.
  - Controller: `sendFile` KHÔNG đi qua WebSocket; nhận tin trả về từ REST và `upsertMessage` (sự kiện WS `message` trùng id sẽ được gộp theo id/`client_id`, **không hiện hai lần**); `client_id` được sinh ở client để đối soát tin lạc quan "đang tải" (một bong bóng giữ chỗ có tiến trình thay vì `UploadTray` chỉ khi đã bắt đầu tải; chọn **một** trong hai và test: bong bóng giữ chỗ trong danh sách tin là cách nhất quán với tin lạc quan khác).

- [ ] **Step 1: Viết test thất bại:** validateFile (đuôi chặn hoa/thường, `a.pdf.exe`, quá 25 MB, tệp rỗng); uploadFile (FormData đúng trường, header xác thực, tiến trình, huỷ, 401 → làm mới token rồi thử lại đúng một lần, 413/415/429/mạng → mã lỗi, không tiết lộ token); fileCache (chia sẻ yêu cầu đang bay, LRU thu hồi `revokeObjectURL`, `clearFileCache`, 404 → lỗi, header xác thực có mặt); Composer (chọn nhiều tệp, giới hạn 5, kéo thả, dán ảnh, chú thích chỉ cho tệp đầu, không gửi tệp bị chặn); UploadTray (tiến trình, huỷ, thử lại, lỗi tiếng Việt); AttachmentView (ảnh lười + giữ tỉ lệ, lightbox focus/Esc/mũi tên, thẻ tệp, tên dài, lỗi tải + thử lại, `alt`); MessageItem (tin tệp có chú thích, tin tệp của mình có Xoá nhưng không có Sửa nội dung tệp — chỉ sửa chú thích); FilesPanel (phân trang, tab, lightbox, nhảy tới tin); tích hợp `ChatLayout.test.tsx` (gửi ảnh: bong bóng giữ chỗ → tin thật không trùng khi sự kiện WS đến trước/sau phản hồi REST; mở "Tệp & ảnh"; tải về gọi fetch có xác thực); rò rỉ: `revokeObjectURL` được gọi khi unmount/đăng xuất.
- [ ] **Step 2-4:** chạy test thất bại; viết mã; `npm test && npm run typecheck && npm run build`
- [ ] **Step 5: Commit:** `feat: send, preview and download file attachments in the chat ui`

---

### Task 8: Kiểm tra trình duyệt thật và tài liệu

**Files:** Modify `scripts/e2e_chat_ui.mjs`, `README.md`, `.env.example`

**Interfaces:** dùng quy trình e2e hiện có (project riêng `-p kn-e2e`, `.env` tạm sao lưu/khôi phục, tạm dừng caddy+api của demo rồi **build lại bằng code mới** ở cuối, script từ chối `BASE_URL` không phải localhost; xem báo cáo e2e của plan 6). Cần thêm `UPLOAD_PER_MINUTE`/`SEARCH_PER_MINUTE` đủ lớn trong `.env` tạm để không vướng giới hạn tốc độ giữa các bước; tạo tệp thử trong thư mục tạm (PNG thật bằng canvas hoặc byte cố định, PDF giả, ELF giả).

- [ ] **Step 1: Thêm các bước:**
  1. **Gửi ảnh:** Alice chọn một PNG qua nút kẹp giấy (`setInputFiles`) ⇒ thấy bong bóng giữ chỗ có tiến trình rồi ảnh thu nhỏ đúng tỉ lệ; Bob (phòng đang mở) thấy ảnh; Bob bấm mở lightbox, Esc đóng, nút Tải về tạo tệp tải xuống có đúng byte (so sánh hash); ảnh trong tin thật **không** hiện hai lần.
  2. **Gửi tệp thường + chú thích:** PDF giả với chú thích ⇒ thẻ tệp (tên, kích thước), Bob tải về đúng byte; kéo thả (`dispatchEvent` drop với `DataTransfer`) và dán ảnh (sự kiện paste có tệp) đều tạo tin.
  3. **Bị chặn:** chọn `virus.exe` ⇒ báo lỗi ngay phía client, không có request tải lên; REST thô với token Alice gửi `evil.png` chứa chữ ký ELF ⇒ 415; tệp lớn hơn `MAX_UPLOAD_MB` (đặt 2 trong `.env` tạm) ⇒ lỗi tiếng Việt "Tệp quá lớn".
  4. **Quyền:** Carol (không ở phòng) gọi `GET /api/files/{id}` bằng token của cô ⇒ 404 `file_not_found` (cùng body với id không tồn tại); sau khi Alice xoá tin tệp, Bob cũng nhận 404; sau khi Bob bị gỡ khỏi nhóm ⇒ 404; không có tệp nào đi qua Caddy dưới dạng tĩnh (đường dẫn `/uploads/...` ⇒ 404 từ SPA fallback, không phải nội dung tệp).
  5. **Tệp & ảnh:** mở bảng, hai tab đúng, "Đến tin nhắn" nhảy được tới tin cũ (kết hợp bước 7).
  6. **Tìm kiếm:** tạo tin "Báo cáo doanh thu của Nguyễn Văn Đức" và tệp "Bảng lương T10.xlsx"; Ctrl+K, gõ `nguyen duc` ⇒ thấy tin, đoạn trích tô sáng đúng "Nguyễn"/"Đức"; gõ `bang luong` ⇒ thấy tệp; tìm trong phòng khác không thuộc mình không bao giờ có kết quả (REST thô với token Carol ⇒ rỗng); bộ lọc "Chỉ trong cuộc trò chuyện này".
  7. **Nhảy tới tin ở xa:** gửi 150 tin vào một phòng (REST/WS thô), tin đầu tiên là "MỐC-ĐẦU"; tìm "MOC dau" ⇒ bấm kết quả ⇒ điều hướng, cuộn tới tin, nháy sáng, thanh "Đang xem tin cũ" hiện; trong lúc đó Bob gửi 3 tin mới ⇒ nút "Quay về tin mới nhất (3 tin mới)"; bấm ⇒ thấy cả 3 tin đúng một lần, ở cuối; bấm vào trích dẫn của một tin trả lời mà tin gốc chưa tải ⇒ nhảy được; tải lại trang khi URL còn `?msg=` không nhảy lại (tham số đã bị xoá); gửi tin khi đang detached ⇒ tự về mới nhất.
  8. **Dọn dẹp:** nhóm có tệp bị giải tán, đặt `ROOM_ARCHIVE_RETENTION_DAYS` rất nhỏ **không khả thi** ⇒ kiểm bằng cách gọi trực tiếp `purge_archived_rooms` trong container API với `retention_days` nhỏ (hoặc đẩy `archived_at` về quá khứ bằng SQL) rồi xác nhận tệp trên đĩa trong volume biến mất (`docker compose exec api ls`) và tệp của phòng khác còn.
  9. **Bền vững:** `docker compose restart api` ⇒ ảnh vẫn tải được.
- [ ] **Step 2: Chạy thật hai lần** theo quy trình hiện có (kết thúc: `down -v` project `kn-e2e`, khôi phục `.env` nguyên byte, **build lại và bật lại demo** `caddy` + `api`); mọi bước cũ vẫn pass. Bước hỏng: điều tra nguyên nhân gốc, sửa mã bằng commit `fix:` riêng kèm test, không nới kiểm tra.
- [ ] **Step 3: README:** hợp đồng REST mới (tải lên, tải về, danh sách tệp, tìm kiếm, `attachment`, mã lỗi mới), cấu hình mới, quy tắc loại tệp/ảnh, vòng đời tệp, tìm kiếm không dấu và giới hạn của nó (tiền tố chỉ ở từ cuối), cửa sổ nhảy, giới hạn và khuyến nghị sao lưu thư mục `uploads` (chi tiết ở Plan 8), lưu ý cột sinh tự động khi nâng cấp bảng `messages` lớn.
- [ ] **Step 4: Chạy lại toàn bộ test:** `cd frontend && npm test && npm run build`, `bash scripts/test.sh -q`.
- [ ] **Step 5: Commit:** `test: extend real-browser e2e for files, search and jump; document them`

---

## Self-Review

**Spec coverage:** mục 3 (`attachments`, `tsvector`), mục 5 (`POST /rooms/{id}/files`, `GET /files/{id}`, `GET /search`), mục 6 (`around` cho kết quả tìm kiếm và reply), mục 8-9 (volume `uploads`, chặn tệp thực thi, `Content-Disposition`, `nosniff`, quyền thành viên mỗi lượt tải, tên uuid), mục 11 (tệp đính kèm, trạng thái rỗng kết quả tìm kiếm). Cột "thành viên và tệp gần đây" cố định bên phải được thay bằng nút "Tệp & ảnh" (ghi ở "Không làm"). Sao lưu `uploads` thuộc Plan 8.

**Placeholder scan:** không có "TBD"/"TODO". Hai chỗ có lựa chọn được ghi rõ để người thực hiện chốt và test: (1) hành vi khi rời phòng giữa lúc tải lên (chọn huỷ + xác nhận), (2) bong bóng giữ chỗ trong danh sách tin thay cho khay tải lên. Task 1-8 mô tả hợp đồng, thứ tự kiểm tra và danh sách test cụ thể thay vì dán toàn bộ mã vì mẫu tương tự đã có (`send_message`, `limits`, `load_message_extras`, `NewChatDialog`, controller, script e2e); người thực hiện phải đọc các tệp được nêu.

**Nhất quán tên:** `attachments`, `attachment_name`, `storage_key`, `thumb_key`, `FileStore`, `classify`, `sanitize_filename`, `send_file_message`, `sweep_orphans`, `search_vector`, `f_unaccent`, `build_tsquery`, `search_messages`, `Thread.mode/hasMoreAfter/newWhileDetached`, `jumpTo`, `loadNewer`, `backToLatest`, `getFileUrl`, `uploadFile`, `validateFile`, `SearchPanel`, `JumpBar`, `AttachmentView`, `ImageLightbox`, `FilesPanel`, `UploadTray`.

**Review Focus:** 6 dòng đều có test: quyền/404 đồng nhất (T1.3, T1.12, T4.4, e2e 4), tệp độc hại (T1.4, T1.5, T1.7), giới hạn streaming/dọn tệp dở (T1.6), vòng đời tệp (T2), tìm kiếm an toàn/không dấu/phạm vi/chỉ mục (T4), cửa sổ nhảy không chen/mất tin (T5, T6, e2e 7), giao diện tải lên/rò rỉ blob (T7, e2e 1-3).

## Plan tiếp theo

| Plan | Nội dung |
|---|---|
| 8 | Vận hành: HTTPS nội bộ (bật được Web Notification trên mạng nội bộ, `COOKIE_SECURE`, Web Locks), giới hạn IP admin, sao lưu/khôi phục DB **và thư mục `uploads`** (có script khôi phục, thử khôi phục thật), thử tải 100.000 tin + đo lại danh sách tin (ảo hoá nếu cần), giới hạn số kết nối WebSocket, dọn `refresh_tokens`, ghim phiên bản thư viện/image, bảng điều khiển admin (dung lượng tệp, người online, lần sao lưu gần nhất) |
