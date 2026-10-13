# Plan 6: Trả lời tin, @nhắc tên và thông báo trình duyệt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Người dùng trả lời đúng một tin cụ thể (hiện trích dẫn), @nhắc tên thành viên trong phòng (có gợi ý khi gõ `@`, người được nhắc thấy nổi bật), và nhận thông báo trình duyệt (cửa sổ thông báo, âm báo, số chưa đọc trên tiêu đề tab) khi có tin quan trọng lúc đang không xem.

**Architecture:** Backend thêm cột `messages.reply_to_id` và bảng `message_mentions`; `send` (WebSocket) nhận thêm `reply_to_id` và `mentions` (danh sách `user_id`); máy chủ **không phân tích văn bản** mà chỉ kiểm tra từng id có phải thành viên phòng và chữ `@Họ Tên` tương ứng có trong nội dung. `MessageOut` mang thêm khối trích dẫn `reply_to` và danh sách `mentions`; `RoomOut` mang thêm `unread_mentions`. Frontend thêm thanh trả lời trong ô soạn, khối trích dẫn trong bong bóng, gợi ý `@` trong ô soạn, nhãn "@" ở thanh bên, và một mô-đun thông báo độc lập (cài đặt lưu `localStorage`, quyết định bằng một hàm thuần để dễ test).

**Tech Stack:** FastAPI + SQLAlchemy async + Alembic + Redis (Plan 3-5b); React 18 + TypeScript + Vitest (Plan 4-5b).

**Spec:** `docs/superpowers/specs/2026-10-12-internal-messaging-design.md` (mục 3: `messages.reply_to_id`, `message_mentions`; mục 7: thông báo; mục 11: reply, @mention). Nhảy tới tin ở xa bằng `around` (cho cả reply lẫn tìm kiếm) được làm ở Plan 7.

## Quyết định thiết kế đã chốt cho plan này (chủ dự án có thể đổi)

- **Reply:** trả lời được tin **cùng phòng**, chưa bị xoá, đã tồn tại thật (id dương). Tin gốc về sau bị xoá thì khối trích dẫn hiện "Tin nhắn đã bị xoá" (không lộ nội dung cũ). Bấm vào trích dẫn: nếu tin gốc đang nằm trong danh sách đã tải thì cuộn tới và nháy sáng; nếu không thì chỉ hiện trích dẫn (nhảy tới tin ở xa làm ở Plan 7 cùng tìm kiếm).
- **Trích dẫn trong dữ liệu trả về:** `{id, sender_id, sender_name, snippet (tối đa 120 ký tự, cắt ở ranh giới ký tự, rỗng nếu đã xoá), deleted}`; tin gốc không còn (phòng bị xoá cứng) thì `reply_to = null`.
- **@mention:** chỉ nhắc được **thành viên của phòng** (chat 1-1 cũng cho phép nhưng ít dùng). Client gửi danh sách `mentions` (id) cùng nội dung có chữ `@Họ Tên`; server lọc bỏ id không phải thành viên, bỏ trùng, tối đa 20 id/tin, **không** tin văn bản. **`@all`** (chủ dự án yêu cầu thêm): trong **nhóm** (không áp dụng cho chat 1-1), gõ `@all` để nhắc **tất cả thành viên**; cờ `mention_all` chỉ được server chấp nhận khi phòng là nhóm **và** nội dung có chữ `@all` đứng riêng (không dính ký tự chữ/số ngay trước hoặc sau); mọi thành viên khác được tính là bị nhắc (huy hiệu "@", thông báo loại `mention`). Chống làm phiền: mỗi người tối đa **10 tin `@all` trong 10 phút** (mọi phòng cộng lại, cấu hình `MENTION_ALL_PER_WINDOW`/`MENTION_ALL_WINDOW_SECONDS`), vượt thì tin **không** được tạo và trả `error` `rate_limited`. Mọi thành viên nhóm đều được dùng `@all` (không phân quyền riêng ở bản này).
- **Sửa tin:** `PATCH /messages/{id}` nhận thêm `mentions` tuỳ chọn; nếu không gửi thì giữ các mention cũ mà chữ `@Tên` còn xuất hiện trong nội dung mới. `mention_all` được giữ chỉ khi `@all` còn trong nội dung mới (sửa tin không thể **thêm** `@all` mới để tránh lách giới hạn tốc độ: nếu bản cũ không có `mention_all` thì bản sửa cũng không). Sửa tin **không** đổi `reply_to`.
- **Chưa đọc @:** `RoomOut.unread_mentions` = số tin có nhắc tên **mình** hoặc có `mention_all` (trong nhóm) với id lớn hơn mốc đã đọc (không tính tin của chính mình, tin đã xoá).
- **Thông báo trình duyệt (chính sách mặc định, bật/tắt được trong cài đặt):** thông báo khi có tin **của người khác** đến mà (cửa sổ đang ẩn **hoặc** phòng đó không đang mở) **và** thuộc một trong: tin trong chat 1-1; tin nhắc tên mình hoặc `@all`; tin trả lời tin của mình; (tuỳ chọn, mặc định tắt) mọi tin trong nhóm. Không thông báo tin của chính mình, tin đã xoá, hay tin cũ nhận lúc bù tin sau khi kết nối lại (chỉ tin **trực tiếp** từ WebSocket vừa đến; luật 60 giây chỉ là lưới an toàn).
- **Cài đặt thông báo** (lưu `localStorage`, hỏng/bị chặn thì dùng mặc định trong bộ nhớ): bật thông báo (cần quyền trình duyệt, chỉ xin khi người dùng bấm), âm báo, hiện nội dung tin trong thông báo (mặc định bật), thông báo mọi tin nhóm (mặc định tắt). Mặc định ban đầu: tắt thông báo cho tới khi người dùng chủ động bật.
- **Số chưa đọc trên tiêu đề tab:** `(N) Kết Nối` với N = tổng chưa đọc của mọi phòng; `Kết Nối` khi N = 0. Không phụ thuộc quyền thông báo.
- **Web Notification chỉ hoạt động ở ngữ cảnh an toàn** (HTTPS hoặc localhost): trên HTTP thuần ở mạng nội bộ, giao diện hiện giải thích "Cần HTTPS để bật thông báo" và vẫn bật âm báo + tiêu đề tab. HTTPS nội bộ làm ở Plan 8.
- **Quy tắc cuối cùng (sau review):** `@Họ Tên` chỉ tính là mention khi **đứng riêng** (ký tự trước `@` không phải chữ/số/gạch dưới, `@` hay `/`; ký tự ngay sau tên không phải chữ/số), giống `@all`; giới hạn `@all` chạy **trước** mọi thao tác DB. Bấm "Gửi không kèm @all" khi hết lượt `@all`. Thông báo: cài đặt lưu theo từng người dùng (`kn.notify.v1.{userId}`), đóng mọi thông báo khi đăng xuất; âm báo và số chưa đọc vẫn hoạt động khi thông báo trình duyệt không dùng được; luật "cũ hơn 60 giây" chỉ là lưới an toàn (chỉ tin trực tiếp qua WebSocket mới báo, tin bù/tin trùng bị loại từ cấu trúc).
- **Không làm:** `@here`, reaction, chuyển tiếp, thông báo đẩy khi đóng hết tab (Service Worker/Push), nhảy tới tin ở xa (Plan 7).

