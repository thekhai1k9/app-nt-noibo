# Plan 4: Giao diện chat (React) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Người dùng nhắn tin được trên trình duyệt: danh sách cuộc trò chuyện (có số chưa đọc), khung hội thoại thời gian thực qua WebSocket, tải lịch sử khi cuộn, gửi tin lạc quan có thử lại, sửa/xoá tin của mình, mở chat 1-1 từ danh bạ; admin quản lý nhóm trong trang "Phòng và nhóm".

**Architecture:** Một `ChatSocket` (tự kết nối lại, xử lý mã đóng 4401/4403, không bao giờ đưa token lên URL) → `ChatController` (REST + sự kiện + gửi lạc quan + đồng bộ lại sau mỗi `ready`) → `ChatStore` (trạng thái bất biến, đọc bằng `useSyncExternalStore`) → các component React. Logic nằm ở lớp thuần TypeScript để test không cần DOM. Backend không đổi ngoài một task nhỏ dọn các việc tồn đọng của Plan 3.

**Tech Stack:** React 18, TypeScript, Vite, react-router-dom 6, TanStack Query 5 (cho các trang admin), Vitest + Testing Library (jsdom), WebSocket gốc của trình duyệt; backend: FastAPI (Plan 3).

**Spec:** `docs/superpowers/specs/2026-10-12-internal-messaging-design.md` (mục 5, 6, 7, 9, 11). Thiết kế giao diện: `docs/design/Main.dc.html`, `docs/design/Admin-Rooms.dc.html`. Hợp đồng WebSocket/REST: mục "API chat (tóm tắt)" trong `README.md`.

## Phạm vi của plan này

Làm: dọn backend tồn đọng (Task 1); nền tảng frontend (kiểu, API, định dạng, nhận dạng liên kết); `ChatSocket`; `ChatStore` + `ChatController` + `ChatProvider`; danh sách tin nhắn có cuộn thông minh, soạn tin, sửa/xoá; thanh bên danh sách phòng, hộp thoại chat mới, bố cục chat thay `HomePage`; trang admin "Phòng và nhóm"; kiểm tra thật trên trình duyệt bằng Playwright.

**Không làm (các plan sau):** đã xem/đang gõ/online/reply/mention/thông báo trình duyệt (Plan 5); file đính kèm và tìm kiếm tin nhắn (Plan 6); HTTPS, giới hạn kết nối, thử tải, sao lưu (Plan 7); cột thành viên/tệp ở bên phải khung chat (cần endpoint liệt kê thành viên cho người dùng thường); danh sách ảo hoá thật sự (dùng `content-visibility: auto` của CSS, đo lại ở Plan 7).

**Điều chỉnh có chủ ý so với bản thiết kế/spec:**
- Không có cột thông tin bên phải (xem trên); tiêu đề phòng hiện tên phòng (chat 1-1: tên người kia) và số thành viên của nhóm.
- Danh sách tin nhắn chưa "ảo hoá" bằng thư viện; trình duyệt bỏ qua việc render các tin ngoài màn hình nhờ `content-visibility: auto`. Spec yêu cầu danh sách ảo hoá; ta chỉ đổi cách làm sau khi có số đo thật.
- Xoá nhóm ở trang admin đòi gõ lại tên nhóm để xác nhận (vì xoá nhóm xoá vĩnh viễn toàn bộ tin nhắn).

## Global Constraints

- UI bằng tiếng Việt; mã lỗi từ server được ánh xạ sang tiếng Việt ở `src/lib/errors.ts`.
- Access token chỉ ở bộ nhớ; WebSocket xác thực bằng khung đầu tiên `{"type":"auth","token":"..."}`; token **không bao giờ** nằm trong URL, `localStorage`, `sessionStorage`.
- Nội dung tin nhắn luôn hiển thị dưới dạng text (`white-space: pre-wrap`); chỉ liên kết `http`/`https` được biến thành `<a>` (`rel="noopener noreferrer nofollow"`, `target="_blank"`); không dùng `dangerouslySetInnerHTML`.
- Mỗi lần nhận `ready` (kể cả lần kết nối lại) và mỗi lần nhận `resync`: tải lại danh sách phòng, bù tin còn thiếu cho mọi phòng đã mở bằng `after=<id tin thật cuối cùng>`, rồi gửi lại các tin đang chờ (cùng `client_id` nên không trùng). Nhận `rooms_changed` thì tải lại danh sách phòng.
- Mã đóng WebSocket: 4401 → làm mới token rồi kết nối lại (nếu refresh bị từ chối, hoặc 4401 hai lần liên tiếp mà chưa nhận `ready` → coi như mất phiên, về đăng nhập); 4403 → mất phiên, không kết nối lại; mã khác → kết nối lại với backoff `1s, 2s, 5s, 10s, 30s` có jitter. Không bao giờ vòng lặp kết nối chặt.
- Tin lạc quan: id cục bộ âm, `client_id` là UUID; khi nhận tin thật có cùng `client_id` thì thay thế (không trùng); quá 15 giây không được xác nhận thì chuyển sang "gửi lỗi" (có nút "Thử lại" gửi lại cùng `client_id`).
- Số chưa đọc: tin của chính mình không bao giờ tính; phòng đang mở và tab đang hiển thị thì không tăng chưa đọc và tự đánh dấu đã đọc (`POST /rooms/{id}/read`); tab ẩn hoặc phòng khác thì tăng.
- Cuộn: tải thêm tin cũ không làm nhảy vị trí cuộn; tin mới đến khi người dùng đang ở cuối thì tự cuộn xuống; đang đọc tin cũ thì hiện nút "↓ N tin mới" thay vì kéo đi.
- Ô soạn tin: Enter gửi, Shift+Enter xuống dòng, **không gửi khi đang gõ bằng bộ gõ tiếng Việt** (`isComposing`), tối đa 4000 ký tự.
- Mọi nút/vùng bấm cao tối thiểu 44px; ô nhập có `<label>` hoặc `aria-label`; bố cục dùng được ở 390px (một cột: danh sách hoặc hội thoại).
- Các test frontend không tạo kết nối mạng thật: `WebSocket` được thay bằng `FakeWebSocket` trong `src/test/setup.ts`.

## Review Focus

Các tình huống spec ngầm đòi hỏi nhưng dễ bị bỏ sót; mỗi dòng có test trong task ghi ở cuối dòng.

- Token chỉ đi trong khung `auth` đầu tiên, không ở URL (Task 3).
- Mất kết nối không gây bão kết nối lại; 4403 không kết nối lại; 4401 không lặp vô hạn (Task 3).
- Tin không trùng và không mất qua lần kết nối lại: bù tin sau `ready`, gộp theo id, gộp tin lạc quan theo `client_id`, gửi lại tin đang chờ (Task 4).
- Số chưa đọc đúng: tin của mình, phòng đang xem, tab ẩn (Task 4).
- Cuộn: thêm tin cũ giữ nguyên vị trí; tin mới khi đang đọc tin cũ không kéo màn hình (Task 5).
- Tin đã xoá không lộ nội dung; liên kết `javascript:` không thành liên kết; gõ tiếng Việt có dấu bằng bộ gõ không gửi nhầm khi bấm Enter xác nhận chữ (Task 2, 5).
- Xoá nhóm ở trang admin cần gõ đúng tên nhóm (Task 7).

---

## File Structure

```
backend/
├── app/chat/hub.py                  # reconcile: 4401 cho must_change, báo rooms_changed khi đổi
├── app/config.py                    # ws_reconcile_seconds > 0
└── tests/test_hub.py                # (sửa/thêm test)
README.md                            # sửa các chỗ sai (Task 1), mục giao diện chat (Task 8)
scripts/e2e_chat_ui.mjs              # kiểm tra trình duyệt thật (Task 8)
frontend/
├── vite.config.ts                   # proxy /api có ws: true
└── src/
    ├── App.tsx                      # tuyến chat + tuyến admin rooms
    ├── index.css                    # kiểu bố cục chat
    ├── lib/
    │   ├── api.ts                   # + handleAuthLost
    │   ├── chatApi.ts               # REST chat có kiểu
    │   ├── chatController.ts        # logic: gửi lạc quan, bù tin, chưa đọc
    │   ├── chatStore.ts             # trạng thái + thao tác bất biến
    │   ├── ChatProvider.tsx         # nối socket + store + controller + hooks
    │   ├── errors.ts                # + mã lỗi chat
    │   ├── format.ts                # giờ, ngày, chữ cái đầu
    │   ├── linkify.tsx              # nhận dạng liên kết an toàn
    │   ├── types.ts                 # + kiểu chat
    │   └── ws.ts                    # ChatSocket
    ├── components/chat/
    │   ├── Composer.tsx
    │   ├── ConnectionBanner.tsx
    │   ├── ConversationPane.tsx
    │   ├── MessageItem.tsx
    │   ├── MessageList.tsx
    │   ├── NewChatDialog.tsx
    │   └── RoomSidebar.tsx
    ├── pages/
    │   ├── ChatHome.tsx
    │   ├── ChatLayout.tsx
    │   └── admin/RoomsPage.tsx      # + AdminLayout (liên kết điều hướng)
    └── test/
        ├── fakeWebSocket.ts
        ├── setup.ts                 # dùng FakeWebSocket
        └── utils.tsx                # sessionRoutes có GET /api/rooms
```
(`HomePage.tsx` bị xoá, thay bằng `ChatLayout` + `ChatHome`.)

Quy ước chạy lệnh: Git Bash. Test frontend chạy trực tiếp bằng Node trong `frontend/` (`npm test`, `npm run typecheck`, `npm run build`). Task 1 (backend) chạy qua `bash scripts/test.sh` từ thư mục gốc. Task 8 cần Docker.

---

### Task 1: Dọn backend tồn đọng của Plan 3

**Files:**
- Modify: `backend/app/chat/hub.py`, `backend/app/config.py`, `backend/tests/test_hub.py`, `backend/tests/test_ws.py` (nếu test hiện có phụ thuộc mã 4403 cho `must_change_password`), `README.md`

**Interfaces:**
- Consumes: `Hub.reconcile` hiện có (đọc `backend/app/chat/hub.py`), `Settings.ws_reconcile_seconds`.
- Produces: hành vi mới (xem dưới); không đổi chữ ký hàm công khai.

- [ ] **Step 1: Viết test thất bại (`backend/tests/test_hub.py`)**

Thêm các test (dùng cùng kiểu helper như các test `reconcile` hiện có trong file: tạo user/phòng bằng `create_user`/`create_room`, `Connection`, `Hub(InMemoryBus(), SessionLocal)`):
1. `test_reconcile_closes_must_change_password_users_with_4401`: user có `must_change_password=True` có kết nối đã đăng ký → sau `await hub.reconcile()`, `conn.close_code == 4401`; user bị khoá (`is_active=False`) vẫn `4403`.
2. `test_reconcile_tells_the_client_to_reload_rooms_when_membership_changed`: kết nối có `room_ids={999}` (không khớp DB) → sau `reconcile()`, `conn.room_ids` bằng dữ liệu DB **và** hàng đợi của kết nối nhận `{"type": "rooms_changed"}`; nếu `room_ids` đã khớp DB thì **không** nhận thêm sự kiện nào (reconcile định kỳ không làm ồn).
3. Trong `backend/tests/test_config.py` (tạo file mới nếu chưa có, dùng `Settings(ws_reconcile_seconds=0)` trong khối `pytest.raises(ValidationError)`): `ws_reconcile_seconds` phải > 0.

Sửa mọi test hiện có đang khẳng định `must_change_password` bị đóng bằng 4403 trong reconcile thành 4401 (chỉ các test đó).

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `bash scripts/test.sh tests/test_hub.py tests/test_config.py -v`
Expected: các test mới thất bại (mã 4403 thay vì 4401; không có sự kiện `rooms_changed`; `Settings(ws_reconcile_seconds=0)` không báo lỗi).

- [ ] **Step 3: Sửa mã**

`backend/app/config.py`: `from pydantic import Field` rồi `ws_reconcile_seconds: float = Field(30.0, gt=0)`.

`backend/app/chat/hub.py`: thêm hằng `CLOSE_UNAUTHENTICATED = 4401` (nếu chưa có) và sửa vòng lặp cuối `reconcile`:
```python
        blocked_locked = {uid for uid, active, _ in rows_state if not active}
        blocked_reauth = {uid for uid, active, must_change in rows_state if active and must_change}
```
(đổi truy vấn đầu để giữ `rows_state = list(rows)` rồi tính hai tập trên), và:
```python
        for conn in conns:
            if conn.user_id in blocked_locked:
                conn.close(CLOSE_ACCOUNT_LOCKED)
            elif conn.user_id in blocked_reauth:
                conn.close(CLOSE_UNAUTHENTICATED)
            elif conn.version == versions[conn]:  # chưa có sự kiện/snapshot mới hơn trong lúc đọc DB
                new_rooms = set(by_user.get(conn.user_id, ()))
                changed = new_rooms != conn.room_ids
                conn.room_ids = new_rooms
                conn.version += 1
                if changed:
                    self._offer(conn, {"type": "rooms_changed"})
```
Giữ nguyên phần còn lại của hàm (xử lý lỗi, thoát sớm khi không có kết nối).

- [ ] **Step 4: Sửa README (`README.md`, mục "API chat (tóm tắt)")**

Sửa đúng các chỗ sau (đọc mục hiện có trước):
- `invalid_client_id`: chỉ ở WebSocket (không có REST gửi tin); `client_id` rỗng cũng cho mã này.
- `message_too_long` khi sửa tin: chỉ khi 4001-10000 ký tự; trên 10000 ký tự REST trả 422 `validation_error`.
- Dòng 4403: "Tài khoản bị khoá" (đối soát định kỳ chỉ dùng 4403 cho tài khoản bị khoá; tài khoản phải đổi mật khẩu bị đóng 4401).
- Thêm: **không mở WebSocket khi người dùng chưa đổi mật khẩu lần đầu** (server đóng 4401 và làm mới token vẫn thành công, nên client dễ lặp vô hạn nếu không kiểm tra `must_change_password`).
- Thêm `service_unavailable` (503, Redis lỗi) vào bảng mã lỗi.
- Ghi rõ: tham số `before`/`after`/`around` phải ≥ 1; muốn "từ đầu" thì **bỏ tham số** thay vì gửi `0` (server trả 422).

- [ ] **Step 5: Chạy test và commit**

Run: `bash scripts/test.sh -q`
Expected: tất cả pass.

```bash
git add backend README.md
git commit -m "fix: reconcile closes reauth users with 4401 and tells clients to reload rooms; correct README" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Nền tảng frontend (kiểu, API chat, định dạng, liên kết, mã lỗi)

**Files:**
- Modify: `frontend/src/lib/types.ts`, `frontend/src/lib/api.ts`, `frontend/src/lib/errors.ts`, `frontend/src/lib/errors.test.ts`, `frontend/vite.config.ts`
- Create: `frontend/src/lib/chatApi.ts`, `frontend/src/lib/chatApi.test.ts`, `frontend/src/lib/format.ts`, `frontend/src/lib/format.test.ts`, `frontend/src/lib/linkify.tsx`, `frontend/src/lib/linkify.test.tsx`

**Interfaces:**
- Consumes: `api`, `ApiError` (hiện có).
- Produces:
  - `types.ts`: `Message`, `Room`, `MessagePage`, `DirectoryUser`, `AdminRoom`, `AdminRoomMember`, `AdminRoomDetail`, `ServerEvent` (xem mã).
  - `api.ts`: `handleAuthLost(): void` (xoá token và gọi handler mất phiên của `AuthProvider`).
  - `chatApi.ts`: `chatApi.{rooms, messages, markRead, openDirect, editMessage, deleteMessage, directory}` và kiểu `ChatApi = typeof chatApi`.
  - `format.ts`: `initials(name)`, `formatTime(iso)`, `dayLabel(iso, now?)`, `listTime(iso, now?)`, `sameDay(a, b)`.
  - `linkify.tsx`: `linkify(text): ReactNode[]`.
  - Mã lỗi tiếng Việt cho: `room_not_found`, `message_not_found`, `empty_message`, `message_too_long`, `invalid_client_id`, `invalid_message`, `invalid_json`, `unknown_type`, `unsupported_frame`, `internal_error`, `rate_limited`, `cannot_chat_with_self`, `invalid_cursor`, `member_not_found`.

- [ ] **Step 1: Viết test thất bại**

`frontend/src/lib/format.test.ts`:
```ts
import { dayLabel, formatTime, initials, listTime, sameDay } from './format'

const now = new Date(2026, 9, 15, 12, 0, 0) // 15/10/2026 12:00 giờ địa phương
const at = (y: number, m: number, d: number, h = 9, min = 5) => new Date(y, m - 1, d, h, min).toISOString()

describe('format', () => {
  it('takes initials from the first and last word', () => {
    expect(initials('Nguyễn Minh Anh')).toBe('NA')
    expect(initials('Hà')).toBe('H')
    expect(initials('  ')).toBe('')
  })

  it('formats the time of day as HH:mm', () => {
    expect(formatTime(at(2026, 10, 15, 9, 5))).toBe('09:05')
  })

  it('labels days relative to now', () => {
    expect(dayLabel(at(2026, 10, 15), now)).toBe('Hôm nay')
    expect(dayLabel(at(2026, 10, 14), now)).toBe('Hôm qua')
    expect(dayLabel(at(2026, 9, 1), now)).toBe('01/09/2026')
  })

  it('shows the time for today and a short date otherwise in the room list', () => {
    expect(listTime(at(2026, 10, 15, 8, 30), now)).toBe('08:30')
    expect(listTime(at(2026, 10, 14), now)).toBe('Hôm qua')
    expect(listTime(at(2026, 9, 1), now)).toBe('01/09')
  })

  it('compares local calendar days', () => {
    expect(sameDay(at(2026, 10, 15, 0, 1), at(2026, 10, 15, 23, 59))).toBe(true)
    expect(sameDay(at(2026, 10, 15), at(2026, 10, 16))).toBe(false)
  })
})
```

`frontend/src/lib/linkify.test.tsx`:
```tsx
import { render } from '@testing-library/react'
import { linkify } from './linkify'

const html = (text: string) => render(<p>{linkify(text)}</p>).container.innerHTML

describe('linkify', () => {
  it('turns http and https URLs into safe links', () => {
    const { container } = render(<p>{linkify('xem https://example.com/a?b=1 nhé')}</p>)
    const link = container.querySelector('a')!
    expect(link.getAttribute('href')).toBe('https://example.com/a?b=1')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer nofollow')
    expect(container.textContent).toBe('xem https://example.com/a?b=1 nhé')
  })

  it('keeps trailing punctuation outside the link', () => {
    const { container } = render(<p>{linkify('vào http://a.vn/x, rồi (https://b.vn).')}</p>)
    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'))
    expect(hrefs).toEqual(['http://a.vn/x', 'https://b.vn'])
    expect(container.textContent).toBe('vào http://a.vn/x, rồi (https://b.vn).')
  })

  it('never links javascript:, data: or other schemes', () => {
    for (const text of ['javascript:alert(1)', 'data:text/html,<script>1</script>', 'ftp://x.vn', 'JaVaScRiPt:alert(1)']) {
      expect(html(text)).not.toContain('<a')
    }
  })

  it('renders HTML in the text as plain text', () => {
    const { container } = render(<p>{linkify('<img src=x onerror=alert(1)> https://ok.vn')}</p>)
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(container.querySelectorAll('a')).toHaveLength(1)
  })

  it('returns plain text unchanged', () => {
    expect(html('không có liên kết')).toBe('<p>không có liên kết</p>')
  })
})
```

`frontend/src/lib/chatApi.test.ts`:
```ts
import { mockFetch } from '../test/mockFetch'
import { chatApi } from './chatApi'

describe('chatApi', () => {
  it('builds the messages URL from the cursor parameters', async () => {
    const { calls } = mockFetch({
      'GET /api/rooms/5/messages': { json: { items: [], has_more_before: false, has_more_after: false } },
    })
    await chatApi.messages(5, {})
    await chatApi.messages(5, { before: 10, limit: 20 })
    await chatApi.messages(5, { after: 7 })
    expect(calls.map((c) => c.path)).toEqual([
      '/api/rooms/5/messages',
      '/api/rooms/5/messages?before=10&limit=20',
      '/api/rooms/5/messages?after=7',
    ])
  })

  it('posts the direct room, read marker, edit and delete with the right payloads', async () => {
    const { calls } = mockFetch({
      'POST /api/rooms/direct': { status: 201, json: { id: 3 } },
      'POST /api/rooms/3/read': { status: 204 },
      'PATCH /api/messages/9': { json: { id: 9 } },
      'DELETE /api/messages/9': { status: 204 },
    })
    await chatApi.openDirect(8)
    await chatApi.markRead(3, 12)
    await chatApi.editMessage(9, 'mới')
    await chatApi.deleteMessage(9)
    expect(calls.map((c) => [c.method, c.path, c.body])).toEqual([
      ['POST', '/api/rooms/direct', { user_id: 8 }],
      ['POST', '/api/rooms/3/read', { message_id: 12 }],
      ['PATCH', '/api/messages/9', { body: 'mới' }],
      ['DELETE', '/api/messages/9', undefined],
    ])
  })

  it('encodes the directory search term', async () => {
    const { calls } = mockFetch({ 'GET /api/users/directory': { json: [] } })
    await chatApi.directory('ha le & co')
    await chatApi.directory('')
    expect(calls.map((c) => c.path)).toEqual(['/api/users/directory?q=ha%20le%20%26%20co', '/api/users/directory'])
  })
})
```

Thêm vào `frontend/src/lib/errors.test.ts`:
```ts
it('has Vietnamese messages for the chat error codes', () => {
  for (const code of [
    'room_not_found', 'message_not_found', 'empty_message', 'message_too_long', 'invalid_client_id',
    'invalid_message', 'invalid_json', 'unknown_type', 'unsupported_frame', 'internal_error', 'rate_limited',
    'cannot_chat_with_self', 'invalid_cursor', 'member_not_found',
  ]) {
    expect(errorMessage(new ApiError(400, code)), code).not.toBe('Có lỗi xảy ra. Vui lòng thử lại.')
  }
})
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `npm test` (trong `frontend/`)
Expected: lỗi không tìm thấy module `./format`, `./linkify`, `./chatApi`; test mã lỗi thất bại.

