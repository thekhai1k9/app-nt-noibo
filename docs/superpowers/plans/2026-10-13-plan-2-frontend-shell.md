# Plan 2: Frontend React (đăng nhập, đổi mật khẩu, trang quản trị) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dựng ứng dụng web React chạy được trên trình duyệt: đăng nhập, đổi mật khẩu bắt buộc lần đầu, trang quản trị người dùng và chi nhánh, nối với API backend của Plan 1, phục vụ qua Caddy trong Docker Compose.

**Architecture:** SPA React + TypeScript (Vite). Access token chỉ giữ trong bộ nhớ; refresh token nằm trong cookie `httpOnly` do backend đặt. Client API tự refresh khi gặp 401, gộp các lần refresh đồng thời và tuần tự hoá giữa các tab bằng `navigator.locks`. Dữ liệu admin dùng TanStack Query. Giao diện theo bản thiết kế trong `docs/design/`. Bản build tĩnh được đóng vào image Caddy.

**Tech Stack:** React 18, TypeScript, Vite, react-router-dom 6, @tanstack/react-query 5, @fontsource/be-vietnam-pro, Vitest + Testing Library (jsdom), Node 22 (trong Docker), Caddy 2.8.

**Spec:** `docs/superpowers/specs/2026-10-12-internal-messaging-design.md` (mục 4, 7, 9, 11). Thiết kế giao diện tham chiếu: `docs/design/*.dc.html` (bản dựng tĩnh từ canvas thiết kế; chỉ dùng để lấy bố cục, màu, chữ, không phải mã sản phẩm).

## Phạm vi của plan này

Làm: khung dự án Vite, client API có refresh an toàn, ngữ cảnh đăng nhập, định tuyến có bảo vệ, trang Đăng nhập, trang Đổi mật khẩu, trang Chủ tạm (chưa có chat), khu vực `/admin` với trang Người dùng và Chi nhánh, đóng gói vào Docker/Caddy, cập nhật README.

**Không làm (các plan sau):** giao diện chat (Plan 3), trang Phòng và nhóm của admin (Plan 3, vì backend chưa có API phòng), đã xem/gõ/online/reply/mention/thông báo (Plan 4), file và tìm kiếm (Plan 5), HTTPS, giới hạn IP admin, sao lưu (Plan 6), bố cục điện thoại riêng (các cột chỉ xếp chồng khi hẹp).

**Khác biệt có chủ ý so với bản thiết kế:**
- Dải 4 chỉ số ở trang Người dùng (tài khoản, online, dung lượng tệp, sao lưu) chỉ giữ chỉ số backend đã có: số tài khoản và số đang hoạt động. Phần còn lại chờ API ở các plan sau.
- Thẻ chi nhánh chỉ hiện số người dùng (chưa có số phòng và số online).
- Vai trò chọn bằng `<select>` thay vì hai nút radio.

## API backend mà frontend dùng (Plan 1, đã merge)

Tất cả dưới tiền tố `/api`. Lỗi trả JSON `{"detail": "<mã>"}`; lỗi kiểm tra dữ liệu (FastAPI) trả 422 với `detail` là danh sách (frontend coi là `validation_error`).

| Endpoint | Ghi chú |
|---|---|
| `POST /auth/login` `{username,password}` | → `{access_token, token_type, must_change_password}`; đặt cookie `refresh_token`. Lỗi: `invalid_credentials` 401, `too_many_attempts` 429 |
| `POST /auth/refresh` | dùng cookie; → như login. Lỗi 401 `invalid_refresh` |
| `POST /auth/logout` | 204 |
| `GET /auth/me` | → User |
| `POST /auth/change-password` `{current_password,new_password}` | → TokenOut. Lỗi: `wrong_current_password` 400, `password_unchanged` 400; mật khẩu mới 8-128 ký tự (422 nếu sai) |
| `GET /admin/users?q=&branch_id=&is_active=` | → User[] |
| `POST /admin/users` `{username,full_name,branch_id,role}` | 201 → User + `temp_password`. Lỗi: `username_taken` 409, `branch_not_found` 404 |
| `PATCH /admin/users/{id}` `{full_name?,branch_id?,role?,is_active?}` | → User. Lỗi `cannot_modify_self` 409 |
| `POST /admin/users/{id}/reset-password` | → `{temp_password}` |
| `GET /admin/branches` | → Branch[] (có `user_count`) |
| `POST /admin/branches` `{name,code,address?}` | 201. Lỗi `branch_exists` 409 |
| `PATCH /admin/branches/{id}` | → Branch. Lỗi `branch_exists`, `branch_not_found` |
| `DELETE /admin/branches/{id}` | 204. Lỗi `branch_has_users` 409 |

Mọi route `/admin/*` trả 403 `forbidden` nếu không phải admin, 403 `password_change_required` nếu còn `must_change_password`. Khi dịch vụ phụ thuộc (Redis) lỗi: 503 `service_unavailable`.

## Global Constraints

- UI bằng tiếng Việt. Mã lỗi API là chuỗi máy đọc được và được ánh xạ sang câu tiếng Việt ở một nơi duy nhất (`src/lib/errors.ts`).
- Access token chỉ nằm trong bộ nhớ JavaScript, không bao giờ ghi vào `localStorage`/`sessionStorage`/cookie do JS đặt.
- Không dùng `dangerouslySetInnerHTML`; mọi chuỗi từ server hiển thị dưới dạng text thuần.
- Mật khẩu tạm chỉ hiển thị một lần ngay sau khi tạo/đặt lại, không lưu vào state lâu dài, không ghi log.
- Font Be Vietnam Pro đóng gói trong bundle bằng `@fontsource/be-vietnam-pro` (mạng WAN nội bộ có thể không ra được Google Fonts). Không gọi tài nguyên bên ngoài nào khác.
- Màu theo bản thiết kế: nền `#F2F4F7`, chữ `#101828`, chữ phụ `#596579`, viền `#E4E7EC`, chủ đạo teal `#0B6E7F`, nền nhạt teal `#E0F2F4`, thanh điều hướng admin `#101828`, nguy hiểm `#D92D20`, online xanh `#12B76A`.
- Mọi nút và vùng bấm cao tối thiểu 44px; mọi ô nhập có `<label>` gắn đúng `htmlFor`/`id`; nút chỉ có icon có `aria-label`.
- Người dùng còn `must_change_password` chỉ được vào `/change-password` (và đăng xuất); mọi route khác chuyển hướng về đó.
- Khu vực `/admin/*` chỉ hiện cho `role = admin` (kiểm tra thật vẫn ở backend).
- Bố cục co giãn: không cuộn ngang trang ở độ rộng điện thoại; bảng rộng cuộn trong khung riêng.
- Mạng lỗi/máy chủ không phản hồi không được tự đăng xuất người dùng.

## Review Focus

Các tình huống spec ngầm đòi hỏi nhưng dễ bị bỏ sót; mỗi dòng có test trong task ghi ở cuối dòng.

- Access token không bao giờ nằm trong `localStorage`/`sessionStorage` sau khi đăng nhập (Task 3).
- Hai request cùng gặp 401 chỉ gây đúng một lần refresh; và refresh 401 một lần thì thử lại một lần (Task 2).
- Mất mạng hoặc máy chủ lỗi lúc refresh không làm người dùng bị đăng xuất; hiện màn hình lỗi có nút "Thử lại" (Task 2, 3).
- Người dùng `must_change_password` gõ thẳng `/admin/users` hay `/` đều bị chuyển về đổi mật khẩu; người không phải admin gõ `/admin/users` bị chuyển về trang chủ (Task 3).
- Mật khẩu tạm biến mất khỏi màn hình khi bấm "Đã ghi lại" và không còn trong DOM (Task 5).

---

## File Structure

```
app-nt-noibo/
├── .gitignore                       # thêm frontend/dist
├── Caddyfile                        # SPA fallback + proxy /api
├── docker-compose.yml               # caddy build từ ./frontend
├── README.md                        # thêm mục giao diện web
├── docs/design/                     # (đã có) bản dựng tĩnh thiết kế
└── frontend/
    ├── Dockerfile                   # node build -> caddy:2.8-alpine
    ├── Dockerfile.dockerignore
    ├── index.html
    ├── package.json / package-lock.json
    ├── tsconfig.json
    ├── vite.config.ts               # + cấu hình vitest, proxy /api khi dev
    └── src/
        ├── main.tsx
        ├── App.tsx                  # AppRoutes
        ├── index.css                # token màu, lớp tiện ích
        ├── lib/
        │   ├── api.ts               # fetch + refresh an toàn
        │   ├── auth.tsx             # AuthProvider, useAuth
        │   ├── errors.ts            # mã lỗi -> tiếng Việt
        │   └── types.ts
        ├── components/
        │   ├── ErrorAlert.tsx
        │   ├── Field.tsx
        │   ├── FullPageMessage.tsx
        │   └── guards.tsx           # RequireAuth, RequireAdmin
        ├── pages/
        │   ├── ChangePasswordPage.tsx
        │   ├── HomePage.tsx
        │   ├── LoginPage.tsx
        │   └── admin/
        │       ├── AdminLayout.tsx
        │       ├── BranchesPage.tsx
        │       └── UsersPage.tsx
        └── test/
            ├── mockFetch.ts
            ├── setup.ts
            └── utils.tsx
```

Quy ước chạy lệnh: dùng Git Bash; chạy lệnh npm trong thư mục `frontend/`. Test frontend chạy trực tiếp bằng Node (không cần Docker); chỉ Task 7 cần Docker.

---

### Task 1: Khung dự án Vite, CSS nền và hạ tầng test

**Files:**
- Create: `frontend/package.json`, `frontend/tsconfig.json`, `frontend/vite.config.ts`, `frontend/index.html`
- Create: `frontend/src/main.tsx`, `frontend/src/App.tsx`, `frontend/src/index.css`
- Create: `frontend/src/test/setup.ts`, `frontend/src/test/mockFetch.ts`
- Create: `frontend/src/App.test.tsx`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: không có.
- Produces: `src/App.tsx` xuất `AppRoutes()` (lúc này chỉ có một route `/` hiển thị tiêu đề "Kết Nối"; các task sau thay thế); `src/test/mockFetch.ts` xuất `mockFetch(routes) -> { fn, calls }`, kiểu `MockResponse`, `MockRequest`, `MockHandler`; `src/test/setup.ts` (jest-dom, dọn dẹp sau mỗi test, gọi `resetApiState()` khi module `lib/api` đã có ở Task 2); lớp CSS dùng chung (xem Step 4).

- [ ] **Step 1: Tạo `package.json` và cài dependency**

`frontend/package.json`:
```json
{
  "name": "ket-noi-web",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@fontsource/be-vietnam-pro": "5.1.0",
    "@tanstack/react-query": "5.62.7",
    "react": "18.3.1",
    "react-dom": "18.3.1",
    "react-router-dom": "6.28.0"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "6.6.3",
    "@testing-library/react": "16.1.0",
    "@testing-library/user-event": "14.5.2",
    "@types/react": "18.3.12",
    "@types/react-dom": "18.3.1",
    "@vitejs/plugin-react": "4.3.4",
    "jsdom": "25.0.1",
    "typescript": "5.7.2",
    "vite": "6.0.3",
    "vitest": "2.1.8"
  }
}
```

Run:
```bash
cd frontend
npm install
```
Expected: cài thành công, sinh `package-lock.json`.

- [ ] **Step 2: Tạo cấu hình TypeScript, Vite, HTML**

`frontend/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "skipLibCheck": true,
    "noEmit": true,
    "isolatedModules": true,
    "types": ["vitest/globals", "@testing-library/jest-dom/vitest"]
  },
  "include": ["src", "vite.config.ts"]
}
```

`frontend/vite.config.ts`:
```ts
/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: {
    // Khi chạy `npm run dev`, API đi qua Caddy của docker compose ở cổng 80.
    proxy: { '/api': 'http://localhost:80' },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
})
```

`frontend/index.html`:
```html
<!doctype html>
<html lang="vi">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Kết Nối</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

Thêm vào cuối `.gitignore` (gốc dự án):
```
frontend/dist/
```

- [ ] **Step 3: Viết test thất bại**

`frontend/src/test/setup.ts` (lúc này chưa import `lib/api`):
```ts
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  localStorage.clear()
  sessionStorage.clear()
})
```

`frontend/src/test/mockFetch.ts`:
```ts
import { vi } from 'vitest'

export interface MockResponse {
  status?: number
  json?: unknown
}
export interface MockRequest {
  method: string
  path: string
  body: unknown
  headers: Headers
}
export type MockHandler = MockResponse | ((req: MockRequest) => MockResponse)

/**
 * Thay `fetch` toàn cục. Khoá có dạng "METHOD /api/duong-dan". Nếu không có khoá khớp
 * cả query, thử khoá không kèm query. Request không có route sẽ ném lỗi để test thất bại rõ ràng.
 */