## Global Constraints

- Mọi giao diện bằng tiếng Việt; nút/vùng bấm tối thiểu 44px; mọi điều khiển có tên truy cập; không dùng `dangerouslySetInnerHTML` (tên người, trích dẫn, mention luôn là text thuần).
- Backend test chỉ qua `bash scripts/test.sh <args>`; frontend `npm test`, `npm run typecheck`, `npm run build` trong `frontend/`.
- Hợp đồng mới:
  - WS client → server `send`: thêm `reply_to_id?: int` (≥1), `mentions?: int[]` (mỗi phần tử int ≥1; WS nhận tối đa 200 phần tử thô, server giữ tối đa 20 id hợp lệ đầu tiên; sai kiểu/ngoài khoảng → `invalid_message`) và `mention_all?: bool` (sai kiểu → `invalid_message`). Mỗi mention (và `mention_all`) chỉ được chấp nhận khi chữ `@{full_name}` (hoặc `@all`) thực sự có trong nội dung đã làm sạch; mention không có chữ tương ứng bị bỏ im lặng. `reply_to_id` không hợp lệ (không tồn tại / khác phòng / đã xoá) → `error` `invalid_reply` (400), tin **không** được tạo. Gửi lặp cùng `client_id`: bản đầu thắng, `reply_to_id/mentions` của lần sau bị bỏ qua.
  - `MessageOut` thêm `reply_to: {id, sender_id, sender_name, snippet, deleted} | null`, `mentions: [{user_id, full_name}]` (rỗng nếu không có) và `mention_all: bool`. Áp dụng cho `message`, `message_updated`, `GET /rooms/{id}/messages`, `PATCH /messages/{id}`, `RoomOut.last_message`.
  - `PATCH /messages/{id}` body `{body, mentions?: int[]}`.
  - `RoomOut` thêm `unread_mentions: int`.
  - `GET /rooms/{id}/messages` phải nạp trích dẫn và mention bằng truy vấn gộp (không N+1), tối đa số truy vấn cố định cho một trang.
  - Mã lỗi mới `invalid_reply` (400) có thông báo tiếng Việt: "Không trả lời được tin này."
- Server không ghi nội dung tin/tên vào log; trích dẫn cắt theo ký tự Unicode (không cắt giữa cặp thay thế), bỏ ký tự điều khiển, gộp xuống dòng thành khoảng trắng.
- Thông báo trình duyệt không bao giờ được gửi cho tin của chính mình, tin của phòng đang xem khi cửa sổ đang hiển thị và có tiêu điểm, hay tin đã xoá; khi `Notification` không tồn tại hoặc quyền bị từ chối, mọi hàm phải im lặng, không ném lỗi.
- Test frontend không dùng mạng/âm thanh thật: `Notification`, `AudioContext`, `localStorage` được giả lập trong test.

## Review Focus

- Reply sang tin của **phòng khác** hoặc tin không tồn tại bị từ chối ở server; trích dẫn không bao giờ lộ nội dung một tin thuộc phòng người đọc không có mặt (Task 1).
- Mention chỉ ghi nhận thành viên thật của phòng và chỉ khi chữ `@Tên` có trong nội dung (không nhắc "ngầm"); id lạ không gây lỗi 500, không làm lộ tồn tại của người dùng, không tạo thông báo cho người ngoài phòng (Task 1).
- `@all` chỉ có hiệu lực trong nhóm, cần chữ `@all` thật trong nội dung, bị giới hạn tốc độ, sửa tin không thể thêm `@all` mới, và nhắc đúng mọi thành viên (huy hiệu "@" + thông báo) nhưng không nhắc người đã rời/bị gỡ (Task 1, 3, 4).
- Tin gốc bị xoá/sửa sau khi được trích: trích dẫn của các tin trả lời hiện đúng trạng thái mới ngay (cả khi đã tải sẵn trong client) mà không lộ nội dung cũ (Task 1, 2).
- Trang tin nhắn không bị N+1; `unread_mentions` khớp mốc đã đọc (Task 1).
- Gõ `@` gợi ý đúng thành viên (không dấu cũng khớp), không chặn Enter/IME khi không mở gợi ý, mention bị xoá khỏi nội dung thì không được gửi kèm (Task 3).
- Thông báo: không lặp, không thông báo tin cũ nhận lúc bù tin, không thông báo tin của mình/đang xem, không lỗi khi trình duyệt không hỗ trợ/bị chặn; tiêu đề tab đúng (Task 4).

