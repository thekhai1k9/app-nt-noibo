# Plan 5: Trạng thái thời gian thực (đã xem, đang soạn tin, online) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Người dùng thấy ai đang online, ai đang soạn tin, và tin của mình đã được xem chưa, cập nhật tức thì và đúng cả khi mất kết nối rồi nối lại.

**Architecture:** Ba loại tín hiệu thêm vào WebSocket hiện có. (1) *Đã xem*: `POST /rooms/{id}/read` hiện có sẽ phát sự kiện `read` lên bus của phòng; thêm `GET /rooms/{id}/members` để lấy mốc đã đọc của từng thành viên lúc mở phòng. (2) *Đang soạn tin*: frame client `typing` → server phát lại `typing` cho cả phòng (chỉ qua pub/sub, không lưu; client tự hết hạn sau 5 giây). (3) *Online*: mỗi kết nối ghi một phần tử có hạn dùng vào Redis ZSET; một tác vụ nền quét mỗi 15 giây, phát `presence` lên các phòng của người dùng khi trạng thái đổi; `GET /presence` cho trạng thái ban đầu. Frontend giữ ba loại dữ liệu này trong `ChatStore` và hiển thị bằng các phần tử nhỏ trong giao diện hiện có.

**Tech Stack:** FastAPI + SQLAlchemy async + Redis (backend, Plan 3/4); React 18 + TypeScript + Vitest (frontend, Plan 4).

**Spec:** `docs/superpowers/specs/2026-10-12-internal-messaging-design.md` (mục 3 "Đã xem", mục 5 "Sự kiện WebSocket", mục 7). Phần reply, @mention và thông báo trình duyệt của giai đoạn "Trải nghiệm" được tách sang Plan 6.

## Quyết định thiết kế đã chốt cho plan này (chủ dự án có thể đổi)

- **Quyền riêng tư của online:** chỉ thấy trạng thái online của những người **chung ít nhất một phòng** với mình (phòng chưa lưu trữ). Không có danh sách online toàn công ty. Admin không có đặc quyền xem thêm.
- **Đã xem:** chat 1-1 hiện "Đã xem" dưới tin cuối của mình nếu người kia đã đọc tới tin đó. Nhóm hiện "Đã xem bởi N người" (bấm hoặc rê chuột/`title` để thấy tên) dưới tin cuối của mình; N chỉ tính thành viên khác mình. Chỉ hiện ở **tin cuối cùng của chính mình** trong phòng (không hiện trên mọi tin).
- **Đang soạn tin:** không lưu trữ ở Redis; chỉ phát qua bus rồi hết hạn ở client sau 5 giây. Khung `typing` bị giới hạn 1 khung/2 giây/phòng/kết nối ở server (vượt thì bỏ qua im lặng).
- **Online hết hạn:** kết nối coi là còn sống 45 giây sau lần làm mới cuối; tác vụ nền làm mới mỗi 15 giây cho các kết nối đang mở trên worker đó; ngắt kết nối bình thường được gỡ ngay.
- **Không làm:** thông báo trình duyệt, reply, @mention (Plan 6); "lần cuối online" (chỉ online/offline); trạng thái "vắng mặt".

## Global Constraints

- Mọi giao diện bằng tiếng Việt. Mọi nút/vùng bấm tối thiểu 44px.
- Backend chỉ chạy test qua `bash scripts/test.sh <pytest args>`; frontend test chạy trực tiếp bằng Node trong `frontend/` (`npm test`, `npm run typecheck`, `npm run build`).
- Hợp đồng WebSocket mới (thêm vào README, mục "API chat"):
  - Client → server: `{"type":"typing","room_id":<int>}`.
  - Server → client: `{"type":"typing","room_id":<int>,"user_id":<int>,"user_name":<str>}`; `{"type":"read","room_id":<int>,"user_id":<int>,"message_id":<int>}`; `{"type":"presence","user_id":<int>,"online":<bool>}`.
  - REST: `GET /api/rooms/{id}/members` → `[{user_id, full_name, last_read_message_id|null}]` (chỉ thành viên phòng chưa lưu trữ được gọi; người ngoài → 404 `room_not_found`); `GET /api/presence` → `{"online_user_ids":[int,...]}` chỉ gồm những người chung phòng với người gọi (không gồm chính họ).