export function mockFetch(routes: Record<string, MockHandler>) {
  const calls: MockRequest[] = []
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const path = url.replace(/^https?:\/\/[^/]+/, '')
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    const req: MockRequest = { method, path, body, headers: new Headers(init?.headers) }
    calls.push(req)
    const handler = routes[`${method} ${path}`] ?? routes[`${method} ${path.split('?')[0]}`]
    if (!handler) throw new Error(`Unmocked request: ${method} ${path}`)
    const res = typeof handler === 'function' ? handler(req) : handler
    const status = res.status ?? 200
    return new Response(status === 204 ? null : JSON.stringify(res.json ?? {}), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', fn)
  return { fn, calls }
}
```

`frontend/src/App.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { AppRoutes } from './App'

it('renders the app name', () => {
  render(
    <MemoryRouter>
      <AppRoutes />
    </MemoryRouter>,
  )
  expect(screen.getByRole('heading', { name: 'Kết Nối' })).toBeInTheDocument()
})
```

- [ ] **Step 4: Chạy test để xác nhận thất bại**

Run: `npm test`
Expected: lỗi không tìm thấy module `./App`.

- [ ] **Step 5: Viết mã tối thiểu**

`frontend/src/App.tsx`:
```tsx
import { Route, Routes } from 'react-router-dom'

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<h1>Kết Nối</h1>} />
    </Routes>
  )
}
```

`frontend/src/main.tsx`:
```tsx
import '@fontsource/be-vietnam-pro/400.css'
import '@fontsource/be-vietnam-pro/500.css'
import '@fontsource/be-vietnam-pro/600.css'
import '@fontsource/be-vietnam-pro/700.css'
import './index.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { AppRoutes } from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  </StrictMode>,
)
```

`frontend/src/index.css`:
```css
:root {
  --bg: #f2f4f7;
  --surface: #ffffff;
  --ink: #101828;
  --muted: #596579;
  --line: #e4e7ec;
  --accent: #0b6e7f;
  --accent-ink: #ffffff;
  --accent-soft: #e0f2f4;
  --nav: #101828;
  --danger: #d92d20;
  --danger-ink: #b42318;
  --danger-soft: #fde7e4;
  --ok: #12b76a;
  --ok-ink: #067647;
  --ok-soft: #dcfae6;
  --warn-ink: #7a4a06;
  --warn-soft: #fef0c7;
  --radius: 12px;
}

* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font-family: 'Be Vietnam Pro', system-ui, sans-serif;
  font-size: 14px;
  line-height: 1.45;
}
h1, h2, h3 { margin: 0; letter-spacing: -0.01em; }
a { color: var(--accent); }
code, .mono { font-family: ui-monospace, Menlo, Consolas, monospace; }
.muted { color: var(--muted); }
.stack { display: flex; flex-direction: column; gap: 16px; }
.row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.grow { flex: 1 1 0; min-width: 0; }