---

## File Structure

```
backend/
├── alembic/versions/0004_reply_mentions.py      # messages.reply_to_id, message_mentions
├── app/models.py                                # Message.reply_to_id, MessageMention
├── app/chat/service.py                          # send_message(reply_to_id, mentions), list_messages/_to_out với trích dẫn+mention, edit_message(mentions), unread_mentions
├── app/chat/schemas.py                          # MessageOut.reply_to/mentions, RoomOut.unread_mentions, ReplyOut
├── app/routers/ws.py, app/routers/chat.py       # frame send mới, PATCH mới
├── tests/test_reply_mentions.py                 # (mới)
frontend/src/
├── lib/types.ts, chatApi.ts, errors.ts          # kiểu, API, mã lỗi
├── lib/chatStore.ts, chatController.ts          # reply/mentions trong gửi lạc quan, cập nhật trích dẫn khi tin gốc đổi
├── lib/notifications.ts                         # (mới) cài đặt, chính sách thuần, thông báo, âm báo, tiêu đề tab
├── components/chat/                             # ReplyBar, QuoteBlock, MentionPicker (mới); sửa Composer, MessageItem, MessageList, ConversationPane, RoomSidebar
├── components/NotificationSettings.tsx          # (mới) cửa sổ cài đặt thông báo
scripts/e2e_chat_ui.mjs, README.md, .env.example
```

---

### Task 1: Backend — trả lời tin, mention, chưa đọc @

**Files:** Create `backend/alembic/versions/0004_reply_mentions.py`, `backend/tests/test_reply_mentions.py`; Modify `backend/app/models.py`, `backend/app/chat/service.py`, `backend/app/chat/schemas.py`, `backend/app/routers/ws.py`, `backend/app/routers/chat.py`, `backend/tests/test_migrations.py` (nếu liệt kê bảng/cột), các test hiện có so khớp chính xác dict `MessageOut`/`RoomOut`.

**Interfaces:**
- Consumes: `service.send_message`, `service.list_messages`, `service.edit_message`, `service.list_rooms`/`get_room_out`, `to_message_out`, `_handle_send` trong `ws.py`, `publish_room_safely`.
- Produces:
  - Migration `0004`: `ALTER TABLE messages ADD COLUMN reply_to_id BIGINT NULL REFERENCES messages(id) ON DELETE SET NULL`; bảng `message_mentions(message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, PRIMARY KEY (message_id, user_id))` + chỉ mục `ix_message_mentions_user_message (user_id, message_id DESC)`; downgrade gỡ theo thứ tự ngược. Model `Message.reply_to_id`, `MessageMention`.
  - `service.send_message(session, user_id, room_id, body, client_id, *, reply_to_id=None, mentions=())` → như cũ (tuple `(message, sender_name, created)`); xác thực `reply_to_id` (tin tồn tại, cùng `room_id`, `deleted_at IS NULL`) → không thì `ChatError(400, "invalid_reply")` **trước** khi tạo tin; lọc `mentions` còn lại các id là thành viên **chưa lưu trữ** của phòng, bỏ trùng, giữ thứ tự, tối đa 20; ghi `message_mentions` trong cùng giao dịch với tin; gửi lặp (`on_conflict_do_nothing`) không ghi thêm gì.
  - `to_message_out`/hàm dựng `MessageOut` nhận dữ liệu đã nạp sẵn (`replies: dict[int, ReplyOut]`, `mentions: dict[int, list[MentionOut]]`); `service.load_message_extras(session, messages) -> (replies, mentions)` nạp bằng đúng **2 truy vấn** cho cả trang (một cho tin gốc + tên người gửi, một cho mention + tên). Dùng ở `list_messages`, `list_rooms` (cho `last_message`), `send` (sự kiện `message`), `edit` (sự kiện `message_updated`), `PATCH`.
  - `ReplyOut(id, sender_id, sender_name, snippet, deleted)`; snippet làm sạch như Global Constraints; tin gốc đã xoá mềm ⇒ `snippet=""`, `deleted=true`.
  - `RoomOut.unread_mentions`, tính trong `list_rooms` bằng một truy vấn gộp theo mốc đã đọc của người gọi (tính cả tin `mention_all` của người khác trong nhóm).
  - Cột `messages.mention_all BOOLEAN NOT NULL DEFAULT false` (cùng migration 0004); `send_message(..., mention_all=False)`: chỉ lưu `true` khi phòng là `group` **và** nội dung khớp mẫu `@all` đứng riêng (regex `(?<![\w@])@all(?!\w)`, không phân biệt hoa thường) **và** người gửi chưa vượt giới hạn tốc độ `@all` (dùng cùng bộ giới hạn Redis như nhóm: `app/chat/limits.py`/`register_attempt`, khoá có `bus_channel_prefix`; Redis lỗi ⇒ cho qua + log); vượt giới hạn ⇒ `ChatError(429, "rate_limited")` **trước** khi tạo tin. Cấu hình `mention_all_per_window: int = Field(10, gt=0)`, `mention_all_window_seconds: int = Field(600, gt=0)`.
  - Lọc `mentions`: chỉ giữ id có chữ `@{full_name}` trong nội dung đã làm sạch (so khớp chuỗi con chính xác).
  - `service.edit_message(session, user_id, message_id, body, mentions=None)`: `mentions=None` ⇒ giữ các mention cũ có `@{full_name}` còn trong nội dung mới; `mentions=[...]` ⇒ thay bằng danh sách đã lọc như `send`.

