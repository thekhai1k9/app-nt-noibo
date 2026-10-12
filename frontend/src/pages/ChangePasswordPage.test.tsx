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

  it('stays on the page and shows an alert when logout cannot reach the server', async () => {
    mockFetch({
      ...mustChange(),
      'POST /api/auth/logout': () => {
        throw new Error('connection refused')
      },
    })
    renderApp('/change-password')
    await userEvent.click(await screen.findByRole('button', { name: 'Đăng xuất' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Không kết nối được máy chủ.')
    expect(screen.getByRole('heading', { name: 'Đổi mật khẩu' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Đăng nhập' })).not.toBeInTheDocument()
  })
})