/* Nút: cao tối thiểu 44px */
.btn {
  min-height: 44px; padding: 0 18px; border-radius: var(--radius);
  border: 1px solid var(--line); background: var(--surface); color: var(--ink);
  font: inherit; font-weight: 600; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
}
.btn:disabled { opacity: 0.6; cursor: not-allowed; }
.btn-primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
.btn-danger { border-color: #fda29b; color: var(--danger-ink); }
.btn-ghost { border-color: transparent; background: transparent; }

/* Biểu mẫu */
.field { display: flex; flex-direction: column; gap: 6px; }
.field label { font-weight: 600; font-size: 13px; color: #344054; }
.input {
  min-height: 44px; padding: 0 12px; border: 1px solid #d0d5dd; border-radius: var(--radius);
  font: inherit; color: var(--ink); background: var(--surface); width: 100%;
}
.input:focus-visible, .btn:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.alert-error {
  padding: 10px 14px; border-radius: var(--radius);
  background: var(--danger-soft); color: var(--danger-ink); font-weight: 500;
}
.notice-ok {
  padding: 14px 16px; border-radius: var(--radius);
  background: var(--ok-soft); color: var(--ok-ink);
}
.notice-ok code { font-size: 16px; font-weight: 700; color: var(--ink); }

/* Thẻ và huy hiệu */
.card { background: var(--surface); border: 1px solid var(--line); border-radius: 16px; padding: 22px; }
.badge {
  display: inline-block; padding: 2px 10px; border-radius: 12px;
  font-size: 12px; font-weight: 600; background: var(--accent-soft); color: var(--accent);
}
.badge-ok { background: var(--ok-soft); color: var(--ok-ink); }
.badge-warn { background: var(--warn-soft); color: var(--warn-ink); }
.badge-danger { background: var(--danger-soft); color: var(--danger-ink); }

.center-screen { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }

/* Đăng nhập */
.login-shell { display: flex; flex-wrap: wrap; min-height: 100vh; }
.login-brand {
  flex: 1 1 420px; padding: 64px; background: var(--accent); color: #fff;
  display: flex; flex-direction: column; justify-content: space-between; gap: 48px;
}
.login-brand p { color: #cfeaee; font-size: 17px; line-height: 1.55; margin: 16px 0 0; max-width: 460px; }
.login-brand h1 { font-size: 40px; line-height: 1.15; max-width: 460px; }
.pill { padding: 6px 14px; border-radius: 16px; background: rgba(255,255,255,0.14); font-weight: 500; }
.login-form-wrap { flex: 1 1 420px; display: flex; align-items: center; justify-content: center; padding: 48px 24px; }
.login-card { width: 100%; max-width: 400px; }

/* Thanh trên cùng (trang chủ tạm) */
.topbar {
  display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
  padding: 12px 24px; background: var(--surface); border-bottom: 1px solid var(--line);
}

/* Khu vực admin */
.admin-shell { display: flex; flex-wrap: wrap; align-items: flex-start; min-height: 100vh; }
.admin-nav {
  flex: 1 1 240px; max-width: 260px; min-height: 100vh; padding: 20px 14px;
  background: var(--nav); color: #fff; display: flex; flex-direction: column; gap: 24px;
}
.admin-nav a {
  display: flex; align-items: center; min-height: 44px; padding: 0 12px; border-radius: var(--radius);
  color: #d0d5dd; text-decoration: none; font-weight: 500;
}
.admin-nav a[aria-current='page'] { background: var(--accent); color: #fff; font-weight: 600; }
.admin-nav .back { margin-top: auto; border: 1px solid #344054; color: #fff; }
.admin-main { flex: 999 1 560px; min-width: 0; padding: 28px 32px; display: flex; flex-direction: column; gap: 20px; }
.admin-aside { flex: 1 1 320px; max-width: 360px; margin: 28px 32px 28px 0; align-self: flex-start; }
.page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }

.table-scroll { overflow-x: auto; background: var(--surface); border: 1px solid var(--line); border-radius: 16px; }
.table-row {
  display: grid; gap: 12px; align-items: center; padding: 10px 16px; min-width: 720px;
  border-bottom: 1px solid #f2f4f7;
}
.table-head { background: #f9fafb; font-size: 12px; font-weight: 600; color: var(--muted); }
.users-grid { grid-template-columns: minmax(0, 2.2fr) minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1.3fr) auto; }
.cards-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 16px; }
.avatar {
  width: 36px; height: 36px; border-radius: 50%; flex: none; background: #d5d9eb; color: #2d3470;
  display: inline-flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 700;
}
.ellipsis { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
```

- [ ] **Step 6: Chạy test, kiểm tra kiểu và build**

Run: `npm test && npm run typecheck && npm run build`
Expected: test pass (1 passed), typecheck không lỗi, build tạo `dist/`. Nếu `tsconfig.json` báo không tìm thấy kiểu `@testing-library/jest-dom/vitest`, sửa mục `types` cho khớp gói đã cài (ví dụ chỉ `"vitest/globals"` và import jest-dom trong `setup.ts`) và ghi lại trong báo cáo.

- [ ] **Step 7: Commit**

```bash
git add .gitignore frontend docs/design
git commit -m "feat: scaffold react frontend with vite, vitest and base styles" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Client API (refresh an toàn), mã lỗi tiếng Việt

**Files:**
- Create: `frontend/src/lib/types.ts`, `frontend/src/lib/api.ts`, `frontend/src/lib/errors.ts`
- Modify: `frontend/src/test/setup.ts` (gọi `resetApiState()` trước mỗi test)
- Create: `frontend/src/lib/api.test.ts`, `frontend/src/lib/errors.test.ts`

**Interfaces:**
- Consumes: `mockFetch` (Task 1).
- Produces:
  - `types.ts`: `Role`, `User`, `Branch`, `TokenOut`, `UserCreated`, `ResetPasswordOut`.
  - `api.ts`: `class ApiError extends Error { status: number; code: string }`; `type RefreshResult = 'ok' | 'denied' | 'unavailable'`; `api<T = void>(path: string, options?: { method?: string; json?: unknown }): Promise<T>` (path không kèm `/api`); `refreshSession(): Promise<RefreshResult>`; `setAccessToken(t: string | null)`, `getAccessToken()`; `setAuthLostHandler(fn | null)`; `resetApiState()`.
  - `errors.ts`: `errorMessage(error: unknown): string`.
  - Quy tắc: 401 trên mọi path trừ `/auth/login`, `/auth/refresh`, `/auth/logout` → refresh một lần rồi thử lại. Refresh `denied` → xoá token, gọi `authLostHandler`, ném `ApiError` gốc. Refresh `unavailable` → ném `ApiError(0, 'network_error')`, KHÔNG gọi `authLostHandler`.

- [ ] **Step 1: Viết test thất bại**

`frontend/src/lib/errors.test.ts`:
```ts
import { ApiError } from './api'
import { errorMessage } from './errors'

it('maps known codes to Vietnamese', () => {
  expect(errorMessage(new ApiError(401, 'invalid_credentials'))).toBe('Sai tên đăng nhập hoặc mật khẩu.')
  expect(errorMessage(new ApiError(409, 'branch_has_users'))).toContain('Chi nhánh còn người dùng')
})

it('falls back for unknown codes and non-ApiError values', () => {
  expect(errorMessage(new ApiError(500, 'something_new'))).toBe('Có lỗi xảy ra. Vui lòng thử lại.')
  expect(errorMessage(new Error('boom'))).toBe('Có lỗi xảy ra. Vui lòng thử lại.')
  expect(errorMessage(null)).toBe('Có lỗi xảy ra. Vui lòng thử lại.')
})

it('has a message for a network failure', () => {
  expect(errorMessage(new ApiError(0, 'network_error'))).toBe('Không kết nối được máy chủ.')
})
```

`frontend/src/lib/api.test.ts`:
```ts
import { vi } from 'vitest'
import { mockFetch } from '../test/mockFetch'
import {
  ApiError,
  api,
  getAccessToken,
  refreshSession,
  setAccessToken,
  setAuthLostHandler,
} from './api'

const tokenJson = (token: string) => ({
  json: { access_token: token, token_type: 'bearer', must_change_password: false },
})

describe('api client', () => {
  it('sends a JSON body and the bearer token', async () => {
    setAccessToken('abc')
    const { calls } = mockFetch({ 'POST /api/admin/branches': { status: 201, json: { id: 1 } } })
    await api('/admin/branches', { method: 'POST', json: { name: 'A' } })
    expect(calls[0].headers.get('Authorization')).toBe('Bearer abc')
    expect(calls[0].headers.get('Content-Type')).toBe('application/json')
    expect(calls[0].body).toEqual({ name: 'A' })
  })

  it('returns undefined for 204', async () => {
    mockFetch({ 'POST /api/auth/logout': { status: 204 } })
    await expect(api('/auth/logout', { method: 'POST' })).resolves.toBeUndefined()
  })

  it('raises ApiError with the server detail code', async () => {
    mockFetch({ 'POST /api/admin/users': { status: 409, json: { detail: 'username_taken' } } })
    await expect(api('/admin/users', { method: 'POST', json: {} })).rejects.toMatchObject({
      status: 409,
      code: 'username_taken',
    })
  })

  it('treats FastAPI 422 as validation_error', async () => {
    mockFetch({ 'POST /api/admin/users': { status: 422, json: { detail: [{ msg: 'x' }] } } })
    await expect(api('/admin/users', { method: 'POST', json: {} })).rejects.toMatchObject({
      code: 'validation_error',
    })
  })

  it('refreshes once on 401 and retries with the new token', async () => {
    setAccessToken('old')
    const { calls } = mockFetch({
      'GET /api/auth/me': (req) =>
        req.headers.get('Authorization') === 'Bearer new'
          ? { json: { id: 1 } }
          : { status: 401, json: { detail: 'not_authenticated' } },
      'POST /api/auth/refresh': tokenJson('new'),
    })
    await expect(api('/auth/me')).resolves.toEqual({ id: 1 })
    expect(getAccessToken()).toBe('new')
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /api/auth/me',
      'POST /api/auth/refresh',
      'GET /api/auth/me',
    ])
  })

  it('shares a single refresh between concurrent 401s', async () => {
    setAccessToken('old')
    let refreshCalls = 0
    const authorized = (req: { headers: Headers }, body: unknown) =>
      req.headers.get('Authorization') === 'Bearer new'
        ? { json: body }
        : { status: 401, json: { detail: 'not_authenticated' } }
    mockFetch({
      'GET /api/admin/users': (req) => authorized(req, []),
      'GET /api/admin/branches': (req) => authorized(req, []),
      'POST /api/auth/refresh': () => {
        refreshCalls += 1
        return tokenJson('new')
      },
    })
    await Promise.all([api('/admin/users'), api('/admin/branches')])
    expect(refreshCalls).toBe(1)
  })

  it('retries the refresh once when it returns 401 (another tab may have rotated the cookie)', async () => {
    setAccessToken('old')
    let refreshCalls = 0
    mockFetch({
      'GET /api/auth/me': (req) =>
        req.headers.get('Authorization') === 'Bearer new'
          ? { json: { id: 1 } }
          : { status: 401, json: { detail: 'not_authenticated' } },
      'POST /api/auth/refresh': () => {
        refreshCalls += 1
        return refreshCalls === 1 ? { status: 401, json: { detail: 'invalid_refresh' } } : tokenJson('new')
      },
    })
    await expect(api('/auth/me')).resolves.toEqual({ id: 1 })
    expect(refreshCalls).toBe(2)
  })

  it('treats a refresh that is denied twice as a lost session', async () => {
    setAccessToken('old')
    const lost = vi.fn()
    setAuthLostHandler(lost)
    let refreshCalls = 0
    mockFetch({
      'GET /api/auth/me': { status: 401, json: { detail: 'not_authenticated' } },
      'POST /api/auth/refresh': () => {
        refreshCalls += 1
        return { status: 401, json: { detail: 'invalid_refresh' } }
      },
    })
    await expect(api('/auth/me')).rejects.toMatchObject({ status: 401, code: 'not_authenticated' })
    expect(refreshCalls).toBe(2)
    expect(lost).toHaveBeenCalledTimes(1)
    expect(getAccessToken()).toBeNull()
  })

  it('does not try to refresh when login itself returns 401', async () => {
    const { fn } = mockFetch({
      'POST /api/auth/login': { status: 401, json: { detail: 'invalid_credentials' } },
    })
    await expect(api('/auth/login', { method: 'POST', json: {} })).rejects.toMatchObject({
      code: 'invalid_credentials',
    })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('reports a network error without losing the session', async () => {
    const lost = vi.fn()
    setAuthLostHandler(lost)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')))
    await expect(api('/admin/users')).rejects.toMatchObject({ status: 0, code: 'network_error' })
    expect(lost).not.toHaveBeenCalled()
  })

  it('does not log the user out when the refresh endpoint is unreachable', async () => {
    setAccessToken('old')
    const lost = vi.fn()
    setAuthLostHandler(lost)
    mockFetch({
      'GET /api/admin/users': { status: 401, json: { detail: 'not_authenticated' } },
      'POST /api/auth/refresh': () => {
        throw new Error('connection reset')
      },
    })
    await expect(api('/admin/users')).rejects.toMatchObject({ code: 'network_error' })
    expect(lost).not.toHaveBeenCalled()
    expect(getAccessToken()).toBe('old')
  })

  it('serializes refresh across tabs with navigator.locks when available', async () => {
    const request = vi.fn((_name: string, cb: () => Promise<unknown>) => cb())
    Object.defineProperty(navigator, 'locks', { value: { request }, configurable: true })
    try {
      mockFetch({ 'POST /api/auth/refresh': tokenJson('t') })
      await expect(refreshSession()).resolves.toBe('ok')
      expect(request).toHaveBeenCalledWith('kn-refresh', expect.any(Function))
    } finally {
      Reflect.deleteProperty(navigator, 'locks') // dọn thuộc tính đã thêm cho test
    }
  })

  it('exposes ApiError with status and code', () => {
    const err = new ApiError(403, 'forbidden')
    expect(err).toBeInstanceOf(Error)
    expect(err.status).toBe(403)
    expect(err.code).toBe('forbidden')
  })
})
```

Cập nhật `frontend/src/test/setup.ts` thành:
```ts
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach, vi } from 'vitest'
import { resetApiState } from '../lib/api'

beforeEach(() => {
  resetApiState()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  localStorage.clear()
  sessionStorage.clear()
})
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `npm test`
Expected: lỗi không tìm thấy module `./api` / `./errors`.

- [ ] **Step 3: Viết `types.ts`**

`frontend/src/lib/types.ts`:
```ts
export type Role = 'admin' | 'member'

export interface User {
  id: number
  username: string
  full_name: string
  branch_id: number
  role: Role
  is_active: boolean
  must_change_password: boolean
  last_login_at: string | null
}

export interface Branch {
  id: number
  name: string
  code: string
  address: string
  user_count: number
}

export interface TokenOut {
  access_token: string
  token_type: 'bearer'
  must_change_password: boolean
}

export interface UserCreated extends User {
  temp_password: string
}

export interface ResetPasswordOut {
  temp_password: string
}
```

- [ ] **Step 4: Viết `api.ts`**

`frontend/src/lib/api.ts`:
```ts
import type { TokenOut } from './types'

export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string) {
    super(code)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

export type RefreshResult = 'ok' | 'denied' | 'unavailable'

// Access token chỉ nằm trong bộ nhớ của tab này. Không ghi vào localStorage/sessionStorage.
let accessToken: string | null = null
let authLostHandler: (() => void) | null = null
let refreshInFlight: Promise<RefreshResult> | null = null

export function setAccessToken(token: string | null): void {
  accessToken = token
}

export function getAccessToken(): string | null {
  return accessToken
}

export function setAuthLostHandler(handler: (() => void) | null): void {
  authLostHandler = handler
}

export function resetApiState(): void {
  accessToken = null
  authLostHandler = null
  refreshInFlight = null
}

interface RequestOptions {
  method?: string
  json?: unknown
}

async function send(path: string, options: RequestOptions, withAuth: boolean): Promise<Response> {
  const headers = new Headers()
  let body: string | undefined
  if (options.json !== undefined) {
    headers.set('Content-Type', 'application/json')
    body = JSON.stringify(options.json)
  }
  if (withAuth && accessToken) headers.set('Authorization', `Bearer ${accessToken}`)
  try {
    return await fetch(`/api${path}`, {
      method: options.method ?? 'GET',
      headers,
      body,
      credentials: 'same-origin',
    })
  } catch {
    throw new ApiError(0, 'network_error')
  }
}

async function toApiError(res: Response): Promise<ApiError> {
  let code = res.status === 422 ? 'validation_error' : 'unknown_error'
  try {
    const data = await res.json()
    if (data && typeof data.detail === 'string') code = data.detail
  } catch {
    // thân phản hồi không phải JSON
  }
  return new ApiError(res.status, code)
}

async function refreshOnce(): Promise<RefreshResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response
    try {
      res = await send('/auth/refresh', { method: 'POST' }, false)
    } catch {
      return 'unavailable'
    }
    if (res.ok) {
      const data = (await res.json()) as TokenOut
      accessToken = data.access_token
      return 'ok'
    }
    if (res.status !== 401) return 'unavailable'
    // 401: có thể tab khác vừa xoay cookie. Thử lại một lần với cookie mới.
  }
  return 'denied'
}

/** Gộp các lần refresh đồng thời trong tab và tuần tự hoá giữa các tab bằng Web Locks. */
export function refreshSession(): Promise<RefreshResult> {
  if (!refreshInFlight) {
    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
    const run = locks ? locks.request('kn-refresh', () => refreshOnce()) : refreshOnce()
    refreshInFlight = run.finally(() => {
      refreshInFlight = null
    })
  }
  return refreshInFlight
}

const NO_REFRESH_PATHS = new Set(['/auth/login', '/auth/refresh', '/auth/logout'])

export async function api<T = void>(path: string, options: RequestOptions = {}): Promise<T> {
  let res = await send(path, options, true)
  if (res.status === 401 && !NO_REFRESH_PATHS.has(path)) {
    const result = await refreshSession()
    if (result === 'denied') {
      accessToken = null
      authLostHandler?.()
      throw await toApiError(res)
    }
    if (result === 'unavailable') throw new ApiError(0, 'network_error')
    res = await send(path, options, true)
  }
  if (!res.ok) throw await toApiError(res)
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}
```

- [ ] **Step 5: Viết `errors.ts`**

`frontend/src/lib/errors.ts`:
```ts
import { ApiError } from './api'

const MESSAGES: Record<string, string> = {
  invalid_credentials: 'Sai tên đăng nhập hoặc mật khẩu.',
  too_many_attempts: 'Bạn nhập sai quá nhiều lần. Vui lòng thử lại sau vài phút.',
  invalid_refresh: 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.',
  not_authenticated: 'Bạn cần đăng nhập để tiếp tục.',
  password_change_required: 'Bạn cần đổi mật khẩu trước khi tiếp tục.',
  forbidden: 'Bạn không có quyền thực hiện thao tác này.',
  wrong_current_password: 'Mật khẩu hiện tại không đúng.',
  password_unchanged: 'Mật khẩu mới phải khác mật khẩu hiện tại.',
  username_taken: 'Tên đăng nhập đã tồn tại.',
  user_not_found: 'Không tìm thấy người dùng.',
  branch_not_found: 'Không tìm thấy chi nhánh.',
  branch_exists: 'Tên hoặc mã chi nhánh đã tồn tại.',
  branch_has_users: 'Chi nhánh còn người dùng. Hãy chuyển họ sang chi nhánh khác trước khi xoá.',
  cannot_modify_self: 'Bạn không thể tự hạ quyền hoặc tự khoá tài khoản của mình.',
  validation_error: 'Dữ liệu chưa hợp lệ. Hãy kiểm tra lại các trường.',
  service_unavailable: 'Máy chủ tạm thời không khả dụng. Vui lòng thử lại sau.',
  network_error: 'Không kết nối được máy chủ.',
  unknown_error: 'Có lỗi xảy ra. Vui lòng thử lại.',
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return MESSAGES[error.code] ?? MESSAGES.unknown_error
  return MESSAGES.unknown_error
}
```

- [ ] **Step 6: Chạy test và kiểm tra kiểu**

Run: `npm test && npm run typecheck`
Expected: tất cả pass, typecheck sạch.

- [ ] **Step 7: Commit**

```bash
git add frontend
git commit -m "feat: add api client with safe token refresh and vietnamese error messages" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Ngữ cảnh đăng nhập, bảo vệ route, trang chủ tạm

**Files:**
- Create: `frontend/src/lib/auth.tsx`
- Create: `frontend/src/components/FullPageMessage.tsx`, `frontend/src/components/guards.tsx`
- Create: `frontend/src/pages/HomePage.tsx`
- Create (stub, thay ở Task 4/5/6): `frontend/src/pages/LoginPage.tsx`, `frontend/src/pages/ChangePasswordPage.tsx`, `frontend/src/pages/admin/AdminLayout.tsx`, `frontend/src/pages/admin/UsersPage.tsx`, `frontend/src/pages/admin/BranchesPage.tsx`
- Modify: `frontend/src/App.tsx`, `frontend/src/main.tsx`
- Create: `frontend/src/test/utils.tsx`, `frontend/src/routes.test.tsx`
- Modify: `frontend/src/App.test.tsx` (xoá, thay bằng `routes.test.tsx`)

**Interfaces:**
- Consumes: `api`, `refreshSession`, `setAccessToken`, `setAuthLostHandler`, `ApiError` (Task 2); `mockFetch` (Task 1).
- Produces:
  - `auth.tsx`: `AuthProvider({children})` (phải nằm trong `QueryClientProvider`); `useAuth(): { status: 'loading'|'anonymous'|'authenticated'|'error'; user: User | null; login(username, password): Promise<void>; logout(): Promise<void>; changePassword(current, next): Promise<void>; reload(): void }`.
  - `guards.tsx`: `RequireAuth({ allowPasswordChange?: boolean, children })`, `RequireAdmin({ children })`.
  - Route: `/login`, `/change-password` (RequireAuth allowPasswordChange), `/` (RequireAuth → HomePage), `/admin` (RequireAuth + RequireAdmin → AdminLayout; index chuyển sang `users`; con `users`, `branches`).
  - `test/utils.tsx`: `makeUser(overrides?)`, `sessionRoutes(user)`, `anonymousRoutes`, `renderApp(path?)`.
  - Các trang stub ở task này chỉ trả tiêu đề để định tuyến chạy được: LoginPage → `<h2>Đăng nhập</h2>`, ChangePasswordPage → `<h2>Đổi mật khẩu</h2>`, AdminLayout → `<Outlet />`, UsersPage → `<h1>Người dùng</h1>`, BranchesPage → `<h1>Chi nhánh</h1>`.

- [ ] **Step 1: Viết test thất bại**

`frontend/src/test/utils.tsx`:
```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { AppRoutes } from '../App'
import { AuthProvider } from '../lib/auth'
import type { User } from '../lib/types'

export function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 1,
    username: 'long.pham',
    full_name: 'Phạm Đức Long',
    branch_id: 1,
    role: 'member',
    is_active: true,
    must_change_password: false,
    last_login_at: null,
    ...overrides,
  }
}

/** Route mock cho một phiên đã đăng nhập (refresh thành công, /auth/me trả user). */
export function sessionRoutes(user: User) {
  return {
    'POST /api/auth/refresh': {
      json: { access_token: 'tok-1', token_type: 'bearer', must_change_password: user.must_change_password },
    },
    'GET /api/auth/me': { json: user },
  }
}

export const anonymousRoutes = {
  'POST /api/auth/refresh': { status: 401, json: { detail: 'invalid_refresh' } },
}

export function renderApp(path = '/') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <AppRoutes />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}
```

`frontend/src/routes.test.tsx`:
```tsx
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockFetch } from './test/mockFetch'
import { anonymousRoutes, makeUser, renderApp, sessionRoutes } from './test/utils'

describe('route guards', () => {
  it('sends an anonymous visitor to the login page', async () => {
    mockFetch(anonymousRoutes)
    renderApp('/')
    expect(await screen.findByRole('heading', { name: 'Đăng nhập' })).toBeInTheDocument()
  })

  it('shows the home page for a member without an admin link', async () => {
    mockFetch(sessionRoutes(makeUser()))
    renderApp('/')
    expect(await screen.findByText('Xin chào, Phạm Đức Long')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Quản trị' })).not.toBeInTheDocument()
  })

  it('shows the admin link for an admin', async () => {
    mockFetch(sessionRoutes(makeUser({ role: 'admin' })))
    renderApp('/')
    expect(await screen.findByRole('link', { name: 'Quản trị' })).toBeInTheDocument()
  })

  it('sends a non-admin who types /admin/users back to the home page', async () => {
    mockFetch(sessionRoutes(makeUser()))
    renderApp('/admin/users')
    expect(await screen.findByText('Xin chào, Phạm Đức Long')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Người dùng' })).not.toBeInTheDocument()
  })

  it('lets an admin open the users page', async () => {
    mockFetch(sessionRoutes(makeUser({ role: 'admin' })))
    renderApp('/admin/users')
    expect(await screen.findByRole('heading', { name: 'Người dùng' })).toBeInTheDocument()
  })

  it('forces a user who must change the password to the change-password page from any route', async () => {
    const user = makeUser({ must_change_password: true, role: 'admin' })
    mockFetch(sessionRoutes(user))
    renderApp('/admin/users')
    expect(await screen.findByRole('heading', { name: 'Đổi mật khẩu' })).toBeInTheDocument()
  })

  it('forces a user who must change the password away from the home page', async () => {
    mockFetch(sessionRoutes(makeUser({ must_change_password: true })))
    renderApp('/')
    expect(await screen.findByRole('heading', { name: 'Đổi mật khẩu' })).toBeInTheDocument()
  })

  it('shows a retry screen, not the login page, when the server is unreachable at startup', async () => {
    let calls = 0
    mockFetch({
      'POST /api/auth/refresh': () => {
        calls += 1
        if (calls === 1) throw new Error('connection refused')
        return { json: { access_token: 'tok', token_type: 'bearer', must_change_password: false } }
      },
      'GET /api/auth/me': { json: makeUser() },
    })
    renderApp('/')
    const retry = await screen.findByRole('button', { name: 'Thử lại' })
    expect(screen.queryByRole('heading', { name: 'Đăng nhập' })).not.toBeInTheDocument()
    await userEvent.click(retry)
    expect(await screen.findByText('Xin chào, Phạm Đức Long')).toBeInTheDocument()
  })

  it('logs out: clears the user and returns to the login page', async () => {
    mockFetch({ ...sessionRoutes(makeUser()), 'POST /api/auth/logout': { status: 204 } })
    renderApp('/')
    await userEvent.click(await screen.findByRole('button', { name: 'Đăng xuất' }))
    expect(await screen.findByRole('heading', { name: 'Đăng nhập' })).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `npm test`
Expected: lỗi không tìm thấy module `./lib/auth` (và các trang).

- [ ] **Step 3: Viết `auth.tsx`**

`frontend/src/lib/auth.tsx`:
```tsx
import { useQueryClient } from '@tanstack/react-query'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { ApiError, api, refreshSession, setAccessToken, setAuthLostHandler } from './api'
import type { TokenOut, User } from './types'

type Status = 'loading' | 'anonymous' | 'authenticated' | 'error'

interface AuthContextValue {
  status: Status
  user: User | null
  login: (username: string, password: string) => Promise<void>
  logout: () => Promise<void>
  changePassword: (current: string, next: string) => Promise<void>
  reload: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const [status, setStatus] = useState<Status>('loading')
  const [user, setUser] = useState<User | null>(null)

  const bootstrap = useCallback(async () => {
    setStatus('loading')
    const result = await refreshSession()
    if (result === 'denied') {
      setUser(null)
      setStatus('anonymous')
      return
    }
    if (result === 'unavailable') {
      setStatus('error')
      return
    }
    try {
      setUser(await api<User>('/auth/me'))
      setStatus('authenticated')
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setUser(null)
        setStatus('anonymous')
      } else {
        setStatus('error')
      }
    }
  }, [])

  useEffect(() => {
    setAuthLostHandler(() => {
      setUser(null)
      setStatus('anonymous')
      queryClient.clear()
    })
    void bootstrap()
    return () => setAuthLostHandler(null)
  }, [bootstrap, queryClient])

  const login = useCallback(async (username: string, password: string) => {
    const token = await api<TokenOut>('/auth/login', { method: 'POST', json: { username, password } })
    setAccessToken(token.access_token)
    setUser(await api<User>('/auth/me'))
    setStatus('authenticated')
  }, [])

  const logout = useCallback(async () => {
    try {
      await api('/auth/logout', { method: 'POST' })
    } catch {
      // vẫn đăng xuất phía trình duyệt dù máy chủ không phản hồi
    }
    setAccessToken(null)
    setUser(null)
    setStatus('anonymous')
    queryClient.clear()
  }, [queryClient])

  const changePassword = useCallback(async (current: string, next: string) => {
    const token = await api<TokenOut>('/auth/change-password', {
      method: 'POST',
      json: { current_password: current, new_password: next },
    })
    setAccessToken(token.access_token)
    setUser(await api<User>('/auth/me'))
  }, [])

  const reload = useCallback(() => {
    void bootstrap()
  }, [bootstrap])

  const value = useMemo(
    () => ({ status, user, login, logout, changePassword, reload }),
    [status, user, login, logout, changePassword, reload],
  )
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
```

- [ ] **Step 4: Viết components, guards, trang chủ và các trang stub**

`frontend/src/components/FullPageMessage.tsx`:
```tsx
import type { ReactNode } from 'react'

export function FullPageMessage({ children }: { children: ReactNode }) {
  return (
    <div className="center-screen">
      <div className="stack" style={{ alignItems: 'center', textAlign: 'center' }}>
        {children}
      </div>
    </div>
  )
}
```

`frontend/src/components/guards.tsx`:
```tsx
import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { FullPageMessage } from './FullPageMessage'

export function RequireAuth({
  allowPasswordChange = false,
  children,
}: {
  allowPasswordChange?: boolean
  children: ReactNode
}) {
  const { status, user, reload } = useAuth()
  const location = useLocation()

  if (status === 'loading') return <FullPageMessage>Đang tải…</FullPageMessage>
  if (status === 'error') {
    return (
      <FullPageMessage>
        <p>Không kết nối được máy chủ.</p>
        <button type="button" className="btn btn-primary" onClick={reload}>
          Thử lại
        </button>
      </FullPageMessage>
    )
  }
  if (status === 'anonymous' || !user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }
  if (user.must_change_password && !allowPasswordChange) {
    return <Navigate to="/change-password" replace />
  }
  return <>{children}</>
}

export function RequireAdmin({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  if (user?.role !== 'admin') return <Navigate to="/" replace />
  return <>{children}</>
}
```

`frontend/src/pages/HomePage.tsx`:
```tsx
import { Link } from 'react-router-dom'
import { useAuth } from '../lib/auth'

export function HomePage() {
  const { user, logout } = useAuth()
  return (
    <div>
      <header className="topbar">
        <strong>Kết Nối</strong>
        <div className="row">
          {user?.role === 'admin' && <Link to="/admin">Quản trị</Link>}
          <button type="button" className="btn" onClick={() => void logout()}>
            Đăng xuất
          </button>
        </div>
      </header>
      <main className="center-screen">
        <div className="card stack" style={{ maxWidth: 480 }}>
          <h1>Xin chào, {user?.full_name}</h1>
          <p className="muted">Giao diện trò chuyện sẽ có ở bản cập nhật sau.</p>
        </div>
      </main>
    </div>
  )
}
```

Các trang stub (sẽ được thay thế ở task sau):

`frontend/src/pages/LoginPage.tsx`:
```tsx
export function LoginPage() {
  return <h2>Đăng nhập</h2>
}
```

`frontend/src/pages/ChangePasswordPage.tsx`:
```tsx
export function ChangePasswordPage() {
  return <h2>Đổi mật khẩu</h2>
}
```

`frontend/src/pages/admin/AdminLayout.tsx`:
```tsx
import { Outlet } from 'react-router-dom'

export function AdminLayout() {
  return <Outlet />
}
```

`frontend/src/pages/admin/UsersPage.tsx`:
```tsx
export function UsersPage() {
  return <h1>Người dùng</h1>
}
```

`frontend/src/pages/admin/BranchesPage.tsx`:
```tsx
export function BranchesPage() {
  return <h1>Chi nhánh</h1>
}
```

- [ ] **Step 5: Viết `App.tsx` và cập nhật `main.tsx`**

`frontend/src/App.tsx` (khu vực admin được tải lười để người dùng thường không tải mã admin):
```tsx
import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { FullPageMessage } from './components/FullPageMessage'
import { RequireAdmin, RequireAuth } from './components/guards'
import { ChangePasswordPage } from './pages/ChangePasswordPage'
import { HomePage } from './pages/HomePage'
import { LoginPage } from './pages/LoginPage'

const AdminLayout = lazy(() => import('./pages/admin/AdminLayout').then((m) => ({ default: m.AdminLayout })))
const BranchesPage = lazy(() => import('./pages/admin/BranchesPage').then((m) => ({ default: m.BranchesPage })))
const UsersPage = lazy(() => import('./pages/admin/UsersPage').then((m) => ({ default: m.UsersPage })))

export function AppRoutes() {
  return (
    <Suspense fallback={<FullPageMessage>Đang tải…</FullPageMessage>}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/change-password"
          element={
            <RequireAuth allowPasswordChange>
              <ChangePasswordPage />
            </RequireAuth>
          }
        />
        <Route
          path="/"
          element={
            <RequireAuth>
              <HomePage />
            </RequireAuth>
          }
        />
        <Route
          path="/admin"
          element={
            <RequireAuth>
              <RequireAdmin>
                <AdminLayout />
              </RequireAdmin>
            </RequireAuth>
          }
        >
          <Route index element={<Navigate to="users" replace />} />
          <Route path="users" element={<UsersPage />} />
          <Route path="branches" element={<BranchesPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  )
}
```

`frontend/src/main.tsx` (thay phần render):
```tsx
import '@fontsource/be-vietnam-pro/400.css'
import '@fontsource/be-vietnam-pro/500.css'
import '@fontsource/be-vietnam-pro/600.css'
import '@fontsource/be-vietnam-pro/700.css'
import './index.css'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { AppRoutes } from './App'
import { AuthProvider } from './lib/auth'

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <AppRoutes />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)
```

Xoá `frontend/src/App.test.tsx` (đã được `routes.test.tsx` thay thế): `git rm frontend/src/App.test.tsx`.

- [ ] **Step 6: Chạy test và kiểm tra kiểu**

Run: `npm test && npm run typecheck`
Expected: tất cả pass.

- [ ] **Step 7: Commit**

```bash
git add -A frontend
git commit -m "feat: add auth context, route guards and placeholder home page" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Trang Đăng nhập và Đổi mật khẩu

**Files:**
- Create: `frontend/src/components/Field.tsx`, `frontend/src/components/ErrorAlert.tsx`
- Replace: `frontend/src/pages/LoginPage.tsx`, `frontend/src/pages/ChangePasswordPage.tsx`
- Create: `frontend/src/pages/LoginPage.test.tsx`, `frontend/src/pages/ChangePasswordPage.test.tsx`

**Interfaces:**
- Consumes: `useAuth` (Task 3), `errorMessage` (Task 2), `renderApp`, `makeUser`, `anonymousRoutes`, `sessionRoutes`, `mockFetch`.
- Produces: `Field({ label, id, ...inputProps })` (nhãn + ô nhập có `htmlFor`); `ErrorAlert({ error })` (render `role="alert"` với `errorMessage(error)`, không render gì nếu `error` rỗng); trang Đăng nhập (`<h2>Đăng nhập</h2>`, ô "Tên đăng nhập", "Mật khẩu", nút "Đăng nhập"); trang Đổi mật khẩu (`<h2>Đổi mật khẩu</h2>`, ô "Mật khẩu hiện tại", "Mật khẩu mới", "Nhập lại mật khẩu mới", nút "Lưu mật khẩu mới", nút "Đăng xuất").

- [ ] **Step 1: Viết test thất bại**

`frontend/src/pages/LoginPage.test.tsx`:
```tsx
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockFetch } from '../test/mockFetch'
import { anonymousRoutes, makeUser, renderApp } from '../test/utils'

const tokenOut = (mustChange: boolean) => ({
  json: { access_token: 'tok-login', token_type: 'bearer', must_change_password: mustChange },
})

async function fillAndSubmit(username: string, password: string) {
  await userEvent.type(await screen.findByLabelText('Tên đăng nhập'), username)
  await userEvent.type(screen.getByLabelText('Mật khẩu'), password)
  await userEvent.click(screen.getByRole('button', { name: 'Đăng nhập' }))
}

describe('LoginPage', () => {
  it('logs in, keeps the token out of web storage and shows the home page', async () => {
    const { calls } = mockFetch({
      ...anonymousRoutes,
      'POST /api/auth/login': tokenOut(false),
      'GET /api/auth/me': { json: makeUser() },
    })
    renderApp('/login')
    await fillAndSubmit('long.pham', 'Passw0rd!')
    expect(await screen.findByText('Xin chào, Phạm Đức Long')).toBeInTheDocument()
    const login = calls.find((c) => c.path === '/api/auth/login')
    expect(login?.body).toEqual({ username: 'long.pham', password: 'Passw0rd!' })
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })

  it('sends a user who must change the password to the change-password page', async () => {
    mockFetch({
      ...anonymousRoutes,
      'POST /api/auth/login': tokenOut(true),
      'GET /api/auth/me': { json: makeUser({ must_change_password: true }) },
    })
    renderApp('/login')
    await fillAndSubmit('long.pham', 'TempPass1234')
    expect(await screen.findByRole('heading', { name: 'Đổi mật khẩu' })).toBeInTheDocument()
  })

  it('shows a Vietnamese message for wrong credentials and stays on the page', async () => {
    mockFetch({
      ...anonymousRoutes,
      'POST /api/auth/login': { status: 401, json: { detail: 'invalid_credentials' } },
    })
    renderApp('/login')
    await fillAndSubmit('long.pham', 'wrong')
    expect(await screen.findByRole('alert')).toHaveTextContent('Sai tên đăng nhập hoặc mật khẩu.')
    expect(screen.getByRole('heading', { name: 'Đăng nhập' })).toBeInTheDocument()
  })

  it('shows the lockout message when the server rate-limits the login', async () => {
    mockFetch({
      ...anonymousRoutes,
      'POST /api/auth/login': { status: 429, json: { detail: 'too_many_attempts' } },
    })
    renderApp('/login')
    await fillAndSubmit('long.pham', 'wrong')
    expect(await screen.findByRole('alert')).toHaveTextContent('Bạn nhập sai quá nhiều lần')
  })

  it('masks the password field', async () => {
    mockFetch(anonymousRoutes)
    renderApp('/login')
    expect(await screen.findByLabelText('Mật khẩu')).toHaveAttribute('type', 'password')
  })
})
```

`frontend/src/pages/ChangePasswordPage.test.tsx`:
```tsx
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockFetch } from '../test/mockFetch'
import { makeUser, renderApp, sessionRoutes } from '../test/utils'

async function fill(current: string, next: string, confirm: string) {
  await userEvent.type(await screen.findByLabelText('Mật khẩu hiện tại'), current)
  await userEvent.type(screen.getByLabelText('Mật khẩu mới'), next)
  await userEvent.type(screen.getByLabelText('Nhập lại mật khẩu mới'), confirm)
  await userEvent.click(screen.getByRole('button', { name: 'Lưu mật khẩu mới' }))
}

const mustChange = () => sessionRoutes(makeUser({ must_change_password: true }))

describe('ChangePasswordPage', () => {
  it('explains why the change is required', async () => {
    mockFetch(mustChange())
    renderApp('/change-password')
    expect(await screen.findByText(/cần đặt mật khẩu mới/i)).toBeInTheDocument()
  })

  it('rejects a short password without calling the server', async () => {
    const { calls } = mockFetch(mustChange())
    renderApp('/change-password')
    await fill('TempPass1234', 'short', 'short')
    expect(await screen.findByRole('alert')).toHaveTextContent('Mật khẩu mới cần ít nhất 8 ký tự.')
    expect(calls.some((c) => c.path === '/api/auth/change-password')).toBe(false)
  })

  it('rejects mismatched confirmation without calling the server', async () => {
    const { calls } = mockFetch(mustChange())
    renderApp('/change-password')
    await fill('TempPass1234', 'NewPassw0rd!', 'NewPassw0rd?')
    expect(await screen.findByRole('alert')).toHaveTextContent('Hai mật khẩu mới không khớp.')
    expect(calls.some((c) => c.path === '/api/auth/change-password')).toBe(false)
  })

  it('shows the server error for a wrong current password', async () => {
    mockFetch({
      ...mustChange(),
      'POST /api/auth/change-password': { status: 400, json: { detail: 'wrong_current_password' } },
    })
    renderApp('/change-password')
    await fill('nope', 'NewPassw0rd!', 'NewPassw0rd!')
    expect(await screen.findByRole('alert')).toHaveTextContent('Mật khẩu hiện tại không đúng.')
  })

  it('saves the new password and continues to the home page', async () => {
    let changed = false
    const { calls } = mockFetch({
      'POST /api/auth/refresh': {
        json: { access_token: 'tok-1', token_type: 'bearer', must_change_password: true },
      },
      'GET /api/auth/me': () => ({ json: makeUser({ must_change_password: !changed }) }),
      'POST /api/auth/change-password': () => {
        changed = true
        return { json: { access_token: 'tok-2', token_type: 'bearer', must_change_password: false } }
      },
    })
    renderApp('/change-password')
    await fill('TempPass1234', 'NewPassw0rd!', 'NewPassw0rd!')
    expect(await screen.findByText('Xin chào, Phạm Đức Long')).toBeInTheDocument()
    const call = calls.find((c) => c.path === '/api/auth/change-password')
    expect(call?.body).toEqual({ current_password: 'TempPass1234', new_password: 'NewPassw0rd!' })
  })

  it('lets the user log out instead', async () => {
    mockFetch({ ...mustChange(), 'POST /api/auth/logout': { status: 204 } })
    renderApp('/change-password')
    await userEvent.click(await screen.findByRole('button', { name: 'Đăng xuất' }))
    expect(await screen.findByRole('heading', { name: 'Đăng nhập' })).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `npm test -- LoginPage ChangePasswordPage`
Expected: các test lỗi vì trang còn là stub.

- [ ] **Step 3: Viết components dùng chung**

`frontend/src/components/Field.tsx`:
```tsx
import type { InputHTMLAttributes } from 'react'

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string
  id: string
}

export function Field({ label, id, className, ...input }: FieldProps) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} className={`input${className ? ` ${className}` : ''}`} {...input} />
    </div>
  )
}
```

`frontend/src/components/ErrorAlert.tsx`:
```tsx
import { errorMessage } from '../lib/errors'

