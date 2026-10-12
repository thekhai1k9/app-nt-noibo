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
