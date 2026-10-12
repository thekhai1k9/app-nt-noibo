import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { getAccessToken, refreshSession } from './lib/api'
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

  it('waits for an in-flight refresh to settle before sending the logout request', async () => {
    const { fn, calls } = mockFetch({
      ...sessionRoutes(makeUser()),
      'POST /api/auth/logout': { status: 204 },
    })
    const delegate = fn.getMockImplementation()!
    // Giữ lần refresh thứ hai lại cho tới khi test cho phép nó hoàn tất.
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let refreshes = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const isRefresh = String(input).endsWith('/auth/refresh') && (init?.method ?? 'GET') === 'POST'
        if (isRefresh) {
          refreshes += 1
          if (refreshes === 2) await gate
        }
        return delegate(input, init)
      }),
    )

    renderApp('/')
    const logoutButton = await screen.findByRole('button', { name: 'Đăng xuất' })

    const refresh = refreshSession() // refresh thứ hai, đang treo
    await userEvent.click(logoutButton)
    await new Promise((r) => setTimeout(r, 20))
    expect(calls.map((c) => `${c.method} ${c.path}`)).not.toContain('POST /api/auth/logout')

    release()
    await refresh
    expect(await screen.findByRole('heading', { name: 'Đăng nhập' })).toBeInTheDocument()
    const order = calls.map((c) => `${c.method} ${c.path}`)
    expect(order.filter((c) => c === 'POST /api/auth/refresh')).toHaveLength(2)
    expect(order.indexOf('POST /api/auth/logout')).toBeGreaterThan(order.lastIndexOf('POST /api/auth/refresh'))
  })
})

describe('session behaviour', () => {
  const home = 'Xin chào, Phạm Đức Long'

  it('keeps the session and shows an alert when logout cannot reach the server', async () => {
    mockFetch({
      ...sessionRoutes(makeUser()),
      'POST /api/auth/logout': () => {
        throw new Error('connection refused')
      },
    })
    renderApp('/')
    await userEvent.click(await screen.findByRole('button', { name: 'Đăng xuất' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Không kết nối được máy chủ.')
    expect(screen.getByText(home)).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Đăng nhập' })).not.toBeInTheDocument()
    expect(getAccessToken()).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Đăng xuất' })).toBeEnabled()
  })

  it('keeps the session when logout gets a 5xx', async () => {
    mockFetch({
      ...sessionRoutes(makeUser()),
      'POST /api/auth/logout': { status: 503, json: { detail: 'service_unavailable' } },
    })
    renderApp('/')
    await userEvent.click(await screen.findByRole('button', { name: 'Đăng xuất' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Máy chủ tạm thời không khả dụng')
    expect(screen.getByText(home)).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Đăng nhập' })).not.toBeInTheDocument()
    expect(getAccessToken()).not.toBeNull()
  })

  it('signs out when logout is answered with 401', async () => {
    mockFetch({
      ...sessionRoutes(makeUser()),
      'POST /api/auth/logout': { status: 401, json: { detail: 'not_authenticated' } },
    })
    renderApp('/')
    await userEvent.click(await screen.findByRole('button', { name: 'Đăng xuất' }))
    expect(await screen.findByRole('heading', { name: 'Đăng nhập' })).toBeInTheDocument()
  })

  it('clears the token and the query cache after a successful logout', async () => {
    mockFetch({ ...sessionRoutes(makeUser()), 'POST /api/auth/logout': { status: 204 } })
    const client = new QueryClient()
    client.setQueryData(['secret'], { x: 1 })
    renderApp('/', client)
    await userEvent.click(await screen.findByRole('button', { name: 'Đăng xuất' }))
    expect(await screen.findByRole('heading', { name: 'Đăng nhập' })).toBeInTheDocument()
    expect(getAccessToken()).toBeNull()
    expect(client.getQueryCache().getAll()).toHaveLength(0)
  })

  it('shows the retry screen, not the login page, when /auth/me fails with 500 at startup', async () => {
    mockFetch({
      ...sessionRoutes(makeUser()),
      'GET /api/auth/me': { status: 500, json: { detail: 'boom' } },
    })
    renderApp('/')
    expect(await screen.findByRole('button', { name: 'Thử lại' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Đăng nhập' })).not.toBeInTheDocument()
  })

  it('sends an anonymous visitor on /admin/users to the login page', async () => {
    mockFetch(anonymousRoutes)
    renderApp('/admin/users')
    expect(await screen.findByRole('heading', { name: 'Đăng nhập' })).toBeInTheDocument()
  })

  it('never writes to localStorage or sessionStorage during a session', async () => {
    mockFetch(sessionRoutes(makeUser()))
    renderApp('/')
    expect(await screen.findByText(home)).toBeInTheDocument()
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })

  it('announces loading with role=status', () => {
    mockFetch({ 'POST /api/auth/refresh': () => new Promise(() => {}) as never })
    renderApp('/')
    expect(screen.getByRole('status')).toHaveTextContent('Đang tải')
  })
})
