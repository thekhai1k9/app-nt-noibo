# Plan 5b: Nhóm chat do người dùng tự tạo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Người dùng thường (không chỉ admin) tạo được nhóm chat với nhiều thành viên (kể cả khác chi nhánh), và chủ nhóm tự quản lý nhóm của mình: đổi tên, thêm/bớt thành viên, giải tán; thành viên khác có thể rời nhóm.

**Architecture:** Dùng lại bảng `rooms`/`room_members` và cơ chế lưu trữ 3 ngày của Plan 4. Người tạo nhóm có `room_members.role = 'owner'`. Thêm endpoint người dùng (không phải `/admin`) cho phòng loại `group`; mỗi thay đổi thành viên báo `rooms_changed` cho những người bị ảnh hưởng nên hub tự cập nhật quyền ngay. Frontend thêm tab "Tạo nhóm" vào hộp thoại "+ Mới" và một bảng "Thông tin nhóm" mở từ tiêu đề cuộc trò chuyện.

**Tech Stack:** FastAPI + SQLAlchemy async + Redis (Plan 3-5); React 18 + TypeScript + Vitest (Plan 4-5).

**Spec:** `docs/superpowers/specs/2026-10-12-internal-messaging-design.md` (mục 3: bảng `rooms`/`room_members` có `role owner/member`; mục 5: `POST /rooms` tạo nhóm hoặc mở direct, thêm/bớt thành viên). Plan 4 mới chỉ làm phía admin; plan này làm phần dành cho người dùng thường.

## Quyết định đã chốt (chủ dự án đã chọn)

- **Quyền quản lý:** chỉ **người tạo nhóm (chủ nhóm)** đổi tên, thêm/bớt thành viên, giải tán. Thành viên khác chỉ chat và có thể **tự rời nhóm**.
- **Liên chi nhánh:** nhóm do người dùng tạo có thể mời **mọi người đang hoạt động** (từ danh bạ toàn công ty). Nhóm do người dùng tạo có `branch_id = NULL`.
- **Giải tán nhóm:** chủ nhóm giải tán = **lưu trữ 3 ngày** như nhóm admin xoá (ẩn ngay với mọi người; admin khôi phục được trong 3 ngày ở trang "Phòng và nhóm"; sau đó xoá vĩnh viễn).
- **Quyết định kèm theo (tôi tự chốt, có thể đổi):** (1) nhóm do admin tạo không có chủ nhóm: người dùng thường không quản lý được, nhưng vẫn rời được; (2) chủ nhóm rời nhóm → quyền chủ chuyển cho thành viên vào nhóm sớm nhất còn lại; thành viên cuối cùng rời → nhóm được lưu trữ; (3) mỗi người là chủ tối đa **20 nhóm đang hoạt động** (`MAX_OWNED_GROUPS`, mặc định 20) để chống tạo hàng loạt; (4) tối đa **200 thành viên** mỗi nhóm (như trang admin); (5) người bị gỡ khỏi nhóm mất quyền truy cập ngay nhưng **tin nhắn cũ vẫn ở lại** cho các thành viên còn lại; nếu được thêm lại sau này họ thấy toàn bộ lịch sử cũ nhưng mốc đã đọc đặt ở tin mới nhất (như trang admin hiện có).

## Global Constraints