- [ ] **Step 1: Viết test thất bại (`backend/tests/test_reply_mentions.py`)** (dùng fixture/helper như `test_chat_api.py`, `test_ws.py`, `test_user_groups.py`; đọc trước):
1. `test_reply_to_message_in_same_room_shows_quote`: A gửi tin 1; B gửi tin trả lời với `reply_to_id=1` → sự kiện `message` có `reply_to = {id:1, sender_id:A, sender_name, snippet: nội dung tin 1, deleted:false}`; `GET /messages` trả cùng trích dẫn.
2. `test_reply_to_other_room_or_missing_or_deleted_is_rejected`: tin của phòng khác / id không tồn tại / tin đã xoá → `error invalid_reply` qua WS, **không** có tin mới trong DB; `reply_to_id` sai kiểu (chuỗi, 0, âm, bool, quá lớn) → `invalid_message`.
3. `test_snippet_is_truncated_sanitized_and_never_leaks_deleted_text`: tin gốc dài 500 ký tự có xuống dòng, tab, emoji ghép → snippet ≤ 120 ký tự, không điều khiển, không cắt giữa cặp thay thế; xoá tin gốc → `reply_to.deleted=true`, `snippet=""` ở lần tải lại; sửa tin gốc → snippet mới ở lần tải lại.
4. `test_reply_is_idempotent_with_client_id`: gửi lại cùng `client_id` (kể cả đổi `reply_to_id`/`mentions`) → một tin, dữ liệu của lần đầu.
5. `test_mentions_keep_only_room_members`: mentions gồm thành viên, người ngoài phòng, người không tồn tại, trùng lặp, chính mình, 25 phần tử → chỉ thành viên hợp lệ (tối đa 20, không trùng), không lỗi; `mentions` trong `MessageOut` có `full_name` đúng; sai kiểu → `invalid_message`.
6. `test_mentions_reach_only_room_members`: sự kiện chỉ tới thành viên (như mọi tin); không có kênh riêng cho người được nhắc.
7. `test_edit_keeps_or_replaces_mentions`: sửa không gửi `mentions`: mention còn `@Tên` trong nội dung mới được giữ, mention mà chữ đã bị xoá bị bỏ; gửi `mentions` mới: thay thế (đã lọc); sự kiện `message_updated` mang `mentions`/`reply_to` đúng, `reply_to` không đổi.
8. `test_page_loading_uses_constant_queries`: trang 50 tin gồm 25 trả lời và 25 có mention nhiều người → số truy vấn SQL (đếm qua sự kiện `before_cursor_execute` của engine) không phụ thuộc số tin (so sánh trang 10 tin với trang 50 tin: chênh ≤ 0).
9. `test_unread_mentions_follow_read_marker`: B được nhắc 3 tin (1 của chính B, 1 đã xoá); `unread_mentions=1` đúng; sau `POST /read` tới tin cuối → 0; `GET /rooms` và `POST /rooms/group` cùng dạng.
10. `test_last_message_preview_carries_quote_and_mentions`: `GET /rooms` → `last_message.reply_to/mentions` đúng.
11. `test_archived_or_removed_member_cannot_reply_or_mention`: người đã bị gỡ gửi `send` kèm `reply_to_id` → `room_not_found` (không lộ trích dẫn); thành viên bị gỡ không còn xuất hiện trong mention mới (nhưng mention cũ trong lịch sử giữ nguyên tên).
12. Migration: `test_migrations.py` đi lên/xuống 0004 sạch; chỉ mục tồn tại.
13. `test_mention_requires_visible_at_name`: mention của thành viên hợp lệ nhưng nội dung không có `@Tên` ⇒ bị bỏ (không nhắc ngầm); có `@Tên` ⇒ giữ.
14. `test_mention_all_in_group_marks_everyone`: nhóm 3 người, A gửi `@all họp 9h` với `mention_all=true` ⇒ `MessageOut.mention_all=true`; B và C có `unread_mentions=1` (A không); `POST /read` ⇒ 0.
15. `test_mention_all_rejected_in_direct_or_without_token`: phòng 1-1 hoặc nội dung không có `@all` đứng riêng (ví dụ `email@all.com`, `x@all`) ⇒ `mention_all=false`, tin vẫn gửi bình thường.
16. `test_mention_all_rate_limited`: đặt `MENTION_ALL_PER_WINDOW=2`; hai tin `@all` đầu OK, tin thứ ba ⇒ `error rate_limited`, **không** có tin mới trong DB; người khác không bị ảnh hưởng; Redis lỗi ⇒ cho qua.
17. `test_edit_cannot_add_mention_all`: tin gốc không có `mention_all`, sửa thêm `@all` ⇒ `mention_all` vẫn false; tin gốc có `@all`, sửa bỏ chữ `@all` ⇒ false; sửa giữ `@all` ⇒ true.
18. `test_mention_all_not_counted_for_removed_member`: thành viên đã bị gỡ không còn `unread_mentions` từ `@all` (phòng không còn trong danh sách của họ).

- [ ] **Step 2: Chạy để xác nhận thất bại:** `bash scripts/test.sh tests/test_reply_mentions.py -q`
- [ ] **Step 3: Viết mã.** Lưu ý: kiểm `reply_to_id` và lọc `mentions` trong **cùng giao dịch** với INSERT tin (sau `require_member`); người gửi cũng thuộc phòng nên không lộ thêm. Cấm `str.format`/f-string đưa nội dung vào SQL (dùng tham số). Cập nhật mọi test hiện có so khớp chính xác dict.
- [ ] **Step 4: Chạy toàn bộ:** `bash scripts/test.sh -q` (hai lần liên tiếp để phát hiện test chập chờn).
- [ ] **Step 5: Commit:** `feat: reply to a message, mention room members and count unread mentions`

---

### Task 2: Frontend — kiểu, API, store/controller cho reply và mention

**Files:** Modify `frontend/src/lib/{types,chatApi,errors,chatStore,chatController}.ts` (+ test), `frontend/src/test/utils.tsx` (`makeMessage`/`makeRoom` có trường mới), `frontend/src/lib/ws.ts` chỉ nếu cần (không cần)