/** Hiển thị lỗi (đã dịch sang tiếng Việt). `message` dùng cho lỗi kiểm tra phía trình duyệt. */
export function ErrorAlert({ error, message }: { error?: unknown; message?: string }) {
  if (!error && !message) return null
  return (
    <div role="alert" className="alert-error">
      {message ?? errorMessage(error)}
    </div>
  )
}
```

- [ ] **Step 4: Viết trang Đăng nhập**

`frontend/src/pages/LoginPage.tsx`:
```tsx
import { useState, type FormEvent } from 'react'
import { Navigate } from 'react-router-dom'
import { ErrorAlert } from '../components/ErrorAlert'
import { Field } from '../components/Field'
import { useAuth } from '../lib/auth'

export function LoginPage() {
  const { status, login } = useAuth()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  if (status === 'authenticated') return <Navigate to="/" replace />

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await login(username.trim(), password)
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-shell">
      <section className="login-brand">
        <strong style={{ fontSize: 20 }}>Kết Nối</strong>
        <div>
          <h1>Mọi chi nhánh, một cuộc trò chuyện.</h1>
          <p>
            Nhắn tin nội bộ giữa các chi nhánh của công ty. Dữ liệu nằm trên máy chủ của công ty bạn.
          </p>
        </div>
        <div className="row">
          <span className="pill">Hà Nội</span>
          <span className="pill">Đà Nẵng</span>
          <span className="pill">TP.HCM</span>
        </div>
      </section>
      <section className="login-form-wrap">
        <form className="card stack login-card" onSubmit={submit}>
          <div>
            <h2>Đăng nhập</h2>
            <p className="muted" style={{ margin: '6px 0 0' }}>
              Dùng tài khoản do quản trị viên cấp.
            </p>
          </div>
          <Field
            id="username"
            label="Tên đăng nhập"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
          <Field
            id="password"
            label="Mật khẩu"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <ErrorAlert error={error} />
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Đăng nhập
          </button>
          <p className="muted" style={{ margin: 0 }}>
            Quên mật khẩu hoặc chưa có tài khoản? Liên hệ quản trị viên của chi nhánh bạn.
          </p>
        </form>
      </section>
    </div>
  )
}
```

- [ ] **Step 5: Viết trang Đổi mật khẩu**

`frontend/src/pages/ChangePasswordPage.tsx`:
```tsx
import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { ErrorAlert } from '../components/ErrorAlert'
import { Field } from '../components/Field'
import { useAuth } from '../lib/auth'