- Mọi giao diện bằng tiếng Việt; nút/vùng bấm tối thiểu 44px; hộp thoại có `role="dialog"`, đóng bằng Esc, trả focus về nút mở.
- Backend test chỉ qua `bash scripts/test.sh <args>`; frontend test chạy trực tiếp (`npm test`, `npm run typecheck`, `npm run build` trong `frontend/`).
- Hợp đồng REST mới (đều cần `get_ready_user`, tiền tố `/api`, mã lỗi tiếng Anh dạng snake_case như hiện có):
  - `POST /rooms/group` body `{name: str(1..100, tự strip), member_ids: int[] (0..199, bỏ trùng, bỏ chính mình)}` → 201 `RoomOut` (xem dưới). Người tạo tự là thành viên với `role='owner'`. Thành viên phải là người dùng **đang hoạt động** (không thì 404 `user_not_found`, không tạo gì). Vượt `MAX_OWNED_GROUPS` → 409 `too_many_groups`.
  - `PATCH /rooms/{id}` body `{name}` → `RoomOut`. Chỉ chủ nhóm; người khác trong phòng → 403 `forbidden`; người ngoài phòng → 404 `room_not_found`; phòng direct → 404 `room_not_found`.
  - `POST /rooms/{id}/members` body `{user_id}` → 200 `list[MemberOut]` (đã cập nhật). Chỉ chủ nhóm. Người dùng không hoạt động/không tồn tại → 404 `user_not_found`. Đã là thành viên → idempotent (200, không đổi gì). Vượt 200 thành viên → 409 `group_full`. Mốc đã đọc của người mới = id tin mới nhất của phòng.
  - `DELETE /rooms/{id}/members/{user_id}` → 200 `list[MemberOut]`. Chỉ chủ nhóm; không được gỡ chính mình (dùng `leave`) → 400 `cannot_remove_self`; không phải thành viên → 404 `member_not_found`.
  - `POST /rooms/{id}/leave` → 204. Mọi thành viên (kể cả nhóm admin tạo). Chủ nhóm rời → chuyển quyền cho thành viên có `joined_at` sớm nhất (hòa thì `user_id` nhỏ nhất) còn lại; không còn ai → lưu trữ phòng.
  - `DELETE /rooms/{id}` → 204. Chỉ chủ nhóm; đặt `archived_at = now()` (cùng cơ chế admin).
  - `GET /rooms/{id}/members` (Plan 5) trả thêm `role: "owner"|"member"`.
  - `RoomOut` thêm `my_role: "owner"|"member"|null` (`null` cho phòng direct).
- Mỗi thay đổi thành viên/tên/giải tán gọi `publish_user_safely(bus, user_id, {"type":"rooms_changed"})` cho **mọi người bị ảnh hưởng** (người được thêm, người bị gỡ, và các thành viên còn lại khi đổi tên/giải tán); sau commit; Redis lỗi không làm hỏng yêu cầu. Người bị gỡ/rời/phòng bị giải tán không còn nhận `message/typing/read/presence` của phòng đó ngay sau khi hub xử lý `rooms_changed`.
- Mọi kiểm tra quyền đọc từ DB trong cùng giao dịch với thao tác (không tin dữ liệu từ client), thao tác đua nhau (hai request cùng thêm một người, chủ nhóm rời cùng lúc với thêm thành viên) không để lại phòng không có chủ nhưng còn thành viên nếu phòng vốn có chủ, và không gây lỗi 500.
- Tên nhóm hiển thị bằng text thuần; không đưa tên/thành viên vào log.

## Review Focus

- Thành viên không phải chủ gọi PATCH/thêm/gỡ/giải tán bị 403, người ngoài phòng bị 404 (không lộ phòng tồn tại), phòng direct và phòng đã lưu trữ luôn 404 (Task 1, 2).
- Người bị gỡ/rời/giải tán mất quyền ngay (REST, WebSocket `typing/read/presence/message`) và các thành viên còn lại không thấy gì lạ (Task 2).
- Chủ nhóm rời → chuyển quyền đúng người; người cuối rời → lưu trữ; không ai ở trạng thái "nhóm có thành viên nhưng không chủ" sau thao tác của người dùng (Task 2).
- Giới hạn 20 nhóm và 200 thành viên không bị vượt kể cả khi gọi song song; tạo nhóm với danh sách chứa người không hoạt động không tạo nửa chừng (Task 1, 2).
- Frontend: nút quản lý chỉ hiện cho chủ nhóm nhưng quyền thật do server quyết định (UI hiện lỗi tiếng Việt khi bị 403/409); sau khi rời/giải tán/bị gỡ, người dùng đang mở nhóm thấy thông báo "không còn trong nhóm" và quay về danh sách, không treo ở màn hình lỗi (Task 3, 4).

---

## File Structure