- Server không bao giờ phát `typing`/`read` cho người không thuộc phòng, không tin `user_id`/`user_name` từ client (lấy từ kết nối đã xác thực).
- Khung `typing` không trả lỗi cho client khi bị giới hạn/không hợp lệ về phòng (tránh lộ phòng nào tồn tại); khung sai kiểu vẫn trả `invalid_message` như `send`.
- Redis lỗi không được làm hỏng gửi/nhận tin: các hàm phát/ghi trạng thái dùng bản "safely" và chỉ ghi log.
- Client tuyệt đối không tin `user_id` trong `typing`/`read`/`presence` ngoài việc hiển thị; sự kiện về chính mình (`user_id === meId`) không bao giờ hiện "đang soạn tin" hay làm tăng/giảm chưa đọc của người khác.
- Sau mỗi `ready`/`resync`, client tải lại presence (`GET /presence`) và mốc đã đọc của các phòng đang mở (`GET /rooms/{id}/members`); typing không cần bù (hết hạn tự nhiên).
- Test frontend không mở mạng thật (đã có `FakeWebSocket`).

## Review Focus

- Người ngoài phòng không nhận được `typing`/`read`; người đã bị gỡ khỏi phòng/phòng đã lưu trữ không còn nhận sự kiện của phòng đó (Task 1, 2).
- `read` chỉ phát khi mốc đọc thực sự tiến lên (không phát khi gửi lại cùng mốc hoặc mốc cũ hơn) (Task 1).
- Cùng một người mở nhiều tab: online chỉ chuyển offline khi **tab cuối cùng** đóng/hết hạn; đóng một tab không làm offline (Task 3).
- Worker/kết nối chết không gỡ khỏi Redis vẫn tự hết hạn đúng 45 giây; ZSET không phình vô hạn (Task 3).
- Presence không lộ người ngoài các phòng chung, kể cả qua `GET /presence` (Task 3).
- "Đang soạn tin" biến mất khi: hết 5 giây, người đó gửi tin, người đó rời phòng; không nhấp nháy khi gõ liên tục (Task 4, 5).
- "Đã xem" đúng sau reconnect (tải lại mốc), đúng khi tin của mình là tin cuối và khi có tin mới đến sau đó (nhãn chuyển sang tin mới nhất của mình), không hiện cho tin đã xoá (Task 4, 5).
- Gõ liên tục chỉ gửi `typing` tối đa 1 lần/3 giây; không gửi khi ô trống hoặc khi socket chưa mở (Task 5).

---

## File Structure

```
backend/
├── alembic/…                       # không đổi
├── app/config.py                   # presence_ttl_seconds, presence_sweep_seconds, ws_typing_interval_seconds
├── app/chat/presence.py            # (mới) Presence: ghi/gỡ/quét ZSET, tính online theo phòng chung
├── app/chat/service.py             # mark_read trả mốc mới hoặc None; list_members; typing quyền
├── app/chat/hub.py                 # đăng ký/huỷ presence, tác vụ quét
├── app/routers/chat.py             # read phát sự kiện; GET /rooms/{id}/members; GET /presence
├── app/routers/ws.py               # frame typing, presence theo vòng đời kết nối
├── app/main.py                     # chạy tác vụ quét presence trong lifespan
├── tests/test_receipts.py          # (mới)
├── tests/test_typing.py            # (mới)
└── tests/test_presence.py          # (mới)
README.md                           # hợp đồng WebSocket/REST mới
scripts/e2e_chat_ui.mjs             # thêm bước đã xem / đang soạn / online
frontend/src/
├── lib/types.ts                    # RoomMember, ServerEvent mở rộng
├── lib/chatApi.ts                  # members(), presence()
├── lib/chatStore.ts                # receipts, typing, online
├── lib/chatController.ts           # xử lý sự kiện, gửi typing, tải lại sau ready
├── components/chat/                # SeenLabel.tsx, TypingIndicator.tsx, PresenceDot.tsx; sửa Composer/MessageList/ConversationPane/RoomSidebar
└── index.css                       # kiểu chấm online, nhãn đã xem
```

---

### Task 1: Đã xem — sự kiện `read` và `GET /rooms/{id}/members` (backend)

**Files:**
- Modify: `backend/app/chat/service.py`, `backend/app/routers/chat.py`
- Create: `backend/tests/test_receipts.py`

**Interfaces:**
- Consumes: `service.mark_read`, `service.require_member`, `publish_room_safely`, `get_bus`, `get_ready_user`.
- Produces:
  - `service.mark_read(session, room_id, user_id, message_id) -> int | None`: trả mốc mới (đã `max`) **chỉ khi mốc thực sự tăng**, ngược lại `None`.
  - `service.list_members(session, room_id, user_id) -> list[MemberReceipt]` (kiểm tra thành viên bằng `require_member`; sắp theo `full_name`); `MemberReceipt(user_id, full_name, last_read_message_id)`.
  - `POST /rooms/{id}/read` vẫn 204; khi mốc tăng, sau khi commit gọi `publish_room_safely(bus, room_id, {"type":"read","room_id":room_id,"user_id":user.id,"message_id":<mốc mới>})`.
  - `GET /rooms/{id}/members` → `list[MemberReceiptOut]` (`user_id`, `full_name`, `last_read_message_id`).