**Interfaces:**
- Consumes: Task 1; `ChatController.send`, `ChatStore` (pending, upsert, replaceMessage, markDeleted).
- Produces:
  - `types.ts`: `Reply {id, sender_id, sender_name, snippet, deleted}`, `Mention {user_id, full_name}`; `Message.reply_to: Reply | null`, `Message.mentions: Mention[]`, `Message.mention_all: boolean`; `Room.unread_mentions: number`.
  - `chatApi.editMessage(id, body, mentions?)`.
  - `errors.ts`: `invalid_reply` → "Không trả lời được tin này."
  - `ChatController.send(roomId, body, opts?: {replyTo?: Message, mentions?: Mention[], mentionAll?: boolean}) -> string | null`: tin lạc quan mang `reply_to` dựng từ `replyTo` (id, sender, snippet cắt như server) và `mentions`; khung gửi `{type:'send', room_id, body, client_id, reply_to_id?, mentions?: number[], mention_all?: true}` (chỉ thêm khoá khi có giá trị); thử lại/gửi lại sau `ready` dùng đúng cùng `reply_to_id`/`mentions` (lưu trong `pendingMeta`).
  - Khi tin gốc bị **sửa** (`message_updated`) hoặc **xoá** (`message_deleted`): mọi tin đã tải có `reply_to.id` bằng id đó được cập nhật trích dẫn (`snippet` mới / `deleted=true`, `snippet=""`) trong store; hàm `store.refreshQuotes(roomId, messageId, patch)`.
  - `markDeleted`/`replaceMessage` giữ nguyên hành vi cũ cho phần còn lại; `bumpRoom` tăng `unread_mentions` khi tin đến **nhắc tên mình** (`mentions` chứa `meId`) hoặc có `mention_all` (người khác gửi, phòng không đang xem), người khác gửi, phòng không đang xem; `clearUnread` đặt `unread_mentions = 0`; `setRooms` giữ quy tắc "không để snapshot cũ làm sống lại huy hiệu" cho cả `unread_mentions`.
  - `controller.jumpTo`: **không** làm ở plan này; thay vào đó `store`/hook `useThread` cung cấp `hasLoaded(messageId)` để UI quyết định có cho bấm trích dẫn không (xem Task 3).

- [ ] **Step 1: Viết test thất bại:** chatApi (PATCH body có/không `mentions`); errors; store (`refreshQuotes` cập nhật đúng và chỉ các tin trỏ tới id đó, snapshot mới; `bumpRoom` đếm `unread_mentions` đúng cho tin nhắc mình/không nhắc/tin của mình/phòng đang xem; `setRooms` không làm lùi `unread_mentions`); controller (send có/không reply+mentions: khung WS chính xác, tin lạc quan có `reply_to`/`mentions`, gửi lại sau `ready` dùng cùng giá trị, hồi âm `error invalid_reply` chuyển tin sang "failed" với `errorCode`; `message_updated`/`message_deleted` của tin gốc cập nhật trích dẫn của tin đã tải; không phá các test Plan 4/5).
- [ ] **Step 2: Chạy để xác nhận thất bại:** `npm test`
- [ ] **Step 3: Viết mã.**
- [ ] **Step 4: Chạy:** `npm test && npm run typecheck && npm run build`
- [ ] **Step 5: Commit:** `feat: carry replies and mentions through the chat store and controller`

---

### Task 3: Frontend — giao diện trả lời và @nhắc tên

**Files:** Create `frontend/src/components/chat/{ReplyBar,QuoteBlock,MentionPicker}.tsx` (+ test); Modify `Composer.tsx`, `MessageItem.tsx`, `MessageList.tsx`, `ConversationPane.tsx`, `RoomSidebar.tsx`, `frontend/src/index.css`, `frontend/src/pages/ChatLayout.test.tsx` (ca tích hợp)

**Interfaces:**
- Consumes: Task 2, `useMembers(roomId)`, `Message`, `Reply`, `Mention`.
- Produces:
  - `MessageItem`: nút `aria-label="Trả lời"` (hiện khi rê chuột/focus; trên màn hình cảm ứng luôn hiện, 44px) gọi `onReply(message)`; không có cho tin đã xoá hay tin đang chờ/lỗi. Khối `QuoteBlock` ở đầu bong bóng khi `reply_to != null`: tên người gửi + snippet (text thuần, tối đa 2 dòng, ellipsis); `deleted` ⇒ chữ "Tin nhắn đã bị xoá"; nếu `hasLoaded(reply_to.id)` thì là nút (`aria-label="Đến tin được trả lời"`) cuộn tới tin gốc (`scrollIntoView({block:'center'})`) và nháy sáng 1,5 giây (`.msg-flash`), nếu không thì chỉ là khối tĩnh. Mention hiển thị nổi bật (`.mention`, text) bằng cách tách nội dung theo các `@{full_name}` có trong `message.mentions` (độ dài giảm dần để tránh khớp nhầm tiền tố; không dùng regex trên tên chưa thoát); tin có nhắc **mình** có viền/nền nhẹ (`.msg-mentions-me`).
  - `ReplyBar({ reply: Message, onCancel })`: `role="status"` "Đang trả lời {tên}: {snippet}" + nút `aria-label="Huỷ trả lời"`; Esc trong ô soạn huỷ trả lời (khi không mở gợi ý @).
  - Gợi ý `@` trong **nhóm** luôn có mục đầu tiên "@all — Nhắc tất cả mọi người" (`role="option"`) khi chữ gõ sau `@` là tiền tố của `all`/`tatca`/`moinguoi` (không dấu, không phân biệt hoa thường) hoặc để trống; chọn ⇒ chèn `@all ` và bật cờ; cờ chỉ gửi khi chữ `@all` đứng riêng còn trong nội dung lúc gửi. Không có mục này ở chat 1-1.
  - Tin có `mention_all` hiển thị chữ `@all` nổi bật (`.mention .mention-all`) và mọi người (trừ người gửi) thấy viền `.msg-mentions-me` như bị nhắc tên.
  - `Composer` nhận `reply?: Message | null`, `onCancelReply`, `members: RoomMember[]` (rỗng ⇒ không bật @), `onSend(body, {replyTo, mentions, mentionAll})`. Gõ `@` ở đầu từ hoặc sau khoảng trắng mở `MentionPicker` (`role="listbox"`, mục `role="option"`, `aria-activedescendant`, tối đa 6 mục) lọc thành viên khác mình theo ký tự sau `@` (không phân biệt hoa thường và dấu tiếng Việt, đ=d, khớp theo bất kỳ từ nào của họ tên); ↑/↓ chọn, Enter/Tab chèn `@{full_name} ` tại vị trí con trỏ và ghi nhớ `{user_id, full_name}`, Esc đóng; **khi gợi ý đang mở thì Enter không gửi tin**; khi không mở thì Enter/IME hoạt động y như hiện có. Khi gửi, `mentions` = các mention đã ghi nhớ mà chuỗi `@{full_name}` **vẫn còn** trong nội dung (xoá chữ thì mention biến mất); bỏ trùng. Sau gửi xoá reply/mention đã nhớ.
  - `ConversationPane`: giữ `replyTo` theo phòng (đổi phòng thì xoá), truyền `members` và handler `onReply`; khi tin được trả lời bị xoá trước lúc gửi thì vẫn gửi (server kiểm tra) và hiện lỗi `invalid_reply` tiếng Việt ở tin lỗi.
  - `RoomSidebar`: phòng có `unread_mentions > 0` hiện huy hiệu "@" (`aria-label="{n} lần được nhắc"`) cạnh số chưa đọc, nền đậm hơn; không đổi bố cục dòng (không làm cao thêm).