- [ ] **Step 3: Viết mã**

Thêm vào cuối `frontend/src/lib/types.ts`:
```ts
export interface Message {
  id: number
  room_id: number
  sender_id: number
  sender_name: string
  body: string
  kind: string
  client_id: string | null
  created_at: string
  edited_at: string | null
  deleted: boolean
}

export interface Room {
  id: number
  type: 'direct' | 'group'
  name: string | null
  branch_id: number | null
  member_count: number
  peer_id: number | null
  last_message: Message | null
  unread_count: number
  last_activity: string
}

export interface MessagePage {
  items: Message[]
  has_more_before: boolean
  has_more_after: boolean
}

export interface DirectoryUser {
  id: number
  username: string
  full_name: string
  branch_id: number
  branch_name: string
}

export interface AdminRoom {
  id: number
  name: string
  branch_id: number | null
  member_count: number
  created_at: string
}

export interface AdminRoomMember {
  user_id: number
  full_name: string
  username: string
  branch_id: number
}

export interface AdminRoomDetail extends AdminRoom {
  members: AdminRoomMember[]
}

export type ServerEvent =
  | { type: 'ready'; user_id: number }
  | { type: 'message' | 'message_updated'; message: Message }
  | { type: 'message_deleted'; room_id: number; message_id: number }
  | { type: 'rooms_changed' }
  | { type: 'resync' }
  | { type: 'pong' }
  | { type: 'error'; code: string; client_id: string | null }
```

Thêm vào `frontend/src/lib/api.ts` (sau `resetApiState`):
```ts
/** Phiên đã mất (WebSocket bị đóng 4403, refresh bị từ chối...): xoá token và báo cho AuthProvider. */
export function handleAuthLost(): void {
  accessToken = null
  authLostHandler?.()
}
```

Thêm các dòng sau vào `MESSAGES` trong `frontend/src/lib/errors.ts`:
```ts
  room_not_found: 'Cuộc trò chuyện không tồn tại hoặc bạn không còn trong đó.',
  message_not_found: 'Tin nhắn không còn tồn tại.',
  empty_message: 'Tin nhắn đang trống.',
  message_too_long: 'Tin nhắn quá dài (tối đa 4000 ký tự).',
  invalid_client_id: 'Không gửi được tin nhắn. Vui lòng thử lại.',
  invalid_message: 'Không gửi được tin nhắn. Vui lòng thử lại.',
  invalid_json: 'Không gửi được tin nhắn. Vui lòng thử lại.',
  unknown_type: 'Không gửi được tin nhắn. Vui lòng thử lại.',
  unsupported_frame: 'Không gửi được tin nhắn. Vui lòng thử lại.',
  internal_error: 'Máy chủ gặp lỗi khi gửi tin. Vui lòng thử lại.',
  rate_limited: 'Bạn gửi quá nhanh. Hãy đợi vài giây rồi thử lại.',
  cannot_chat_with_self: 'Bạn không thể nhắn tin cho chính mình.',
  invalid_cursor: 'Yêu cầu tải tin nhắn không hợp lệ.',
  member_not_found: 'Người này không ở trong nhóm.',
```
(`room_not_found` đã có thể tồn tại trong bản cũ với nội dung khác: giữ một khai báo duy nhất theo bảng trên.)

`frontend/src/lib/chatApi.ts`:
```ts
import { api } from './api'
import type { DirectoryUser, Message, MessagePage, Room } from './types'

export interface MessageQuery {
  before?: number
  after?: number
  around?: number
  limit?: number
}

function query(params: MessageQuery): string {
  const search = new URLSearchParams()
  if (params.before !== undefined) search.set('before', String(params.before))
  if (params.after !== undefined) search.set('after', String(params.after))
  if (params.around !== undefined) search.set('around', String(params.around))
  if (params.limit !== undefined) search.set('limit', String(params.limit))
  const text = search.toString()
  return text ? `?${text}` : ''
}

export const chatApi = {
  rooms: () => api<Room[]>('/rooms'),
  messages: (roomId: number, params: MessageQuery) => api<MessagePage>(`/rooms/${roomId}/messages${query(params)}`),
  markRead: (roomId: number, messageId: number) =>
    api(`/rooms/${roomId}/read`, { method: 'POST', json: { message_id: messageId } }),
  openDirect: (userId: number) => api<Room>('/rooms/direct', { method: 'POST', json: { user_id: userId } }),
  editMessage: (messageId: number, body: string) =>
    api<Message>(`/messages/${messageId}`, { method: 'PATCH', json: { body } }),
  deleteMessage: (messageId: number) => api(`/messages/${messageId}`, { method: 'DELETE' }),
  directory: (q: string) => api<DirectoryUser[]>(`/users/directory${q ? `?q=${encodeURIComponent(q)}` : ''}`),
}

export type ChatApi = typeof chatApi
```

`frontend/src/lib/format.ts`:
```ts
const pad = (n: number) => String(n).padStart(2, '0')

export function initials(fullName: string): string {
  const words = fullName.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return ''
  const first = words[0][0] ?? ''
  const last = words.length > 1 ? (words[words.length - 1][0] ?? '') : ''
  return (first + last).toUpperCase()
}

export function formatTime(iso: string): string {
  const d = new Date(iso)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function sameDay(a: string, b: string): boolean {
  const x = new Date(a)
  const y = new Date(b)
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate()
}

function dayDiff(iso: string, now: Date): number {
  const d = new Date(iso)
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  return Math.round((start(now) - start(d)) / 86_400_000)
}

export function dayLabel(iso: string, now: Date = new Date()): string {
  const diff = dayDiff(iso, now)
  if (diff === 0) return 'Hôm nay'
  if (diff === 1) return 'Hôm qua'
  const d = new Date(iso)
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`
}

export function listTime(iso: string, now: Date = new Date()): string {
  const diff = dayDiff(iso, now)
  if (diff === 0) return formatTime(iso)
  if (diff === 1) return 'Hôm qua'
  const d = new Date(iso)
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`
}
```

`frontend/src/lib/linkify.tsx`:
```tsx
import type { ReactNode } from 'react'

const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi
const TRAILING_PUNCTUATION = /[.,;:!?)\]}]+$/

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** Biến các URL http/https trong văn bản thành liên kết; mọi thứ khác giữ nguyên là text. */
export function linkify(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let cursor = 0
  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0
    const url = match[0].replace(TRAILING_PUNCTUATION, '')
    if (!url || !isHttpUrl(url)) continue
    if (start > cursor) nodes.push(text.slice(cursor, start))
    nodes.push(
      <a key={`${start}-${url}`} href={url} target="_blank" rel="noopener noreferrer nofollow">
        {url}
      </a>,
    )
    cursor = start + url.length
  }
  if (cursor < text.length) nodes.push(text.slice(cursor))
  return nodes
}
```

`frontend/vite.config.ts`: đổi `proxy: { '/api': 'http://localhost:80' }` thành `proxy: { '/api': { target: 'http://localhost:80', ws: true } }` (cho phép WebSocket khi chạy `npm run dev`).

- [ ] **Step 4: Chạy test và kiểm tra kiểu**

Run: `npm test && npm run typecheck`
Expected: tất cả pass, kiểu sạch.

- [ ] **Step 5: Commit**

```bash
git add frontend
git commit -m "feat: add chat types, rest client, formatting, safe linkify and chat error messages" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `ChatSocket` (kết nối, đăng nhập, kết nối lại, mã đóng)

**Files:**
- Create: `frontend/src/lib/ws.ts`, `frontend/src/lib/ws.test.ts`, `frontend/src/test/fakeWebSocket.ts`
- Modify: `frontend/src/test/setup.ts`

**Interfaces:**
- Consumes: `RefreshResult` (từ `api.ts`), `ServerEvent` (`types.ts`).
- Produces:
  - `type SocketStatus = 'connecting' | 'open' | 'offline'`.
  - `class ChatSocket` với `constructor(opts: ChatSocketOptions)`; `getStatus()`; `onEvent(listener) -> unsubscribe`; `onStatus(listener) -> unsubscribe`; `start()`; `stop()`; `send(payload: object) -> boolean` (chỉ khi `open`); `reconnectNow()`.
  - `ChatSocketOptions`: `getToken: () => string | null`, `refresh: () => Promise<RefreshResult>`, `onAuthLost: () => void`, và tuỳ chọn `url`, `backoffMs` (mặc định `[1000, 2000, 5000, 10000, 30000]`), `random` (mặc định `Math.random`), `createSocket(url) => WebSocket`.
  - `FakeWebSocket` (test): `static instances`, `static last`, `static reset()`, `url`, `sent: string[]`, `sentJson`, `open()`, `receive(obj)`, `serverClose(code)`, `close(code?)`.
  - Quy tắc: kết nối lại có `jitter` = `delay * (0.8 + random() * 0.4)`; `ready` đặt lại bộ đếm lỗi; 4403 → `onAuthLost` và dừng; 4401 → `refresh()`: `ok` → kết nối ngay; `denied` → `onAuthLost` và dừng; `unavailable` → backoff; hai lần 4401 liên tiếp chưa có `ready` → `onAuthLost` và dừng; không có token → thử `refresh()` trước.

- [ ] **Step 1: Viết test thất bại**

`frontend/src/test/fakeWebSocket.ts`:
```ts
type Handler<T> = ((event: T) => void) | null

/** WebSocket giả cho test: không có mạng; test điều khiển từng bước. */
export class FakeWebSocket {
  static instances: FakeWebSocket[] = []

  static reset(): void {
    FakeWebSocket.instances = []
  }

  static get last(): FakeWebSocket {
    const ws = FakeWebSocket.instances.at(-1)
    if (!ws) throw new Error('chưa có FakeWebSocket nào được tạo')
    return ws
  }

  url: string
  readyState = 0
  sent: string[] = []
  onopen: Handler<unknown> = null
  onmessage: Handler<{ data: string }> = null
  onclose: Handler<{ code: number }> = null
  onerror: Handler<unknown> = null

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  /** Client tự đóng (giống WebSocket thật, đóng xong thì onclose chạy). */
  close(code = 1000): void {
    this.readyState = 3
    this.onclose?.({ code })
  }

  get sentJson(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s))
  }

  open(): void {
    this.readyState = 1
    this.onopen?.({})
  }

  receive(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) })
  }

  serverClose(code: number): void {
    this.readyState = 3
    this.onclose?.({ code })
  }
}
```

Trong `frontend/src/test/setup.ts` thêm import và, trong `beforeEach`, trước `resetApiState()`:
```ts
import { FakeWebSocket } from './fakeWebSocket'
// ...
beforeEach(() => {
  FakeWebSocket.reset()
  vi.stubGlobal('WebSocket', FakeWebSocket)
  resetApiState()
})
```
(giữ nguyên các dòng hiện có của `beforeEach` và `afterEach`.)

`frontend/src/lib/ws.test.ts`:
```ts
import { vi } from 'vitest'
import type { RefreshResult } from './api'
import type { ServerEvent } from './types'
import { ChatSocket } from './ws'
import { FakeWebSocket } from '../test/fakeWebSocket'

function setup(overrides: Partial<ConstructorParameters<typeof ChatSocket>[0]> = {}) {
  const events: ServerEvent[] = []
  const statuses: string[] = []
  const onAuthLost = vi.fn()
  const refresh = vi.fn<() => Promise<RefreshResult>>().mockResolvedValue('ok')
  const socket = new ChatSocket({
    getToken: () => 'tok-1',
    refresh,
    onAuthLost,
    url: 'ws://test/api/ws',
    random: () => 0.5, // jitter = delay * 1.0
    ...overrides,
  })
  socket.onEvent((e) => events.push(e))
  socket.onStatus((s) => statuses.push(s))
  return { socket, events, statuses, onAuthLost, refresh }
}