```
backend/
├── app/config.py                  # max_owned_groups, max_group_members
├── app/chat/service.py            # create_group, rename_group, add_group_member, remove_group_member, leave_group, dissolve_group, my_role trong list_rooms
├── app/chat/schemas.py            # RoomOut.my_role, MemberReceiptOut.role
├── app/routers/chat.py            # endpoint người dùng (create/rename/members/leave/dissolve)
├── tests/test_user_groups.py      # (mới)
README.md, .env.example            # hợp đồng + biến môi trường
frontend/src/
├── lib/types.ts, chatApi.ts, errors.ts          # kiểu, API, mã lỗi tiếng Việt
├── lib/chatController.ts                        # createGroup, renameGroup, addMember, removeMember, leaveGroup, dissolveGroup
├── components/chat/NewChatDialog.tsx            # thêm tab "Tạo nhóm"
├── components/chat/GroupPanel.tsx               # (mới) bảng "Thông tin nhóm"
├── components/chat/ConversationPane.tsx         # nút mở bảng, xử lý mất quyền
scripts/e2e_chat_ui.mjs                          # bước tạo nhóm / quản lý / rời
```

---

### Task 1: Backend — tạo nhóm bởi người dùng và `my_role`

**Files:** Modify `backend/app/config.py`, `backend/app/chat/service.py`, `backend/app/chat/schemas.py`, `backend/app/routers/chat.py`, `.env.example`; Create `backend/tests/test_user_groups.py`

**Interfaces:**
- Consumes: `service.list_rooms`, `service.require_member`, `Room`/`RoomMember`, `publish_user_safely`, `get_bus`, mẫu hiện có trong `backend/app/routers/admin_rooms.py` (tạo phòng, mốc đã đọc của thành viên mới, `_notify`).
- Produces: `config.max_owned_groups: int = Field(20, gt=0)`, `config.max_group_members: int = Field(200, gt=0)`; `service.create_group(session, user, name, member_ids) -> Room`; `service.list_rooms` trả `my_role`; `POST /rooms/group`; `RoomOut.my_role`; `GET /rooms/{id}/members` trả `role`. Trả về của `POST /rooms/group` là cùng dạng phần tử của `GET /rooms` (dùng lại logic xây `RoomOut`).

- [ ] **Step 1: Viết test thất bại (`backend/tests/test_user_groups.py`)** — dùng fixture/helper như `test_chat_api.py`/`test_admin_rooms.py` (đọc trước).
1. `test_user_creates_group_with_members_across_branches`: user A (chi nhánh 1) tạo nhóm với B (chi nhánh 2) và C → 201; A là `my_role=owner`; B, C thấy phòng trong `GET /rooms` với `my_role=member`, `member_count=3`, `branch_id=null`; `GET /rooms/{id}/members` có `role` đúng; B và C nhận `rooms_changed` qua WebSocket.
2. `test_group_name_is_stripped_and_validated`: tên rỗng/chỉ khoảng trắng/>100 ký tự → 422; tên có khoảng trắng đầu cuối được cắt.
3. `test_group_member_ids_dedupe_and_ignore_self`: `member_ids` chứa A, B, B → nhóm có đúng 2 thành viên.
4. `test_inactive_or_missing_member_creates_nothing`: một id không hoạt động hoặc không tồn tại → 404 `user_not_found` và không có phòng mới trong DB.
5. `test_too_many_member_ids`: 200 id (thêm người tạo thành 201) → 422/409 `group_full`; đúng 199 id + người tạo là hợp lệ.
6. `test_owned_group_limit`: đặt `MAX_OWNED_GROUPS=2` (qua env test); tạo 2 nhóm ok, nhóm thứ 3 → 409 `too_many_groups`; nhóm đã lưu trữ không tính vào giới hạn.
7. `test_group_can_be_created_alone`: `member_ids=[]` → hợp lệ (nhóm 1 người, sẽ mời sau).
8. `test_unauthenticated_and_must_change_password_rejected`: như các endpoint chat khác (401/403 theo `get_ready_user`).
9. `test_my_role_for_admin_created_and_direct_rooms`: nhóm admin tạo → `my_role='member'` (không chủ); phòng direct → `null`.