- [ ] **Step 1: Viết test thất bại:** QuoteBlock (tên/snippet text thuần, `deleted`, nút chỉ khi `hasLoaded`, nháy sáng); ReplyBar; MentionPicker (lọc không dấu "duc" khớp "Đức", đ/d, theo bất kỳ từ, bỏ chính mình, giới hạn 6, điều hướng bàn phím, đóng khi mất `@`); Composer (Enter khi gợi ý mở chọn mục chứ **không gửi**; Enter khi không mở vẫn gửi; Shift+Enter, IME không bị phá; xoá chữ `@Tên` thì không gửi mention đó; hai người trùng tên khác id vẫn chèn đúng id người được chọn; Esc huỷ trả lời; gửi truyền đúng `replyTo` và `mentions`); MessageItem (nút Trả lời có/không; hiển thị mention nổi bật, tên chứa ký tự đặc biệt/regex như `A+B (C)` không lỗi; tin nhắc mình có lớp `msg-mentions-me`); RoomSidebar (huy hiệu @). Tích hợp `ChatLayout.test.tsx`: mở nhóm, bấm "Trả lời" trên một tin → thanh trả lời hiện → gõ và gửi → khung WS có `reply_to_id` đúng, tin lạc quan có trích dẫn; gõ `@Th` chọn một thành viên → khung WS có `mentions` đúng; nhận `message` nhắc tên mình ở phòng khác → huy hiệu "@" trên thanh bên; nhận `message_deleted` của tin gốc → trích dẫn của tin đã tải đổi thành "Tin nhắn đã bị xoá".
- [ ] **Step 2: Chạy để xác nhận thất bại:** `npm test`
- [ ] **Step 3: Viết mã** (CSS: `.quote` nền nhạt viền trái 3px; `.mention` đậm màu chủ đạo; `.msg-flash` animation ngắn tắt khi `prefers-reduced-motion`).
- [ ] **Step 4: Chạy:** `npm test && npm run typecheck && npm run build`
- [ ] **Step 5: Commit:** `feat: reply quotes, @mention suggestions and mention badges in the chat ui`

---

### Task 4: Frontend — thông báo trình duyệt, âm báo, số chưa đọc trên tiêu đề

**Files:** Create `frontend/src/lib/notifications.ts` (+ test), `frontend/src/components/NotificationSettings.tsx` (+ test); Modify `frontend/src/lib/chatController.ts` (+ test) và `ChatProvider.tsx` (nối), `frontend/src/components/chat/RoomSidebar.tsx` (nút "Thông báo" mở cài đặt), `frontend/src/pages/ChatLayout.test.tsx`

