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