- [ ] **Step 2: Chạy để xác nhận thất bại:** `bash scripts/test.sh tests/test_user_groups.py -q`
- [ ] **Step 3: Viết mã.** Đếm nhóm đã sở hữu bằng truy vấn `room_members.role='owner' AND rooms.archived_at IS NULL`; để giới hạn đúng khi gọi song song, khoá hàng người dùng tạo (`SELECT … FOR UPDATE` trên `users`) hoặc dùng `pg_advisory_xact_lock(user_id)` trong giao dịch tạo. Tạo phòng + toàn bộ thành viên trong **một giao dịch** (không để nửa chừng nếu một id sai). Mốc đã đọc của thành viên mới = null (phòng mới chưa có tin). Thông báo `rooms_changed` cho các thành viên được mời sau commit.
- [ ] **Step 4: Chạy toàn bộ:** `bash scripts/test.sh -q`
- [ ] **Step 5: Commit:** `feat: let any user create a group chat and expose their role`

---

### Task 2: Backend — quản lý nhóm (đổi tên, thêm/bớt, rời, giải tán)

**Files:** Modify `backend/app/chat/service.py`, `backend/app/routers/chat.py`; Modify/extend `backend/tests/test_user_groups.py`

**Interfaces:**
- Consumes: Task 1; `Hub` (cập nhật `room_ids` qua `rooms_changed`), `admin_rooms` (mẫu thêm thành viên với mốc đã đọc = tin mới nhất).
- Produces: `service.rename_group`, `service.add_group_member`, `service.remove_group_member`, `service.leave_group`, `service.dissolve_group` và các endpoint trong Global Constraints. Một helper `_owned_group(session, room_id, user_id) -> Room` (404/403 đúng quy tắc) dùng chung.

- [ ] **Step 1: Viết test thất bại** (thêm vào `test_user_groups.py`):
1. `test_only_owner_can_rename_add_remove_dissolve`: thành viên thường gọi PATCH, POST members, DELETE members, DELETE room → 403 `forbidden`; người ngoài phòng → 404 `room_not_found`; phòng direct → 404; phòng đã lưu trữ → 404.
2. `test_owner_renames_and_members_get_rooms_changed`: PATCH ok, mọi thành viên nhận `rooms_changed`, `GET /rooms` thấy tên mới.
3. `test_owner_adds_member_with_read_marker_at_latest`: có sẵn 5 tin; thêm D → D thấy phòng, `unread_count=0`, đọc được lịch sử; thêm lại D lần nữa idempotent (200, không lỗi, không sự kiện dư thừa quan trọng); người không hoạt động → 404 `user_not_found`; đủ 200 thành viên rồi thêm → 409 `group_full`.
4. `test_removed_member_loses_access_immediately`: C đang mở WebSocket; chủ gỡ C → C nhận `rooms_changed`, sau đó `GET /rooms/{id}/messages` → 404, gửi `send` vào phòng → `error room_not_found`, không nhận `message/typing/read/presence` mới của phòng; các thành viên còn lại không thấy gì bất thường; không gỡ được chính mình → 400 `cannot_remove_self`; gỡ người không phải thành viên → 404 `member_not_found`; tin cũ của C vẫn còn trong lịch sử của những người khác.
5. `test_member_leaves`: thành viên thường rời → 204, mất quyền, các thành viên còn lại nhận `rooms_changed`; rời lần hai → 404.
6. `test_owner_leaves_transfers_ownership`: chủ rời → thành viên `joined_at` sớm nhất (hòa → `user_id` nhỏ nhất) thành `owner` (kiểm qua `GET /rooms/{id}/members` và `my_role`); đúng một owner sau thao tác.
7. `test_last_member_leaving_archives_the_group`: người cuối rời → `rooms.archived_at` khác null; admin thấy trong `GET /admin/rooms?archived=true`.
8. `test_leave_admin_created_group_allowed_but_no_management`: thành viên nhóm admin tạo rời được; không PATCH/thêm/gỡ/giải tán được (403).
9. `test_owner_dissolves_group`: DELETE → 204, nhóm ẩn với mọi thành viên (REST + WS `rooms_changed`), `archived_at` đặt, admin khôi phục được qua `POST /admin/rooms/{id}/restore` và chủ nhóm vẫn là owner sau khôi phục.
10. `test_concurrent_add_member_is_safe`: hai request song song thêm cùng một người → đều 200, đúng một dòng `room_members`; hai request song song thêm người khi nhóm còn 1 chỗ trống → đúng một thành công, một 409, không vượt 200.
11. `test_owner_leave_races_with_add`: chủ rời song song với việc thêm thành viên → kết quả hợp lệ (nhóm còn một owner hoặc đã lưu trữ), không 500.
12. `test_events_to_removed_user_dont_leak_to_others`: gỡ C không làm các thành viên còn lại nhận `presence`/`typing` của C sau đó (C không còn trong phòng).