export function ChangePasswordPage() {
  const { user, changePassword, logout } = useAuth()
  const navigate = useNavigate()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [validation, setValidation] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    if (next.length < 8) {
      setValidation('Mật khẩu mới cần ít nhất 8 ký tự.')
      return
    }
    if (next !== confirm) {
      setValidation('Hai mật khẩu mới không khớp.')
      return
    }
    setValidation(undefined)
    setBusy(true)
    try {
      await changePassword(current, next)
      navigate('/', { replace: true })
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="center-screen">
      <form className="card stack" style={{ width: '100%', maxWidth: 420 }} onSubmit={submit}>
        <div>
          <h2>Đổi mật khẩu</h2>
          {user?.must_change_password && (
            <p className="muted" style={{ margin: '6px 0 0' }}>
              Bạn cần đặt mật khẩu mới trước khi tiếp tục.
            </p>
          )}
        </div>
        <Field
          id="current"
          label="Mật khẩu hiện tại"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          required
        />
        <Field
          id="next"
          label="Mật khẩu mới"
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          required
        />
        <Field
          id="confirm"
          label="Nhập lại mật khẩu mới"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
        />
        <ErrorAlert error={error} message={validation} />
        <button type="submit" className="btn btn-primary" disabled={busy}>
          Lưu mật khẩu mới
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => void logout()}>
          Đăng xuất
        </button>
      </form>
    </div>
  )
}
```

- [ ] **Step 6: Chạy test và kiểm tra kiểu**

Run: `npm test && npm run typecheck`
Expected: tất cả pass.

- [ ] **Step 7: Commit**

```bash
git add -A frontend
git commit -m "feat: add login and forced password change pages" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Khung admin và trang Người dùng

**Files:**
- Replace: `frontend/src/pages/admin/AdminLayout.tsx`, `frontend/src/pages/admin/UsersPage.tsx`
- Create: `frontend/src/pages/admin/AdminLayout.test.tsx`, `frontend/src/pages/admin/UsersPage.test.tsx`

**Interfaces:**
- Consumes: `api`, `useAuth`, `Field`, `ErrorAlert`, `errorMessage`, `Role/User/Branch/UserCreated/ResetPasswordOut`, test helpers (`renderApp`, `makeUser`, `sessionRoutes`, `mockFetch`).
- Produces: `AdminLayout` (thanh điều hướng tối với liên kết "Người dùng", "Chi nhánh", "Về trò chuyện"; `aria-current="page"` cho mục đang mở; nội dung qua `<Outlet />`); `UsersPage` theo mô tả dưới.
- Truy vấn: `GET /admin/users` (+ `?q=&branch_id=&is_active=`) và `GET /admin/branches`. Khoá query `['admin','users', queryString]` và `['admin','branches']`.
- Giao diện `UsersPage`: tiêu đề `<h1>Người dùng</h1>` + dòng "N tài khoản · M đang hoạt động" (tính trên danh sách đang hiển thị); ô tìm `aria-label="Tìm người dùng"`; select `aria-label="Lọc theo chi nhánh"` và `"Lọc theo trạng thái"`; mỗi dòng: tên, `username`, tên chi nhánh, vai trò ("Quản trị viên"/"Thành viên"), huy hiệu trạng thái ("Hoạt động", "Đã khoá", "Chờ đổi mật khẩu"), nút `aria-label="Đặt lại mật khẩu của {username}"` và `aria-label="Khoá {username}"` / `"Mở khoá {username}"`; khối tạo tài khoản (`<aside>` tiêu đề "Tạo tài khoản mới", nhãn "Họ tên", "Tên đăng nhập", "Chi nhánh", "Vai trò", nút "Tạo tài khoản"); thông báo mật khẩu tạm `role="status"` có chữ "Chỉ hiển thị một lần", mật khẩu trong `<code>`, nút "Sao chép" và "Đã ghi lại".