- [ ] **Step 1: Viết test thất bại (`backend/tests/test_receipts.py`)** (dùng fixture/helper như `test_chat_api.py`, `test_ws.py`; đọc chúng trước)
1. `test_read_publishes_event_to_room_members_only`: phòng gồm A, B; C ngoài phòng. B mở WS. A gọi `POST /rooms/{id}/read` với tin id=X → B nhận `{"type":"read","room_id":..,"user_id":A,"message_id":X}`; C (kết nối WS riêng) không nhận gì trong 0,5 giây.
2. `test_read_event_only_when_marker_advances`: gọi read với X, rồi X lần nữa, rồi mốc nhỏ hơn X → chỉ sự kiện đầu được phát (đếm số sự kiện nhận), `last_read_message_id` trong DB không giảm.
3. `test_read_event_reaches_senders_other_tab`: A có hai kết nối WS; A gọi read → cả hai nhận `read` với `user_id == A` (đồng bộ đa tab).
4. `test_members_lists_receipts`: `GET /api/rooms/{id}/members` trả đủ thành viên với `last_read_message_id` đúng (null khi chưa đọc), sắp theo tên; người ngoài phòng → 404 `room_not_found`; phòng đã lưu trữ → 404; thành viên đã bị gỡ → 404.
5. `test_read_survives_bus_failure`: bus ném lỗi khi publish (dùng bus giả như các test bus hiện có) → request vẫn 204 và mốc vẫn được lưu.

- [ ] **Step 2: Chạy để xác nhận thất bại:** `bash scripts/test.sh tests/test_receipts.py -q`

- [ ] **Step 3: Viết mã** theo Interfaces. `mark_read` hiện `UPDATE … SET last_read = GREATEST(COALESCE(last_read,0), :id)`; đổi sang đọc mốc cũ (`SELECT … FOR UPDATE` hoặc `UPDATE … RETURNING` kèm so sánh) để biết mốc có tăng không, không làm mất tính đúng khi hai request song song. Router: `bus: MessageBus = Depends(get_bus)`, phát sự kiện sau commit khi hàm trả khác `None`.

- [ ] **Step 4: Chạy toàn bộ test backend:** `bash scripts/test.sh -q` → tất cả pass.

- [ ] **Step 5: Commit:** `git add backend && git commit -m "feat: broadcast read receipts and list room members with read markers" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"`

---

### Task 2: Đang soạn tin — frame `typing` (backend)

**Files:**
- Modify: `backend/app/routers/ws.py`, `backend/app/config.py`
- Create: `backend/tests/test_typing.py`

**Interfaces:**
- Consumes: `Connection.room_ids`, `publish_room_safely`, người dùng đã xác thực trong `websocket_endpoint` (cần `user.full_name`).
- Produces: `config.ws_typing_interval_seconds: float = Field(2.0, gt=0)`; `_handle_typing(conn, hub, data, state)` trong `ws.py`; `Connection` có thêm `user_name: str` (đặt khi tạo kết nối) và bộ nhớ `typing_last: dict[int, float]` (phòng → thời điểm gửi gần nhất, dùng `time.monotonic()`).
- Hành vi: frame `{"type":"typing","room_id":N}` → nếu `N` là int hợp lệ (1..MAX_ROOM_ID, không phải bool) **và** `N in conn.room_ids` **và** chưa gửi `typing` cho phòng đó trong `ws_typing_interval_seconds` → publish `{"type":"typing","room_id":N,"user_id":conn.user_id,"user_name":conn.user_name}` lên bus phòng. Phòng không thuộc `room_ids` hoặc bị giới hạn: bỏ qua im lặng (không lỗi). `room_id` sai kiểu/ngoài khoảng → `invalid_message` như `send`. Không tính vào giới hạn 20 tin/10 giây của `send`. Sự kiện **không** được echo trực tiếp cho người gửi ngoài đường bus (bus phòng vẫn gửi tới mọi kết nối trong phòng kể cả của người gửi; client tự bỏ qua `user_id` của mình).