- [ ] **Step 2: Chạy để xác nhận thất bại:** `bash scripts/test.sh tests/test_user_groups.py -q`
- [ ] **Step 3: Viết mã.** Mọi thao tác chạy trong một giao dịch, khoá hàng phòng (`SELECT … FROM rooms WHERE id=… FOR UPDATE`) trước khi kiểm tra quyền/đếm thành viên/chuyển quyền để loại các cuộc đua. Thứ tự kiểm tra: phòng tồn tại + chưa lưu trữ + là `group` + người gọi là thành viên (nếu không → 404 `room_not_found`) → vai trò chủ (nếu không → 403 `forbidden`). `rooms_changed` gửi sau commit cho tất cả người bị ảnh hưởng (kể cả người bị gỡ/rời, vì hub cần tính lại `room_ids` của họ).
- [ ] **Step 4: Chạy toàn bộ:** `bash scripts/test.sh -q`
- [ ] **Step 5: Commit:** `feat: let group owners manage members and let members leave`

---

### Task 3: Frontend — kiểu, API, controller và tab "Tạo nhóm"

**Files:** Modify `frontend/src/lib/{types,chatApi,errors,chatController}.ts` (+ test của từng file), `frontend/src/components/chat/NewChatDialog.tsx` (+ test), `frontend/src/test/utils.tsx` (nếu cần `makeRoom` có `my_role`)

**Interfaces:**
- Consumes: Task 1/2 hợp đồng; `chatApi.directory`, `ChatController.openDirect`, `ChatStore.upsertRoom`.
- Produces:
  - `types.ts`: `Room.my_role: 'owner' | 'member' | null`; `RoomMember.role: 'owner' | 'member'`.
  - `chatApi`: `createGroup(name, memberIds) -> Room`, `renameGroup(roomId, name) -> Room`, `addMember(roomId, userId) -> RoomMember[]`-tương-thích-với-`MemberOut` (`user_id, full_name, last_read_message_id, role`), `removeMember(roomId, userId)`, `leaveGroup(roomId)`, `dissolveGroup(roomId)`.
  - `errors.ts`: tiếng Việt cho `too_many_groups` ("Bạn đang quản lý quá nhiều nhóm. Hãy giải tán bớt."), `group_full` ("Nhóm đã đủ số thành viên tối đa."), `cannot_remove_self` ("Hãy dùng \"Rời nhóm\" để tự rời."), và các mã đã có (`forbidden`, `user_not_found`, `member_not_found`, `room_not_found`) vẫn đúng ngữ cảnh nhóm.
  - `ChatController`: `createGroup(name, memberIds) -> Promise<Room>` (upsert phòng vào store rồi trả phòng, điều hướng do UI), `renameGroup`, `addMember`, `removeMember`, `leaveGroup`, `dissolveGroup` (mỗi cái gọi API, cập nhật store/`loadMembers` khi cần, `loadRooms` sau khi rời/giải tán; lỗi ném lại cho UI), tất cả không để rò hẹn giờ.
  - `NewChatDialog`: hai tab `role="tab"` "Nhắn riêng" (như hiện có) và "Tạo nhóm": ô "Tên nhóm" (`aria-label="Tên nhóm"`, tối đa 100), ô tìm người (`aria-label="Tìm người để thêm"`, debounce 250ms như tab cũ), danh sách người có hộp chọn nhiều, các "chip" người đã chọn (có nút bỏ chọn `aria-label="Bỏ {tên}"`; giữ lựa chọn khi đổi từ khoá tìm), nút "Tạo nhóm" (vô hiệu khi tên rỗng hoặc đang gửi; cho phép tạo nhóm không có thành viên khác). Thành công → đóng hộp thoại và điều hướng `/chat/{id}`. Lỗi hiện `ErrorAlert`. Esc/backdrop bị bỏ qua khi đang gửi; focus bẫy và trả về nút mở như tab cũ.