- [ ] **Step 1: Viết test thất bại**

`frontend/src/pages/admin/AdminLayout.test.tsx`:
```tsx
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockFetch } from '../../test/mockFetch'
import { makeUser, renderApp, sessionRoutes } from '../../test/utils'

const admin = () => sessionRoutes(makeUser({ role: 'admin' }))
const emptyAdminData = {
  'GET /api/admin/users': { json: [] },
  'GET /api/admin/branches': { json: [] },
}

describe('AdminLayout', () => {
  it('redirects /admin to the users page and marks the current nav item', async () => {
    mockFetch({ ...admin(), ...emptyAdminData })
    renderApp('/admin')
    const nav = await screen.findByRole('navigation', { name: 'Quản trị' })
    expect(within(nav).getByRole('link', { name: 'Người dùng' })).toHaveAttribute('aria-current', 'page')
    expect(within(nav).getByRole('link', { name: 'Chi nhánh' })).not.toHaveAttribute('aria-current')
  })

  it('navigates between sections and back to the chat', async () => {
    mockFetch({ ...admin(), ...emptyAdminData })
    renderApp('/admin/users')
    const nav = await screen.findByRole('navigation', { name: 'Quản trị' })
    await userEvent.click(within(nav).getByRole('link', { name: 'Chi nhánh' }))
    expect(await screen.findByRole('heading', { name: 'Chi nhánh' })).toBeInTheDocument()
    await userEvent.click(within(nav).getByRole('link', { name: 'Về trò chuyện' }))
    expect(await screen.findByText('Xin chào, Phạm Đức Long')).toBeInTheDocument()
  })
})
```

`frontend/src/pages/admin/UsersPage.test.tsx`:
```tsx
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import type { Branch, User } from '../../lib/types'
import { mockFetch } from '../../test/mockFetch'
import { makeUser, renderApp, sessionRoutes } from '../../test/utils'

const branches: Branch[] = [
  { id: 1, name: 'Hà Nội', code: 'HN', address: '', user_count: 2 },
  { id: 2, name: 'Đà Nẵng', code: 'ĐN', address: '', user_count: 1 },
]
const users: User[] = [
  makeUser({ id: 1, username: 'long.pham', full_name: 'Phạm Đức Long', role: 'admin', branch_id: 1 }),
  makeUser({ id: 2, username: 'ha.le', full_name: 'Lê Thu Hà', branch_id: 2 }),
  makeUser({ id: 3, username: 'tuan.bui', full_name: 'Bùi Tuấn', branch_id: 1, is_active: false }),
  makeUser({ id: 4, username: 'nhi.hoang', full_name: 'Hoàng Lan Nhi', branch_id: 2, must_change_password: true }),
]

const base = () => ({
  ...sessionRoutes(makeUser({ id: 1, role: 'admin' })),
  'GET /api/admin/users': { json: users },
  'GET /api/admin/branches': { json: branches },
})

async function openPage() {
  renderApp('/admin/users')
  await screen.findByText('Lê Thu Hà')
  // Chờ danh sách chi nhánh tải xong: ô "Chi nhánh" của form tạo mặc định chọn chi nhánh đầu tiên.
  await waitFor(() => expect(screen.getByLabelText('Chi nhánh')).toHaveValue('1'))
}

const rowOf = (name: string) => screen.getByText(name).closest('.table-row') as HTMLElement

describe('UsersPage', () => {
  it('lists users with branch names, roles and statuses', async () => {
    mockFetch(base())
    await openPage()
    // Các chuỗi như "Đã khoá" cũng là <option> trong ô lọc, nên luôn tìm trong từng dòng.
    const row = rowOf('Lê Thu Hà')
    expect(within(row).getByText('Đà Nẵng')).toBeInTheDocument()
    expect(within(row).getByText('Thành viên')).toBeInTheDocument()
    expect(within(row).getByText('Hoạt động')).toBeInTheDocument()
    expect(within(rowOf('Bùi Tuấn')).getByText('Đã khoá')).toBeInTheDocument()
    expect(within(rowOf('Hoàng Lan Nhi')).getByText('Chờ đổi mật khẩu')).toBeInTheDocument()
    expect(within(rowOf('Phạm Đức Long')).getByText('Quản trị viên')).toBeInTheDocument()
    expect(screen.getByText('4 tài khoản · 3 đang hoạt động')).toBeInTheDocument()
  })

  it('sends the filters to the server', async () => {
    const { calls } = mockFetch(base())
    await openPage()
    await userEvent.selectOptions(screen.getByLabelText('Lọc theo chi nhánh'), '2')
    await userEvent.selectOptions(screen.getByLabelText('Lọc theo trạng thái'), 'true')
    await userEvent.type(screen.getByLabelText('Tìm người dùng'), 'ha')
    await waitFor(() => {
      const last = calls.filter((c) => c.path.startsWith('/api/admin/users?')).at(-1)
      expect(last?.path).toContain('branch_id=2')
      expect(last?.path).toContain('is_active=true')
      expect(last?.path).toContain('q=ha')
    })
  })

  it('creates a user, shows the temporary password once and resets the form', async () => {
    const created = makeUser({ id: 9, username: 'ngoc.vo', full_name: 'Võ Bảo Ngọc', branch_id: 2 })
    const { calls } = mockFetch({
      ...base(),
      'POST /api/admin/users': { status: 201, json: { ...created, temp_password: 'Kx7mQ4pRt2Aa' } },
    })
    await openPage()
    await userEvent.type(screen.getByLabelText('Họ tên'), 'Võ Bảo Ngọc')
    await userEvent.type(screen.getByLabelText('Tên đăng nhập'), 'ngoc.vo')
    await userEvent.selectOptions(screen.getByLabelText('Chi nhánh'), '2')
    await userEvent.click(screen.getByRole('button', { name: 'Tạo tài khoản' }))

    const status = await screen.findByRole('status')
    expect(within(status).getByText('Kx7mQ4pRt2Aa')).toBeInTheDocument()
    expect(status).toHaveTextContent('Chỉ hiển thị một lần')
    const post = calls.find((c) => c.method === 'POST' && c.path === '/api/admin/users')
    expect(post?.body).toEqual({ full_name: 'Võ Bảo Ngọc', username: 'ngoc.vo', branch_id: 2, role: 'member' })
    expect(screen.getByLabelText('Họ tên')).toHaveValue('')
    expect(screen.getByLabelText('Tên đăng nhập')).toHaveValue('')
  })

  it('removes the temporary password from the page when dismissed', async () => {
    mockFetch({
      ...base(),
      'POST /api/admin/users': {
        status: 201,
        json: { ...makeUser({ id: 9, username: 'ngoc.vo' }), temp_password: 'Kx7mQ4pRt2Aa' },
      },
    })
    await openPage()
    await userEvent.type(screen.getByLabelText('Họ tên'), 'Võ Bảo Ngọc')
    await userEvent.type(screen.getByLabelText('Tên đăng nhập'), 'ngoc.vo')
    await userEvent.click(screen.getByRole('button', { name: 'Tạo tài khoản' }))
    await screen.findByText('Kx7mQ4pRt2Aa')
    await userEvent.click(screen.getByRole('button', { name: 'Đã ghi lại' }))
    expect(screen.queryByText('Kx7mQ4pRt2Aa')).not.toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('shows a Vietnamese error when the username is taken', async () => {
    mockFetch({
      ...base(),
      'POST /api/admin/users': { status: 409, json: { detail: 'username_taken' } },
    })
    await openPage()
    await userEvent.type(screen.getByLabelText('Họ tên'), 'Ai Đó')
    await userEvent.type(screen.getByLabelText('Tên đăng nhập'), 'ha.le')
    await userEvent.click(screen.getByRole('button', { name: 'Tạo tài khoản' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Tên đăng nhập đã tồn tại.')
  })

  it('deactivates and reactivates a user', async () => {
    const { calls } = mockFetch({
      ...base(),
      'PATCH /api/admin/users/2': (req) => ({
        json: { ...users[1], is_active: (req.body as { is_active: boolean }).is_active },
      }),
    })
    await openPage()
    await userEvent.click(screen.getByRole('button', { name: 'Khoá ha.le' }))
    await waitFor(() => {
      const patch = calls.find((c) => c.method === 'PATCH' && c.path === '/api/admin/users/2')
      expect(patch?.body).toEqual({ is_active: false })
    })
    await userEvent.click(screen.getByRole('button', { name: 'Mở khoá tuan.bui' }))
    await waitFor(() => {
      const patch = calls.find((c) => c.method === 'PATCH' && c.path === '/api/admin/users/3')
      expect(patch?.body).toEqual({ is_active: true })
    })
  })

  it('shows the cannot_modify_self error', async () => {
    mockFetch({
      ...base(),
      'PATCH /api/admin/users/1': { status: 409, json: { detail: 'cannot_modify_self' } },
    })
    await openPage()
    await userEvent.click(screen.getByRole('button', { name: 'Khoá long.pham' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('không thể tự hạ quyền')
  })

  it('resets a password after confirmation and shows the new temporary password', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { calls } = mockFetch({
      ...base(),
      'POST /api/admin/users/2/reset-password': { json: { temp_password: 'Zz9Yy8Xx7Ww6' } },
    })
    await openPage()
    await userEvent.click(screen.getByRole('button', { name: 'Đặt lại mật khẩu của ha.le' }))
    expect(await screen.findByText('Zz9Yy8Xx7Ww6')).toBeInTheDocument()
    expect(calls.some((c) => c.path === '/api/admin/users/2/reset-password')).toBe(true)
  })

  it('does not reset the password when the admin cancels the confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const { calls } = mockFetch(base())
    await openPage()
    await userEvent.click(screen.getByRole('button', { name: 'Đặt lại mật khẩu của ha.le' }))
    expect(calls.some((c) => c.path.endsWith('/reset-password'))).toBe(false)
  })
})
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `npm test -- AdminLayout UsersPage`
Expected: các test lỗi vì còn là stub.

- [ ] **Step 3: Viết `AdminLayout.tsx`**

`frontend/src/pages/admin/AdminLayout.tsx`:
```tsx
import { NavLink, Outlet } from 'react-router-dom'

export function AdminLayout() {
  return (
    <div className="admin-shell">
      <nav className="admin-nav" aria-label="Quản trị">
        <div>
          <strong style={{ fontSize: 16 }}>Kết Nối</strong>
          <div style={{ fontSize: 12, color: '#98a2b3' }}>Quản trị</div>
        </div>
        <div className="stack" style={{ gap: 4 }}>
          <NavLink to="/admin/users">Người dùng</NavLink>
          <NavLink to="/admin/branches">Chi nhánh</NavLink>
        </div>
        <NavLink to="/" className="back" end>
          Về trò chuyện
        </NavLink>
      </nav>
      <Outlet />
    </div>
  )
}
```
(`NavLink` tự đặt `aria-current="page"` cho mục đang mở. Mục "Về trò chuyện" có `end` và không phải mục đang mở trong khu vực admin, nên không mang `aria-current`.)

- [ ] **Step 4: Viết `UsersPage.tsx`**

`frontend/src/pages/admin/UsersPage.tsx`:
```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { ErrorAlert } from '../../components/ErrorAlert'
import { Field } from '../../components/Field'
import { api } from '../../lib/api'
import type { Branch, ResetPasswordOut, Role, User, UserCreated } from '../../lib/types'

interface TempPassword {
  title: string
  password: string
}

function initials(fullName: string): string {
  const words = fullName.trim().split(/\s+/)
  return ((words[0]?.[0] ?? '') + (words.length > 1 ? (words.at(-1)?.[0] ?? '') : '')).toUpperCase()
}

function statusOf(user: User): { label: string; className: string } {
  if (!user.is_active) return { label: 'Đã khoá', className: 'badge badge-danger' }
  if (user.must_change_password) return { label: 'Chờ đổi mật khẩu', className: 'badge badge-warn' }
  return { label: 'Hoạt động', className: 'badge badge-ok' }
}

function TempPasswordNotice({ notice, onDismiss }: { notice: TempPassword; onDismiss: () => void }) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(notice.password)
    } catch {
      // trình duyệt không cho phép; người dùng vẫn chép tay được
    }
  }
  return (
    <div role="status" className="notice-ok stack" style={{ gap: 8 }}>
      <strong>{notice.title}</strong>
      <div>
        Mật khẩu tạm: <code>{notice.password}</code>
      </div>
      <div>Chỉ hiển thị một lần. Hãy chép lại và gửi cho người dùng ngay; người dùng phải đổi mật khẩu khi đăng nhập lần đầu.</div>
      <div className="row">
        <button type="button" className="btn" onClick={() => void copy()}>
          Sao chép
        </button>
        <button type="button" className="btn btn-primary" onClick={onDismiss}>
          Đã ghi lại
        </button>
      </div>
    </div>
  )
}