**Interfaces:**
- Consumes: Task 2/3; `Room`, `Message`, `useRooms`.
- Produces:
  - `notifications.ts`:
    - `type NotifySettings = {enabled: boolean; sound: boolean; showPreview: boolean; allGroupMessages: boolean}`; `DEFAULT_SETTINGS` = `{enabled:false, sound:true, showPreview:true, allGroupMessages:false}`; `loadSettings()/saveSettings()` bọc try/catch quanh `localStorage` (khoá `kn.notify.v1`, dữ liệu hỏng ⇒ mặc định; ghi lỗi thì bỏ qua).
    - `shouldNotify(input: {message, room, meId, settings, windowVisible, windowFocused, activeRoomId, now}) -> {notify: boolean; reason: 'direct'|'mention'|'reply'|'group'|null}` (`mention` gồm cả `message.mention_all` trong nhóm): hàm **thuần** theo chính sách ở đầu plan (không thông báo tin của mình/đã xoá/cũ hơn 60 giây so với `now` (lưới an toàn; ChatProvider truyền đồng hồ đã bù lệch giờ máy nên tin trực tiếp gần như không bao giờ bị loại vì tuổi); nếu phòng đang mở **và** cửa sổ hiển thị có tiêu điểm thì không).
    - `notificationSupport() -> 'unsupported'|'insecure'|'denied'|'default'|'granted'` (kiểm tra `typeof Notification`, `isSecureContext`, `Notification.permission`).
    - `requestPermission() -> Promise<NotificationPermission | 'unsupported' | 'insecure'>` (chỉ gọi khi người dùng bấm).
    - `showNotification({title, body, tag, onClick})`: dùng `new Notification` với `tag = "kn-room-{id}"` (thay thế thông báo cũ của cùng phòng, không dồn đống), `silent: true` (âm do mình phát), tự đóng sau 8 giây, `onclick` ⇒ `window.focus()` rồi `onClick()`; bọc try/catch.
    - `playBeep()`: Web Audio (oscillator ~880Hz, 120ms, âm lượng thấp), một `AudioContext` dùng lại, `resume()` khi cần, bỏ qua im lặng nếu không có/bị chặn; giới hạn tối đa 1 tiếng/1,5 giây.
    - `unreadTotal(rooms)` và `updateTitle(total)`: `document.title = total>0 ? "(" + total + ") Kết Nối" : "Kết Nối"` (giữ tên gốc đọc từ `document.title` lúc khởi tạo, bỏ tiền tố cũ đúng).
  - `ChatController` nhận dep `onIncoming?: (event: {message, room, live: true}) => void` gọi **chỉ** khi tin đến từ WebSocket sự kiện `message` (không gọi cho tin tải qua REST/bù tin) và là tin mới (id mới chưa có trong thread); `ChatProvider` nối `onIncoming` ⇒ `shouldNotify` ⇒ `showNotification` + `playBeep` theo cài đặt hiện tại (đọc tại thời điểm tin đến); nội dung thông báo: `title` = tên phòng (chat 1-1: tên người kia), `body` = `"{người gửi}: {nội dung ≤ 140 ký tự}"` hoặc `"Tin nhắn mới"` khi `showPreview=false`; `onClick` điều hướng tới `/chat/{roomId}`. Tiêu đề tab cập nhật mỗi khi `rooms` đổi (effect trong `ChatProvider`), khôi phục khi unmount.
  - `NotificationSettings`: hộp thoại (mẫu của `NewChatDialog`: role=dialog, Esc, bẫy focus, trả focus) với 4 công tắc `role="switch"` và nút "Bật thông báo trình duyệt": `unsupported` ⇒ "Trình duyệt không hỗ trợ thông báo."; `insecure` ⇒ "Cần HTTPS để bật thông báo (âm báo và số chưa đọc trên tiêu đề vẫn hoạt động)."; `denied` ⇒ hướng dẫn mở lại quyền trong cài đặt trình duyệt; `default` ⇒ nút xin quyền (kết quả `granted` mới đặt `enabled=true`); công tắc `showPreview` có mô tả "Nội dung tin sẽ hiện trên màn hình khoá/khu vực thông báo của máy"; nút "Gửi thử" phát một thông báo + âm mẫu. Mở từ nút `aria-label="Cài đặt thông báo"` ở chân thanh bên.

- [ ] **Step 1: Viết test thất bại:** `shouldNotify` bảng đầy đủ (chat 1-1 hiện/ẩn/đang xem; mention; reply tới tin của mình (so `reply_to.sender_id === meId`); nhóm thường tắt/bật `allGroupMessages`; tin của mình; tin đã xoá; tin cũ > 60 giây; cửa sổ ẩn khi đang mở phòng ⇒ thông báo; cửa sổ hiển thị nhưng mất tiêu điểm ⇒ thông báo; `enabled=false` ⇒ không); `loadSettings` khi `localStorage` ném lỗi/dữ liệu hỏng; `notificationSupport` các nhánh (giả lập `Notification`, `isSecureContext`); `showNotification` dùng `tag` theo phòng, đóng sau 8 giây (fake timers), `onclick` focus + callback, không ném lỗi khi `Notification` ném; `playBeep` giới hạn tần suất và im lặng khi không có `AudioContext`; `updateTitle`/`unreadTotal` (cộng đúng, khôi phục tên gốc, không chồng tiền tố); controller: `onIncoming` chỉ cho tin WS mới (không cho bù tin REST, không cho tin trùng id); tích hợp `ChatLayout.test.tsx` với `Notification`/`AudioContext` giả: bật thông báo từ cài đặt, nhận tin chat 1-1 khi `document.visibilityState='hidden'` ⇒ đúng một thông báo với `tag`/nội dung đúng và một tiếng; nhận tin nhóm thường ⇒ không; nhận tin nhắc tên ⇒ có; tiêu đề tab `(2) Kết Nối` rồi trở về `Kết Nối` sau khi đọc; bấm thông báo mở đúng phòng; `showPreview=false` ⇒ nội dung không lộ trong thông báo.
- [ ] **Step 2: Chạy để xác nhận thất bại:** `npm test`
- [ ] **Step 3: Viết mã.**
- [ ] **Step 4: Chạy:** `npm test && npm run typecheck && npm run build`
- [ ] **Step 5: Commit:** `feat: browser notifications, sound and unread count in the tab title`

---

### Task 5: Kiểm tra trình duyệt thật và tài liệu

**Files:** Modify `scripts/e2e_chat_ui.mjs`, `README.md`, `.env.example` (nếu có biến mới)

**Interfaces:** dùng quy trình e2e hiện có (project riêng `-p kn-e2e`, `.env` tạm sao lưu/khôi phục, tạm dừng caddy+api của demo rồi build lại bằng code mới ở cuối, script từ chối `BASE_URL` không phải localhost; xem README mục "Kiểm tra trên trình duyệt thật" và báo cáo e2e của plan 5b). Chromium headless cho phép cấp quyền `notifications` qua `context.grantPermissions(['notifications'])` và có thể giả lập `Notification` bằng `addInitScript` để ghi lại lời gọi; localhost là ngữ cảnh an toàn.