- [ ] **Step 1: Viết test thất bại:** chatApi (đường dẫn/phương thức/body chính xác cho 6 hàm, `member_ids` là mảng số); errors (3 mã mới có thông báo riêng); controller (createGroup upsert phòng + trả phòng; leave/dissolve gọi `loadRooms` và xoá thread qua cơ chế prune hiện có; lỗi API ném lên và không thay đổi store; chống gọi trùng khi đang chạy); NewChatDialog: chuyển tab giữ trạng thái hợp lý, chọn nhiều người xuyên qua các lần tìm, chip bỏ chọn, tạo nhóm gửi đúng `{name, member_ids}`, nút vô hiệu khi tên rỗng/đang gửi, lỗi 409 `too_many_groups` hiển thị tiếng Việt, đóng bị chặn khi đang gửi, điều hướng sau khi tạo.
- [ ] **Step 2: Chạy để xác nhận thất bại:** `npm test`
- [ ] **Step 3: Viết mã** theo Interfaces.
- [ ] **Step 4: Chạy:** `npm test && npm run typecheck && npm run build`
- [ ] **Step 5: Commit:** `feat: create group chats from the new-chat dialog`

---

### Task 4: Frontend — bảng "Thông tin nhóm" (xem, quản lý, rời, giải tán)

**Files:** Create `frontend/src/components/chat/GroupPanel.tsx` (+ test); Modify `frontend/src/components/chat/ConversationPane.tsx` (+ test), `frontend/src/pages/ChatLayout.test.tsx` (ca tích hợp), `frontend/src/index.css`

**Interfaces:**
- Consumes: Task 3, `useMembers(roomId)`, `Room.my_role`, `chatApi.directory`.
- Produces:
  - Nút `aria-label="Thông tin nhóm"` ở tiêu đề của phòng `group` (không có ở phòng direct) mở `GroupPanel` (hộp thoại `role="dialog"`, `aria-modal`, Esc/backdrop/"Đóng", trả focus).
  - `GroupPanel({ room, onClose })`: tên nhóm + số thành viên; danh sách thành viên (tên, nhãn "Chủ nhóm" cho owner, nhãn "Bạn" cho chính mình; tên hiển thị dạng text); **dành cho chủ nhóm** (`room.my_role === 'owner'`): đổi tên (ô + "Lưu tên", không gửi khi không đổi), thêm thành viên (ô tìm `aria-label="Thêm thành viên"` dùng directory, loại người đã trong nhóm, bấm một người để thêm), nút gỡ cạnh mỗi thành viên khác (`aria-label="Gỡ {tên} khỏi nhóm"`, hỏi `window.confirm`), vùng nguy hiểm "Giải tán nhóm" cần **gõ đúng tên nhóm** (so khớp NFC, phân biệt hoa thường, không trim) rồi nút "Giải tán nhóm" mới bật, kèm giải thích "Nhóm biến mất với mọi người ngay. Tin nhắn được giữ một thời gian để quản trị viên khôi phục khi cần, sau đó bị xoá vĩnh viễn."; **cho mọi thành viên**: nút "Rời nhóm" (`window.confirm`; nếu là chủ nhóm, nội dung xác nhận nói quyền chủ nhóm sẽ chuyển cho người vào nhóm sớm nhất, và nếu là người cuối cùng thì nhóm sẽ được lưu trữ). Mọi thao tác: nút vô hiệu khi đang chạy, lỗi tiếng Việt qua `ErrorAlert`, tải lại danh sách thành viên sau khi thêm/gỡ/đổi tên (kể cả lỗi giữa chừng không để UI lệch).
  - `ConversationPane`: sau khi rời/giải tán thành công → đóng bảng và `navigate('/')`; nếu phòng biến mất khỏi danh sách (bị gỡ, nhóm giải tán/lưu trữ bởi người khác) hiện lại thông báo hiện có "Cuộc trò chuyện không tồn tại hoặc bạn không còn trong đó." kèm "Về danh sách" (đã có) và **đóng bảng đang mở** nếu có.
  - Nếu `my_role` đổi (được chuyển quyền chủ) khi bảng đang mở, giao diện cập nhật theo ngay (các nút quản lý xuất hiện/biến mất).