function CreateUserForm({ branches, onCreated }: { branches: Branch[]; onCreated: (u: UserCreated) => void }) {
  const [fullName, setFullName] = useState('')
  const [username, setUsername] = useState('')
  const [branchId, setBranchId] = useState('')
  const [role, setRole] = useState<Role>('member')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const effectiveBranch = branchId || (branches[0] ? String(branches[0].id) : '')

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const created = await api<UserCreated>('/admin/users', {
        method: 'POST',
        json: { full_name: fullName.trim(), username: username.trim(), branch_id: Number(effectiveBranch), role },
      })
      setFullName('')
      setUsername('')
      setRole('member')
      onCreated(created)
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="card stack" onSubmit={submit}>
      <div>
        <h2 style={{ fontSize: 17 }}>Tạo tài khoản mới</h2>
        <p className="muted" style={{ margin: '4px 0 0' }}>
          Người dùng phải đổi mật khẩu ở lần đăng nhập đầu.
        </p>
      </div>
      <Field id="new-full-name" label="Họ tên" value={fullName} onChange={(e) => setFullName(e.target.value)} required />
      <Field
        id="new-username"
        label="Tên đăng nhập"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        pattern="[A-Za-z0-9._\-]{3,50}"
        title="3-50 ký tự: chữ, số, dấu chấm, gạch dưới hoặc gạch ngang"
        required
      />
      <div className="field">
        <label htmlFor="new-branch">Chi nhánh</label>
        <select id="new-branch" className="input" value={effectiveBranch} onChange={(e) => setBranchId(e.target.value)} required>
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="new-role">Vai trò</label>
        <select id="new-role" className="input" value={role} onChange={(e) => setRole(e.target.value as Role)}>
          <option value="member">Thành viên</option>
          <option value="admin">Quản trị viên</option>
        </select>
      </div>
      <ErrorAlert error={error} />
      <button type="submit" className="btn btn-primary" disabled={busy || branches.length === 0}>
        Tạo tài khoản
      </button>
    </form>
  )
}