- [ ] **Step 1: Viết test thất bại (`backend/tests/test_typing.py`)**
1. `test_typing_reaches_other_members_with_authenticated_identity`: A và B cùng phòng, B mở WS; A gửi typing → B nhận `{"type":"typing","room_id":R,"user_id":A,"user_name":"<tên A>"}`; nếu A gửi thêm `"user_id": 999` trong frame thì B vẫn nhận `user_id == A`.
2. `test_typing_not_delivered_outside_room`: C không ở phòng R, mở WS; A gửi typing vào R → C không nhận gì. Và C gửi typing vào R → không ai nhận (C không phải thành viên), C không nhận lỗi.
3. `test_typing_is_throttled_per_room`: A gửi 5 typing liên tiếp vào R (interval đặt 0,3 giây qua env của test) → B nhận đúng 1; đợi qua interval → typing tiếp theo được phát; typing vào phòng khác R2 không bị chặn bởi R.
4. `test_typing_invalid_room_id`: `room_id` là chuỗi/bool/0/2**31 → nhận `error invalid_message`.
5. `test_typing_does_not_consume_send_rate_limit`: gửi nhiều typing rồi vẫn gửi đủ số tin tối đa của giới hạn `send`.
6. `test_typing_after_archive_or_removal`: sau khi nhóm bị lưu trữ hoặc A bị gỡ khỏi nhóm (hub cập nhật `room_ids` qua `rooms_changed`), typing của A không còn đến B nữa.

- [ ] **Step 2: Chạy để xác nhận thất bại:** `bash scripts/test.sh tests/test_typing.py -q`
- [ ] **Step 3: Viết mã** (thêm biến `WS_TYPING_INTERVAL_SECONDS` vào `.env.example` và `tests/conftest.py` cho test, ví dụ 0.3).
- [ ] **Step 4: Chạy toàn bộ:** `bash scripts/test.sh -q`
- [ ] **Step 5: Commit:** `feat: relay typing indicators to room members`

---

### Task 3: Online — presence trong Redis (backend)

**Files:**
- Create: `backend/app/chat/presence.py`, `backend/tests/test_presence.py`
- Modify: `backend/app/chat/hub.py`, `backend/app/routers/ws.py`, `backend/app/routers/chat.py`, `backend/app/main.py`, `backend/app/config.py`, `.env.example`

**Interfaces:**
- Consumes: `get_redis()`, `Hub`/`Connection`, `service.user_room_ids`, `publish_room_safely`, `bus_channel_prefix`.
- Produces:
  - `config.presence_ttl_seconds: float = Field(45.0, gt=0)`, `config.presence_sweep_seconds: float = Field(15.0, gt=0)`.
  - `class Presence(redis, prefix, ttl)` với:
    - `await touch(user_id, conn_id)`: `ZADD {prefix}:online {now+ttl} "{user_id}:{conn_id}"`.
    - `await remove(user_id, conn_id)`: `ZREM`.
    - `await online_user_ids() -> set[int]`: xoá phần tử hết hạn (`ZREMRANGEBYSCORE -inf now`) rồi đọc tất cả, gộp theo `user_id`.
    - Dùng đồng hồ có thể tiêm (`clock: Callable[[], float] = time.time`) để test không phải ngủ thật.
  - `Hub` có `presence: Presence | None`; `Connection` có `conn_id: str` (uuid4 hex). `Hub.register` không đổi chữ ký; thêm `async Hub.on_connected(conn)` (gọi `presence.touch`, rồi nếu user vừa chuyển từ offline sang online thì `_announce(user_id, True)`) và `async Hub.on_disconnected(conn)` (`presence.remove`, rồi nếu user không còn online thì `_announce(user_id, False)`).
  - `Hub._announce(user_id, online)`: lấy `user_room_ids` của user (phòng chưa lưu trữ) và `publish_room_safely` `{"type":"presence","user_id":..,"online":..}` cho từng phòng. Lỗi Redis chỉ ghi log.
  - Tác vụ `Hub.run_presence_sweeper(interval)`: mỗi `interval` giây (a) `touch` lại mọi kết nối đang mở trên worker này, (b) tính `online_user_ids()` mới, so với tập `self._last_online` đã biết, (c) `_announce` cho người nào thay đổi (online→offline do hết hạn hoặc offline→online do worker khác), (d) lưu tập mới. Lỗi một lượt chỉ ghi log, vòng lặp không chết (mẫu `_reconcile_guarded`). Khởi tạo/huỷ trong `lifespan` cạnh `reconciler`.
  - `GET /presence` (`get_ready_user`) → `{"online_user_ids":[...]}`: giao của `online_user_ids()` với tập người chung ít nhất một phòng chưa lưu trữ với người gọi, **loại chính người gọi**. (Truy vấn: user_id khác trong các `room_members` của các phòng của người gọi.)
  - `ws.py`: sau khi gửi `ready`, `await hub.on_connected(conn)`; trong `finally` (trước/sau `hub.unregister`) `await hub.on_disconnected(conn)`; khi nhận `ping` từ client thì `await hub.presence.touch(...)` (làm mới ngoài vòng quét), bắt lỗi Redis.