- [ ] **Step 1: Viết test thất bại** — GroupPanel: chủ nhóm thấy đủ điều khiển, thành viên thường chỉ thấy danh sách + "Rời nhóm"; phòng admin tạo (`my_role='member'`) không có điều khiển quản lý; đổi tên gửi `PATCH` đúng body và không gửi khi không đổi; thêm thành viên loại người đã có và gửi đúng `{user_id}`; gỡ cần xác nhận (huỷ → không gọi API); giải tán: nút tắt cho tới khi gõ đúng tên (sai hoa thường/thừa khoảng trắng vẫn tắt), gọi `DELETE` một lần dù bấm đúp; rời nhóm xác nhận khác nhau cho chủ nhóm; lỗi 403/409 hiển thị tiếng Việt và không đóng bảng; không có `role="alert"` thừa lúc bình thường. Tích hợp (`ChatLayout.test.tsx`, mockFetch + FakeWebSocket): mở phòng nhóm → mở bảng → thêm thành viên → danh sách cập nhật; nhận `rooms_changed` kèm danh sách phòng không còn phòng này (bị gỡ) khi bảng đang mở → bảng đóng và hiện thông báo; chủ nhóm giải tán → về `/`, phòng biến khỏi sidebar.
- [ ] **Step 2: Chạy để xác nhận thất bại:** `npm test`
- [ ] **Step 3: Viết mã.** Tái dùng `Field`, `ErrorAlert`, kiểu hộp thoại hiện có của `NewChatDialog` (bẫy focus, Esc, trả focus).
- [ ] **Step 4: Chạy:** `npm test && npm run typecheck && npm run build`
- [ ] **Step 5: Commit:** `feat: add group info panel with owner controls, leave and dissolve`

---

### Task 5: Kiểm tra trình duyệt thật và tài liệu

**Files:** Modify `scripts/e2e_chat_ui.mjs`, `README.md`, `.env.example`

**Interfaces:** dùng quy trình e2e hiện có (project riêng `-p kn-e2e`, `.env` tạm sao lưu/khôi phục, dừng tạm caddy+api của demo rồi build lại bằng code mới ở cuối; script từ chối `BASE_URL` không phải localhost).