- [ ] **Step 1: Thêm các bước vào script:**
  1. **Trả lời:** Bob trả lời một tin của Alice ở nhóm → Alice thấy khối trích dẫn đúng tên/nội dung; bấm trích dẫn → cuộn tới tin gốc và nháy sáng (kiểm tra có lớp `msg-flash` rồi mất); Alice xoá tin gốc → trích dẫn ở trang Bob chuyển thành "Tin nhắn đã bị xoá" **không cần tải lại**; REST: trả lời bằng `reply_to_id` của phòng khác (qua WS thô bằng token Bob) → nhận `invalid_reply`, không có tin mới.
  2. **@mention và @all:** Alice gõ `@` trong nhóm → gợi ý hiện, gõ "bo" (không dấu) lọc ra Bob → Enter chèn `@Tên Bob ` (Enter lúc này **không** gửi tin), gửi → Bob thấy tin nổi bật `.msg-mentions-me`; ở thanh bên Bob (đang ở phòng khác) thấy huy hiệu "@" và số chưa đọc; mở phòng → huy hiệu "@" biến mất; xoá chữ `@Tên` rồi gửi → REST `GET /messages` cho thấy `mentions=[]`. **@all:** Alice gõ `@` trong nhóm 3 người → mục "@all" đứng đầu; chọn và gửi `@all họp 9h` → Bob và Carol (một đang ở phòng khác) thấy huy hiệu "@" và viền nhắc tên, Alice thì không; Bob nhận thông báo loại `mention` khi trang ẩn; trong chat 1-1 không có mục "@all"; REST/WS thô: gửi `mention_all=true` mà nội dung không có `@all` ⇒ lưu `mention_all=false`; gửi vượt giới hạn (đặt `MENTION_ALL_PER_WINDOW=3` trong `.env` tạm) ⇒ nhận `rate_limited` và không có tin mới.
  3. **Thông báo (giả lập `Notification` + `AudioContext` qua `addInitScript`, cấp quyền):** Bob bật thông báo trong cài đặt; trang của Bob đưa sang trạng thái ẩn (mở tab khác trong cùng context, `bringToFront`) → Alice nhắn chat 1-1 cho Bob ⇒ ghi nhận đúng một lần `new Notification(title=tên phòng/người, body="Alice: …", tag="kn-room-{id}")` và một tiếng; Alice nhắn nhóm thường ⇒ **không** thông báo; Alice nhắc tên Bob trong nhóm ⇒ có; tiêu đề tab của Bob thành `(N) Kết Nối` và về `Kết Nối` sau khi đọc hết; nhận tin khi đang xem đúng phòng và tab hiển thị ⇒ không thông báo; tắt "hiện nội dung" ⇒ thông báo mang "Tin nhắn mới".
  4. **Không thông báo tin cũ:** cắt WebSocket của Bob, Alice nhắn 3 tin, nối lại ⇒ Bob có đủ tin nhưng **không** có thông báo nào cho 3 tin bù đó.
- [ ] **Step 2: Chạy thật hai lần** theo quy trình hiện có (kết thúc: `down -v` project `kn-e2e`, khôi phục `.env` nguyên byte, build lại và bật lại demo `caddy` + `api`); mọi bước cũ vẫn pass. Bước hỏng: điều tra nguyên nhân gốc, sửa mã bằng commit `fix:` riêng kèm test, không nới kiểm tra.
- [ ] **Step 3: README:** hợp đồng WS/REST mới (`reply_to_id`, `mentions`, `reply_to`, `unread_mentions`, `invalid_reply`), mục "Giao diện chat" thêm trả lời / @nhắc tên / thông báo (chính sách mặc định, cài đặt, giới hạn HTTP-vs-HTTPS, quyền riêng tư của nội dung thông báo).
- [ ] **Step 4: Chạy lại toàn bộ test:** `cd frontend && npm test && npm run build`, `bash scripts/test.sh -q`.
- [ ] **Step 5: Commit:** `test: extend real-browser e2e for replies, mentions and notifications; document them`

---

## Self-Review

**Spec coverage:** mục 3 (`reply_to_id`, `message_mentions`), mục 5 (`send` có reply/mention), mục 7 (Web Notification, âm báo, badge số chưa đọc trên tiêu đề tab, cần HTTPS), mục 11 (reply, @mention). Nhảy tới tin ở xa bằng `around` chuyển sang Plan 7 (ghi ở đầu). `@all` đã được làm (chỉ trong nhóm, có giới hạn tốc độ).

**Placeholder scan:** không có "TBD"/"TODO". Task 2-5 mô tả hợp đồng và danh sách test cụ thể thay vì dán toàn bộ mã vì mẫu tương tự đã có (Composer, NewChatDialog, controller, script e2e); người thực hiện phải đọc các tệp được nêu.

**Nhất quán tên:** `reply_to_id`, `reply_to`, `mentions`, `unread_mentions`, `invalid_reply`, `ReplyOut/Reply`, `MentionOut/Mention`, `load_message_extras`, `refreshQuotes`, `shouldNotify`, `notificationSupport`, `showNotification`, `playBeep`, `updateTitle`, `NotificationSettings`, `QuoteBlock/ReplyBar/MentionPicker`.

**Review Focus:** 6 dòng đều có test: reply chéo phòng (T1.2, T1.11, e2e 1), mention thành viên thật (T1.5, T1.6), trích dẫn khi gốc đổi/xoá (T1.3, T2, T3 tích hợp, e2e 1), N+1 và `unread_mentions` (T1.8, T1.9), gợi ý `@` + IME (T3), thông báo (T4 + e2e 3, 4).

## Các plan tiếp theo

| Plan | Nội dung |
|---|---|
| 7 | File đính kèm (xem trước ảnh), tìm kiếm tin nhắn tiếng Việt, nhảy tới tin ở xa bằng `around` (dùng cho cả kết quả tìm kiếm lẫn bấm trích dẫn) |
| 8 | Vận hành: HTTPS nội bộ (bật được Web Notification trên mạng nội bộ), giới hạn IP admin, sao lưu/khôi phục, thử tải 100.000 tin, giới hạn kết nối WS, dọn `refresh_tokens`, ghim phiên bản |
