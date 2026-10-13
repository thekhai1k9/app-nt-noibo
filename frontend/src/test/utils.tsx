import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { AppRoutes } from '../App'
import { AuthProvider } from '../lib/auth'
import type { Message, Room, User } from '../lib/types'

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

export function renderApp(
  path = '/',
  client: QueryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  }),
) {
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

export function makeRoom(overrides: Partial<Room> = {}): Room {
  return {
    id: 1, type: 'group', name: 'Dự án kho', branch_id: null, member_count: 3, peer_id: null,
    last_message: null, unread_count: 0, last_activity: '2026-10-15T08:00:00.000Z',
    my_role: overrides.type === 'direct' ? null : 'member', ...overrides,
  }
}

export function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 1, room_id: 1, sender_id: 2, sender_name: 'Lê Thu Hà', body: 'xin chào', kind: 'text', client_id: null,
    created_at: '2026-10-15T09:00:00.000Z', edited_at: null, deleted: false, ...overrides,
  }
}