const ready = { type: 'ready', user_id: 1 }

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('ChatSocket', () => {
  it('authenticates with the first frame and keeps the token out of the URL', () => {
    const { socket } = setup()
    socket.start()
    const ws = FakeWebSocket.last
    expect(ws.url).toBe('ws://test/api/ws')
    expect(ws.url).not.toContain('tok-1')
    ws.open()
    expect(ws.sentJson).toEqual([{ type: 'auth', token: 'tok-1' }])
  })

  it('becomes open on ready, emits ready and later events', () => {
    const { socket, events, statuses } = setup()
    socket.start()
    const ws = FakeWebSocket.last
    ws.open()
    expect(socket.getStatus()).toBe('connecting')
    ws.receive(ready)
    ws.receive({ type: 'rooms_changed' })
    expect(socket.getStatus()).toBe('open')
    expect(statuses).toEqual(['connecting', 'open'])
    expect(events).toEqual([ready, { type: 'rooms_changed' }])
  })

  it('sends only while open', () => {
    const { socket } = setup()
    expect(socket.send({ type: 'ping' })).toBe(false)
    socket.start()
    const ws = FakeWebSocket.last
    ws.open()
    expect(socket.send({ type: 'ping' })).toBe(false) // chưa ready
    ws.receive(ready)
    expect(socket.send({ type: 'send', room_id: 1, body: 'hi', client_id: 'c1' })).toBe(true)
    expect(ws.sentJson.at(-1)).toEqual({ type: 'send', room_id: 1, body: 'hi', client_id: 'c1' })
  })

  it('ignores malformed frames', () => {
    const { socket, events } = setup()
    socket.start()
    const ws = FakeWebSocket.last
    ws.open()
    ws.onmessage?.({ data: 'không phải json' })
    ws.onmessage?.({ data: JSON.stringify([1, 2]) })
    ws.receive(ready)
    expect(events).toEqual([ready])
  })

  it('reconnects with growing backoff and resets it after ready', () => {
    const { socket } = setup()
    socket.start()
    FakeWebSocket.last.serverClose(1006)
    expect(FakeWebSocket.instances).toHaveLength(1)
    vi.advanceTimersByTime(999)
    expect(FakeWebSocket.instances).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(FakeWebSocket.instances).toHaveLength(2) // sau 1s
    FakeWebSocket.last.serverClose(1006)
    vi.advanceTimersByTime(2000)
    expect(FakeWebSocket.instances).toHaveLength(3) // sau 2s
    FakeWebSocket.last.serverClose(1006)
    vi.advanceTimersByTime(4999)
    expect(FakeWebSocket.instances).toHaveLength(3)
    vi.advanceTimersByTime(1)
    expect(FakeWebSocket.instances).toHaveLength(4) // sau 5s
    FakeWebSocket.last.open()
    FakeWebSocket.last.receive(ready) // thành công: đặt lại backoff
    FakeWebSocket.last.serverClose(1006)
    vi.advanceTimersByTime(1000)
    expect(FakeWebSocket.instances).toHaveLength(5)
  })

  it('caps the backoff at the last value', () => {
    const { socket } = setup({ backoffMs: [100, 200] })
    socket.start()
    for (let i = 0; i < 4; i++) {
      FakeWebSocket.last.serverClose(1006)
      vi.advanceTimersByTime(200)
    }
    expect(FakeWebSocket.instances.length).toBe(5)
    FakeWebSocket.last.serverClose(1006)
    vi.advanceTimersByTime(199)
    expect(FakeWebSocket.instances.length).toBe(5)
    vi.advanceTimersByTime(1)
    expect(FakeWebSocket.instances.length).toBe(6)
  })

  it('applies jitter to the delay', () => {
    const { socket } = setup({ random: () => 1 }) // jitter = delay * 1.2
    socket.start()
    FakeWebSocket.last.serverClose(1006)
    vi.advanceTimersByTime(1199)
    expect(FakeWebSocket.instances).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(FakeWebSocket.instances).toHaveLength(2)
  })

  it('does not reconnect after 4403 and reports the lost session', () => {
    const { socket, onAuthLost, statuses } = setup()
    socket.start()
    FakeWebSocket.last.open()
    FakeWebSocket.last.receive(ready)
    FakeWebSocket.last.serverClose(4403)
    vi.advanceTimersByTime(60_000)
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(onAuthLost).toHaveBeenCalledTimes(1)
    expect(statuses.at(-1)).toBe('offline')
  })

  it('refreshes the token on 4401 and reconnects immediately', async () => {
    const { socket, refresh, onAuthLost } = setup()
    socket.start()
    FakeWebSocket.last.open()
    FakeWebSocket.last.serverClose(4401)
    await vi.advanceTimersByTimeAsync(0)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(onAuthLost).not.toHaveBeenCalled()
  })

  it('gives up when the refresh is denied after 4401', async () => {
    const refresh = vi.fn<() => Promise<RefreshResult>>().mockResolvedValue('denied')
    const { socket, onAuthLost } = setup({ refresh })
    socket.start()
    FakeWebSocket.last.serverClose(4401)
    await vi.advanceTimersByTimeAsync(0)
    expect(onAuthLost).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(socket.getStatus()).toBe('offline')
  })

  it('does not loop on repeated 4401 without a ready in between', async () => {
    const { socket, refresh, onAuthLost } = setup()
    socket.start()
    FakeWebSocket.last.serverClose(4401)
    await vi.advanceTimersByTimeAsync(0)
    FakeWebSocket.last.serverClose(4401) // lần hai liên tiếp, vẫn chưa có ready
    await vi.advanceTimersByTimeAsync(0)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(onAuthLost).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(FakeWebSocket.instances).toHaveLength(2)
  })

  it('counts 4401 failures again after a successful ready', async () => {
    const { socket, onAuthLost } = setup()
    socket.start()
    FakeWebSocket.last.serverClose(4401)
    await vi.advanceTimersByTimeAsync(0)
    FakeWebSocket.last.open()
    FakeWebSocket.last.receive(ready)
    FakeWebSocket.last.serverClose(4401)
    await vi.advanceTimersByTimeAsync(0)
    expect(onAuthLost).not.toHaveBeenCalled()
    expect(FakeWebSocket.instances).toHaveLength(3)
  })

  it('tries to refresh first when there is no token', async () => {
    let token: string | null = null
    const refresh = vi.fn<() => Promise<RefreshResult>>().mockImplementation(async () => {
      token = 'tok-new'
      return 'ok'
    })
    const { socket } = setup({ getToken: () => token, refresh })
    socket.start()
    expect(FakeWebSocket.instances).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(FakeWebSocket.instances).toHaveLength(1)
    FakeWebSocket.last.open()
    expect(FakeWebSocket.last.sentJson).toEqual([{ type: 'auth', token: 'tok-new' }])
  })

  it('backs off when the refresh endpoint is unavailable', async () => {
    const refresh = vi.fn<() => Promise<RefreshResult>>().mockResolvedValue('unavailable')
    const { socket, onAuthLost } = setup({ getToken: () => null, refresh })
    socket.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(refresh).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(onAuthLost).not.toHaveBeenCalled()
  })

  it('stop() closes quietly: no reconnect and stale events are ignored', () => {
    const { socket, events } = setup()
    socket.start()
    const ws = FakeWebSocket.last
    ws.open()
    socket.stop()
    vi.advanceTimersByTime(60_000)
    ws.receive({ type: 'rooms_changed' })
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(events).toEqual([])
    expect(socket.getStatus()).toBe('offline')
  })

  it('can be started again after stop()', () => {
    const { socket } = setup()
    socket.start()
    socket.stop()
    socket.start()
    expect(FakeWebSocket.instances).toHaveLength(2)
  })

  it('reconnectNow() skips the waiting time', () => {
    const { socket } = setup()
    socket.start()
    FakeWebSocket.last.serverClose(1006)
    socket.reconnectNow()
    expect(FakeWebSocket.instances).toHaveLength(2)
    vi.advanceTimersByTime(60_000) // hẹn giờ cũ đã bị huỷ: không tạo thêm kết nối
    expect(FakeWebSocket.instances).toHaveLength(2)
  })

  it('reconnectNow() does nothing while connected', () => {
    const { socket } = setup()
    socket.start()
    FakeWebSocket.last.open()
    FakeWebSocket.last.receive(ready)
    socket.reconnectNow()
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('does not reconnect twice when an old socket closes after a newer one exists', () => {
    const { socket } = setup()
    socket.start()
    const first = FakeWebSocket.last
    first.serverClose(1006)
    socket.reconnectNow()
    first.serverClose(1006) // sự kiện đóng trễ của kết nối cũ
    vi.advanceTimersByTime(60_000)
    expect(FakeWebSocket.instances).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `npm test -- ws.test`
Expected: lỗi không tìm thấy module `./ws`.

- [ ] **Step 3: Viết `ws.ts`**

`frontend/src/lib/ws.ts`:
```ts
import type { RefreshResult } from './api'
import type { ServerEvent } from './types'

export type SocketStatus = 'connecting' | 'open' | 'offline'

export interface ChatSocketOptions {
  getToken: () => string | null
  refresh: () => Promise<RefreshResult>
  onAuthLost: () => void
  url?: string
  backoffMs?: number[]
  random?: () => number
  createSocket?: (url: string) => WebSocket
}

const DEFAULT_BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000]
const MAX_CONSECUTIVE_AUTH_FAILURES = 2
const CLOSE_UNAUTHENTICATED = 4401
const CLOSE_ACCOUNT_LOCKED = 4403

function defaultUrl(): string {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${window.location.host}/api/ws`
}

export class ChatSocket {
  private ws: WebSocket | null = null
  private status: SocketStatus = 'offline'
  private stopped = true
  private attempt = 0
  private authFailures = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly eventListeners = new Set<(event: ServerEvent) => void>()
  private readonly statusListeners = new Set<(status: SocketStatus) => void>()

  constructor(private readonly opts: ChatSocketOptions) {}

  getStatus(): SocketStatus {
    return this.status
  }

  onEvent(listener: (event: ServerEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  onStatus(listener: (status: SocketStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.attempt = 0
    this.authFailures = 0
    this.connect()
  }

  stop(): void {
    this.stopped = true
    this.clearTimer()
    const ws = this.ws
    this.ws = null
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null
      try {
        ws.close(1000)
      } catch {
        // đã đóng
      }
    }
    this.setStatus('offline')
  }

  send(payload: object): boolean {
    if (this.status !== 'open' || !this.ws) return false
    try {
      this.ws.send(JSON.stringify(payload))
      return true
    } catch {
      return false
    }
  }

  /** Dùng khi mạng có lại hoặc tab hiển thị lại: không chờ hết thời gian backoff. */
  reconnectNow(): void {
    if (this.stopped || this.status !== 'offline') return
    this.clearTimer()
    this.connect()
  }

  private setStatus(status: SocketStatus): void {
    if (this.status === status) return
    this.status = status
    this.statusListeners.forEach((listener) => listener(status))
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private connect(): void {
    if (this.stopped) return
    this.setStatus('connecting')
    const token = this.opts.getToken()
    if (!token) {
      void this.handleAuthFailure()
      return
    }
    const url = this.opts.url ?? defaultUrl()
    let ws: WebSocket
    try {
      ws = (this.opts.createSocket ?? ((u: string) => new WebSocket(u)))(url)
    } catch {
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    // Token chỉ đi trong khung đầu tiên, không bao giờ nằm trong URL.
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token }))
    ws.onmessage = (event) => this.handleMessage(ws, event.data)
    ws.onclose = (event) => this.handleClose(ws, event.code)
    ws.onerror = () => {} // onclose luôn chạy sau onerror
  }

  private handleMessage(ws: WebSocket, data: unknown): void {
    if (ws !== this.ws || typeof data !== 'string') return
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      return
    }
    if (!parsed || typeof parsed !== 'object' || typeof (parsed as { type?: unknown }).type !== 'string') return
    const event = parsed as ServerEvent
    if (event.type === 'ready') {
      this.attempt = 0
      this.authFailures = 0
      this.setStatus('open')
    }
    this.eventListeners.forEach((listener) => listener(event))
  }

  private handleClose(ws: WebSocket, code: number): void {
    if (ws !== this.ws) return // kết nối cũ đã bị thay thế
    this.ws = null
    this.setStatus('offline')
    if (this.stopped) return
    if (code === CLOSE_ACCOUNT_LOCKED) {
      this.giveUp()
    } else if (code === CLOSE_UNAUTHENTICATED) {
      void this.handleAuthFailure()
    } else {
      this.scheduleReconnect()
    }
  }

  private async handleAuthFailure(): Promise<void> {
    this.authFailures += 1
    if (this.authFailures > MAX_CONSECUTIVE_AUTH_FAILURES - 1 && this.authFailures >= MAX_CONSECUTIVE_AUTH_FAILURES) {
      this.giveUp()
      return
    }
    const result = await this.opts.refresh()
    if (this.stopped) return
    if (result === 'ok') this.connect()
    else if (result === 'denied') this.giveUp()
    else this.scheduleReconnect()
  }

  private giveUp(): void {
    this.stopped = true
    this.clearTimer()
    this.setStatus('offline')
    this.opts.onAuthLost()
  }

  private scheduleReconnect(): void {
    if (this.stopped) return
    this.setStatus('offline')
    const backoff = this.opts.backoffMs ?? DEFAULT_BACKOFF_MS
    const base = backoff[Math.min(this.attempt, backoff.length - 1)]
    this.attempt += 1
    const random = this.opts.random ?? Math.random
    const delay = Math.round(base * (0.8 + random() * 0.4))
    this.clearTimer()
    this.timer = setTimeout(() => {
      this.timer = null
      this.connect()
    }, delay)
  }
}
```
(Điều kiện trong `handleAuthFailure` được viết gọn: giữ đúng ý "lần thứ hai liên tiếp → bỏ cuộc"; nếu thấy dư thừa, đơn giản hoá thành `if (this.authFailures >= MAX_CONSECUTIVE_AUTH_FAILURES)` mà không đổi hành vi.)

- [ ] **Step 4: Chạy test**

Run: `npm test && npm run typecheck`
Expected: tất cả pass. Nếu test về `reconnectNow` hoặc thứ tự `onclose` của kết nối cũ phát hiện lỗi thật trong mã, sửa mã (không nới test).

- [ ] **Step 5: Commit**

```bash
git add frontend
git commit -m "feat: add chat websocket client with reconnect backoff and close-code handling" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `ChatStore`, `ChatController`, `ChatProvider`

**Files:**
- Create: `frontend/src/lib/chatStore.ts`, `frontend/src/lib/chatStore.test.ts`, `frontend/src/lib/chatController.ts`, `frontend/src/lib/chatController.test.ts`, `frontend/src/lib/ChatProvider.tsx`

**Interfaces:**
- Consumes: `ChatApi`, `ChatSocket`, `SocketStatus`, kiểu `Message`/`Room`/`MessagePage`/`ServerEvent`, `getAccessToken`, `refreshSession`, `handleAuthLost`, `useAuth`.
- Produces:
  - `chatStore.ts`: `ChatMessage` (= `Message & { pending?: 'sending' | 'failed'; errorCode?: string }`), `Thread` (`items`, `hasMoreBefore`, `loaded`, `loadingOlder`, `error`), `ChatState` (`status`, `rooms`, `roomsLoaded`, `roomsError`, `threads`), `class ChatStore` với `subscribe`, `getState`, và các thao tác: `setStatus`, `setRooms`, `setRoomsError`, `upsertRoom`, `applyLatest`, `applyOlder`, `applyAfter`, `setThreadLoadingOlder`, `setThreadError`, `upsertMessage`, `replaceMessage`, `markDeleted`, `addPending`, `setPendingState`, `removePending`, `bumpRoom`, `clearUnread`, `reset`. Thread rỗng: `EMPTY_THREAD`.
  - `chatController.ts`: `class ChatController` với `loadRooms()`, `openRoom(roomId)`, `loadOlder(roomId)`, `send(roomId, body) -> string | null` (trả `client_id`), `retry(clientId)`, `edit(messageId, body)`, `remove(roomId, messageId)`, `openDirect(userId) -> Promise<Room>`, `setActiveRoom(roomId | null)`, `onVisible()`, `handleSocketEvent(event)`, `dispose()`.
  - `ChatProvider.tsx`: `ChatProvider({children})` (chỉ dùng dưới `RequireAuth`), hooks `useChatController()`, `useChatState(selector)`, `useRooms()`, `useThread(roomId)`, `useSocketStatus()`.
  - Hợp đồng sự kiện: xem Global Constraints (sau `ready`/`resync`: `loadRooms` + bù tin cho thread đã tải + gửi lại tin đang chờ; `rooms_changed`: `loadRooms`).

- [ ] **Step 1: Viết test thất bại cho store**

`frontend/src/lib/chatStore.test.ts`:
```ts
import { ChatStore } from './chatStore'
import type { Message, MessagePage, Room } from './types'

const msg = (id: number, over: Partial<Message> = {}): Message => ({
  id,
  room_id: 1,
  sender_id: 2,
  sender_name: 'Bob',
  body: `tin ${id}`,
  kind: 'text',
  client_id: null,
  created_at: `2026-10-15T09:${String(id % 60).padStart(2, '0')}:00.000Z`,
  edited_at: null,
  deleted: false,
  ...over,
})

const page = (ids: number[], more = false): MessagePage => ({
  items: ids.map((id) => msg(id)),
  has_more_before: more,
  has_more_after: more,
})

const room = (id: number, over: Partial<Room> = {}): Room => ({
  id,
  type: 'group',
  name: `Phòng ${id}`,
  branch_id: null,
  member_count: 3,
  peer_id: null,
  last_message: null,
  unread_count: 0,
  last_activity: '2026-10-15T08:00:00.000Z',
  ...over,
})

const ids = (store: ChatStore, roomId = 1) => store.getState().threads[roomId]?.items.map((m) => m.id)

describe('ChatStore threads', () => {
  it('replaces the newest page but keeps pending messages at the end', () => {
    const store = new ChatStore()
    store.applyLatest(1, page([5, 6], true))
    store.addPending(1, { ...msg(-1, { client_id: 'c1', sender_id: 1 }), pending: 'sending' })
    store.applyLatest(1, page([5, 6, 7], true))
    expect(ids(store)).toEqual([5, 6, 7, -1])
    expect(store.getState().threads[1].hasMoreBefore).toBe(true)
    expect(store.getState().threads[1].loaded).toBe(true)
  })

  it('prepends older pages without duplicates and updates hasMoreBefore', () => {
    const store = new ChatStore()
    store.applyLatest(1, page([5, 6], true))
    store.applyOlder(1, page([3, 4, 5], false))
    expect(ids(store)).toEqual([3, 4, 5, 6])
    expect(store.getState().threads[1].hasMoreBefore).toBe(false)
  })

  it('appends catch-up pages in order without duplicates', () => {
    const store = new ChatStore()
    store.applyLatest(1, page([5, 6]))
    store.applyAfter(1, page([6, 7, 8]))
    expect(ids(store)).toEqual([5, 6, 7, 8])
  })

  it('replaces a pending message when the real one arrives with the same client_id', () => {
    const store = new ChatStore()
    store.applyLatest(1, page([5]))
    store.addPending(1, { ...msg(-1, { client_id: 'c1', sender_id: 1, body: 'xin chào' }), pending: 'sending' })
    store.upsertMessage(msg(6, { client_id: 'c1', sender_id: 1, body: 'xin chào' }))
    expect(ids(store)).toEqual([5, 6])
    expect(store.getState().threads[1].items.some((m) => m.pending)).toBe(false)
  })

  it('upserts by id, keeping order, and ignores threads that were never loaded', () => {
    const store = new ChatStore()
    store.upsertMessage(msg(9, { room_id: 2 }))
    expect(store.getState().threads[2]).toBeUndefined()
    store.applyLatest(1, page([5, 7]))
    store.upsertMessage(msg(6))
    store.upsertMessage(msg(7, { body: 'sửa' }))
    expect(ids(store)).toEqual([5, 6, 7])
    expect(store.getState().threads[1].items[2].body).toBe('sửa')
  })

  it('replaces updated messages and hides deleted ones, also in the room preview', () => {
    const store = new ChatStore()
    store.setRooms([room(1, { last_message: msg(7) })])
    store.applyLatest(1, page([6, 7]))
    store.replaceMessage(msg(7, { body: 'đã sửa', edited_at: '2026-10-15T10:00:00.000Z' }))
    expect(store.getState().rooms[0].last_message?.body).toBe('đã sửa')
    store.markDeleted(1, 7)
    const last = store.getState().threads[1].items[1]
    expect(last.deleted).toBe(true)
    expect(last.body).toBe('')
    expect(store.getState().rooms[0].last_message?.deleted).toBe(true)
    expect(store.getState().rooms[0].last_message?.body).toBe('')
  })

  it('tracks pending state, failures with an error code, and removal', () => {
    const store = new ChatStore()
    store.addPending(1, { ...msg(-1, { client_id: 'c1', sender_id: 1 }), pending: 'sending' })
    store.setPendingState('c1', 'failed', 'rate_limited')
    const failed = store.getState().threads[1].items[0]
    expect(failed.pending).toBe('failed')
    expect(failed.errorCode).toBe('rate_limited')
    store.setPendingState('c1', 'sending')
    expect(store.getState().threads[1].items[0].errorCode).toBeUndefined()
    store.removePending('c1')
    expect(ids(store)).toEqual([])
  })

  it('notifies subscribers on every change and produces new snapshots', () => {
    const store = new ChatStore()
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)
    const before = store.getState()
    store.setStatus('open')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.getState()).not.toBe(before)
    unsubscribe()
    store.setStatus('offline')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('reset() clears everything', () => {
    const store = new ChatStore()
    store.setRooms([room(1)])
    store.applyLatest(1, page([1]))
    store.reset()
    expect(store.getState().rooms).toEqual([])
    expect(store.getState().threads).toEqual({})
    expect(store.getState().roomsLoaded).toBe(false)
  })
})

describe('ChatStore rooms', () => {
  it('bumps the preview, activity and unread count and re-sorts the list', () => {
    const store = new ChatStore()
    store.setRooms([room(1, { last_activity: '2026-10-15T09:00:00.000Z' }), room(2, { last_activity: '2026-10-15T08:00:00.000Z' })])
    const found = store.bumpRoom(msg(30, { room_id: 2, created_at: '2026-10-15T10:00:00.000Z' }), true)
    expect(found).toBe(true)
    expect(store.getState().rooms.map((r) => r.id)).toEqual([2, 1])
    expect(store.getState().rooms[0].unread_count).toBe(1)
    expect(store.getState().rooms[0].last_message?.id).toBe(30)
  })

  it('does not bump when the message is older than the current preview or the room is unknown', () => {
    const store = new ChatStore()
    store.setRooms([room(1, { last_message: msg(10), unread_count: 2 })])
    expect(store.bumpRoom(msg(9), true)).toBe(true)
    expect(store.getState().rooms[0].last_message?.id).toBe(10)
    expect(store.getState().rooms[0].unread_count).toBe(2)
    expect(store.bumpRoom(msg(11, { room_id: 99 }), true)).toBe(false)
  })

  it('does not count unread when told not to, and clears unread', () => {
    const store = new ChatStore()
    store.setRooms([room(1, { unread_count: 3 })])
    store.bumpRoom(msg(1), false)
    expect(store.getState().rooms[0].unread_count).toBe(3)
    store.clearUnread(1)
    expect(store.getState().rooms[0].unread_count).toBe(0)
  })

  it('adds a new room with upsertRoom and replaces an existing one', () => {
    const store = new ChatStore()
    store.upsertRoom(room(5, { name: 'A' }))
    store.upsertRoom(room(5, { name: 'B' }))
    expect(store.getState().rooms).toHaveLength(1)
    expect(store.getState().rooms[0].name).toBe('B')
  })
})
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `npm test -- chatStore`
Expected: lỗi không tìm thấy module `./chatStore`.

- [ ] **Step 3: Viết `chatStore.ts`**

`frontend/src/lib/chatStore.ts`:
```ts
import type { Message, MessagePage, Room } from './types'
import type { SocketStatus } from './ws'

export interface ChatMessage extends Message {
  pending?: 'sending' | 'failed'
  errorCode?: string
}

export interface Thread {
  items: ChatMessage[]
  hasMoreBefore: boolean
  loaded: boolean
  loadingOlder: boolean
  error: boolean
}

export interface ChatState {
  status: SocketStatus
  rooms: Room[]
  roomsLoaded: boolean
  roomsError: boolean
  threads: Record<number, Thread>
}

export const EMPTY_THREAD: Thread = { items: [], hasMoreBefore: false, loaded: false, loadingOlder: false, error: false }

const isPending = (m: ChatMessage) => m.pending !== undefined

/** Gộp tin thật (theo id, tăng dần); tin đang chờ luôn nằm cuối, giữ nguyên thứ tự tạo. */
function mergeReal(existing: ChatMessage[], incoming: Message[]): ChatMessage[] {
  const byId = new Map<number, ChatMessage>()
  for (const m of existing) if (!isPending(m)) byId.set(m.id, m)
  for (const m of incoming) byId.set(m.id, m)
  const real = [...byId.values()].sort((a, b) => a.id - b.id)
  return [...real, ...existing.filter(isPending)]
}

function sortRooms(rooms: Room[]): Room[] {
  return [...rooms].sort((a, b) => (a.last_activity < b.last_activity ? 1 : a.last_activity > b.last_activity ? -1 : b.id - a.id))
}

export class ChatStore {
  private state: ChatState = { status: 'offline', rooms: [], roomsLoaded: false, roomsError: false, threads: {} }
  private readonly listeners = new Set<() => void>()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getState = (): ChatState => this.state

  private set(patch: Partial<ChatState>): void {
    this.state = { ...this.state, ...patch }
    this.listeners.forEach((listener) => listener())
  }

  private updateThread(roomId: number, fn: (thread: Thread) => Thread): void {
    const current = this.state.threads[roomId] ?? EMPTY_THREAD
    this.set({ threads: { ...this.state.threads, [roomId]: fn(current) } })
  }

  setStatus(status: SocketStatus): void {
    if (this.state.status !== status) this.set({ status })
  }

  setRooms(rooms: Room[]): void {
    this.set({ rooms: sortRooms(rooms), roomsLoaded: true, roomsError: false })
  }

  setRoomsError(): void {
    this.set({ roomsError: true })
  }

  upsertRoom(room: Room): void {
    const others = this.state.rooms.filter((r) => r.id !== room.id)
    this.set({ rooms: sortRooms([...others, room]) })
  }

  applyLatest(roomId: number, page: MessagePage): void {
    this.updateThread(roomId, (t) => ({
      ...t,
      items: mergeReal(t.items.filter(isPending), page.items),
      hasMoreBefore: page.has_more_before,
      loaded: true,
      error: false,
    }))
  }

  applyOlder(roomId: number, page: MessagePage): void {
    this.updateThread(roomId, (t) => ({
      ...t,
      items: mergeReal(t.items, page.items),
      hasMoreBefore: page.has_more_before,
      loadingOlder: false,
    }))
  }

  applyAfter(roomId: number, page: MessagePage): void {
    this.updateThread(roomId, (t) => ({ ...t, items: mergeReal(t.items, page.items) }))
  }

  setThreadLoadingOlder(roomId: number, loadingOlder: boolean): void {
    this.updateThread(roomId, (t) => ({ ...t, loadingOlder }))
  }

  setThreadError(roomId: number, error: boolean): void {
    this.updateThread(roomId, (t) => ({ ...t, error }))
  }

  /** Tin mới (từ WebSocket): cập nhật thread đã tải và thay thế tin lạc quan cùng client_id. */
  upsertMessage(message: Message): void {
    const thread = this.state.threads[message.room_id]
    if (!thread) return
    const items = message.client_id
      ? thread.items.filter((m) => !(isPending(m) && m.client_id === message.client_id))
      : thread.items
    this.set({
      threads: { ...this.state.threads, [message.room_id]: { ...thread, items: mergeReal(items, [message]) } },
    })
  }

  replaceMessage(message: Message): void {
    const thread = this.state.threads[message.room_id]
    const threads = thread
      ? {
          ...this.state.threads,
          [message.room_id]: { ...thread, items: thread.items.map((m) => (m.id === message.id ? { ...message } : m)) },
        }
      : this.state.threads
    const rooms = this.state.rooms.map((r) => (r.id === message.room_id && r.last_message?.id === message.id ? { ...r, last_message: message } : r))
    this.set({ threads, rooms })
  }

  markDeleted(roomId: number, messageId: number): void {
    const hide = (m: Message): Message => (m.id === messageId ? { ...m, deleted: true, body: '' } : m)
    const thread = this.state.threads[roomId]
    const threads = thread
      ? { ...this.state.threads, [roomId]: { ...thread, items: thread.items.map((m) => hide(m) as ChatMessage) } }
      : this.state.threads
    const rooms = this.state.rooms.map((r) => (r.id === roomId && r.last_message ? { ...r, last_message: hide(r.last_message) } : r))
    this.set({ threads, rooms })
  }

  addPending(roomId: number, message: ChatMessage): void {
    this.updateThread(roomId, (t) => ({ ...t, items: [...t.items, message] }))
  }

  setPendingState(clientId: string, pending: 'sending' | 'failed', errorCode?: string): void {
    const threads: Record<number, Thread> = {}
    for (const [key, thread] of Object.entries(this.state.threads)) {
      threads[Number(key)] = {
        ...thread,
        items: thread.items.map((m) => {
          if (!isPending(m) || m.client_id !== clientId) return m
          const { errorCode: _drop, ...rest } = m
          return { ...rest, pending, ...(pending === 'failed' && errorCode ? { errorCode } : {}) }
        }),
      }
    }
    this.set({ threads })
  }

  removePending(clientId: string): void {
    const threads: Record<number, Thread> = {}
    for (const [key, thread] of Object.entries(this.state.threads)) {
      threads[Number(key)] = { ...thread, items: thread.items.filter((m) => !(isPending(m) && m.client_id === clientId)) }
    }
    this.set({ threads })
  }

  /** Cập nhật xem trước/hoạt động/chưa đọc của phòng. Trả false nếu phòng chưa có trong danh sách. */
  bumpRoom(message: Message, countUnread: boolean): boolean {
    const room = this.state.rooms.find((r) => r.id === message.room_id)
    if (!room) return false
    const newer = !room.last_message || message.id > room.last_message.id
    if (!newer) return true
    this.set({
      rooms: sortRooms(
        this.state.rooms.map((r) =>
          r.id === room.id
            ? { ...r, last_message: message, last_activity: message.created_at, unread_count: r.unread_count + (countUnread ? 1 : 0) }
            : r,
        ),
      ),
    })
    return true
  }

  clearUnread(roomId: number): void {
    this.set({ rooms: this.state.rooms.map((r) => (r.id === roomId && r.unread_count !== 0 ? { ...r, unread_count: 0 } : r)) })
  }

  reset(): void {
    this.set({ rooms: [], roomsLoaded: false, roomsError: false, threads: {} })
  }
}
```

- [ ] **Step 4: Viết test thất bại cho controller**

`frontend/src/lib/chatController.test.ts`:
```ts
import { vi } from 'vitest'
import { ChatController } from './chatController'
import { ChatStore } from './chatStore'
import type { Message, MessagePage, Room } from './types'

const msg = (id: number, over: Partial<Message> = {}): Message => ({
  id,
  room_id: 1,
  sender_id: 2,
  sender_name: 'Bob',
  body: `tin ${id}`,
  kind: 'text',
  client_id: null,
  created_at: `2026-10-15T09:${String(id % 60).padStart(2, '0')}:00.000Z`,
  edited_at: null,
  deleted: false,
  ...over,
})
const page = (ids: number[], more = false): MessagePage => ({ items: ids.map((i) => msg(i)), has_more_before: more, has_more_after: more })
const room = (id: number, over: Partial<Room> = {}): Room => ({
  id, type: 'group', name: `P${id}`, branch_id: null, member_count: 3, peer_id: null,
  last_message: null, unread_count: 0, last_activity: '2026-10-15T08:00:00.000Z', ...over,
})

function setup(opts: { visible?: boolean; open?: boolean } = {}) {
  const store = new ChatStore()
  const api = {
    rooms: vi.fn().mockResolvedValue([room(1), room(2)]),
    messages: vi.fn().mockResolvedValue(page([1, 2, 3])),
    markRead: vi.fn().mockResolvedValue(undefined),
    openDirect: vi.fn(),
    editMessage: vi.fn(),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
    directory: vi.fn(),
  }
  let isOpen = opts.open ?? true
  const socket = { send: vi.fn(() => isOpen), getStatus: () => (isOpen ? 'open' : 'offline') as 'open' | 'offline' }
  let counter = 0
  const controller = new ChatController({
    store,
    api,
    socket,
    meId: 1,
    meName: 'Tôi',
    newClientId: () => `cid-${++counter}`,
    isVisible: () => opts.visible ?? true,
    sendTimeoutMs: 15_000,
  })
  return { store, api, socket, controller, setOpen: (v: boolean) => { isOpen = v } }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }))
afterEach(() => vi.useRealTimers())

describe('ChatController: loading', () => {
  it('opens a room by loading the newest page, then only catches up on later opens', async () => {
    const { controller, api, store } = setup()
    await controller.openRoom(1)
    expect(api.messages).toHaveBeenCalledWith(1, { limit: 50 })
    expect(store.getState().threads[1].items.map((m) => m.id)).toEqual([1, 2, 3])
    api.messages.mockResolvedValueOnce({ items: [msg(4)], has_more_before: false, has_more_after: false })
    await controller.openRoom(1)
    expect(api.messages).toHaveBeenLastCalledWith(1, { after: 3, limit: 100 })
    expect(store.getState().threads[1].items.map((m) => m.id)).toEqual([1, 2, 3, 4])
  })

  it('catch-up keeps paging while the server says there is more', async () => {
    const { controller, api, store } = setup()
    await controller.openRoom(1)
    api.messages
      .mockResolvedValueOnce({ items: [msg(4), msg(5)], has_more_before: false, has_more_after: true })
      .mockResolvedValueOnce({ items: [msg(6)], has_more_before: false, has_more_after: false })
    await controller.openRoom(1)
    expect(api.messages).toHaveBeenNthCalledWith(2, 1, { after: 3, limit: 100 })
    expect(api.messages).toHaveBeenNthCalledWith(3, 1, { after: 5, limit: 100 })
    expect(store.getState().threads[1].items.map((m) => m.id)).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('flags a thread error when the first load fails and recovers on retry', async () => {
    const { controller, api, store } = setup()
    api.messages.mockRejectedValueOnce(new Error('x'))
    await controller.openRoom(1)
    expect(store.getState().threads[1].error).toBe(true)
    await controller.openRoom(1)
    expect(store.getState().threads[1].error).toBe(false)
    expect(store.getState().threads[1].loaded).toBe(true)
  })

  it('loads older messages once at a time and stops when there is nothing more', async () => {
    const { controller, api, store } = setup()
    api.messages.mockResolvedValueOnce(page([5, 6, 7], true))
    await controller.openRoom(1)
    api.messages.mockResolvedValueOnce(page([2, 3, 4], false))
    await Promise.all([controller.loadOlder(1), controller.loadOlder(1)])
    expect(api.messages).toHaveBeenCalledTimes(2)
    expect(api.messages).toHaveBeenLastCalledWith(1, { before: 5, limit: 50 })
    expect(store.getState().threads[1].items.map((m) => m.id)).toEqual([2, 3, 4, 5, 6, 7])
    await controller.loadOlder(1)
    expect(api.messages).toHaveBeenCalledTimes(2)
  })

  it('ignores a stale rooms response when a newer request was made', async () => {
    const { controller, api, store } = setup()
    let resolveFirst: (rooms: Room[]) => void = () => {}
    api.rooms.mockImplementationOnce(() => new Promise<Room[]>((r) => { resolveFirst = r }))
    const first = controller.loadRooms()
    api.rooms.mockResolvedValueOnce([room(7)])
    await controller.loadRooms()
    resolveFirst([room(1)])
    await first
    expect(store.getState().rooms.map((r) => r.id)).toEqual([7])
  })

  it('marks the rooms as failed to load when the request fails', async () => {
    const { controller, api, store } = setup()
    api.rooms.mockRejectedValueOnce(new Error('x'))
    await controller.loadRooms()
    expect(store.getState().roomsError).toBe(true)
  })
})

describe('ChatController: optimistic send', () => {
  it('adds a pending message, sends it with its client_id and reconciles when the server echoes it', async () => {
    const { controller, socket, store } = setup()
    await controller.openRoom(1)
    const clientId = controller.send(1, '  xin chào  ')
    expect(clientId).toBe('cid-1')
    expect(socket.send).toHaveBeenCalledWith({ type: 'send', room_id: 1, body: 'xin chào', client_id: 'cid-1' })
    const pending = store.getState().threads[1].items.at(-1)!
    expect(pending).toMatchObject({ pending: 'sending', body: 'xin chào', sender_id: 1, sender_name: 'Tôi', client_id: 'cid-1' })
    expect(pending.id).toBeLessThan(0)

    controller.handleSocketEvent({ type: 'message', message: msg(4, { sender_id: 1, sender_name: 'Tôi', body: 'xin chào', client_id: 'cid-1' }) })
    const items = store.getState().threads[1].items
    expect(items.map((m) => m.id)).toEqual([1, 2, 3, 4])
    expect(items.some((m) => m.pending)).toBe(false)
    vi.advanceTimersByTime(60_000) // hẹn giờ lỗi đã bị huỷ
    expect(store.getState().threads[1].items.some((m) => m.pending)).toBe(false)
  })

  it('ignores empty messages', async () => {
    const { controller, socket } = setup()
    await controller.openRoom(1)
    expect(controller.send(1, '   ')).toBeNull()
    expect(socket.send).not.toHaveBeenCalled()
  })

  it('keeps the message pending while offline and resends it (same client_id) after ready', async () => {
    const { controller, socket, setOpen, store } = setup({ open: false })
    await controller.openRoom(1)
    controller.send(1, 'gửi sau')
    expect(store.getState().threads[1].items.at(-1)!.pending).toBe('sending')
    setOpen(true)
    controller.handleSocketEvent({ type: 'ready', user_id: 1 })
    await flush()
    const payloads = socket.send.mock.calls.map((c) => c[0])
    expect(payloads.filter((p) => p.client_id === 'cid-1').length).toBeGreaterThanOrEqual(2)
    expect(payloads.at(-1)).toEqual({ type: 'send', room_id: 1, body: 'gửi sau', client_id: 'cid-1' })
  })

  it('marks a message as failed after the timeout, and retry resends it with the same client_id', async () => {
    const { controller, socket, store } = setup()
    await controller.openRoom(1)
    controller.send(1, 'mất mạng')
    vi.advanceTimersByTime(15_000)
    expect(store.getState().threads[1].items.at(-1)!.pending).toBe('failed')
    controller.retry('cid-1')
    expect(store.getState().threads[1].items.at(-1)!.pending).toBe('sending')
    expect(socket.send).toHaveBeenLastCalledWith({ type: 'send', room_id: 1, body: 'mất mạng', client_id: 'cid-1' })
    controller.handleSocketEvent({ type: 'message', message: msg(9, { sender_id: 1, body: 'mất mạng', client_id: 'cid-1' }) })
    expect(store.getState().threads[1].items.filter((m) => m.body === 'mất mạng')).toHaveLength(1)
  })

  it('marks the pending message as failed with the server error code', async () => {
    const { controller, store } = setup()
    await controller.openRoom(1)
    controller.send(1, 'nhanh quá')
    controller.handleSocketEvent({ type: 'error', code: 'rate_limited', client_id: 'cid-1' })
    expect(store.getState().threads[1].items.at(-1)).toMatchObject({ pending: 'failed', errorCode: 'rate_limited' })
  })

  it('ignores errors that do not belong to a pending message', async () => {
    const { controller, store } = setup()
    await controller.openRoom(1)
    controller.handleSocketEvent({ type: 'error', code: 'invalid_json', client_id: null })
    controller.handleSocketEvent({ type: 'error', code: 'x', client_id: 'unknown' })
    expect(store.getState().threads[1].items).toHaveLength(3)
  })
})

describe('ChatController: unread counts and read markers', () => {
  it('counts an incoming message as unread when the room is not being viewed', async () => {
    const { controller, store, api } = setup()
    await controller.loadRooms()
    controller.handleSocketEvent({ type: 'message', message: msg(10, { room_id: 2 }) })
    expect(store.getState().rooms.find((r) => r.id === 2)!.unread_count).toBe(1)
    expect(api.markRead).not.toHaveBeenCalled()
  })

  it('does not count and marks as read when the room is open and the tab is visible', async () => {
    const { controller, store, api } = setup()
    await controller.loadRooms()
    controller.setActiveRoom(1)
    await controller.openRoom(1)
    api.markRead.mockClear()
    controller.handleSocketEvent({ type: 'message', message: msg(10, { room_id: 1 }) })
    expect(store.getState().rooms.find((r) => r.id === 1)!.unread_count).toBe(0)
    expect(api.markRead).toHaveBeenCalledWith(1, 10)
  })

  it('counts as unread when the room is open but the tab is hidden, then marks read when it becomes visible', async () => {
    let visible = false
    const store = new ChatStore()
    const api = { rooms: vi.fn().mockResolvedValue([room(1)]), messages: vi.fn().mockResolvedValue(page([1])), markRead: vi.fn().mockResolvedValue(undefined), openDirect: vi.fn(), editMessage: vi.fn(), deleteMessage: vi.fn(), directory: vi.fn() }
    const controller = new ChatController({ store, api, socket: { send: vi.fn(() => true), getStatus: () => 'open' }, meId: 1, meName: 'Tôi', isVisible: () => visible })
    await controller.loadRooms()
    controller.setActiveRoom(1)
    await controller.openRoom(1)
    controller.handleSocketEvent({ type: 'message', message: msg(5, { room_id: 1 }) })
    expect(store.getState().rooms[0].unread_count).toBe(1)
    expect(api.markRead).not.toHaveBeenCalled()
    visible = true
    controller.onVisible()
    expect(store.getState().rooms[0].unread_count).toBe(0)
    expect(api.markRead).toHaveBeenCalledWith(1, 5)
  })

  it('never counts the user\'s own messages (for example sent from another tab)', async () => {
    const { controller, store } = setup()
    await controller.loadRooms()
    controller.handleSocketEvent({ type: 'message', message: msg(11, { room_id: 2, sender_id: 1 }) })
    expect(store.getState().rooms.find((r) => r.id === 2)!.unread_count).toBe(0)
  })

  it('does not send the same read marker twice', async () => {
    const { controller, api } = setup()
    await controller.loadRooms()
    controller.setActiveRoom(1)
    await controller.openRoom(1)
    expect(api.markRead).toHaveBeenCalledTimes(1)
    controller.onVisible()
    controller.onVisible()
    expect(api.markRead).toHaveBeenCalledTimes(1)
  })

  it('reloads the room list when a message arrives for an unknown room', async () => {
    const { controller, api } = setup()
    await controller.loadRooms()
    api.rooms.mockClear()
    controller.handleSocketEvent({ type: 'message', message: msg(12, { room_id: 77 }) })
    expect(api.rooms).toHaveBeenCalledTimes(1)
  })
})

describe('ChatController: socket events', () => {
  it('after ready and after resync: reloads rooms and catches up on every loaded thread only', async () => {
    const { controller, api } = setup()
    await controller.loadRooms()
    await controller.openRoom(1) // chỉ phòng 1 đã tải
    api.rooms.mockClear()
    api.messages.mockClear()
    api.messages.mockResolvedValue({ items: [], has_more_before: false, has_more_after: false })
    controller.handleSocketEvent({ type: 'ready', user_id: 1 })
    await flush()
    expect(api.rooms).toHaveBeenCalledTimes(1)
    expect(api.messages).toHaveBeenCalledTimes(1)
    expect(api.messages).toHaveBeenCalledWith(1, { after: 3, limit: 100 })
    controller.handleSocketEvent({ type: 'resync' })
    await flush()
    expect(api.rooms).toHaveBeenCalledTimes(2)
    expect(api.messages).toHaveBeenCalledTimes(2)
  })

  it('reloads the room list on rooms_changed', async () => {
    const { controller, api } = setup()
    controller.handleSocketEvent({ type: 'rooms_changed' })
    await flush()
    expect(api.rooms).toHaveBeenCalledTimes(1)
  })

  it('applies message_updated and message_deleted events', async () => {
    const { controller, store } = setup()
    await controller.openRoom(1)
    controller.handleSocketEvent({ type: 'message_updated', message: msg(2, { body: 'đã sửa', edited_at: '2026-10-15T10:00:00.000Z' }) })
    controller.handleSocketEvent({ type: 'message_deleted', room_id: 1, message_id: 3 })
    const items = store.getState().threads[1].items
    expect(items[1].body).toBe('đã sửa')
    expect(items[2]).toMatchObject({ deleted: true, body: '' })
  })
})

describe('ChatController: edit, delete, direct rooms', () => {
  it('edits and deletes through the API and updates the store', async () => {
    const { controller, api, store } = setup()
    await controller.openRoom(1)
    api.editMessage.mockResolvedValueOnce(msg(2, { body: 'mới', edited_at: '2026-10-15T10:00:00.000Z' }))
    await controller.edit(2, 'mới')
    expect(store.getState().threads[1].items[1].body).toBe('mới')
    await controller.remove(1, 3)
    expect(api.deleteMessage).toHaveBeenCalledWith(3)
    expect(store.getState().threads[1].items[2].deleted).toBe(true)
  })

  it('lets API errors propagate to the caller', async () => {
    const { controller, api } = setup()
    api.editMessage.mockRejectedValueOnce(new Error('403'))
    await expect(controller.edit(2, 'x')).rejects.toThrow('403')
  })

  it('opens a direct room and adds it to the list', async () => {
    const { controller, api, store } = setup()
    api.openDirect.mockResolvedValueOnce(room(9, { type: 'direct', name: 'Hà', peer_id: 5 }))
    const opened = await controller.openDirect(5)
    expect(opened.id).toBe(9)
    expect(store.getState().rooms.some((r) => r.id === 9)).toBe(true)
  })

  it('dispose() cancels pending timers', async () => {
    const { controller, store } = setup()
    await controller.openRoom(1)
    controller.send(1, 'x')
    controller.dispose()
    vi.advanceTimersByTime(60_000)
    expect(store.getState().threads[1].items.at(-1)!.pending).toBe('sending')
  })
})
```

- [ ] **Step 5: Viết `chatController.ts`**

`frontend/src/lib/chatController.ts`:
```ts
import type { ChatApi } from './chatApi'
import { EMPTY_THREAD, type ChatMessage, type ChatStore } from './chatStore'
import type { Message, Room, ServerEvent } from './types'
import type { SocketStatus } from './ws'

export interface ChatControllerDeps {
  store: ChatStore
  api: ChatApi
  socket: { send(payload: object): boolean; getStatus(): SocketStatus }
  meId: number
  meName: string
  newClientId?: () => string
  isVisible?: () => boolean
  sendTimeoutMs?: number
}

const PAGE_SIZE = 50
const CATCH_UP_PAGE = 100
const CATCH_UP_MAX_PAGES = 20

interface PendingMeta {
  roomId: number
  body: string
}

export class ChatController {
  private activeRoom: number | null = null
  private roomsSeq = 0
  private nextLocalId = -1
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly pendingMeta = new Map<string, PendingMeta>()
  private readonly lastMarked = new Map<number, number>()

  constructor(private readonly deps: ChatControllerDeps) {}

  // ---- tải dữ liệu ----

  async loadRooms(): Promise<void> {
    const seq = ++this.roomsSeq
    try {
      const rooms = await this.deps.api.rooms()
      if (seq === this.roomsSeq) this.deps.store.setRooms(rooms)
    } catch {
      if (seq === this.roomsSeq) this.deps.store.setRoomsError()
    }
  }

  async openRoom(roomId: number): Promise<void> {
    const thread = this.deps.store.getState().threads[roomId]
    if (thread?.loaded) await this.catchUp(roomId)
    else await this.loadLatest(roomId)
    this.markReadIfViewing(roomId)
  }

  private async loadLatest(roomId: number): Promise<void> {
    try {
      this.deps.store.applyLatest(roomId, await this.deps.api.messages(roomId, { limit: PAGE_SIZE }))
    } catch {
      this.deps.store.setThreadError(roomId, true)
    }
  }

  private lastRealId(roomId: number): number | null {
    const items = this.deps.store.getState().threads[roomId]?.items ?? []
    for (let i = items.length - 1; i >= 0; i--) if (!items[i].pending) return items[i].id
    return null
  }

  private async catchUp(roomId: number): Promise<void> {
    let after = this.lastRealId(roomId)
    if (after === null) return this.loadLatest(roomId)
    try {
      for (let i = 0; i < CATCH_UP_MAX_PAGES; i++) {
        const page = await this.deps.api.messages(roomId, { after, limit: CATCH_UP_PAGE })
        this.deps.store.applyAfter(roomId, page)
        if (!page.has_more_after || page.items.length === 0) return
        after = page.items[page.items.length - 1].id
      }
      await this.loadLatest(roomId) // lỡ quá nhiều tin: tải lại trang mới nhất
    } catch {
      // lần ready/resync sau sẽ bù tiếp
    }
  }

  async loadOlder(roomId: number): Promise<void> {
    const thread = this.deps.store.getState().threads[roomId] ?? EMPTY_THREAD
    if (thread.loadingOlder || !thread.hasMoreBefore) return
    const items = thread.items.filter((m) => !m.pending)
    if (items.length === 0) return
    this.deps.store.setThreadLoadingOlder(roomId, true)
    try {
      this.deps.store.applyOlder(roomId, await this.deps.api.messages(roomId, { before: items[0].id, limit: PAGE_SIZE }))
    } catch {
      this.deps.store.setThreadLoadingOlder(roomId, false)
    }
  }

  // ---- gửi lạc quan ----

  send(roomId: number, rawBody: string): string | null {
    const body = rawBody.trim()
    if (!body) return null
    const clientId = (this.deps.newClientId ?? (() => crypto.randomUUID()))()
    const message: ChatMessage = {
      id: this.nextLocalId--,
      room_id: roomId,
      sender_id: this.deps.meId,
      sender_name: this.deps.meName,
      body,
      kind: 'text',
      client_id: clientId,
      created_at: new Date().toISOString(),
      edited_at: null,
      deleted: false,
      pending: 'sending',
    }
    this.pendingMeta.set(clientId, { roomId, body })
    this.deps.store.addPending(roomId, message)
    this.transmit(clientId)
    return clientId
  }

  retry(clientId: string): void {
    if (!this.pendingMeta.has(clientId)) return
    this.deps.store.setPendingState(clientId, 'sending')
    this.transmit(clientId)
  }

  private transmit(clientId: string): void {
    const meta = this.pendingMeta.get(clientId)
    if (!meta) return
    this.armTimeout(clientId)
    this.deps.socket.send({ type: 'send', room_id: meta.roomId, body: meta.body, client_id: clientId })
  }

  private armTimeout(clientId: string): void {
    const existing = this.timers.get(clientId)
    if (existing) clearTimeout(existing)
    this.timers.set(
      clientId,
      setTimeout(() => {
        this.timers.delete(clientId)
        this.deps.store.setPendingState(clientId, 'failed')
      }, this.deps.sendTimeoutMs ?? 15_000),
    )
  }

  private confirm(clientId: string): void {
    const timer = this.timers.get(clientId)
    if (timer) clearTimeout(timer)
    this.timers.delete(clientId)
    this.pendingMeta.delete(clientId)
  }

  private resendPending(): void {
    for (const clientId of this.pendingMeta.keys()) {
      const thread = Object.values(this.deps.store.getState().threads).find((t) =>
        t.items.some((m) => m.pending === 'sending' && m.client_id === clientId),
      )
      if (thread) this.transmit(clientId)
    }
  }

  // ---- sự kiện từ WebSocket ----

  handleSocketEvent(event: ServerEvent): void {
    switch (event.type) {
      case 'ready':
      case 'resync':
        void this.resync()
        break
      case 'rooms_changed':
        void this.loadRooms()
        break
      case 'message':
        this.onMessage(event.message)
        break
      case 'message_updated':
        this.deps.store.replaceMessage(event.message)
        break
      case 'message_deleted':
        this.deps.store.markDeleted(event.room_id, event.message_id)
        break
      case 'error':
        if (event.client_id && this.pendingMeta.has(event.client_id)) {
          const timer = this.timers.get(event.client_id)
          if (timer) clearTimeout(timer)
          this.timers.delete(event.client_id)
          this.deps.store.setPendingState(event.client_id, 'failed', event.code)
        }
        break
      default:
        break
    }
  }

  private async resync(): Promise<void> {
    this.resendPending()
    await this.loadRooms()
    const threads = this.deps.store.getState().threads
    await Promise.all(
      Object.entries(threads)
        .filter(([, thread]) => thread.loaded)
        .map(async ([roomId]) => {
          await this.catchUp(Number(roomId))
          this.markReadIfViewing(Number(roomId))
        }),
    )
  }

  private onMessage(message: Message): void {
    const mine = message.sender_id === this.deps.meId
    if (mine && message.client_id) this.confirm(message.client_id)
    const viewing = this.isViewing(message.room_id)
    this.deps.store.upsertMessage(message)
    const known = this.deps.store.bumpRoom(message, !mine && !viewing)
    if (!known) void this.loadRooms()
    if (!mine && viewing) this.markReadIfViewing(message.room_id)
  }

  // ---- đã đọc ----

  setActiveRoom(roomId: number | null): void {
    this.activeRoom = roomId
  }

  onVisible(): void {
    if (this.activeRoom !== null) this.markReadIfViewing(this.activeRoom)
  }

  private isViewing(roomId: number): boolean {
    const visible = this.deps.isVisible ? this.deps.isVisible() : document.visibilityState === 'visible'
    return this.activeRoom === roomId && visible
  }

  private markReadIfViewing(roomId: number): void {
    if (!this.isViewing(roomId)) return
    const last = this.lastRealId(roomId)
    if (last === null || (this.lastMarked.get(roomId) ?? 0) >= last) return
    this.lastMarked.set(roomId, last)
    this.deps.store.clearUnread(roomId)
    this.deps.api.markRead(roomId, last).catch(() => {
      this.lastMarked.delete(roomId)
    })
  }

  // ---- sửa, xoá, chat mới ----

  async edit(messageId: number, body: string): Promise<void> {
    this.deps.store.replaceMessage(await this.deps.api.editMessage(messageId, body))
  }

  async remove(roomId: number, messageId: number): Promise<void> {
    await this.deps.api.deleteMessage(messageId)
    this.deps.store.markDeleted(roomId, messageId)
  }

  async openDirect(userId: number): Promise<Room> {
    const room = await this.deps.api.openDirect(userId)
    this.deps.store.upsertRoom(room)
    return room
  }

  dispose(): void {
    this.timers.forEach((timer) => clearTimeout(timer))
    this.timers.clear()
  }
}
```
Ghi chú cho người thực hiện: nếu một test ở Step 4 phát hiện hành vi sai trong mã trên (ví dụ thứ tự `confirm`/`upsertMessage`, bộ đếm hẹn giờ), sửa mã chứ không nới test.

- [ ] **Step 6: Viết `ChatProvider.tsx`**

`frontend/src/lib/ChatProvider.tsx`:
```tsx
import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { getAccessToken, handleAuthLost, refreshSession } from './api'
import { useAuth } from './auth'
import { chatApi } from './chatApi'
import { ChatController } from './chatController'
import { ChatStore, EMPTY_THREAD, type ChatState, type Thread } from './chatStore'
import type { Room } from './types'
import { ChatSocket, type SocketStatus } from './ws'

interface ChatContextValue {
  store: ChatStore
  controller: ChatController
}

const ChatContext = createContext<ChatContextValue | null>(null)

function build(userId: number, userName: string): { socket: ChatSocket } & ChatContextValue {
  const store = new ChatStore()
  const socket = new ChatSocket({ getToken: getAccessToken, refresh: refreshSession, onAuthLost: handleAuthLost })
  const controller = new ChatController({ store, api: chatApi, socket, meId: userId, meName: userName })
  socket.onStatus((status) => store.setStatus(status))
  socket.onEvent((event) => controller.handleSocketEvent(event))
  return { store, controller, socket }
}

/** Chỉ dùng dưới RequireAuth: giữ một WebSocket cho cả phiên làm việc của người dùng. */
export function ChatProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const [instance] = useState(() => (user ? build(user.id, user.full_name) : null))

  useEffect(() => {
    if (!instance) return
    const { socket, controller } = instance
    socket.start()
    void controller.loadRooms()
    const onOnline = () => socket.reconnectNow()
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        socket.reconnectNow()
        controller.onVisible()
      }
    }
    window.addEventListener('online', onOnline)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('online', onOnline)
      document.removeEventListener('visibilitychange', onVisibility)
      socket.stop()
      controller.dispose()
    }
  }, [instance])

  if (!instance) return null
  return <ChatContext.Provider value={{ store: instance.store, controller: instance.controller }}>{children}</ChatContext.Provider>
}

function useChatContext(): ChatContextValue {
  const ctx = useContext(ChatContext)
  if (!ctx) throw new Error('useChat* must be used inside ChatProvider')
  return ctx
}

export function useChatController(): ChatController {
  return useChatContext().controller
}

export function useChatState<T>(selector: (state: ChatState) => T): T {
  const { store } = useChatContext()
  return useSyncExternalStore(store.subscribe, () => selector(store.getState()))
}

export function useRooms(): { rooms: Room[]; loaded: boolean; error: boolean } {
  const rooms = useChatState((s) => s.rooms)
  const loaded = useChatState((s) => s.roomsLoaded)
  const error = useChatState((s) => s.roomsError)
  return { rooms, loaded, error }
}

export function useThread(roomId: number): Thread {
  return useChatState((s) => s.threads[roomId] ?? EMPTY_THREAD)
}

export function useSocketStatus(): SocketStatus {
  return useChatState((s) => s.status)
}
```

- [ ] **Step 7: Chạy test và kiểm tra kiểu**

Run: `npm test && npm run typecheck`
Expected: tất cả pass. (`ChatProvider` được kiểm bằng test tích hợp ở Task 6.)

- [ ] **Step 8: Commit**

```bash
git add frontend
git commit -m "feat: add chat store, controller (optimistic send, catch-up, unread) and provider" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Thành phần hội thoại (tin nhắn, danh sách cuộn, ô soạn)

**Files:**
- Create: `frontend/src/components/chat/MessageItem.tsx`, `frontend/src/components/chat/MessageItem.test.tsx`, `frontend/src/components/chat/MessageList.tsx`, `frontend/src/components/chat/MessageList.test.tsx`, `frontend/src/components/chat/Composer.tsx`, `frontend/src/components/chat/Composer.test.tsx`, `frontend/src/components/chat/ConnectionBanner.tsx`
- Modify: `frontend/src/index.css` (kiểu chat)

**Interfaces:**
- Consumes: `ChatMessage`, `Thread` (store), `linkify`, `format`, `errorMessage`, `ApiError`.
- Produces:
  - `MessageItem({ message, mine, showSender, onRetry(clientId), onEdit(id, body): Promise<void>, onDelete(id): Promise<void> })`.
  - `MessageList({ items, hasMoreBefore, loaded, loadingOlder, error, meId, isGroup, onLoadOlder(), onRetryLoad(), onRetrySend(clientId), onEdit, onDelete })`.
  - `Composer({ onSend(body: string): void, disabled?: boolean })`.
  - `ConnectionBanner()` (đọc `useSocketStatus`): hiện `role="status"` "Đang kết nối lại…" khi không `open`.
  - Hành vi: xem Global Constraints (cuộn, bộ gõ, 4000 ký tự).

- [ ] **Step 1: Viết test thất bại**

`frontend/src/components/chat/Composer.test.tsx`:
```tsx
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import { Composer } from './Composer'

describe('Composer', () => {
  it('sends on Enter, trims the text and clears the box', async () => {
    const onSend = vi.fn()
    render(<Composer onSend={onSend} />)
    await userEvent.type(screen.getByLabelText('Nhập tin nhắn'), '  xin chào  {Enter}')
    expect(onSend).toHaveBeenCalledWith('xin chào')
    expect(screen.getByLabelText('Nhập tin nhắn')).toHaveValue('')
  })

  it('inserts a new line on Shift+Enter without sending', async () => {
    const onSend = vi.fn()
    render(<Composer onSend={onSend} />)
    await userEvent.type(screen.getByLabelText('Nhập tin nhắn'), 'dòng 1{Shift>}{Enter}{/Shift}dòng 2')
    expect(onSend).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Nhập tin nhắn')).toHaveValue('dòng 1\ndòng 2')
  })

  it('does not send while an IME composition is in progress (Vietnamese input methods)', () => {
    const onSend = vi.fn()
    render(<Composer onSend={onSend} />)
    const box = screen.getByLabelText('Nhập tin nhắn')
    fireEvent.change(box, { target: { value: 'chào' } })
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true })
    fireEvent.keyDown(box, { key: 'Enter', keyCode: 229 })
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('chào')
  })

  it('does not send empty or whitespace-only text', async () => {
    const onSend = vi.fn()
    render(<Composer onSend={onSend} />)
    await userEvent.type(screen.getByLabelText('Nhập tin nhắn'), '   {Enter}')
    await userEvent.click(screen.getByRole('button', { name: 'Gửi tin nhắn' }))
    expect(onSend).not.toHaveBeenCalled()
  })

  it('sends with the button', async () => {
    const onSend = vi.fn()
    render(<Composer onSend={onSend} />)
    await userEvent.type(screen.getByLabelText('Nhập tin nhắn'), 'hi')
    await userEvent.click(screen.getByRole('button', { name: 'Gửi tin nhắn' }))
    expect(onSend).toHaveBeenCalledWith('hi')
  })

  it('limits the text to 4000 characters and shows a counter near the limit', async () => {
    render(<Composer onSend={vi.fn()} />)
    const box = screen.getByLabelText('Nhập tin nhắn')
    expect(box).toHaveAttribute('maxlength', '4000')
    fireEvent.change(box, { target: { value: 'a'.repeat(3600) } })
    expect(screen.getByText('3600/4000')).toBeInTheDocument()
  })

  it('is disabled when told so', () => {
    render(<Composer onSend={vi.fn()} disabled />)
    expect(screen.getByLabelText('Nhập tin nhắn')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Gửi tin nhắn' })).toBeDisabled()
  })
})
```

`frontend/src/components/chat/MessageItem.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import type { ChatMessage } from '../../lib/chatStore'
import { MessageItem } from './MessageItem'

const base: ChatMessage = {
  id: 7, room_id: 1, sender_id: 2, sender_name: 'Lê Thu Hà', body: 'xin chào https://example.com',
  kind: 'text', client_id: null, created_at: '2026-10-15T09:05:00.000Z', edited_at: null, deleted: false,
}
const props = { showSender: true, onRetry: vi.fn(), onEdit: vi.fn().mockResolvedValue(undefined), onDelete: vi.fn().mockResolvedValue(undefined) }

describe('MessageItem', () => {
  it('shows the sender name, the text with a safe link and no actions for other people\'s messages', () => {
    render(<MessageItem {...props} message={base} mine={false} />)
    expect(screen.getByText('Lê Thu Hà')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'https://example.com' })).toHaveAttribute('rel', 'noopener noreferrer nofollow')
    expect(screen.queryByRole('button', { name: 'Sửa tin nhắn' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Xoá tin nhắn' })).not.toBeInTheDocument()
  })

  it('hides the sender name when asked', () => {
    render(<MessageItem {...props} message={base} mine={false} showSender={false} />)
    expect(screen.queryByText('Lê Thu Hà')).not.toBeInTheDocument()
  })

  it('shows the edited marker', () => {
    render(<MessageItem {...props} message={{ ...base, edited_at: '2026-10-15T10:00:00.000Z' }} mine={false} />)
    expect(screen.getByText('(đã sửa)')).toBeInTheDocument()
  })

  it('never shows the text of a deleted message', () => {
    render(<MessageItem {...props} message={{ ...base, deleted: true, body: 'bí mật' }} mine />)
    expect(screen.getByText('Tin nhắn đã bị xoá')).toBeInTheDocument()
    expect(screen.queryByText('bí mật')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sửa tin nhắn' })).not.toBeInTheDocument()
  })

  it('renders HTML in the body as plain text', () => {
    render(<MessageItem {...props} message={{ ...base, body: '<b>đậm</b><img src=x onerror=alert(1)>' }} mine={false} />)
    expect(document.querySelector('img')).toBeNull()
    expect(screen.getByText('<b>đậm</b><img src=x onerror=alert(1)>')).toBeInTheDocument()
  })

  it('lets the owner edit inline and calls onEdit with the trimmed text', async () => {
    const onEdit = vi.fn().mockResolvedValue(undefined)
    render(<MessageItem {...props} onEdit={onEdit} message={{ ...base, sender_id: 1, body: 'gốc' }} mine />)
    await userEvent.click(screen.getByRole('button', { name: 'Sửa tin nhắn' }))
    const box = screen.getByLabelText('Sửa nội dung tin nhắn')
    expect(box).toHaveValue('gốc')
    await userEvent.clear(box)
    await userEvent.type(box, '  đã sửa ')
    await userEvent.click(screen.getByRole('button', { name: 'Lưu' }))
    expect(onEdit).toHaveBeenCalledWith(7, 'đã sửa')
    expect(screen.queryByLabelText('Sửa nội dung tin nhắn')).not.toBeInTheDocument()
  })

  it('cancels editing without calling onEdit and shows the server error when saving fails', async () => {
    const onEdit = vi.fn().mockRejectedValue(new Error('x'))
    render(<MessageItem {...props} onEdit={onEdit} message={{ ...base, sender_id: 1 }} mine />)
    await userEvent.click(screen.getByRole('button', { name: 'Sửa tin nhắn' }))
    await userEvent.click(screen.getByRole('button', { name: 'Huỷ' }))
    expect(onEdit).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Sửa tin nhắn' }))
    await userEvent.click(screen.getByRole('button', { name: 'Lưu' }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.getByLabelText('Sửa nội dung tin nhắn')).toBeInTheDocument()
  })

  it('asks for confirmation before deleting', async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    render(<MessageItem {...props} onDelete={onDelete} message={{ ...base, sender_id: 1 }} mine />)
    await userEvent.click(screen.getByRole('button', { name: 'Xoá tin nhắn' }))
    expect(onDelete).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Xoá tin nhắn' }))
    expect(onDelete).toHaveBeenCalledWith(7)
    confirm.mockRestore()
  })

  it('shows the sending state without actions', () => {
    render(<MessageItem {...props} message={{ ...base, id: -1, sender_id: 1, pending: 'sending' }} mine />)
    expect(screen.getByText('Đang gửi…')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sửa tin nhắn' })).not.toBeInTheDocument()
  })

  it('shows the failure reason with a retry button', async () => {
    const onRetry = vi.fn()
    render(
      <MessageItem {...props} onRetry={onRetry} message={{ ...base, id: -1, sender_id: 1, client_id: 'c1', pending: 'failed', errorCode: 'rate_limited' }} mine />,
    )
    expect(screen.getByText(/Gửi lỗi/)).toBeInTheDocument()
    expect(screen.getByText('Bạn gửi quá nhanh. Hãy đợi vài giây rồi thử lại.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Thử lại' }))
    expect(onRetry).toHaveBeenCalledWith('c1')
  })
})
```

`frontend/src/components/chat/MessageList.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import type { ChatMessage } from '../../lib/chatStore'
import { MessageList } from './MessageList'

const m = (id: number, over: Partial<ChatMessage> = {}): ChatMessage => ({
  id, room_id: 1, sender_id: 2, sender_name: 'Bob', body: `tin ${id}`, kind: 'text', client_id: null,
  created_at: '2026-10-15T09:00:00.000Z', edited_at: null, deleted: false, ...over,
})

const base = {
  hasMoreBefore: false, loaded: true, loadingOlder: false, error: false, meId: 1, isGroup: true,
  onLoadOlder: vi.fn(), onRetryLoad: vi.fn(), onRetrySend: vi.fn(),
  onEdit: vi.fn().mockResolvedValue(undefined), onDelete: vi.fn().mockResolvedValue(undefined),
}

/** jsdom không có layout: định nghĩa các số đo cuộn để kiểm tra logic. */
function mockMetrics(el: HTMLElement, metrics: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => metrics.scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => metrics.clientHeight })
  Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => metrics.scrollTop, set: (v: number) => { metrics.scrollTop = v } })
}

const listOf = () => screen.getByTestId('message-list')

describe('MessageList', () => {
  it('shows an empty state for a loaded room without messages', () => {
    render(<MessageList {...base} items={[]} />)
    expect(screen.getByText('Chưa có tin nhắn. Hãy gửi lời chào!')).toBeInTheDocument()
  })

  it('shows the start marker only when there is nothing older', () => {
    const { rerender } = render(<MessageList {...base} items={[m(1)]} hasMoreBefore />)
    expect(screen.queryByText('Đầu cuộc trò chuyện')).not.toBeInTheDocument()
    rerender(<MessageList {...base} items={[m(1)]} hasMoreBefore={false} />)
    expect(screen.getByText('Đầu cuộc trò chuyện')).toBeInTheDocument()
  })

  it('shows day separators and groups sender names for consecutive messages in a group', () => {
    render(
      <MessageList
        {...base}
        items={[
          m(1, { created_at: '2026-10-14T09:00:00.000Z' }),
          m(2, { created_at: '2026-10-14T09:01:00.000Z' }),
          m(3, { created_at: '2026-10-15T09:00:00.000Z' }),
        ]}
      />,
    )
    expect(screen.getAllByTestId('day-separator')).toHaveLength(2)
    expect(screen.getAllByText('Bob')).toHaveLength(2) // tin 1 và tin 3 (đầu ngày); tin 2 liền kề thì ẩn tên
  })

  it('hides sender names in direct chats', () => {
    render(<MessageList {...base} isGroup={false} items={[m(1)]} />)
    expect(screen.queryByText('Bob')).not.toBeInTheDocument()
  })

  it('asks for older messages when scrolled near the top, but not while loading or when there is nothing older', () => {
    const onLoadOlder = vi.fn()
    const { rerender } = render(<MessageList {...base} onLoadOlder={onLoadOlder} hasMoreBefore items={[m(5)]} />)
    const el = listOf()
    mockMetrics(el, { scrollHeight: 1000, clientHeight: 400, scrollTop: 50 })
    el.dispatchEvent(new Event('scroll'))
    expect(onLoadOlder).toHaveBeenCalledTimes(1)
    mockMetrics(el, { scrollHeight: 1000, clientHeight: 400, scrollTop: 600 })
    el.dispatchEvent(new Event('scroll'))
    expect(onLoadOlder).toHaveBeenCalledTimes(1)
    rerender(<MessageList {...base} onLoadOlder={onLoadOlder} hasMoreBefore={false} items={[m(5)]} />)
    mockMetrics(listOf(), { scrollHeight: 1000, clientHeight: 400, scrollTop: 10 })
    listOf().dispatchEvent(new Event('scroll'))
    expect(onLoadOlder).toHaveBeenCalledTimes(1)
  })

  it('keeps the scroll position when older messages are prepended', () => {
    const metrics = { scrollHeight: 500, clientHeight: 400, scrollTop: 0 }
    const { rerender } = render(<MessageList {...base} hasMoreBefore items={[m(5), m(6)]} />)
    mockMetrics(listOf(), metrics)
    listOf().dispatchEvent(new Event('scroll')) // ghi nhận số đo hiện tại
    metrics.scrollHeight = 800 // thêm 300px tin cũ ở trên
    rerender(<MessageList {...base} hasMoreBefore items={[m(3), m(4), m(5), m(6)]} />)
    expect(metrics.scrollTop).toBe(300)
  })

  it('follows new messages when the user is at the bottom', () => {
    const metrics = { scrollHeight: 1000, clientHeight: 400, scrollTop: 600 } // đang ở cuối
    const { rerender } = render(<MessageList {...base} items={[m(1)]} />)
    mockMetrics(listOf(), metrics)
    listOf().dispatchEvent(new Event('scroll'))
    metrics.scrollHeight = 1100
    rerender(<MessageList {...base} items={[m(1), m(2)]} />)
    expect(metrics.scrollTop).toBe(1100)
    expect(screen.queryByRole('button', { name: /tin mới/ })).not.toBeInTheDocument()
  })

  it('shows a counter instead of jumping when new messages arrive while reading older ones', async () => {
    const metrics = { scrollHeight: 1000, clientHeight: 400, scrollTop: 100 } // đang đọc tin cũ
    const { rerender } = render(<MessageList {...base} items={[m(1)]} />)
    mockMetrics(listOf(), metrics)
    listOf().dispatchEvent(new Event('scroll'))
    metrics.scrollHeight = 1100
    rerender(<MessageList {...base} items={[m(1), m(2), m(3)]} />)
    expect(metrics.scrollTop).toBe(100)
    const button = screen.getByRole('button', { name: '↓ 2 tin mới' })
    await userEvent.click(button)
    expect(metrics.scrollTop).toBe(1100)
    expect(screen.queryByRole('button', { name: /tin mới/ })).not.toBeInTheDocument()
  })

  it('always scrolls to the bottom for the user\'s own new messages', () => {
    const metrics = { scrollHeight: 1000, clientHeight: 400, scrollTop: 100 }
    const { rerender } = render(<MessageList {...base} items={[m(1)]} />)
    mockMetrics(listOf(), metrics)
    listOf().dispatchEvent(new Event('scroll'))
    metrics.scrollHeight = 1100
    rerender(<MessageList {...base} items={[m(1), m(-1, { sender_id: 1, pending: 'sending', client_id: 'c1' })]} />)
    expect(metrics.scrollTop).toBe(1100)
  })

  it('shows loading and error states with a retry button', async () => {
    const onRetryLoad = vi.fn()
    const { rerender } = render(<MessageList {...base} hasMoreBefore loadingOlder items={[m(1)]} />)
    expect(screen.getByText('Đang tải tin cũ…')).toBeInTheDocument()
    rerender(<MessageList {...base} onRetryLoad={onRetryLoad} error loaded={false} items={[]} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Không tải được tin nhắn')
    await userEvent.click(screen.getByRole('button', { name: 'Thử lại' }))
    expect(onRetryLoad).toHaveBeenCalled()
  })

  it('shows a loading indicator before the first page arrives', () => {
    render(<MessageList {...base} loaded={false} items={[]} />)
    expect(screen.getByText('Đang tải…')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `npm test -- components/chat`
Expected: lỗi không tìm thấy các module component.

- [ ] **Step 3: Viết các component**

`frontend/src/components/chat/Composer.tsx`:
```tsx
import { useState, type KeyboardEvent } from 'react'

export const MAX_MESSAGE_LENGTH = 4000
const COUNTER_FROM = 3500

export function Composer({ onSend, disabled = false }: { onSend: (body: string) => void; disabled?: boolean }) {
  const [text, setText] = useState('')

  function submit() {
    const body = text.trim()
    if (!body || body.length > MAX_MESSAGE_LENGTH) return
    onSend(body)
    setText('')
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey) return
    // Bộ gõ tiếng Việt dùng Enter để chốt chữ đang soạn: không được gửi tin lúc đó.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    event.preventDefault()
    submit()
  }

  return (
    <div className="composer">
      <div className="composer-box">
        <textarea
          className="composer-input"
          aria-label="Nhập tin nhắn"
          placeholder="Nhập tin nhắn…"
          rows={Math.min(6, Math.max(1, text.split('\n').length))}
          maxLength={MAX_MESSAGE_LENGTH}
          value={text}
          disabled={disabled}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          className="btn btn-primary composer-send"
          aria-label="Gửi tin nhắn"
          disabled={disabled}
          onClick={submit}
        >
          Gửi
        </button>
      </div>
      {text.length >= COUNTER_FROM && <div className="muted composer-counter">{`${text.length}/${MAX_MESSAGE_LENGTH}`}</div>}
    </div>
  )
}
```
(Nếu `event.keyCode` bị TypeScript đánh dấu deprecated, dùng `(event.nativeEvent as KeyboardEvent).keyCode`; hành vi giữ nguyên.)

`frontend/src/components/chat/MessageItem.tsx`:
```tsx
import { useState } from 'react'
import { ErrorAlert } from '../ErrorAlert'
import type { ChatMessage } from '../../lib/chatStore'
import { ApiError } from '../../lib/api'
import { errorMessage } from '../../lib/errors'
import { formatTime, initials } from '../../lib/format'
import { linkify } from '../../lib/linkify'