export function UsersPage() {
  const queryClient = useQueryClient()
  const [q, setQ] = useState('')
  const [branchId, setBranchId] = useState('')
  const [activeFilter, setActiveFilter] = useState('')
  const [notice, setNotice] = useState<TempPassword | null>(null)
  const [actionError, setActionError] = useState<unknown>(null)

  const params = new URLSearchParams()
  if (q.trim()) params.set('q', q.trim())
  if (branchId) params.set('branch_id', branchId)
  if (activeFilter) params.set('is_active', activeFilter)
  const queryString = params.toString()

  const users = useQuery({
    queryKey: ['admin', 'users', queryString],
    queryFn: () => api<User[]>(`/admin/users${queryString ? `?${queryString}` : ''}`),
  })
  const branches = useQuery({ queryKey: ['admin', 'branches'], queryFn: () => api<Branch[]>('/admin/branches') })

  const refreshUsers = () => queryClient.invalidateQueries({ queryKey: ['admin', 'users'] })

  const toggleActive = useMutation({
    mutationFn: (user: User) =>
      api<User>(`/admin/users/${user.id}`, { method: 'PATCH', json: { is_active: !user.is_active } }),
    onSuccess: () => {
      setActionError(null)
      void refreshUsers()
    },
    onError: setActionError,
  })

  const resetPassword = useMutation({
    mutationFn: async (user: User) => {
      const result = await api<ResetPasswordOut>(`/admin/users/${user.id}/reset-password`, { method: 'POST' })
      return { user, password: result.temp_password }
    },
    onSuccess: ({ user, password }) => {
      setActionError(null)
      setNotice({ title: `Mật khẩu tạm mới của ${user.username}`, password })
      void refreshUsers()
    },
    onError: setActionError,
  })

  const branchName = (id: number) => branches.data?.find((b) => b.id === id)?.name ?? '—'
  const list = users.data ?? []
  const activeCount = list.filter((u) => u.is_active).length

  function confirmReset(user: User) {
    if (window.confirm(`Đặt lại mật khẩu của ${user.username}? Họ sẽ bị đăng xuất khỏi mọi thiết bị.`)) {
      resetPassword.mutate(user)
    }
  }

  return (
    <>
      <main className="admin-main">
        <div className="page-head">
          <div>
            <h1>Người dùng</h1>
            <p className="muted" style={{ margin: '4px 0 0' }}>
              {list.length} tài khoản · {activeCount} đang hoạt động
            </p>
          </div>
        </div>

        {notice && <TempPasswordNotice notice={notice} onDismiss={() => setNotice(null)} />}
        <ErrorAlert error={actionError} />
        {users.isError && <ErrorAlert error={users.error} />}

        <div className="row">
          <input
            className="input grow"
            style={{ minWidth: 220 }}
            aria-label="Tìm người dùng"
            placeholder="Tìm theo tên hoặc tên đăng nhập"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <select className="input" style={{ width: 'auto' }} aria-label="Lọc theo chi nhánh" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
            <option value="">Tất cả chi nhánh</option>
            {(branches.data ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          <select className="input" style={{ width: 'auto' }} aria-label="Lọc theo trạng thái" value={activeFilter} onChange={(e) => setActiveFilter(e.target.value)}>
            <option value="">Mọi trạng thái</option>
            <option value="true">Hoạt động</option>
            <option value="false">Đã khoá</option>
          </select>
        </div>

        <div className="table-scroll">
          <div className="table-row table-head users-grid">
            <span>Họ tên</span>
            <span>Chi nhánh</span>
            <span>Vai trò</span>
            <span>Trạng thái</span>
            <span />
          </div>
          {list.map((user) => {
            const status = statusOf(user)
            return (
              <div key={user.id} className="table-row users-grid">
                <div className="row" style={{ flexWrap: 'nowrap', minWidth: 0 }}>
                  <span className="avatar" aria-hidden="true">
                    {initials(user.full_name)}
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div className="ellipsis" style={{ fontWeight: 600 }}>
                      {user.full_name}
                    </div>
                    <div className="muted ellipsis" style={{ fontSize: 12 }}>
                      {user.username}
                    </div>
                  </div>
                </div>
                <span>{branchName(user.branch_id)}</span>
                <span>{user.role === 'admin' ? 'Quản trị viên' : 'Thành viên'}</span>
                <span className={status.className} style={{ justifySelf: 'start' }}>
                  {status.label}
                </span>
                <div className="row" style={{ flexWrap: 'nowrap', gap: 4 }}>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    style={{ padding: '0 10px' }}
                    aria-label={`Đặt lại mật khẩu của ${user.username}`}
                    onClick={() => confirmReset(user)}
                  >
                    Đặt lại MK
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    style={{ padding: '0 10px' }}
                    aria-label={`${user.is_active ? 'Khoá' : 'Mở khoá'} ${user.username}`}
                    onClick={() => toggleActive.mutate(user)}
                  >
                    {user.is_active ? 'Khoá' : 'Mở khoá'}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </main>

      <aside className="admin-aside" aria-label="Tạo tài khoản">
        <CreateUserForm
          branches={branches.data ?? []}
          onCreated={(created) => {
            setNotice({ title: `Đã tạo tài khoản ${created.username}`, password: created.temp_password })
            void refreshUsers()
            void queryClient.invalidateQueries({ queryKey: ['admin', 'branches'] })
          }}
        />
      </aside>
    </>
  )
}
```

- [ ] **Step 5: Chạy test và kiểm tra kiểu**

Run: `npm test && npm run typecheck`
Expected: tất cả pass. Nếu một test tìm theo tên truy cập (`name`) lệch do khoảng trắng hay thứ tự nhãn, sửa mã cho đúng nghĩa trong mô tả Interfaces của task chứ không sửa test.

- [ ] **Step 6: Commit**

```bash
git add -A frontend
git commit -m "feat: add admin layout and users management page" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Trang Chi nhánh

**Files:**
- Replace: `frontend/src/pages/admin/BranchesPage.tsx`
- Create: `frontend/src/pages/admin/BranchesPage.test.tsx`

**Interfaces:**
- Consumes: `api`, `Field`, `ErrorAlert`, `Branch`, test helpers.
- Produces: `BranchesPage`: tiêu đề `<h1>Chi nhánh</h1>`; nút "Thêm chi nhánh" (mở khung tạo); lưới thẻ mỗi chi nhánh gồm tên, mã, địa chỉ, "N người dùng" và nút `aria-label="Sửa {tên}"`; khung bên phải (`<aside>`) là form dùng cho cả tạo ("Thêm chi nhánh") và sửa ("Sửa chi nhánh") với nhãn "Tên chi nhánh", "Mã chi nhánh", "Địa chỉ", nút "Lưu thay đổi" (sửa) / "Tạo chi nhánh" (tạo), nút "Huỷ", và khi sửa có nút "Xoá chi nhánh" (hỏi `window.confirm`). Khoá query `['admin','branches']`.

- [ ] **Step 1: Viết test thất bại**

`frontend/src/pages/admin/BranchesPage.test.tsx`:
```tsx
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import type { Branch } from '../../lib/types'
import { mockFetch } from '../../test/mockFetch'
import { makeUser, renderApp, sessionRoutes } from '../../test/utils'

const branches: Branch[] = [
  { id: 1, name: 'Hà Nội', code: 'HN', address: 'Cầu Giấy', user_count: 18 },
  { id: 2, name: 'Đà Nẵng', code: 'ĐN', address: 'Hải Châu', user_count: 14 },
]

const base = () => ({
  ...sessionRoutes(makeUser({ role: 'admin' })),
  'GET /api/admin/branches': { json: branches },
})

async function openPage() {
  renderApp('/admin/branches')
  await screen.findByText('Đà Nẵng')
}

describe('BranchesPage', () => {
  it('lists branches with user counts', async () => {
    mockFetch(base())
    await openPage()
    const card = screen.getByText('Đà Nẵng').closest('.card') as HTMLElement
    expect(within(card).getByText('ĐN')).toBeInTheDocument()
    expect(within(card).getByText('Hải Châu')).toBeInTheDocument()
    expect(within(card).getByText('14 người dùng')).toBeInTheDocument()
  })

  it('creates a branch', async () => {
    const { calls } = mockFetch({
      ...base(),
      'POST /api/admin/branches': {
        status: 201,
        json: { id: 3, name: 'TP.HCM', code: 'HCM', address: 'Quận 7', user_count: 0 },
      },
    })
    await openPage()
    await userEvent.click(screen.getByRole('button', { name: 'Thêm chi nhánh' }))
    await userEvent.type(screen.getByLabelText('Tên chi nhánh'), 'TP.HCM')
    await userEvent.type(screen.getByLabelText('Mã chi nhánh'), 'HCM')
    await userEvent.type(screen.getByLabelText('Địa chỉ'), 'Quận 7')
    await userEvent.click(screen.getByRole('button', { name: 'Tạo chi nhánh' }))
    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST' && c.path === '/api/admin/branches')
      expect(post?.body).toEqual({ name: 'TP.HCM', code: 'HCM', address: 'Quận 7' })
    })
  })

  it('edits a branch', async () => {
    const { calls } = mockFetch({
      ...base(),
      'PATCH /api/admin/branches/2': { json: { ...branches[1], address: 'Sơn Trà' } },
    })
    await openPage()
    await userEvent.click(screen.getByRole('button', { name: 'Sửa Đà Nẵng' }))
    const address = screen.getByLabelText('Địa chỉ')
    expect(address).toHaveValue('Hải Châu')
    await userEvent.clear(address)
    await userEvent.type(address, 'Sơn Trà')
    await userEvent.click(screen.getByRole('button', { name: 'Lưu thay đổi' }))
    await waitFor(() => {
      const patch = calls.find((c) => c.method === 'PATCH' && c.path === '/api/admin/branches/2')
      expect(patch?.body).toEqual({ name: 'Đà Nẵng', code: 'ĐN', address: 'Sơn Trà' })
    })
  })

  it('shows a Vietnamese error for a duplicate name or code', async () => {
    mockFetch({
      ...base(),
      'POST /api/admin/branches': { status: 409, json: { detail: 'branch_exists' } },
    })
    await openPage()
    await userEvent.click(screen.getByRole('button', { name: 'Thêm chi nhánh' }))
    await userEvent.type(screen.getByLabelText('Tên chi nhánh'), 'Hà Nội')
    await userEvent.type(screen.getByLabelText('Mã chi nhánh'), 'HN')
    await userEvent.click(screen.getByRole('button', { name: 'Tạo chi nhánh' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Tên hoặc mã chi nhánh đã tồn tại.')
  })

  it('explains why a branch that still has users cannot be deleted', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    mockFetch({
      ...base(),
      'DELETE /api/admin/branches/1': { status: 409, json: { detail: 'branch_has_users' } },
    })
    await openPage()
    await userEvent.click(screen.getByRole('button', { name: 'Sửa Hà Nội' }))
    await userEvent.click(screen.getByRole('button', { name: 'Xoá chi nhánh' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Chi nhánh còn người dùng')
  })

  it('deletes an empty branch after confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { calls } = mockFetch({
      ...base(),
      'DELETE /api/admin/branches/2': { status: 204 },
    })
    await openPage()
    await userEvent.click(screen.getByRole('button', { name: 'Sửa Đà Nẵng' }))
    await userEvent.click(screen.getByRole('button', { name: 'Xoá chi nhánh' }))
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/admin/branches/2')).toBe(true)
    })
  })

  it('does not delete when the admin cancels the confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const { calls } = mockFetch(base())
    await openPage()
    await userEvent.click(screen.getByRole('button', { name: 'Sửa Đà Nẵng' }))
    await userEvent.click(screen.getByRole('button', { name: 'Xoá chi nhánh' }))
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
  })
})
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `npm test -- BranchesPage`
Expected: các test lỗi vì còn là stub.

- [ ] **Step 3: Viết `BranchesPage.tsx`**

`frontend/src/pages/admin/BranchesPage.tsx`:
```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { ErrorAlert } from '../../components/ErrorAlert'
import { Field } from '../../components/Field'
import { api } from '../../lib/api'
import type { Branch } from '../../lib/types'

type Editing = Branch | 'new' | null

function BranchForm({ branch, onDone }: { branch: Branch | null; onDone: () => void }) {
  const queryClient = useQueryClient()
  const [name, setName] = useState(branch?.name ?? '')
  const [code, setCode] = useState(branch?.code ?? '')
  const [address, setAddress] = useState(branch?.address ?? '')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  async function run(action: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      await action()
      await queryClient.invalidateQueries({ queryKey: ['admin', 'branches'] })
      onDone()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    const json = { name: name.trim(), code: code.trim(), address: address.trim() }
    void run(() =>
      branch
        ? api<Branch>(`/admin/branches/${branch.id}`, { method: 'PATCH', json })
        : api<Branch>('/admin/branches', { method: 'POST', json }),
    )
  }

  function remove() {
    if (!branch) return
    if (window.confirm(`Xoá chi nhánh ${branch.name}? Thao tác này không thể hoàn tác.`)) {
      void run(() => api(`/admin/branches/${branch.id}`, { method: 'DELETE' }))
    }
  }

  return (
    <form className="card stack" onSubmit={submit}>
      <div>
        <h2 style={{ fontSize: 17 }}>{branch ? 'Sửa chi nhánh' : 'Thêm chi nhánh'}</h2>
        {branch && (
          <p className="muted" style={{ margin: '4px 0 0' }}>
            {branch.name} · {branch.user_count} người dùng
          </p>
        )}
      </div>
      <Field id="branch-name" label="Tên chi nhánh" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required />
      <Field id="branch-code" label="Mã chi nhánh" value={code} onChange={(e) => setCode(e.target.value)} maxLength={10} required />
      <Field id="branch-address" label="Địa chỉ" value={address} onChange={(e) => setAddress(e.target.value)} maxLength={200} />
      <ErrorAlert error={error} />
      <div className="row">
        <button type="button" className="btn grow" onClick={onDone}>
          Huỷ
        </button>
        <button type="submit" className="btn btn-primary grow" disabled={busy}>
          {branch ? 'Lưu thay đổi' : 'Tạo chi nhánh'}
        </button>
      </div>
      {branch && (
        <button type="button" className="btn btn-danger" onClick={remove} disabled={busy}>
          Xoá chi nhánh
        </button>
      )}
    </form>
  )
}

export function BranchesPage() {
  const [editing, setEditing] = useState<Editing>(null)
  const branches = useQuery({ queryKey: ['admin', 'branches'], queryFn: () => api<Branch[]>('/admin/branches') })
  const list = branches.data ?? []

  return (
    <>
      <main className="admin-main">
        <div className="page-head">
          <div>
            <h1>Chi nhánh</h1>
            <p className="muted" style={{ margin: '4px 0 0' }}>
              Mỗi người dùng thuộc một chi nhánh.
            </p>
          </div>
          <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>
            Thêm chi nhánh
          </button>
        </div>
        {branches.isError && <ErrorAlert error={branches.error} />}
        <div className="cards-grid">
          {list.map((b) => (
            <div key={b.id} className="card stack" style={{ gap: 12, padding: 18 }}>
              <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'nowrap' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 16, fontWeight: 700 }}>{b.name}</div>
                  <div className="muted ellipsis" style={{ fontSize: 12 }}>
                    {b.address}
                  </div>
                </div>
                <span className="badge">{b.code}</span>
              </div>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="muted">{b.user_count} người dùng</span>
                <button
                  type="button"
                  className="btn btn-ghost"
                  aria-label={`Sửa ${b.name}`}
                  onClick={() => setEditing(b)}
                >
                  Sửa
                </button>
              </div>
            </div>
          ))}
        </div>
      </main>
      {editing && (
        <aside className="admin-aside" aria-label="Biểu mẫu chi nhánh">
          <BranchForm
            key={editing === 'new' ? 'new' : editing.id}
            branch={editing === 'new' ? null : editing}
            onDone={() => setEditing(null)}
          />
        </aside>
      )}
    </>
  )
}
```

- [ ] **Step 4: Chạy test và kiểm tra kiểu**

Run: `npm test && npm run typecheck`
Expected: tất cả pass.

- [ ] **Step 5: Commit**

```bash
git add -A frontend
git commit -m "feat: add branches management page" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Đóng gói vào Docker/Caddy, README và kiểm tra thật

**Files:**
- Create: `frontend/Dockerfile`, `frontend/Dockerfile.dockerignore`
- Modify: `Caddyfile`, `docker-compose.yml` (dịch vụ `caddy`), `README.md`

**Interfaces:**
- Consumes: bản build `frontend/dist` từ `npm run build`; `Caddyfile` đang mount từ gốc dự án.
- Produces: image caddy chứa bản build ở `/srv`; Caddy phục vụ SPA (mọi đường dẫn không phải `/api/*` và không phải file tĩnh trả `index.html`); `/api/*` vẫn proxy sang `api:8000`.

- [ ] **Step 1: Viết Dockerfile frontend**

`frontend/Dockerfile`:
```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM caddy:2.8-alpine
COPY --from=build /app/dist /srv
```

`frontend/Dockerfile.dockerignore`:
```
node_modules
dist
```

- [ ] **Step 2: Cập nhật Caddyfile**

Thay toàn bộ `Caddyfile`:
```
:80 {
	encode gzip
	handle /api/* {
		reverse_proxy api:8000
	}
	handle {
		root * /srv
		try_files {path} /index.html
		file_server
	}
}
```

- [ ] **Step 3: Cập nhật dịch vụ `caddy` trong `docker-compose.yml`**

Trong dịch vụ `caddy`, thay dòng `image: caddy:2.8-alpine` bằng hai dòng sau (image giờ do dự án tự build từ `frontend/Dockerfile`, đóng bản build vào `/srv`), giữ nguyên mọi dòng khác (`restart`, `logging`, `ports`, volume `Caddyfile`, `depends_on`, `healthcheck`):
```yaml
    build: ./frontend
    image: ket-noi-web:local
```
Chạy `docker compose config -q` để chắc chắn tệp hợp lệ.

- [ ] **Step 4: Cập nhật README**

Thêm vào `README.md` (sau mục "Chạy lần đầu") mục:
````markdown
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
````

- [ ] **Step 5: Kiểm tra toàn bộ stack bằng Docker**

Run (từ thư mục gốc dự án; dùng `.env` tạm có JWT_SECRET thật, giống cách đã làm ở Plan 1):
```bash
cp .env .env.bak 2>/dev/null || true
cat .env.example | sed "s/^JWT_SECRET=.*/JWT_SECRET=$(openssl rand -hex 32)/" > .env
docker compose up -d --build
sleep 40
docker compose ps
curl -s -o /dev/null -w "root:%{http_code}\n" http://localhost/
curl -s -o /dev/null -w "spa-fallback:%{http_code}\n" http://localhost/admin/users
curl -s http://localhost/ | grep -c '<div id="root">'
curl -s http://localhost/api/health
```
Expected: 4 container `healthy`/`running`; `root:200`; `spa-fallback:200` (trả `index.html`); số dòng chứa `<div id="root">` là 1; `{"status":"ok"}`.

Run:
```bash
docker compose exec api python -m app.cli create-admin --username demo.admin --full-name "Demo Admin" --branch-name "Hà Nội" --branch-code HN
```
Expected: in mật khẩu tạm. Ghi lại làm `TEMP`.

Run:
```bash
curl -s -X POST http://localhost/api/auth/login -H "Content-Type: application/json" -d '{"username":"demo.admin","password":"TEMP"}'
```
Expected: JSON có `"must_change_password":true`.

Mở trình duyệt thật tại `http://localhost/` và kiểm tra tay (ghi kết quả vào báo cáo, hoặc ghi rõ nếu không có trình duyệt để mở): (1) trang Đăng nhập hiện đúng bố cục, chữ tiếng Việt dùng font Be Vietnam Pro, không có yêu cầu mạng ra ngoài trong tab Network; (2) đăng nhập `demo.admin`, bị chuyển sang Đổi mật khẩu; (3) đổi mật khẩu xong vào trang chủ, thấy liên kết "Quản trị"; (4) tạo một chi nhánh và một người dùng, thấy mật khẩu tạm chỉ hiện một lần; (5) tải lại trang (F5) vẫn đăng nhập (refresh bằng cookie). 

Dọn: `docker compose down -v` (stack thử nghiệm của chính plan này), khôi phục `.env` từ `.env.bak` (`mv .env.bak .env` nếu có; nếu không có `.env.bak` thì xoá `.env` tạm).

- [ ] **Step 6: Chạy lại toàn bộ test và build frontend lần cuối**

Run: `cd frontend && npm test && npm run build`
Expected: tất cả pass, build thành công.

- [ ] **Step 7: Commit**

```bash
git add frontend Caddyfile docker-compose.yml README.md
git commit -m "feat: serve the react app through caddy and document the web ui" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage (phần thuộc Plan 2):**
- Mục 7 (React + TS + Vite, TanStack Query, route admin tách chunk): tách chunk lazy-load chưa làm. Ghi nhận: spec nói "Khu vực /admin được tách chunk (lazy-load)". Chưa có task. **Bổ sung vào Task 3 Step 5**: dùng `React.lazy` cho `AdminLayout`, `UsersPage`, `BranchesPage` trong `App.tsx` với `Suspense` và `FullPageMessage` làm fallback. Đã thêm bên dưới.
- Mục 7 (access token chỉ trong bộ nhớ, Zustand): Zustand chưa cần (YAGNI, chưa có WebSocket/presence); sẽ thêm ở Plan 3.
- Mục 9 (không render HTML thô, cookie httpOnly): không dùng `dangerouslySetInnerHTML`; cookie do backend đặt.
- Mục 11 (màu, font, vùng bấm 44px): Task 1 CSS và các trang.
- Mục 11 "Chưa có trong bản thiết kế": màn hình đổi mật khẩu bắt buộc (Task 4), trạng thái mất kết nối ở mức "Thử lại" lúc khởi động (Task 3); trạng thái rỗng của danh sách (chưa làm, chấp nhận ở plan này); bố cục điện thoại riêng (không làm).
- Mục 5/Plan 1 ghi chú: refresh nguyên tử → client thử lại một lần và tuần tự hoá bằng Web Locks (Task 2).

**Quét placeholder:** không có "TBD"/"TODO"; mọi bước mã đều có mã đầy đủ. Hai chỗ chấp nhận điều chỉnh có kiểm soát: Task 1 Step 6 (kiểu của jest-dom) và Task 5 Step 5 (tên truy cập), cả hai nêu rõ cách xử lý.

**Nhất quán kiểu và tên:** `api`, `refreshSession`, `RefreshResult`, `useAuth`, `renderApp`, `makeUser`, `sessionRoutes`, `anonymousRoutes` dùng thống nhất. Mã lỗi khớp backend (Plan 1). Query key `['admin','users', qs]` / `['admin','branches']` dùng đồng nhất; `invalidateQueries({queryKey:['admin','users']})` khớp tiền tố.

**Review Focus:** 5 dòng đều có test: token ngoài storage (`LoginPage.test` "logs in, keeps the token out of web storage"), một refresh cho nhiều 401 và retry (`api.test`), mất mạng không đăng xuất (`api.test` + `routes.test` "retry screen"), guard `must_change_password`/không phải admin (`routes.test`), mật khẩu tạm biến mất (`UsersPage.test` "removes the temporary password").

**Spec mục 7 (khu vực `/admin` tách chunk lazy-load):** Task 3 Step 5 (`App.tsx`) dùng `React.lazy` + `Suspense` cho ba trang admin; các test dùng `findBy…` nên chờ được việc tải chunk.

## Các plan tiếp theo

| Plan | Nội dung |
|---|---|
| 3 | Chat lõi: bảng phòng/tin nhắn (kèm test chạy migration thật trước khi thêm `0002`), WebSocket + `MessageBus`, tải lịch sử theo cuộn, API admin phòng/nhóm, giao diện chat và trang Phòng và nhóm |
| 4 | Đã xem, đang gõ, online, reply, mention, thông báo trình duyệt |
| 5 | File đính kèm và tìm kiếm tiếng Việt |
| 6 | HTTPS nội bộ, giới hạn IP admin, sao lưu và khôi phục, thử tải, dọn `refresh_tokens` |