- [ ] **Step 1: Viết test thất bại (`backend/tests/test_presence.py`)**
Unit (`Presence` với Redis test thật và đồng hồ giả):
1. `test_touch_makes_user_online_until_ttl`: touch → online; tiến đồng hồ vượt ttl → không còn online và phần tử đã bị xoá khỏi ZSET (kích thước về 0).
2. `test_two_connections_one_user`: touch hai `conn_id` của cùng user, remove một → vẫn online; remove cái còn lại → offline.
3. `test_touch_refreshes_expiry`.
Tích hợp (WS thật như `test_ws.py`; đặt `PRESENCE_SWEEP_SECONDS` nhỏ cho test):
4. `test_presence_event_on_connect_and_disconnect`: A và B chung phòng; B mở WS; A mở WS → B nhận `presence {A, online:true}`; A đóng WS → B nhận `presence {A, online:false}`.
5. `test_second_tab_close_keeps_user_online`: A mở hai WS, B nhận `online:true` đúng một lần; đóng một tab → B không nhận `online:false`; đóng tab cuối → nhận.
6. `test_presence_not_sent_to_users_without_shared_room`: C không chung phòng với A → không nhận presence của A.
7. `test_get_presence_scope`: A, B chung phòng, C chung phòng với B nhưng không với A, D ngoài mọi phòng; tất cả online → A gọi `GET /api/presence` chỉ thấy `[B]` (không thấy C, D, không thấy chính A); phòng chung đã lưu trữ thì không tính.
8. `test_sweeper_announces_expiry_and_survives_errors`: ép phần tử của A hết hạn (đồng hồ giả/xoá trực tiếp trong Redis) → lượt quét phát `online:false`; lượt đầu cố ý ném lỗi (redis giả) không làm tác vụ dừng.
9. `test_redis_failure_does_not_break_websocket`: Presence ném RedisError trong `on_connected`/`touch` → kết nối WS vẫn nhận `ready` và gửi/nhận tin bình thường.

- [ ] **Step 2: Chạy để xác nhận thất bại:** `bash scripts/test.sh tests/test_presence.py -q`
- [ ] **Step 3: Viết mã** theo Interfaces. Ghi chú: dùng một pipeline cho `touch`+dọn dẹp để hạn chế vòng tròn Redis; khoá ZSET `"{prefix}:online"` (prefix lấy từ `bus_channel_prefix` để test cô lập); `_announce` không được chặn vòng đời kết nối (bọc `try/except`, có thể `asyncio.create_task` rồi giữ tham chiếu trong tập để tránh bị thu gom, nhưng phải được huỷ khi `close_all`).
- [ ] **Step 4: Chạy toàn bộ:** `bash scripts/test.sh -q`
- [ ] **Step 5: Commit:** `feat: track online presence in redis and announce changes to shared rooms`

---

### Task 4: Frontend — kiểu, API, store, controller cho đã xem / đang soạn / online

**Files:**
- Modify: `frontend/src/lib/types.ts`, `frontend/src/lib/chatApi.ts`, `frontend/src/lib/chatStore.ts`, `frontend/src/lib/chatController.ts` và các test tương ứng (`chatApi.test.ts`, `chatStore.test.ts`, `chatController.test.ts`), `frontend/src/lib/ChatProvider.tsx` (hooks mới)