interface Props {
  message: ChatMessage
  mine: boolean
  showSender: boolean
  onRetry: (clientId: string) => void
  onEdit: (messageId: number, body: string) => Promise<void>
  onDelete: (messageId: number) => Promise<void>
}

export function MessageItem({ message, mine, showSender, onRetry, onEdit, onDelete }: Props) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(message.body)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const canAct = mine && !message.deleted && !message.pending

  async function save() {
    const body = draft.trim()
    if (!body) return
    setBusy(true)
    setError(null)
    try {
      await onEdit(message.id, body)
      setEditing(false)
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!window.confirm('Xoá tin nhắn này? Mọi người trong cuộc trò chuyện sẽ không còn thấy nội dung.')) return
    setError(null)
    try {
      await onDelete(message.id)
    } catch (err) {
      setError(err)
    }
  }

  return (
    <div className={`msg${mine ? ' mine' : ''}`} data-message-id={message.id}>
      {!mine && (
        <span className="avatar" aria-hidden="true">
          {initials(message.sender_name)}
        </span>
      )}
      <div className="msg-col">
        {showSender && !mine && <div className="msg-sender">{message.sender_name}</div>}
        <div className={`bubble${message.pending === 'failed' ? ' bubble-failed' : ''}`}>
          {message.deleted ? (
            <em>Tin nhắn đã bị xoá</em>
          ) : editing ? (
            <div className="stack" style={{ gap: 8 }}>
              <textarea
                className="input"
                aria-label="Sửa nội dung tin nhắn"
                rows={2}
                maxLength={4000}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
              />
              <div className="row">
                <button type="button" className="btn" onClick={() => { setEditing(false); setDraft(message.body); setError(null) }}>
                  Huỷ
                </button>
                <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()}>
                  Lưu
                </button>
              </div>
            </div>
          ) : (
            linkify(message.body)
          )}
        </div>
        <div className="msg-foot">
          <span>{formatTime(message.created_at)}</span>
          {message.edited_at && !message.deleted && <span>(đã sửa)</span>}
          {message.pending === 'sending' && <span>Đang gửi…</span>}
          {message.pending === 'failed' && (
            <>
              <span className="msg-failed">Gửi lỗi</span>
              <span>{errorMessage(new ApiError(0, message.errorCode ?? 'network_error'))}</span>
              <button type="button" className="btn btn-ghost" onClick={() => message.client_id && onRetry(message.client_id)}>
                Thử lại
              </button>
            </>
          )}
          {canAct && !editing && (
            <>
              <button type="button" className="btn btn-ghost" aria-label="Sửa tin nhắn" onClick={() => { setDraft(message.body); setEditing(true) }}>
                Sửa
              </button>
              <button type="button" className="btn btn-ghost" aria-label="Xoá tin nhắn" onClick={() => void remove()}>
                Xoá
              </button>
            </>
          )}
        </div>
        <ErrorAlert error={error} />
      </div>
    </div>
  )
}
```

`frontend/src/components/chat/MessageList.tsx`:
```tsx
import { Fragment, useLayoutEffect, useRef, useState } from 'react'
import type { ChatMessage } from '../../lib/chatStore'
import { dayLabel, sameDay } from '../../lib/format'
import { MessageItem } from './MessageItem'

