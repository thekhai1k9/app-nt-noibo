import { QueryClient } from '@tanstack/react-query'
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
      'PATCH /api/admin/users/3': { json: { ...users[2], is_active: true } },
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
    // Sau mỗi lần đổi trạng thái danh sách được tải lại (1 lần đầu + 2 lần sau PATCH).
    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'GET' && c.path === '/api/admin/users').length).toBeGreaterThanOrEqual(3),
    )
  })

  it('disables reset and lock on the signed-in admin own row', async () => {
    mockFetch(base())
    await openPage()
    const reset = screen.getByRole('button', { name: 'Đặt lại mật khẩu của long.pham' })
    const lock = screen.getByRole('button', { name: 'Khoá long.pham' })
    expect(reset).toBeDisabled()
    expect(reset).toHaveAttribute('title', 'Dùng trang Đổi mật khẩu của bạn')
    expect(lock).toBeDisabled()
    expect(lock).toHaveAttribute('title', 'Bạn không thể tự khoá tài khoản của mình')
    expect(screen.getByRole('button', { name: 'Khoá ha.le' })).toBeEnabled()
  })

  it('edits the branch and role of a user, sending only the changed fields', async () => {
    const { calls } = mockFetch({
      ...base(),
      'PATCH /api/admin/users/2': { json: { ...users[1], branch_id: 1, role: 'admin' } },
    })
    await openPage()
    await userEvent.click(screen.getByRole('button', { name: 'Sửa ha.le' }))
    expect(screen.getByRole('heading', { name: 'Sửa tài khoản' })).toBeInTheDocument()
    expect(screen.getByText('ha.le', { selector: 'aside *' })).toBeInTheDocument()
    expect(screen.getByLabelText('Họ tên')).toHaveValue('Lê Thu Hà')
    expect(screen.getByLabelText('Chi nhánh')).toHaveValue('2')
    await userEvent.selectOptions(screen.getByLabelText('Chi nhánh'), '1')
    await userEvent.selectOptions(screen.getByLabelText('Vai trò'), 'admin')
    const branchGets = () => calls.filter((c) => c.method === 'GET' && c.path === '/api/admin/branches').length
    const before = branchGets()
    await userEvent.click(screen.getByRole('button', { name: 'Lưu thay đổi' }))
    await waitFor(() => {
      const patch = calls.find((c) => c.method === 'PATCH' && c.path === '/api/admin/users/2')
      expect(patch?.body).toEqual({ branch_id: 1, role: 'admin' })
    })
    // Quay lại form tạo và tải lại số liệu chi nhánh.
    expect(await screen.findByRole('heading', { name: 'Tạo tài khoản mới' })).toBeInTheDocument()
    await waitFor(() => expect(branchGets()).toBeGreaterThan(before))
  })

  it('shows the cannot_modify_self error when the admin demotes themselves', async () => {
    mockFetch({
      ...base(),
      'PATCH /api/admin/users/1': { status: 409, json: { detail: 'cannot_modify_self' } },
    })
    await openPage()
    await userEvent.click(screen.getByRole('button', { name: 'Sửa long.pham' }))
    await userEvent.selectOptions(screen.getByLabelText('Vai trò'), 'member')
    await userEvent.click(screen.getByRole('button', { name: 'Lưu thay đổi' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('không thể tự hạ quyền')
    expect(screen.getByRole('heading', { name: 'Sửa tài khoản' })).toBeInTheDocument()
  })

  it('returns to the create form when editing is cancelled', async () => {
    mockFetch(base())
    await openPage()
    await userEvent.click(screen.getByRole('button', { name: 'Sửa ha.le' }))
    await userEvent.click(screen.getByRole('button', { name: 'Huỷ' }))
    expect(screen.getByRole('heading', { name: 'Tạo tài khoản mới' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Sửa tài khoản' })).not.toBeInTheDocument()
  })

  it('closes the edit panel without a request when nothing changed', async () => {
    const { calls } = mockFetch(base())
    await openPage()
    await userEvent.click(screen.getByRole('button', { name: 'Sửa ha.le' }))
    await userEvent.click(screen.getByRole('button', { name: 'Lưu thay đổi' }))
    expect(screen.getByRole('heading', { name: 'Tạo tài khoản mới' })).toBeInTheDocument()
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false)
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

  it('removes the temporary password from the page when a reset notice is dismissed', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    mockFetch({
      ...base(),
      'POST /api/admin/users/2/reset-password': { json: { temp_password: 'Zz9Yy8Xx7Ww6' } },
    })
    await openPage()
    await userEvent.click(screen.getByRole('button', { name: 'Đặt lại mật khẩu của ha.le' }))
    await screen.findByText('Zz9Yy8Xx7Ww6')
    await userEvent.click(screen.getByRole('button', { name: 'Đã ghi lại' }))
    expect(screen.queryByText('Zz9Yy8Xx7Ww6')).not.toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('copies the temporary password to the clipboard', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    mockFetch({
      ...base(),
      'POST /api/admin/users/2/reset-password': { json: { temp_password: 'Zz9Yy8Xx7Ww6' } },
    })
    await openPage()
    await userEvent.click(screen.getByRole('button', { name: 'Đặt lại mật khẩu của ha.le' }))
    await screen.findByText('Zz9Yy8Xx7Ww6')
    await userEvent.click(screen.getByRole('button', { name: 'Sao chép' }))
    expect(writeText).toHaveBeenCalledWith('Zz9Yy8Xx7Ww6')
  })

  it('blocks creating and resetting while a temporary password is showing', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    mockFetch({
      ...base(),
      'POST /api/admin/users/2/reset-password': { json: { temp_password: 'Zz9Yy8Xx7Ww6' } },
    })
    await openPage()
    await userEvent.click(screen.getByRole('button', { name: 'Đặt lại mật khẩu của ha.le' }))
    await screen.findByText('Zz9Yy8Xx7Ww6')
    expect(screen.getByRole('button', { name: 'Tạo tài khoản' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Đặt lại mật khẩu của ha.le' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Đặt lại mật khẩu của tuan.bui' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Khoá ha.le' })).toBeEnabled()
    await userEvent.click(screen.getByRole('button', { name: 'Đã ghi lại' }))
    expect(screen.getByRole('button', { name: 'Tạo tài khoản' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Đặt lại mật khẩu của ha.le' })).toBeEnabled()
  })

  it('never keeps the temporary password in the TanStack caches', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const secret = 'Zz9Yy8Xx7Ww6'
    mockFetch({
      ...base(),
      'POST /api/admin/users/2/reset-password': { json: { temp_password: secret } },
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const cacheHolds = () =>
      JSON.stringify([
        ...client.getMutationCache().getAll().map((m) => ({ data: m.state.data, variables: m.state.variables })),
        ...client.getQueryCache().getAll().map((q) => q.state.data),
      ]).includes(secret)
    const { unmount } = renderApp('/admin/users', client)
    await screen.findByText('Lê Thu Hà')
    await waitFor(() => expect(screen.getByLabelText('Chi nhánh')).toHaveValue('1'))
    await userEvent.click(screen.getByRole('button', { name: 'Đặt lại mật khẩu của ha.le' }))
    await screen.findByText(secret)
    expect(cacheHolds()).toBe(false)
    await userEvent.click(screen.getByRole('button', { name: 'Đã ghi lại' }))
    expect(cacheHolds()).toBe(false)
    unmount()
    expect(cacheHolds()).toBe(false)
  })
})