**Interfaces:**
- Consumes: `ServerEvent`, `ChatStore`, `ChatController`, `ChatSocket.send`.
- Produces:
  - `types.ts`: `RoomMember {user_id:number; full_name:string; last_read_message_id:number|null}`; `ServerEvent` thêm `{type:'typing'; room_id:number; user_id:number; user_name:string}`, `{type:'read'; room_id:number; user_id:number; message_id:number}`, `{type:'presence'; user_id:number; online:boolean}`.
  - `chatApi.members(roomId) -> RoomMember[]`; `chatApi.presence() -> {online_user_ids:number[]}`.
  - `ChatState` thêm: `members: Record<number, RoomMember[]>` (theo phòng), `online: Record<number, true>` (tập user_id online), `typing: Record<number, Record<number, {name:string; until:number}>>` (phòng → user → hạn). Store: `setMembers(roomId, members)`, `applyRead(roomId, userId, messageId)` (chỉ tăng, bỏ qua user không có trong danh sách… nhưng vẫn lưu nếu danh sách chưa tải? — **không lưu**: chỉ cập nhật khi `members[roomId]` đã có; mốc sẽ đúng khi `setMembers` tải lần đầu), `setOnline(ids)`, `setPresence(userId, online)`, `setTyping(roomId, userId, name, until)`, `clearTyping(roomId, userId)`, `pruneTyping(now)`; thread bị `removeThreads` thì xoá luôn `members`/`typing` của phòng.
  - `ChatController`: xử lý `typing` (bỏ qua `user_id === meId`; đặt hạn `now + 5000`; hẹn giờ dọn bằng `setTimeout` và huỷ trong `dispose`), `read` (gọi `applyRead`; nếu `user_id === meId` thì đồng thời `clearUnread(room)` — đồng bộ đa tab), `presence`. Tin `message` từ người nào thì `clearTyping(room, sender)`. Sau mỗi `ready`/`resync`: `refreshPresence()` (gọi `presence()` → `setOnline`) và `loadMembers(roomId)` cho phòng đang mở (`activeRoom`) — chỉ một lần cùng lúc cho mỗi phòng. `openRoom` cũng gọi `loadMembers`. `sendTyping(roomId)`: giới hạn **tối đa 1 lần/3 giây mỗi phòng**, chỉ gửi khi socket `open` (dùng `socket.send` trả true), không ném lỗi. `leaveRoom` không xoá members (giữ cho lần mở lại).
  - `ChatProvider.tsx`: hooks `useMembers(roomId)`, `useTyping(roomId)` (danh sách tên còn hạn, loại `meId`), `useOnline(userId)`.

- [ ] **Step 1: Viết test thất bại** (mỗi mục là một test; dùng cùng khuôn mock như test hiện có)
chatApi: `members` và `presence` gọi đúng đường dẫn. chatStore: `applyRead` chỉ tăng và bỏ qua khi chưa tải members; `setTyping`/`pruneTyping` xoá đúng người hết hạn; `removeThreads` xoá members/typing; mọi thay đổi tạo snapshot mới. chatController:
1. `typing` của người khác tạo mục có hạn 5 giây và biến mất khi `vi.advanceTimersByTime(5000)`; `typing` của chính mình bị bỏ qua.
2. `message` từ người đang soạn tin xoá "đang soạn" của họ ngay.
3. `read` của người khác cập nhật mốc trong `members`; `read` của chính mình xoá chưa đọc của phòng đó (và không lỗi nếu phòng không có trong danh sách).
4. `presence` bật/tắt `online[userId]`; `ready` tải lại presence và members của phòng đang mở (kiểm đúng số lần gọi API, không gọi members cho phòng chưa mở).
5. `sendTyping` gửi đúng `{type:'typing',room_id}`, chỉ 1 lần trong 3 giây dù gọi 10 lần, gửi lại sau 3 giây, không gửi khi socket đóng, không ném lỗi khi `send` trả false.
6. Hai `loadMembers` đồng thời cho cùng một phòng chỉ gọi API một lần; lỗi API không làm hỏng trạng thái (members cũ giữ nguyên).
7. `dispose` huỷ hẹn giờ typing (không còn timer: `vi.getTimerCount() === 0`).

- [ ] **Step 2: Chạy để xác nhận thất bại:** `npm test` (trong `frontend/`)
- [ ] **Step 3: Viết mã** theo Interfaces.
- [ ] **Step 4: Chạy:** `npm test && npm run typecheck && npm run build`
- [ ] **Step 5: Commit:** `feat: track read receipts, typing and presence in the chat store and controller`

---

### Task 5: Frontend — hiển thị (đã xem, đang soạn tin, chấm online)

**Files:**
- Create: `frontend/src/components/chat/SeenLabel.tsx`, `TypingIndicator.tsx`, `PresenceDot.tsx` và test cho từng cái
- Modify: `frontend/src/components/chat/Composer.tsx`, `MessageList.tsx` (hoặc `MessageItem.tsx`), `ConversationPane.tsx`, `RoomSidebar.tsx`, `frontend/src/index.css`, `frontend/src/pages/ChatLayout.test.tsx` (thêm ca tích hợp)