const NEAR_BOTTOM_PX = 80
const NEAR_TOP_PX = 120

interface Props {
  items: ChatMessage[]
  hasMoreBefore: boolean
  loaded: boolean
  loadingOlder: boolean
  error: boolean
  meId: number
  isGroup: boolean
  onLoadOlder: () => void
  onRetryLoad: () => void
  onRetrySend: (clientId: string) => void
  onEdit: (messageId: number, body: string) => Promise<void>
  onDelete: (messageId: number) => Promise<void>
}

function nearBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX
}

export function MessageList(props: Props) {
  const { items, hasMoreBefore, loaded, loadingOlder, error, meId, isGroup } = props
  const listRef = useRef<HTMLDivElement>(null)
  const snapshot = useRef({ firstReal: null as number | null, lastReal: null as number | null, pending: 0, scrollHeight: 0, atBottom: true })
  const [unseen, setUnseen] = useState(0)

  const real = items.filter((m) => !m.pending)
  const firstReal = real[0]?.id ?? null
  const lastReal = real.at(-1)?.id ?? null
  const pendingCount = items.length - real.length

  useLayoutEffect(() => {
    const el = listRef.current
    if (!el) return
    const prev = snapshot.current
    const scrollToBottom = () => {
      el.scrollTop = el.scrollHeight
      snapshot.current.atBottom = true
      setUnseen(0)
    }
    if (prev.firstReal === null && prev.lastReal === null && prev.pending === 0) {
      if (items.length > 0) scrollToBottom() // lần đầu có dữ liệu: xuống cuối
    } else if (firstReal !== null && prev.firstReal !== null && firstReal < prev.firstReal) {
      el.scrollTop += el.scrollHeight - prev.scrollHeight // tin cũ được thêm lên đầu: giữ nguyên vị trí
    }
    const newReal = prev.lastReal !== null && lastReal !== null && lastReal > prev.lastReal
    const newPending = pendingCount > prev.pending
    if (newPending) {
      scrollToBottom() // tin của chính mình luôn cuộn xuống
    } else if (newReal) {
      const incoming = real.filter((m) => m.id > (prev.lastReal ?? 0))
      const foreign = incoming.filter((m) => m.sender_id !== meId).length
      if (prev.atBottom || foreign === 0) scrollToBottom()
      else setUnseen((n) => n + foreign)
    }
    snapshot.current = { firstReal, lastReal, pending: pendingCount, scrollHeight: el.scrollHeight, atBottom: snapshot.current.atBottom }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstReal, lastReal, pendingCount, items.length])

  function onScroll() {
    const el = listRef.current
    if (!el) return
    const atBottom = nearBottom(el)
    snapshot.current.atBottom = atBottom
    snapshot.current.scrollHeight = el.scrollHeight
    if (atBottom) setUnseen(0)
    if (el.scrollTop < NEAR_TOP_PX && hasMoreBefore && !loadingOlder) props.onLoadOlder()
  }

  function jumpToBottom() {
    const el = listRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    snapshot.current.atBottom = true
    setUnseen(0)
  }

  return (
    <div className="msg-list-wrap">
      <div className="msg-list" data-testid="message-list" ref={listRef} onScroll={onScroll}>
        {error && !loaded && (
          <div role="alert" className="alert-error stack" style={{ gap: 8 }}>
            <span>Không tải được tin nhắn.</span>
            <button type="button" className="btn" onClick={props.onRetryLoad}>
              Thử lại
            </button>
          </div>
        )}
        {!loaded && !error && <div className="muted msg-note">Đang tải…</div>}
        {loadingOlder && <div className="muted msg-note">Đang tải tin cũ…</div>}
        {loaded && !hasMoreBefore && items.length > 0 && <div className="muted msg-note">Đầu cuộc trò chuyện</div>}
        {loaded && items.length === 0 && <div className="muted msg-note">Chưa có tin nhắn. Hãy gửi lời chào!</div>}
        {items.map((message, index) => {
          const previous = items[index - 1]
          const newDay = !previous || !sameDay(previous.created_at, message.created_at)
          const showSender = isGroup && (newDay || previous.sender_id !== message.sender_id)
          return (
            <Fragment key={message.pending ? `p-${message.client_id}` : message.id}>
              {newDay && (
                <div className="day-separator" data-testid="day-separator">
                  {dayLabel(message.created_at)}
                </div>
              )}
              <MessageItem
                message={message}
                mine={message.sender_id === meId}
                showSender={showSender}
                onRetry={props.onRetrySend}
                onEdit={props.onEdit}
                onDelete={props.onDelete}
              />
            </Fragment>
          )
        })}
      </div>
      {unseen > 0 && (
        <button type="button" className="btn btn-primary msg-unseen" onClick={jumpToBottom}>
          {`↓ ${unseen} tin mới`}
        </button>
      )}
    </div>
  )
}
```
Ghi chú cho người thực hiện: nếu jsdom cho `scrollTop` hành vi khác (ví dụ chỉ đọc), các test dùng `mockMetrics` đã ghi đè trên chính phần tử; nếu logic cuộn ở trên không qua được một test, sửa **logic** (đúng theo Global Constraints), không nới test. `showSender`: với `previous` undefined, `newDay` đã là `true` nên biểu thức không truy cập `previous.sender_id`.

`frontend/src/components/chat/ConnectionBanner.tsx`:
```tsx
import { useSocketStatus } from '../../lib/ChatProvider'

