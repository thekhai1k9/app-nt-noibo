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