**Interfaces:**
- Consumes: hooks của Task 4, `Message`, `Room`, `RoomMember`.
- Produces:
  - `SeenLabel({ seenBy: string[], total: number, isGroup: boolean })` — chat 1-1: `Đã xem` khi `seenBy.length ≥ 1`, ngược lại không hiện gì; nhóm: `Đã xem bởi {n} người` (`title` = tên, nối bằng ", ") khi `n ≥ 1`, ngược lại `Đã gửi`… (không hiện gì khi không ai xem).
  - `TypingIndicator({ names: string[] })` — `role="status"`, `aria-live="polite"`: 1 người `{tên} đang soạn tin…`, 2 người `{a} và {b} đang soạn tin…`, ≥3 `Nhiều người đang soạn tin…`; rỗng thì không render.
  - `PresenceDot({ online: boolean, label?: string })` — chấm xanh `#12B76A` (`aria-label="Đang hoạt động"`) khi online; không render khi offline (tránh nhiễu); kích thước 12px, có viền nền.
  - `Composer` nhận `onTyping?: () => void`: gọi khi nội dung thay đổi và **không rỗng** (không gọi khi xoá hết, khi `disabled`, hay trong lúc bộ gõ đang soạn dấu **vẫn gọi** vì người dùng đang gõ).
  - `ConversationPane`: tiêu đề phòng direct hiện `PresenceDot` + chữ "Đang hoạt động" khi người kia online; truyền `onTyping={() => controller.sendTyping(roomId)}`; hiện `TypingIndicator` ngay trên ô soạn tin; tính `SeenLabel` cho **tin thật cuối cùng của chính mình** (không tính tin đã xoá, tin đang chờ/lỗi): `seenBy` = thành viên khác mình có `last_read_message_id ≥ id` của tin đó.
  - `RoomSidebar`: avatar phòng direct có `PresenceDot` ở góc dưới phải khi người kia (`peer_id`) online.

- [ ] **Step 1: Viết test thất bại**
SeenLabel/TypingIndicator/PresenceDot: các nhánh nêu trên (bao gồm rỗng không render, `title` đúng tên, định dạng 1/2/≥3 người). Composer: `onTyping` gọi khi gõ, không gọi khi xoá hết/`disabled`, không phá hành vi Enter/IME hiện có. Tích hợp `ChatLayout.test.tsx` (mockFetch + FakeWebSocket): (a) mở phòng nhóm, `GET /rooms/1/members` trả mốc, gửi tin của mình → nhãn "Đã xem bởi 1 người" xuất hiện sau khi nhận sự kiện `read` của người khác với `message_id` ≥ id tin, và nhãn **chuyển sang tin mới nhất** của mình khi gửi thêm tin; (b) `typing` của người khác hiện dòng "…đang soạn tin…" rồi biến mất sau 5 giây (fake timers), và biến mất ngay khi họ gửi tin; (c) `presence online:true` của người kia hiện chấm trong sidebar và "Đang hoạt động" ở tiêu đề phòng direct, `online:false` thì mất; (d) sau reconnect (`serverClose` rồi `ready`) trạng thái presence/members được tải lại (khẳng định các request `/api/presence` và `/api/rooms/1/members` được gọi lại); (e) gõ vào ô soạn tin gửi khung `typing` qua `FakeWebSocket.sent` đúng 1 lần trong 3 giây.

- [ ] **Step 2: Chạy để xác nhận thất bại:** `npm test`
- [ ] **Step 3: Viết mã.** Kiểu CSS: `.presence-dot { width:12px;height:12px;border-radius:50%;background:#12B76A;border:2px solid var(--surface); }` (đặt tuyệt đối ở góc avatar), `.seen-label { font-size:12px; color: var(--muted); }`, `.typing-indicator { padding: 0 20px 4px; font-size: 13px; color: var(--muted); min-height: 20px; }` (giữ chiều cao cố định để khung chat không nhảy khi dòng xuất hiện/biến mất; render `<div role="status">` luôn có mặt, nội dung rỗng khi không ai gõ).
- [ ] **Step 4: Chạy:** `npm test && npm run typecheck && npm run build`
- [ ] **Step 5: Commit:** `feat: show seen labels, typing indicator and presence dots`

---

### Task 6: Kiểm tra trình duyệt thật và tài liệu

**Files:**
- Modify: `scripts/e2e_chat_ui.mjs`, `README.md`

**Interfaces:**
- Consumes: toàn bộ stack (`docker compose -p kn-e2e …`), script e2e hiện có (đọc kỹ cấu trúc `step`, helper chờ, hai ngữ cảnh Alice/Bob, proxy WebSocket).
- Produces: các bước mới trong script, README cập nhật.