export function ConnectionBanner() {
  const status = useSocketStatus()
  if (status === 'open') return null
  return (
    <div role="status" className="conn-banner">
      Đang kết nối lại… Tin nhắn mới sẽ hiện khi có kết nối.
    </div>
  )
}
```

Thêm vào cuối `frontend/src/index.css`:
```css
/* ===== Chat ===== */
.chat-shell { display: flex; height: 100vh; background: var(--bg); }
.chat-side {
  flex: 0 0 340px; background: var(--surface); border-right: 1px solid var(--line);
  display: flex; flex-direction: column; min-height: 0; min-width: 0;
}
.chat-main { flex: 1 1 0; min-width: 0; min-height: 0; display: flex; flex-direction: column; background: #fafbfc; }
.chat-side-head { padding: 16px 16px 8px; display: flex; flex-direction: column; gap: 10px; }
.chat-side-list { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 10px 8px; display: flex; flex-direction: column; gap: 2px; }
.chat-side-foot { border-top: 1px solid var(--line); padding: 10px 14px; display: flex; flex-direction: column; gap: 8px; }
.room-item {
  display: flex; align-items: center; gap: 12px; padding: 10px; border-radius: var(--radius);
  color: inherit; text-decoration: none; min-height: 56px;
}
.room-item:hover { background: #f2f4f7; }
.room-item[aria-current='page'] { background: var(--accent-soft); }
.room-avatar {
  width: 46px; height: 46px; border-radius: 14px; flex: none; background: #d5d9eb; color: #2d3470;
  display: flex; align-items: center; justify-content: center; font-weight: 700;
}
.room-avatar.direct { border-radius: 50%; }
.unread-badge {
  min-width: 20px; height: 20px; padding: 0 6px; border-radius: 10px; background: var(--danger); color: #fff;
  font-size: 12px; font-weight: 700; display: flex; align-items: center; justify-content: center;
}
.chat-head { height: 64px; padding: 0 20px; background: var(--surface); border-bottom: 1px solid var(--line); display: flex; align-items: center; gap: 12px; }
.msg-list-wrap { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }
.msg-list { flex: 1; min-height: 0; overflow-y: auto; padding: 16px 20px 8px; display: flex; flex-direction: column; gap: 6px; }
.msg-note { text-align: center; padding: 6px; }
.day-separator {
  align-self: center; margin: 10px 0 4px; padding: 3px 12px; border-radius: 12px; background: #eaecf0;
  color: #475467; font-size: 12px; font-weight: 600;
}
.msg { display: flex; gap: 10px; align-items: flex-end; content-visibility: auto; contain-intrinsic-size: auto 56px; }
.msg.mine { flex-direction: row-reverse; }
.msg-col { max-width: 70%; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.msg.mine .msg-col { align-items: flex-end; }
.msg-sender { font-size: 12px; font-weight: 600; color: #344054; }
.bubble {
  padding: 9px 14px; border-radius: 16px; background: var(--surface); border: 1px solid var(--line);
  white-space: pre-wrap; overflow-wrap: anywhere;
}
.msg.mine .bubble { background: var(--accent); border-color: var(--accent); color: #fff; }
.msg.mine .bubble a { color: #fff; text-decoration: underline; }
.bubble-failed { border-color: #fda29b; }
.msg-foot { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; font-size: 12px; color: var(--muted); }
.msg-foot .btn { min-height: 44px; padding: 0 8px; font-size: 12px; }
.msg-failed { color: var(--danger-ink); font-weight: 600; }
.msg-unseen { position: absolute; right: 20px; bottom: 12px; box-shadow: 0 4px 14px rgba(16, 24, 40, 0.25); }
.conn-banner { padding: 8px 20px; background: var(--warn-soft); color: var(--warn-ink); font-weight: 500; }
.composer { padding: 8px 20px 16px; }
.composer-box { display: flex; align-items: flex-end; gap: 8px; padding: 8px; background: var(--surface); border: 1px solid #d0d5dd; border-radius: 16px; }
.composer-input { flex: 1; min-width: 0; border: 0; outline: 0; resize: none; background: transparent; font: inherit; color: var(--ink); padding: 11px 6px; }
.composer-counter { text-align: right; padding: 2px 8px; }
.dialog-backdrop { position: fixed; inset: 0; background: rgba(16, 24, 40, 0.5); display: flex; align-items: center; justify-content: center; padding: 16px; z-index: 10; }
.dialog { width: 100%; max-width: 440px; max-height: 80vh; overflow: auto; }

@media (max-width: 760px) {
  .chat-side { flex-basis: 100%; }
  .chat-shell[data-room='open'] .chat-side { display: none; }
  .chat-shell:not([data-room='open']) .chat-main { display: none; }
  .msg-col { max-width: 82%; }
}
```

- [ ] **Step 4: Chạy test và kiểm tra kiểu**

Run: `npm test && npm run typecheck`
Expected: tất cả pass.

- [ ] **Step 5: Commit**

```bash
git add frontend
git commit -m "feat: add message list with smart scrolling, message items and composer" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Thanh bên, chat mới, bố cục chat và tuyến (thay `HomePage`)

**Files:**
- Create: `frontend/src/components/chat/RoomSidebar.tsx`, `frontend/src/components/chat/NewChatDialog.tsx`, `frontend/src/components/chat/ConversationPane.tsx`, `frontend/src/pages/ChatLayout.tsx`, `frontend/src/pages/ChatHome.tsx`, `frontend/src/pages/ChatLayout.test.tsx`
- Modify: `frontend/src/App.tsx`, `frontend/src/test/utils.tsx`, các test hiện có phụ thuộc `HomePage`
- Delete: `frontend/src/pages/HomePage.tsx`

**Interfaces:**
- Consumes: `ChatProvider` + hooks, `chatApi`, `useAuth`, `Composer`, `MessageList`, `ConnectionBanner`, `FakeWebSocket`.
- Produces:
  - Tuyến: `/` (`ChatHome`) và `/chat/:roomId` (`ConversationPane`) trong `ChatLayout` (bố cục tuyến lồng nhau trong `RequireAuth`; `ChatProvider` bọc cả hai).
  - `ChatLayout`: `<div className="chat-shell" data-room="open"|"none">` gồm `RoomSidebar` và `<main className="chat-main"><Outlet/></main>`.
  - `RoomSidebar`: tiêu đề "Kết Nối", nút "Cuộc trò chuyện mới" (mở `NewChatDialog`), ô lọc (`aria-label="Lọc cuộc trò chuyện"`), danh sách phòng (mỗi mục là `NavLink` tới `/chat/:id`, hiện tên, xem trước tin cuối (`Tên: nội dung`, "Tin nhắn đã bị xoá" nếu đã xoá), giờ, huy hiệu chưa đọc); chân thanh bên giữ nguyên hợp đồng của `HomePage` cũ: văn bản `Xin chào, {họ tên}`, liên kết "Quản trị" (admin), liên kết "Đổi mật khẩu", nút "Đăng xuất" (+ `ErrorAlert` khi đăng xuất lỗi, nút vô hiệu khi đang xử lý).
  - `NewChatDialog({ onClose })`: `role="dialog"` `aria-modal`, ô tìm (`aria-label="Tìm người"`, trễ 250ms), danh sách người (tên, chi nhánh); bấm một người → `controller.openDirect(id)` rồi điều hướng `/chat/<roomId>` và đóng; Esc/nút "Đóng" đóng hộp thoại; lỗi hiện `ErrorAlert`.
  - `ConversationPane`: đọc `roomId` từ URL; `setActiveRoom(roomId)` + `openRoom(roomId)` khi vào, `setActiveRoom(null)` khi rời; tiêu đề phòng, `ConnectionBanner`, `MessageList`, `Composer`; khi `roomId` không hợp lệ hoặc phòng không có trong danh sách đã tải: thông báo "Cuộc trò chuyện không tồn tại hoặc bạn không còn trong đó." kèm liên kết "Về danh sách".
  - `test/utils.tsx`: `sessionRoutes(user)` thêm `'GET /api/rooms': { json: [] }`.

- [ ] **Step 1: Cập nhật hạ tầng test và các test hiện có**

`frontend/src/test/utils.tsx`: trong `sessionRoutes`, thêm vào đối tượng trả về `'GET /api/rooms': { json: [] }`. Thêm helper:
```tsx
export function makeRoom(overrides: Partial<Room> = {}): Room {
  return {
    id: 1, type: 'group', name: 'Dự án kho', branch_id: null, member_count: 3, peer_id: null,
    last_message: null, unread_count: 0, last_activity: '2026-10-15T08:00:00.000Z', ...overrides,
  }
}
export function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 1, room_id: 1, sender_id: 2, sender_name: 'Lê Thu Hà', body: 'xin chào', kind: 'text', client_id: null,
    created_at: '2026-10-15T09:00:00.000Z', edited_at: null, deleted: false, ...overrides,
  }
}
```
(import `Message`, `Room` từ `../lib/types`).

Xoá `HomePage.tsx` và sửa mọi test hiện có cho đúng giao diện mới. Hợp đồng giữ nguyên để giảm sửa: văn bản `Xin chào, {họ tên}`, liên kết "Quản trị"/"Đổi mật khẩu", nút "Đăng xuất" vẫn tồn tại (trong chân thanh bên). Cần kiểm tra và sửa: `routes.test.tsx`, `LoginPage.test.tsx`, `ChangePasswordPage.test.tsx`, `AdminLayout.test.tsx`, `lib/auth.test.tsx`, `components/ErrorBoundary.test.tsx` (nếu có tham chiếu trang chủ); các test chỉ khẳng định các hợp đồng nêu trên không cần đổi.

- [ ] **Step 2: Viết test tích hợp thất bại (`frontend/src/pages/ChatLayout.test.tsx`)**

```tsx
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import { FakeWebSocket } from '../test/fakeWebSocket'
import { mockFetch } from '../test/mockFetch'
import { makeMessage, makeRoom, makeUser, renderApp, sessionRoutes } from '../test/utils'

const me = makeUser({ id: 1 })
const rooms = [
  makeRoom({ id: 1, name: 'Dự án kho', unread_count: 2, last_message: makeMessage({ id: 5, body: 'báo cáo xong', sender_name: 'Lê Thu Hà', created_at: '2026-10-15T09:00:00.000Z' }), last_activity: '2026-10-15T09:00:00.000Z' }),
  makeRoom({ id: 2, type: 'direct', name: 'Trần Quốc Huy', peer_id: 3, last_message: makeMessage({ id: 9, room_id: 2, deleted: true, body: '', sender_name: 'Trần Quốc Huy' }), last_activity: '2026-10-15T08:00:00.000Z' }),
]

function routes(extra: Record<string, unknown> = {}) {
  return {
    ...sessionRoutes(me),
    'GET /api/rooms': { json: rooms },
    'GET /api/rooms/1/messages': {
      json: { items: [makeMessage({ id: 4, body: 'chào cả nhà' }), makeMessage({ id: 5, body: 'báo cáo xong' })], has_more_before: false, has_more_after: false },
    },
    'POST /api/rooms/1/read': { status: 204 },
    ...extra,
  } as Parameters<typeof mockFetch>[0]
}

async function connect() {
  await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0))
  const ws = FakeWebSocket.last
  await act(async () => {
    ws.open()
    ws.receive({ type: 'ready', user_id: 1 })
  })
  return ws
}

describe('chat layout', () => {
  it('shows the room list with previews, deleted placeholders and unread badges', async () => {
    mockFetch(routes())
    renderApp('/')
    const first = await screen.findByRole('link', { name: /Dự án kho/ })
    expect(within(first).getByText('Lê Thu Hà: báo cáo xong')).toBeInTheDocument()
    expect(within(first).getByText('2')).toBeInTheDocument()
    const second = screen.getByRole('link', { name: /Trần Quốc Huy/ })
    expect(within(second).getByText('Tin nhắn đã bị xoá')).toBeInTheDocument()
    expect(screen.getByText('Xin chào, Phạm Đức Long')).toBeInTheDocument()
  })

  it('authenticates the socket with the first frame only', async () => {
    mockFetch(routes())
    renderApp('/')
    await screen.findByRole('link', { name: /Dự án kho/ })
    await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0))
    const ws = FakeWebSocket.last
    expect(ws.url).not.toContain('tok-1')
    ws.open()
    expect(ws.sentJson).toEqual([{ type: 'auth', token: 'tok-1' }])
  })

  it('opens a room, shows its messages and marks it as read', async () => {
    const { calls } = mockFetch(routes())
    renderApp('/chat/1')
    expect(await screen.findByText('chào cả nhà')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Dự án kho' })).toBeInTheDocument()
    await waitFor(() => expect(calls.some((c) => c.path === '/api/rooms/1/read' && (c.body as { message_id: number }).message_id === 5)).toBe(true))
    await waitFor(() => expect(within(screen.getByRole('link', { name: /Dự án kho/ })).queryByText('2')).not.toBeInTheDocument())
  })

  it('shows a live message from another user in the open room', async () => {
    mockFetch(routes())
    renderApp('/chat/1')
    await screen.findByText('chào cả nhà')
    const ws = await connect()
    await act(async () => ws.receive({ type: 'message', message: makeMessage({ id: 6, body: 'tin mới realtime' }) }))
    expect(await screen.findByText('tin mới realtime')).toBeInTheDocument()
  })

  it('counts a message for another room as unread', async () => {
    mockFetch(routes())
    renderApp('/chat/1')
    await screen.findByText('chào cả nhà')
    const ws = await connect()
    await act(async () => ws.receive({ type: 'message', message: makeMessage({ id: 10, room_id: 2, sender_id: 3, sender_name: 'Trần Quốc Huy', body: 'ơi' }) }))
    const item = await screen.findByRole('link', { name: /Trần Quốc Huy/ })
    await waitFor(() => expect(within(item).getByText('1')).toBeInTheDocument())
    expect(within(item).getByText('Trần Quốc Huy: ơi')).toBeInTheDocument()
  })

  it('sends a message optimistically, then reconciles it with the server echo', async () => {
    mockFetch(routes())
    renderApp('/chat/1')
    await screen.findByText('chào cả nhà')
    const ws = await connect()
    await userEvent.type(screen.getByLabelText('Nhập tin nhắn'), 'tôi gửi{Enter}')
    expect(screen.getByText('tôi gửi')).toBeInTheDocument()
    expect(screen.getByText('Đang gửi…')).toBeInTheDocument()
    const sent = ws.sentJson.find((m) => m.type === 'send')!
    expect(sent).toMatchObject({ room_id: 1, body: 'tôi gửi' })
    await act(async () =>
      ws.receive({ type: 'message', message: makeMessage({ id: 7, sender_id: 1, sender_name: 'Phạm Đức Long', body: 'tôi gửi', client_id: sent.client_id as string }) }),
    )
    await waitFor(() => expect(screen.queryByText('Đang gửi…')).not.toBeInTheDocument())
    expect(screen.getAllByText('tôi gửi')).toHaveLength(1)
  })

  it('shows a reconnecting banner when the socket drops and catches up after the next ready', async () => {
    const { calls } = mockFetch(routes())
    renderApp('/chat/1')
    await screen.findByText('chào cả nhà')
    const ws = await connect()
    expect(screen.queryByText(/Đang kết nối lại/)).not.toBeInTheDocument()
    await act(async () => ws.serverClose(1006))
    expect(await screen.findByText(/Đang kết nối lại/)).toBeInTheDocument()
    const catchUp = routes({
      'GET /api/rooms/1/messages': { json: { items: [makeMessage({ id: 6, body: 'tin lỡ' })], has_more_before: false, has_more_after: false } },
    })
    mockFetch(catchUp)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1300)) // chờ backoff 1s (+ jitter) rồi kết nối lại
    })
    const ws2 = await connect()
    expect(ws2).not.toBe(ws)
    expect(await screen.findByText('tin lỡ')).toBeInTheDocument()
    void calls
  })

  it('shows a not-found message for rooms the user is not in', async () => {
    mockFetch(routes())
    renderApp('/chat/999')
    expect(await screen.findByText('Cuộc trò chuyện không tồn tại hoặc bạn không còn trong đó.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Về danh sách' })).toBeInTheDocument()
  })

  it('filters the room list by name', async () => {
    mockFetch(routes())
    renderApp('/')
    await screen.findByRole('link', { name: /Dự án kho/ })
    await userEvent.type(screen.getByLabelText('Lọc cuộc trò chuyện'), 'huy')
    expect(screen.queryByRole('link', { name: /Dự án kho/ })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Trần Quốc Huy/ })).toBeInTheDocument()
  })

  it('starts a direct chat from the directory', async () => {
    const { calls } = mockFetch(
      routes({
        'GET /api/users/directory': { json: [{ id: 3, username: 'huy', full_name: 'Trần Quốc Huy', branch_id: 2, branch_name: 'TP.HCM' }] },
        'POST /api/rooms/direct': { status: 200, json: makeRoom({ id: 2, type: 'direct', name: 'Trần Quốc Huy', peer_id: 3 }) },
        'GET /api/rooms/2/messages': { json: { items: [], has_more_before: false, has_more_after: false } },
      }),
    )
    renderApp('/')
    await userEvent.click(await screen.findByRole('button', { name: 'Cuộc trò chuyện mới' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(await within(dialog).findByRole('button', { name: /Trần Quốc Huy/ }))
    expect(await screen.findByText('Chưa có tin nhắn. Hãy gửi lời chào!')).toBeInTheDocument()
    expect(calls.find((c) => c.path === '/api/rooms/direct')?.body).toEqual({ user_id: 3 })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('closes the new-chat dialog with Escape', async () => {
    mockFetch(routes({ 'GET /api/users/directory': { json: [] } }))
    renderApp('/')
    await userEvent.click(await screen.findByRole('button', { name: 'Cuộc trò chuyện mới' }))
    await screen.findByRole('dialog')
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('searches the directory with a short delay and shows the empty result', async () => {
    const { calls } = mockFetch(routes({ 'GET /api/users/directory': { json: [] } }))
    renderApp('/')
    await userEvent.click(await screen.findByRole('button', { name: 'Cuộc trò chuyện mới' }))
    await userEvent.type(await screen.findByLabelText('Tìm người'), 'zzz')
    await waitFor(() => expect(calls.some((c) => c.path === '/api/users/directory?q=zzz')).toBe(true))
    expect(await screen.findByText('Không tìm thấy ai.')).toBeInTheDocument()
  })

  it('goes back to the login page when the socket is closed with 4403 (account locked)', async () => {
    mockFetch(routes())
    renderApp('/chat/1')
    await screen.findByText('chào cả nhà')
    const ws = await connect()
    await act(async () => ws.serverClose(4403))
    expect(await screen.findByRole('heading', { name: 'Đăng nhập' })).toBeInTheDocument()
  })

  it('keeps the greeting, admin link and logout in the sidebar footer', async () => {
    mockFetch({ ...routes(), ...sessionRoutes(makeUser({ role: 'admin' })), 'GET /api/rooms': { json: rooms } } as Parameters<typeof mockFetch>[0])
    renderApp('/')
    expect(await screen.findByRole('link', { name: 'Quản trị' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Đổi mật khẩu' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Đăng xuất' })).toBeInTheDocument()
    void vi
  })
})
```

- [ ] **Step 3: Chạy test để xác nhận thất bại**

Run: `npm test -- ChatLayout`
Expected: lỗi không tìm thấy các component/trang.

- [ ] **Step 4: Viết các component**

`frontend/src/components/chat/NewChatDialog.tsx`:
```tsx
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { chatApi } from '../../lib/chatApi'
import { useChatController } from '../../lib/ChatProvider'
import type { DirectoryUser } from '../../lib/types'
import { ErrorAlert } from '../ErrorAlert'

const SEARCH_DELAY_MS = 250

export function NewChatDialog({ onClose }: { onClose: () => void }) {
  const controller = useChatController()
  const navigate = useNavigate()
  const [term, setTerm] = useState('')
  const [users, setUsers] = useState<DirectoryUser[] | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(
      () => {
        chatApi
          .directory(term.trim())
          .then((result) => !cancelled && (setUsers(result), setError(null)))
          .catch((err) => !cancelled && setError(err))
      },
      term ? SEARCH_DELAY_MS : 0,
    )
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [term])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  async function pick(user: DirectoryUser) {
    setBusy(true)
    setError(null)
    try {
      const room = await controller.openDirect(user.id)
      onClose()
      navigate(`/chat/${room.id}`)
    } catch (err) {
      setError(err)
      setBusy(false)
    }
  }

  return (
    <div className="dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="card dialog stack" role="dialog" aria-modal="true" aria-label="Cuộc trò chuyện mới">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ fontSize: 17 }}>Cuộc trò chuyện mới</h2>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Đóng
          </button>
        </div>
        <input
          className="input"
          autoFocus
          aria-label="Tìm người"
          placeholder="Tìm theo tên hoặc tên đăng nhập"
          value={term}
          onChange={(event) => setTerm(event.target.value)}
        />
        <ErrorAlert error={error} />
        <div className="stack" style={{ gap: 4 }}>
          {users === null && <div className="muted">Đang tải…</div>}
          {users?.length === 0 && <div className="muted">Không tìm thấy ai.</div>}
          {users?.map((user) => (
            <button key={user.id} type="button" className="btn btn-ghost" style={{ justifyContent: 'flex-start' }} disabled={busy} onClick={() => void pick(user)}>
              {user.full_name} <span className="muted">· {user.branch_name}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
```

`frontend/src/components/chat/RoomSidebar.tsx`:
```tsx
import { useState } from 'react'
import { Link, NavLink } from 'react-router-dom'
import { useAuth } from '../../lib/auth'
import { initials, listTime } from '../../lib/format'
import { useRooms } from '../../lib/ChatProvider'
import type { Room } from '../../lib/types'
import { ErrorAlert } from '../ErrorAlert'
import { NewChatDialog } from './NewChatDialog'

function preview(room: Room): string {
  const last = room.last_message
  if (!last) return 'Chưa có tin nhắn'
  if (last.deleted) return 'Tin nhắn đã bị xoá'
  return `${last.sender_name}: ${last.body}`
}

export function RoomSidebar() {
  const { user, logout } = useAuth()
  const { rooms, loaded, error } = useRooms()
  const [filter, setFilter] = useState('')
  const [dialog, setDialog] = useState(false)
  const [logoutError, setLogoutError] = useState<unknown>(null)
  const [pending, setPending] = useState(false)

  const shown = rooms.filter((room) => (room.name ?? '').toLowerCase().includes(filter.trim().toLowerCase()))

  async function onLogout() {
    setLogoutError(null)
    setPending(true)
    try {
      await logout()
    } catch (err) {
      setLogoutError(err)
      setPending(false)
    }
  }

  return (
    <aside className="chat-side" aria-label="Danh sách cuộc trò chuyện">
      <div className="chat-side-head">
        <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'nowrap' }}>
          <strong style={{ fontSize: 18 }}>Kết Nối</strong>
          <button type="button" className="btn" aria-label="Cuộc trò chuyện mới" onClick={() => setDialog(true)}>
            + Mới
          </button>
        </div>
        <input className="input" aria-label="Lọc cuộc trò chuyện" placeholder="Lọc theo tên" value={filter} onChange={(event) => setFilter(event.target.value)} />
      </div>
      <nav className="chat-side-list" aria-label="Cuộc trò chuyện">
        {error && !loaded && <div className="alert-error">Không tải được danh sách. Đang thử lại khi có kết nối.</div>}
        {loaded && rooms.length === 0 && <div className="muted" style={{ padding: 12 }}>Chưa có cuộc trò chuyện nào. Bấm "+ Mới" để bắt đầu.</div>}
        {shown.map((room) => (
          <NavLink key={room.id} to={`/chat/${room.id}`} className="room-item">
            <span className={`room-avatar${room.type === 'direct' ? ' direct' : ''}`} aria-hidden="true">
              {initials(room.name ?? '')}
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span className="row" style={{ justifyContent: 'space-between', flexWrap: 'nowrap' }}>
                <strong className="ellipsis">{room.name}</strong>
                <span className="muted" style={{ fontSize: 12, flex: 'none' }}>{listTime(room.last_activity)}</span>
              </span>
              <span className="row" style={{ justifyContent: 'space-between', flexWrap: 'nowrap' }}>
                <span className="muted ellipsis" style={{ fontSize: 13 }}>{preview(room)}</span>
                {room.unread_count > 0 && <span className="unread-badge">{room.unread_count}</span>}
              </span>
            </span>
          </NavLink>
        ))}
      </nav>
      <div className="chat-side-foot">
        <div style={{ fontWeight: 600 }}>Xin chào, {user?.full_name}</div>
        <div className="row">
          {user?.role === 'admin' && (
            <Link to="/admin" className="btn">
              Quản trị
            </Link>
          )}
          <Link to="/change-password" className="btn">
            Đổi mật khẩu
          </Link>
          <button type="button" className="btn" disabled={pending} onClick={() => void onLogout()}>
            Đăng xuất
          </button>
        </div>
        <ErrorAlert error={logoutError} />
      </div>
      {dialog && <NewChatDialog onClose={() => setDialog(false)} />}
    </aside>
  )
}
```

`frontend/src/components/chat/ConversationPane.tsx`:
```tsx
import { useEffect } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAuth } from '../../lib/auth'
import { useChatController, useRooms, useSocketStatus, useThread } from '../../lib/ChatProvider'
import { Composer } from './Composer'
import { ConnectionBanner } from './ConnectionBanner'
import { MessageList } from './MessageList'

function NotFound() {
  return (
    <div className="center-screen">
      <div className="card stack" style={{ maxWidth: 420 }}>
        <p>Cuộc trò chuyện không tồn tại hoặc bạn không còn trong đó.</p>
        <Link to="/" className="btn btn-primary">
          Về danh sách
        </Link>
      </div>
    </div>
  )
}

export function ConversationPane() {
  const params = useParams()
  const roomId = Number(params.roomId)
  const valid = Number.isInteger(roomId) && roomId > 0
  if (!valid) return <NotFound />
  return <Conversation key={roomId} roomId={roomId} />
}

function Conversation({ roomId }: { roomId: number }) {
  const { user } = useAuth()
  const controller = useChatController()
  const { rooms, loaded } = useRooms()
  const thread = useThread(roomId)
  const status = useSocketStatus()
  const room = rooms.find((r) => r.id === roomId)

  useEffect(() => {
    controller.setActiveRoom(roomId)
    void controller.openRoom(roomId)
    return () => controller.setActiveRoom(null)
  }, [controller, roomId])

  if (loaded && !room) return <NotFound />

  return (
    <>
      <header className="chat-head">
        <Link to="/" className="btn btn-ghost chat-back" aria-label="Về danh sách">
          ←
        </Link>
        <div style={{ minWidth: 0 }}>
          <h2 style={{ fontSize: 17 }} className="ellipsis">{room?.name ?? ''}</h2>
          {room?.type === 'group' && <div className="muted" style={{ fontSize: 12 }}>{room.member_count} thành viên</div>}
        </div>
      </header>
      <ConnectionBanner />
      <MessageList
        items={thread.items}
        hasMoreBefore={thread.hasMoreBefore}
        loaded={thread.loaded}
        loadingOlder={thread.loadingOlder}
        error={thread.error}
        meId={user?.id ?? 0}
        isGroup={room?.type === 'group'}
        onLoadOlder={() => void controller.loadOlder(roomId)}
        onRetryLoad={() => void controller.openRoom(roomId)}
        onRetrySend={(clientId) => controller.retry(clientId)}
        onEdit={(id, body) => controller.edit(id, body)}
        onDelete={(id) => controller.remove(roomId, id)}
      />
      <Composer onSend={(body) => controller.send(roomId, body)} disabled={status === 'offline' && false} />
    </>
  )
}
```
(Ô soạn không bị vô hiệu khi mất mạng: tin vào hàng chờ và tự gửi lại sau `ready`; vì vậy không truyền `disabled`. Dòng `disabled={status === 'offline' && false}` ở trên chỉ minh hoạ ý đó: **xoá thuộc tính `disabled` và biến `status`/`useSocketStatus` thừa** khi viết thật.)

Thêm CSS nhỏ (cuối `index.css`): `.chat-back { display: none; }` và trong `@media (max-width: 760px) { .chat-back { display: inline-flex; } }`.

`frontend/src/pages/ChatHome.tsx`:
```tsx
export function ChatHome() {
  return (
    <div className="center-screen">
      <div className="card stack" style={{ maxWidth: 420, textAlign: 'center' }}>
        <h1 style={{ fontSize: 20 }}>Chọn một cuộc trò chuyện</h1>
        <p className="muted">Hoặc bấm "+ Mới" để nhắn tin cho đồng nghiệp.</p>
      </div>
    </div>
  )
}
```

`frontend/src/pages/ChatLayout.tsx`:
```tsx
import { Outlet, useMatch } from 'react-router-dom'
import { RoomSidebar } from '../components/chat/RoomSidebar'
import { ChatProvider } from '../lib/ChatProvider'

export function ChatLayout() {
  const open = useMatch('/chat/:roomId') !== null
  return (
    <ChatProvider>
      <div className="chat-shell" data-room={open ? 'open' : 'none'}>
        <RoomSidebar />
        <main className="chat-main">
          <Outlet />
        </main>
      </div>
    </ChatProvider>
  )
}
```

`frontend/src/App.tsx`: thay import `HomePage` bằng `ChatLayout`, `ChatHome`, `ConversationPane` và thay route `/`:
```tsx
<Route
  element={
    <RequireAuth>
      <ChatLayout />
    </RequireAuth>
  }
>
  <Route path="/" element={<ChatHome />} />
  <Route path="/chat/:roomId" element={<ConversationPane />} />
</Route>
```
(đặt trước route `/admin`; giữ nguyên các route khác.)

- [ ] **Step 5: Chạy test và kiểm tra kiểu**

Run: `npm test && npm run typecheck && npm run build`
Expected: tất cả pass (kể cả các test cũ đã sửa ở Step 1). Nếu một test tích hợp phát hiện lỗi thật trong mã (thứ tự sự kiện, gộp tin trùng, đếm chưa đọc...), sửa mã trước; chỉ chỉnh test khi chính test sai về giao diện.

- [ ] **Step 6: Commit**

```bash
git add -A frontend
git commit -m "feat: add chat layout with room list, conversation pane and new-chat dialog replacing the home page" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Trang admin "Phòng và nhóm"

**Files:**
- Create: `frontend/src/pages/admin/RoomsPage.tsx`, `frontend/src/pages/admin/RoomsPage.test.tsx`
- Modify: `frontend/src/pages/admin/AdminLayout.tsx` (liên kết "Phòng và nhóm"), `frontend/src/App.tsx` (tuyến lười `/admin/rooms`), `frontend/src/pages/admin/AdminLayout.test.tsx` (nếu liệt kê liên kết điều hướng)

**Interfaces:**
- Consumes: `api`, `Field`, `ErrorAlert`, kiểu `AdminRoom`, `AdminRoomDetail`, `AdminRoomMember`, `Branch`, `User`, TanStack Query (khoá `['admin','rooms', qs]`, `['admin','room', id]`, `['admin','branches']`, `['admin','users', '']`).
- Produces: `RoomsPage` (`<h1>Phòng và nhóm</h1>`); dải ghi chú "Quản trị viên không xem được nội dung tin nhắn"; ô tìm `aria-label="Tìm nhóm"` + lọc chi nhánh `aria-label="Lọc theo chi nhánh"`; bảng nhóm (tên, phạm vi, số thành viên, nút `aria-label="Quản lý {tên}"`); khung bên phải là form **"Tạo nhóm mới"** (tên, chi nhánh (tuỳ chọn "Liên chi nhánh"), danh sách người dùng đang hoạt động có hộp chọn và ô lọc `aria-label="Lọc người dùng"`, nút "Tạo nhóm") hoặc **chi tiết nhóm** (đổi tên + "Lưu tên"; danh sách thành viên có nút `aria-label="Gỡ {tên đăng nhập} khỏi nhóm"`; chọn người để thêm `aria-label="Thêm thành viên"` + nút "Thêm"; vùng nguy hiểm "Xoá nhóm" cần gõ đúng tên nhóm vào ô `aria-label="Gõ tên nhóm để xác nhận"` thì nút "Xoá nhóm" mới bật; có đoạn "Toàn bộ tin nhắn của nhóm sẽ bị xoá vĩnh viễn.").
- API dùng: `GET /admin/rooms?q=&branch_id=`, `POST /admin/rooms`, `GET /admin/rooms/{id}`, `PATCH /admin/rooms/{id}`, `DELETE /admin/rooms/{id}`, `POST /admin/rooms/{id}/members`, `DELETE /admin/rooms/{id}/members/{user_id}`, `GET /admin/branches`, `GET /admin/users?is_active=true`.

- [ ] **Step 1: Viết test thất bại**

`frontend/src/pages/admin/RoomsPage.test.tsx` (theo khuôn `UsersPage.test.tsx`/`BranchesPage.test.tsx`: `renderApp('/admin/rooms')`, `sessionRoutes(makeUser({ role: 'admin' }))`, `mockFetch`, `userEvent`). Các test cần có, mỗi test dùng dữ liệu tối thiểu (2 chi nhánh, 3 người dùng, 2 nhóm):
1. **lists groups** với tên, phạm vi (tên chi nhánh hoặc "Liên chi nhánh") và số thành viên; có dòng ghi chú "Quản trị viên không xem được nội dung tin nhắn".
2. **sends the filters**: chọn chi nhánh và gõ vào "Tìm nhóm" → yêu cầu có `branch_id=` và `q=`.
3. **creates a group** với tên, chi nhánh (hoặc để trống = liên chi nhánh), hai người được chọn → `POST /api/admin/rooms` với body `{ name, branch_id, member_ids }` đúng; danh sách được tải lại; form sạch.
4. **create validation**: tên rỗng → nút "Tạo nhóm" bị vô hiệu hoặc không gửi yêu cầu; lỗi server (`user_not_found`) hiện bằng tiếng Việt.
5. **manages a group**: bấm "Quản lý X" → thấy thành viên; đổi tên → `PATCH` body `{ name }`; gỡ một người → `DELETE .../members/{id}`; thêm người từ danh sách chọn → `POST .../members` body `{ user_id }`; mỗi thao tác tải lại chi tiết và danh sách.
6. **delete needs the typed name**: nút "Xoá nhóm" vô hiệu cho tới khi gõ **chính xác** tên nhóm (khác hoa/thường hoặc thừa khoảng trắng vẫn vô hiệu); gõ đúng → `DELETE /api/admin/rooms/{id}` được gọi; sau đó khung quay về form tạo nhóm; trang có đoạn "Toàn bộ tin nhắn của nhóm sẽ bị xoá vĩnh viễn."
7. **server errors**: `room_not_found` khi thao tác → thông báo tiếng Việt; không có `role="alert"` thừa lúc bình thường.
8. **nav link**: trong `AdminLayout.test.tsx` thêm khẳng định có liên kết "Phòng và nhóm" trong thanh điều hướng và nó mang `aria-current="page"` khi ở `/admin/rooms`.

Mỗi test khẳng định **nội dung body chính xác** của các yêu cầu ghi/xoá bằng `calls`.

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `npm test -- RoomsPage AdminLayout`
Expected: lỗi không tìm thấy `RoomsPage`; test điều hướng thất bại.

- [ ] **Step 3: Viết `RoomsPage.tsx`**

Viết theo mẫu của `UsersPage.tsx` và `BranchesPage.tsx` (đọc hai file đó trước để dùng cùng quy ước: `useQuery` + `useMutation`/hàm bất đồng bộ với `ErrorAlert`, `invalidateQueries` sau mỗi thay đổi, vô hiệu nút khi đang xử lý, `key` cho biểu mẫu theo nhóm được chọn, các lớp CSS `admin-main`, `admin-aside`, `table-scroll`, `table-row`, `card`, `stack`, `row`, `btn`...). Thành phần: `RoomsPage` (trạng thái `selected: number | null`), `CreateRoomForm`, `RoomDetail` (nhận `roomId`; truy vấn `['admin','room', id]`). Quy tắc bắt buộc:
- Danh sách người dùng cho form tạo và ô "Thêm thành viên" lấy từ `GET /admin/users?is_active=true`; ô thêm chỉ liệt kê người **chưa** trong nhóm.
- Gửi `branch_id` là `null` khi chọn "Liên chi nhánh"; `member_ids` là mảng số.
- Xoá nhóm: so sánh `typed === room.name` (so khớp tuyệt đối, không trim, không bỏ qua hoa/thường); sau khi xoá thành công đặt `selected = null` và làm mới các truy vấn `['admin','rooms']`.
- Mọi lỗi từ `api` hiển thị qua `ErrorAlert` (tiếng Việt từ `errors.ts`); xoá lỗi cũ khi bắt đầu thao tác mới.
- Không dùng `window.confirm` cho xoá nhóm (đã có bước gõ tên).

`AdminLayout.tsx`: thêm `<NavLink to="/admin/rooms">Phòng và nhóm</NavLink>` sau "Chi nhánh". `App.tsx`: thêm `const RoomsPage = lazy(() => import('./pages/admin/RoomsPage').then((m) => ({ default: m.RoomsPage })))` và `<Route path="rooms" element={<RoomsPage />} />` trong nhóm route `/admin`.

- [ ] **Step 4: Chạy test và kiểm tra kiểu**

Run: `npm test && npm run typecheck && npm run build`
Expected: tất cả pass.

- [ ] **Step 5: Commit**

```bash
git add -A frontend
git commit -m "feat: add admin groups page with typed confirmation for deleting a group" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Kiểm tra thật trên trình duyệt (Playwright) và tài liệu

**Files:**
- Create: `scripts/e2e_chat_ui.mjs`
- Modify: `README.md` (mục "Giao diện chat")

**Interfaces:**
- Consumes: toàn bộ stack Docker (`docker compose up -d --build`), CLI `create-admin`, thư viện `playwright` (cài **ngoài repo**, ví dụ trong thư mục tạm; script nhận thư mục này qua biến môi trường `PLAYWRIGHT_DIR`).
- Produces: script chạy được bằng `PLAYWRIGHT_DIR=<thư mục> BASE_URL=http://localhost ADMIN_USER=<tên> ADMIN_TEMP_PASSWORD=<mật khẩu tạm> node scripts/e2e_chat_ui.mjs`, in `PASS`/`FAIL` cho từng bước và thoát mã khác 0 nếu có bước hỏng. **Chỉ dùng trên stack thử nghiệm** (tạo người dùng/nhóm, đổi mật khẩu).

- [ ] **Step 1: Viết script**

`scripts/e2e_chat_ui.mjs` (ESM, Node 22+; nạp Playwright bằng `import(pathToFileURL(path.join(process.env.PLAYWRIGHT_DIR, 'node_modules/playwright/index.mjs')))`; dùng `fetch` toàn cục cho phần chuẩn bị dữ liệu qua REST). Cấu trúc:
- **Chuẩn bị (REST, không qua giao diện):** đăng nhập admin bằng mật khẩu tạm, đổi mật khẩu thành giá trị cố định, lấy chi nhánh đầu tiên, tạo hai người dùng `ui.alice` (Lê Thu Hà) và `ui.bob` (Trần Quốc Huy) cùng chi nhánh, tạo nhóm "UI nhóm" gồm cả hai. Lưu mật khẩu tạm của hai người.
- **Hàm tiện ích:** `step(name, fn)` in `PASS`/`FAIL` (chụp ảnh `fail-<n>.png` khi hỏng); `loginAndChangePassword(page, user, tempPw, newPw)` đi qua trang đăng nhập và trang đổi mật khẩu bằng nhãn tiếng Việt thật (`Tên đăng nhập`, `Mật khẩu`, `Đăng nhập`, `Mật khẩu hiện tại`, `Mật khẩu mới`, `Nhập lại mật khẩu mới`, `Lưu mật khẩu mới`).
- **Hai ngữ cảnh trình duyệt** (alice và bob), mỗi ngữ cảnh một trang. Các bước (mỗi bước là một `step`):
  1. Alice và Bob đăng nhập, đổi mật khẩu, thấy thanh bên có "UI nhóm".
  2. Alice mở "UI nhóm", gõ "xin chào cả nhóm" + Enter: tin hiện ngay (trạng thái "Đang gửi…" rồi biến mất).
  3. Bob (đang ở danh sách, chưa mở phòng) thấy huy hiệu chưa đọc `1` trên "UI nhóm" **không cần tải lại**; mở phòng thì thấy tin, huy hiệu biến mất.
  4. Bob trả lời; Alice (đang mở phòng) thấy tin ngay, không có huy hiệu chưa đọc.
  5. Alice mở hộp thoại "Cuộc trò chuyện mới", tìm "Quốc Huy", chọn → vào phòng 1-1, gửi "chào Huy"; Bob thấy phòng mới xuất hiện trong danh sách (sự kiện `rooms_changed`) cùng tin chưa đọc.
  6. **Mất mạng:** `bobContext.setOffline(true)`; Alice gửi tin; Bob bật lại mạng (`setOffline(false)`) và trong vòng 10 giây thấy tin (bù tin sau khi kết nối lại), không trùng.
  7. **Gửi khi mất mạng:** Alice `setOffline(true)`, gõ "gửi lúc offline", thấy trạng thái "Đang gửi…"; `setOffline(false)`; tin được gửi và Bob nhận **đúng một lần**.
  8. Sửa và xoá: Alice sửa một tin của mình (nút "Sửa tin nhắn" → "Lưu"), Bob thấy "(đã sửa)"; Alice xoá một tin (chấp nhận `dialog` xác nhận), Bob thấy "Tin nhắn đã bị xoá" và không còn nội dung.
  9. **Cuộn:** tạo 120 tin vào "UI nhóm" bằng REST (Bob gửi qua WebSocket hoặc dùng người gửi bất kỳ), Alice mở lại phòng: thấy tin mới nhất ở cuối; cuộn lên đầu thì tải thêm tin cũ và vị trí cuộn không nhảy (so `scrollHeight - scrollTop` trước/sau thay đổi ≤ vài px).
  10. **An toàn:** Bob gửi `<img src=x onerror=alert(1)> https://example.com javascript:alert(1)`; Alice thấy đúng văn bản, có một liên kết `https://example.com` với `rel="noopener noreferrer nofollow"`, không có phần tử `img`, không có hộp thoại `alert` nào bật lên.
  11. **Token:** `localStorage`/`sessionStorage` rỗng; trong các yêu cầu mạng của Alice không có URL WebSocket nào chứa token (kiểm `page.on('websocket')` và URL).
  12. **Điện thoại 390px:** trang không có cuộn ngang; chỉ thấy danh sách khi chưa chọn phòng và chỉ thấy hội thoại khi đã chọn (có nút "Về danh sách").
  13. **Admin:** admin mở `/admin/rooms`, thấy "UI nhóm"; tạo nhóm "UI nhóm 2" với một thành viên; thử xoá bằng cách gõ sai tên → nút vẫn tắt; gõ đúng → xoá được.
  14. **Khoá tài khoản:** admin khoá `ui.bob` qua REST; trang của Bob về trang đăng nhập trong vòng ~40 giây (đối soát định kỳ hoặc sự kiện ngắt kết nối), không vòng lặp kết nối lại.
  15. Không có lỗi `pageerror` nào (loại trừ các dòng log 401 của `/auth/refresh` lúc chưa đăng nhập).
- Cuối script: in tổng kết `N/M đạt`, thoát mã 1 nếu có bước hỏng.

- [ ] **Step 2: Chạy thật trên stack Docker**

Run (từ thư mục gốc; stack thử nghiệm dùng `.env` tạm với `JWT_SECRET` thật và `APP_ENV=prod`, sao lưu và khôi phục `.env` gốc ngoài repo, không in secret):
```bash
docker compose up -d --build
# chờ api healthy (khoảng 20-40 giây): docker compose ps
docker compose exec -T api python -m app.cli create-admin --username ui.admin --full-name "UI Admin" --branch-name "Hà Nội" --branch-code HN
# cài Playwright ngoài repo (một lần): mkdir <thư mục tạm> && cd <thư mục tạm> && npm init -y && npm i playwright@1.49.1 && npx playwright install chromium
PLAYWRIGHT_DIR=<thư mục tạm> BASE_URL=http://localhost ADMIN_USER=ui.admin ADMIN_TEMP_PASSWORD=<mật khẩu tạm> node scripts/e2e_chat_ui.mjs
```
Expected: mọi bước `PASS`. Với bước hỏng: điều tra nguyên nhân gốc (mã hay script); **không** nới kiểm tra để qua. Báo lỗi thật phát hiện được (đặc biệt về kết nối lại, chưa đọc, cuộn). Dọn dẹp: `docker compose down -v`, khôi phục `.env` gốc.

- [ ] **Step 3: Cập nhật README**

Thêm mục "Giao diện chat" sau mục "Giao diện web": mô tả bố cục (danh sách phòng, hội thoại, "+ Mới" để nhắn riêng), hành vi (tin hiện ngay và tự gửi lại khi mạng có lại, số chưa đọc, sửa/xoá tin của mình, liên kết `http/https` tự nhận dạng), trang admin "Phòng và nhóm" (tạo/đổi tên/thêm bớt thành viên; **xoá nhóm là xoá vĩnh viễn toàn bộ tin nhắn, phải gõ lại tên nhóm**), và cách chạy kiểm tra trình duyệt thật (`scripts/e2e_chat_ui.mjs`, **chỉ trên stack thử nghiệm**, cần Playwright cài ngoài repo, các biến môi trường `PLAYWRIGHT_DIR`, `BASE_URL`, `ADMIN_USER`, `ADMIN_TEMP_PASSWORD`).

- [ ] **Step 4: Chạy lại toàn bộ test và commit**

Run: `cd frontend && npm test && npm run build` và `bash scripts/test.sh -q` (từ thư mục gốc)
Expected: tất cả pass.

```bash
git add scripts/e2e_chat_ui.mjs README.md
git commit -m "test: add real-browser chat end-to-end script and document the chat ui" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage (phần thuộc Plan 4):**
- Mục 6 (tải lịch sử khi cuộn, giữ vị trí cuộn, nút "↓ N tin mới", tin đã xoá, `around`): Task 4, 5. `around` chưa dùng (nhảy tới một tin cụ thể dành cho tìm kiếm ở Plan 6). Danh sách ảo hoá: thay bằng `content-visibility` (ghi trong "Điều chỉnh có chủ ý").
- Mục 7 (React, TanStack Query cho REST, tin nhắn lạc quan bằng `client_id`, WebSocket tự kết nối lại và lấy phần thiếu, text thuần + liên kết http/https, khu `/admin`): Task 2-7. Zustand không dùng (store riêng + `useSyncExternalStore`, ít phụ thuộc hơn).
- Mục 11 (chat chính, trang Phòng và nhóm, trạng thái rỗng và đang tải, trạng thái mất kết nối, bố cục màn hình hẹp): Task 5-7. Cột bên phải bỏ (cần endpoint).
- Mục 5 (sau mỗi `ready` bù tin; `rooms_changed`; `resync`; mã đóng): Task 3, 4.
- Mục 9 (không HTML thô, liên kết an toàn): Task 2, 5.
- Việc tồn đọng của Plan 3 (README sai, 4401 cho must_change, `rooms_changed` khi đối soát đổi phòng, `gt=0`): Task 1.

**Quét placeholder:** không có "TBD"/"TODO". Hai chỗ có chủ ý để người thực hiện dùng theo mẫu có sẵn trong repo: Task 7 `RoomsPage.tsx` (viết theo khuôn `UsersPage`/`BranchesPage` với quy tắc bắt buộc và test mô tả đủ nội dung yêu cầu) và Task 8 script Playwright (danh sách bước và nhãn cụ thể). Hai chỗ ghi chú sửa mã khi viết thật: `disabled` thừa trong `ConversationPane` (cần xoá, đã nêu rõ), điều kiện thừa trong `handleAuthFailure` (cho phép đơn giản hoá, hành vi không đổi).

**Nhất quán kiểu và tên:** `ChatSocket`/`SocketStatus`, `ChatStore`/`ChatState`/`Thread`/`ChatMessage`, `ChatController` (`send` trả `client_id`, `retry(clientId)`, `remove(roomId, messageId)`), `chatApi.*`, hook `useRooms`/`useThread`/`useSocketStatus`/`useChatController`, nhãn tiếng Việt dùng thống nhất giữa component và test ("Nhập tin nhắn", "Gửi tin nhắn", "Sửa tin nhắn", "Xoá tin nhắn", "Cuộc trò chuyện mới", "Tìm người", "Lọc cuộc trò chuyện", "Về danh sách"...). Hợp đồng của `HomePage` cũ (lời chào, "Quản trị", "Đổi mật khẩu", "Đăng xuất") giữ nguyên trong chân thanh bên nên các test hiện có ít phải sửa.

**Review Focus:** 7 dòng đều có test: token ở khung đầu (Task 3 `authenticates with the first frame...`, Task 6 `authenticates the socket...`); không bão kết nối lại/4403/4401 (Task 3); không trùng/không mất (Task 4 controller + Task 6 `reconnecting banner...` + Task 8 bước 6, 7); chưa đọc (Task 4 `describe unread...`); cuộn (Task 5 `MessageList`); tin xoá, liên kết nguy hiểm, bộ gõ (Task 2 `linkify`, Task 5 `MessageItem`/`Composer`); xoá nhóm cần gõ tên (Task 7 test 6, Task 8 bước 13).

## Các plan tiếp theo

| Plan | Nội dung |
|---|---|
| 5 | Đã xem (qua WebSocket), đang gõ, online/offline, reply, mention, thông báo trình duyệt (Web Notification, âm báo, badge số chưa đọc trên tiêu đề tab) |
| 6 | File đính kèm (kèm xem trước ảnh) và tìm kiếm tin nhắn tiếng Việt, nhảy tới tin bằng `around` |
| 7 | Vận hành: HTTPS nội bộ (bật Web Locks, `COOKIE_SECURE`), giới hạn IP admin, sao lưu và khôi phục, thử tải 100.000 tin và đo lại danh sách ảo hoá, giới hạn số kết nối WebSocket, dọn `refresh_tokens`, ghim phiên bản |