- [ ] **Step 1: Thêm các bước vào script:**
  1. **Tạo nhóm bởi người dùng thường:** Alice (user thường, chi nhánh A) mở "+ Mới" → tab "Tạo nhóm", đặt tên "Nhóm liên chi nhánh", chọn Bob (chi nhánh B) và Carol, tạo → Alice vào thẳng phòng; Bob và Carol thấy nhóm xuất hiện trong danh sách **không cần tải lại**; Alice gửi tin → Bob và Carol nhận.
  2. **Quản lý bởi chủ nhóm:** Alice đổi tên nhóm → Bob thấy tên mới; Alice thêm Dave → Dave thấy nhóm và lịch sử, không có huy hiệu chưa đọc cho tin cũ; Alice gỡ Carol → nhóm biến mất khỏi danh sách của Carol ngay và Carol không gửi/nhận được gì nữa (kiểm bằng REST: `GET /rooms/{id}/messages` → 404 với token của Carol).
  3. **Quyền:** Bob (thành viên thường) mở "Thông tin nhóm" → không thấy điều khiển quản lý; gọi trực tiếp `PATCH /api/rooms/{id}` bằng token của Bob → 403.
  4. **Rời nhóm và chuyển quyền:** Alice (chủ) rời → Bob trở thành chủ nhóm (thấy điều khiển quản lý, `my_role=owner` qua REST); Alice không còn thấy nhóm.
  5. **Giải tán:** Bob (chủ mới) giải tán bằng cách gõ sai tên → nút tắt; gõ đúng → nhóm biến mất với Dave ngay; admin thấy ở tab "Đã lưu trữ", khôi phục → Bob và Dave thấy lại nhóm với tin nhắn.
  6. **Giới hạn:** (REST) tạo nhóm vượt `MAX_OWNED_GROUPS` (đặt 3 trong `.env` tạm của stack thử nghiệm) → 409 `too_many_groups`, và UI hiện thông báo tiếng Việt khi thử qua hộp thoại.
- [ ] **Step 2: Chạy thật hai lần** theo quy trình hiện có; mọi bước cũ vẫn pass. Bước hỏng: điều tra nguyên nhân gốc, sửa mã bằng commit `fix:` riêng kèm test, không nới kiểm tra.
- [ ] **Step 3: README:** mục "API chat" thêm các endpoint nhóm của người dùng, `my_role`, `role`, mã lỗi mới; mục "Giao diện chat" thêm cách tạo và quản lý nhóm, quy tắc chủ nhóm/rời/giải tán; biến môi trường `MAX_OWNED_GROUPS`, `MAX_GROUP_MEMBERS`.
- [ ] **Step 4: Chạy lại toàn bộ test:** `cd frontend && npm test && npm run build`, `bash scripts/test.sh -q`.
- [ ] **Step 5: Commit:** `test: extend real-browser e2e for user-created groups; document group management`

---

## Self-Review

**Spec coverage:** mục 3 (`role owner/member` đã có trong schema, giờ được dùng), mục 5 (`POST /rooms` tạo nhóm, thêm/bớt thành viên cho người dùng) — plan này bù phần người dùng thường mà Plan 4 mới làm phía admin. Giải tán dùng lại lưu trữ 3 ngày; riêng tư không đổi (admin vẫn không đọc được nội dung).

**Placeholder scan:** không có "TBD"/"TODO". Task 1-4 mô tả hợp đồng, trình tự kiểm tra và danh sách test cụ thể thay vì dán toàn bộ mã vì mẫu tương tự đã có (admin_rooms, NewChatDialog, RoomsPage); người thực hiện phải đọc các tệp được nêu.

**Nhất quán tên:** `my_role`, `role`, `max_owned_groups`, `max_group_members`, `too_many_groups`, `group_full`, `cannot_remove_self`, `chatApi.createGroup/renameGroup/addMember/removeMember/leaveGroup/dissolveGroup`, `GroupPanel`.

**Review Focus:** 5 dòng đều có test: quyền/404 (T2.1, T2.8), mất quyền tức thì (T2.4, T2.12), chuyển quyền/lưu trữ (T2.6, T2.7), giới hạn và đua nhau (T1.5, T1.6, T2.10, T2.11), UI không treo khi mất quyền (T4 tích hợp, e2e bước 2-4).

## Các plan tiếp theo

| Plan | Nội dung |
|---|---|
| 6 | Reply một tin, @mention (gợi ý từ thành viên phòng), thông báo trình duyệt (Web Notification, âm báo, badge số chưa đọc trên tiêu đề tab) |
| 7 | File đính kèm (xem trước ảnh), tìm kiếm tin nhắn tiếng Việt, nhảy tới tin bằng `around` |
| 8 | Vận hành: HTTPS nội bộ, giới hạn IP admin, sao lưu/khôi phục, thử tải 100.000 tin, giới hạn kết nối WS, dọn `refresh_tokens`, ghim phiên bản |