- [ ] **Step 1: Thêm vào `scripts/e2e_chat_ui.mjs`** (sau các bước chat hiện có, trước bước khoá tài khoản):
  1. **Online:** Alice và Bob chung phòng; cả hai đang mở → Alice thấy chấm online ở phòng direct với Bob; Bob đóng trang (`page.close()`) → trong tối đa 20 giây Alice thấy chấm biến mất; Bob mở lại → chấm trở lại. Bob mở **hai tab**, đóng một → chấm vẫn còn.
  2. **Đang soạn tin:** Bob gõ (không gửi) vào ô soạn → Alice thấy "Bob … đang soạn tin…" trong 2 giây; Bob dừng gõ → dòng biến mất trong 6 giây; Bob gửi tin → dòng biến mất ngay.
  3. **Đã xem:** Alice gửi tin ở phòng direct khi Bob **không** mở phòng đó → không có nhãn "Đã xem"; Bob mở phòng → Alice thấy "Đã xem" dưới tin cuối trong 3 giây; trong nhóm 3 người: nhãn "Đã xem bởi 1 người" rồi "…2 người" khi người thứ hai đọc.
  4. **Sau mất mạng:** cắt WebSocket của Alice (cơ chế đã có), Bob gửi và đọc nhiều thứ trong lúc đó, nối lại → trạng thái online/đã xem của Alice đúng (không treo trạng thái cũ).
  5. **Quyền riêng tư:** người dùng Dave không chung phòng với Alice → Alice không bao giờ thấy chấm online của Dave dù Dave đang online (kiểm `GET /api/presence` bằng REST với token của Alice không chứa id của Dave).
- [ ] **Step 2: Chạy thật:** theo quy trình trong README mục "Kiểm tra trên trình duyệt thật" (project riêng `-p kn-e2e`, `.env` tạm sao lưu và khôi phục, không đụng project dev). Mọi bước hiện có vẫn phải pass. Bước hỏng: điều tra nguyên nhân gốc (mã hay script), sửa mã bằng commit `fix:` riêng kèm test; không nới kiểm tra.
- [ ] **Step 3: README:** cập nhật mục "API chat (tóm tắt)" với hợp đồng mới (Global Constraints), mục "Giao diện chat" thêm đã xem/đang soạn/online và quy tắc riêng tư (chỉ người chung phòng); ghi biến môi trường mới.
- [ ] **Step 4: Chạy lại toàn bộ test:** `cd frontend && npm test && npm run build`, `bash scripts/test.sh -q`.
- [ ] **Step 5: Commit:** `test: extend real-browser e2e for seen, typing and presence; document the new realtime events`

---

## Self-Review

**Spec coverage (mục 5 và 11 phần thuộc plan này):** `typing`/`read`/`presence` có đủ cả hai chiều; "đã xem" bằng `last_read_message_id` (mục 3); online/typing qua Redis với TTL (online) và pub/sub có hết hạn (typing) — typing không lưu Redis là điều chỉnh có chủ ý đã ghi ở "Quyết định thiết kế"; đồng bộ đã đọc giữa các tab (Task 1 test 3, Task 4 test 3). Reply, @mention, thông báo trình duyệt chuyển sang Plan 6 (ghi ở phần mở đầu).

**Placeholder scan:** không có "TBD"/"TODO". Task 3-6 mô tả hành vi, hợp đồng và danh sách test cụ thể thay vì dán toàn bộ mã vì các mẫu tương tự đã có sẵn trong repo (`Hub.run_reconciler`, `test_ws.py`, `ChatLayout.test.tsx`, script e2e); người thực hiện phải đọc các tệp được nêu ở từng task.

**Nhất quán tên:** sự kiện `typing`/`read`/`presence`; `Connection.user_name`/`conn_id`; `Presence.touch/remove/online_user_ids`; `Hub.on_connected/on_disconnected/run_presence_sweeper`; `chatApi.members/presence`; store `members/online/typing`; controller `sendTyping/loadMembers/refreshPresence`; component `SeenLabel/TypingIndicator/PresenceDot`.

**Review Focus:** 8 dòng đều có test: ngoài phòng (T1.1, T2.2, T3.6), `read` chỉ khi tiến (T1.2), nhiều tab (T3.5), hết hạn Redis (T3.1, T3.8), riêng tư presence (T3.7, T6.5), typing hết hạn/xoá khi gửi tin (T4.1-2, T5 tích hợp b), đã xem sau reconnect và chuyển sang tin mới nhất (T5 a, d), giới hạn typing phía client (T4.5, T5 e).

## Các plan tiếp theo

| Plan | Nội dung |
|---|---|
| 6 | Reply một tin, @mention (gợi ý từ thành viên phòng), thông báo trình duyệt (Web Notification, âm báo, badge số chưa đọc trên tiêu đề tab) |
| 7 | File đính kèm (xem trước ảnh), tìm kiếm tin nhắn tiếng Việt, nhảy tới tin bằng `around` |
| 8 | Vận hành: HTTPS nội bộ, giới hạn IP admin, sao lưu/khôi phục, thử tải 100.000 tin, giới hạn kết nối WS, dọn `refresh_tokens`, ghim phiên bản |
