import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AdminRoom, AdminRoomDetail, Branch, User } from '../../lib/types'
import { formatDateTime } from '../../lib/format'
import { mockFetch, type MockRequest } from '../../test/mockFetch'
import { makeUser, renderApp, sessionRoutes } from '../../test/utils'

const branches: Branch[] = [
  { id: 1, name: 'Hà Nội', code: 'HN', address: '', user_count: 2 },
  { id: 2, name: 'Đà Nẵng', code: 'ĐN', address: '', user_count: 1 },
]
const users: User[] = [
  makeUser({ id: 1, username: 'long.pham', full_name: 'Phạm Đức Long', role: 'admin', branch_id: 1 }),
  makeUser({ id: 2, username: 'ha.le', full_name: 'Lê Thu Hà', branch_id: 2 }),
  makeUser({ id: 3, username: 'tuan.bui', full_name: 'Bùi Tuấn', branch_id: 1 }),
]
const room = (over: Partial<AdminRoom>): AdminRoom => ({
  id: 10,
  name: 'Dự án kho',
  branch_id: null,
  member_count: 2,
  created_at: '2026-10-01T08:00:00Z',
  archived_at: null,
  purge_at: null,
  ...over,
})
const khoRoom = room({})
const hnRoom = room({ id: 11, name: 'Kế toán HN', branch_id: 1, member_count: 1 })
const detailOf = (r: AdminRoom, memberIds: number[]): AdminRoomDetail => ({
  ...r,
  member_count: memberIds.length,
  members: users
    .filter((u) => memberIds.includes(u.id))
    .map((u) => ({ user_id: u.id, full_name: u.full_name, username: u.username, branch_id: u.branch_id })),
})
const purgeAt = '2026-10-18T09:05:00Z'
const archivedRoom = room({ id: 12, name: 'Nhóm cũ', archived_at: '2026-10-15T09:05:00Z', purge_at: purgeAt })

const base = () => ({
  ...sessionRoutes(makeUser({ id: 1, role: 'admin' })),
  'GET /api/admin/branches': { json: branches },
  'GET /api/admin/users': { json: users },
  'GET /api/admin/rooms': { json: [khoRoom, hnRoom] },
})

async function openPage() {
  renderApp('/admin/rooms')
  await screen.findByText('Kế toán HN')
}

const rowOf = (name: string) => screen.getByText(name).closest('.table-row') as HTMLElement
const find = (calls: MockRequest[], method: string, path: string) =>
  calls.find((c) => c.method === method && c.path === path)

describe('RoomsPage', () => {
  it('lists groups with scope, member count and the privacy note', async () => {
    mockFetch(base())
    await openPage()
    expect(screen.getByRole('heading', { name: 'Phòng và nhóm' })).toBeInTheDocument()
    expect(screen.getByText(/Quản trị viên không xem được nội dung tin nhắn/)).toBeInTheDocument()
    const kho = within(rowOf('Dự án kho'))
    expect(kho.getByText('Liên chi nhánh')).toBeInTheDocument()
    expect(kho.getByText('2')).toBeInTheDocument()
    const hn = within(rowOf('Kế toán HN'))
    expect(hn.getByText('Hà Nội')).toBeInTheDocument()
    expect(hn.getByText('1')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Tạo nhóm mới' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('sends the filters to the server', async () => {
    const { calls } = mockFetch(base())
    await openPage()
    await userEvent.selectOptions(screen.getByLabelText('Lọc theo chi nhánh'), '1')
    await userEvent.type(screen.getByLabelText('Tìm nhóm'), 'kế')
    await waitFor(() => {
      const paths = calls.filter((c) => c.path.startsWith('/api/admin/rooms?')).map((c) => c.path)
      expect(paths).toContain('/api/admin/rooms?q=k%E1%BA%BF&branch_id=1')
    })
  })

  it('creates a group with the chosen branch and members, then resets the form', async () => {
    const { calls } = mockFetch({
      ...base(),
      'POST /api/admin/rooms': { status: 201, json: detailOf(room({ id: 20, name: 'Kho mới', branch_id: 2 }), [2, 3]) },
    })
    await openPage()
    await screen.findByText(/Lê Thu Hà/)
    await userEvent.type(screen.getByLabelText('Tên nhóm'), '  Kho mới ')
    await userEvent.selectOptions(screen.getByLabelText('Chi nhánh'), '2')
    await userEvent.click(screen.getByRole('checkbox', { name: /Bùi Tuấn/ }))
    await userEvent.click(screen.getByRole('checkbox', { name: /Lê Thu Hà/ }))
    const before = calls.filter((c) => c.method === 'GET' && c.path === '/api/admin/rooms').length
    await userEvent.click(screen.getByRole('button', { name: 'Tạo nhóm' }))
    await waitFor(() => {
      expect(find(calls, 'POST', '/api/admin/rooms')?.body).toEqual({ name: 'Kho mới', branch_id: 2, member_ids: [2, 3] })
    })
    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'GET' && c.path === '/api/admin/rooms').length).toBeGreaterThan(before),
    )
    await waitFor(() => expect(screen.getByLabelText('Tên nhóm')).toHaveValue(''))
    expect(screen.getByLabelText('Chi nhánh')).toHaveValue('')
    expect(screen.getByRole('checkbox', { name: /Bùi Tuấn/ })).not.toBeChecked()
  })

  it('sends branch_id null for a cross-branch group', async () => {
    const { calls } = mockFetch({
      ...base(),
      'POST /api/admin/rooms': { status: 201, json: detailOf(room({ id: 21, name: 'Chung' }), []) },
    })
    await openPage()
    await userEvent.type(screen.getByLabelText('Tên nhóm'), 'Chung')
    await userEvent.click(screen.getByRole('button', { name: 'Tạo nhóm' }))
    await waitFor(() => {
      expect(find(calls, 'POST', '/api/admin/rooms')?.body).toEqual({ name: 'Chung', branch_id: null, member_ids: [] })
    })
  })

  it('filters the member checklist', async () => {
    mockFetch(base())
    await openPage()
    await screen.findByText(/Lê Thu Hà/)
    await userEvent.type(screen.getByLabelText('Lọc người dùng'), 'tuan')
    expect(screen.queryByRole('checkbox', { name: /Lê Thu Hà/ })).not.toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /Bùi Tuấn/ })).toBeInTheDocument()
  })

  it('blocks an empty name and shows a Vietnamese server error', async () => {
    const { calls } = mockFetch({
      ...base(),
      'POST /api/admin/rooms': { status: 404, json: { detail: 'user_not_found' } },
    })
    await openPage()
    const create = screen.getByRole('button', { name: 'Tạo nhóm' })
    expect(create).toBeDisabled()
    await userEvent.type(screen.getByLabelText('Tên nhóm'), '   ')
    expect(create).toBeDisabled()
    expect(find(calls, 'POST', '/api/admin/rooms')).toBeUndefined()
    await userEvent.clear(screen.getByLabelText('Tên nhóm'))
    await userEvent.type(screen.getByLabelText('Tên nhóm'), 'Nhóm lỗi')
    await userEvent.click(create)
    expect(await screen.findByRole('alert')).toHaveTextContent('Không tìm thấy người dùng.')
  })

  it('manages a group: rename, remove a member, add a member', async () => {
    let members = [2, 3]
    let name = 'Dự án kho'
    const { calls } = mockFetch({
      ...base(),
      'GET /api/admin/rooms': () => ({ json: [room({ name, member_count: members.length }), hnRoom] }),
      'GET /api/admin/rooms/10': () => ({ json: detailOf(room({ name }), members) }),
      'PATCH /api/admin/rooms/10': (req) => {
        name = (req.body as { name: string }).name
        return { json: detailOf(room({ name }), members) }
      },
      'DELETE /api/admin/rooms/10/members/3': () => {
        members = [2]
        return { json: detailOf(room({ name }), members) }
      },
      'POST /api/admin/rooms/10/members': () => {
        members = [2, 1]
        return { json: detailOf(room({ name }), members) }
      },
    })
    await openPage()
    await userEvent.click(screen.getByRole('button', { name: 'Quản lý Dự án kho' }))
    expect(await screen.findByRole('button', { name: 'Gỡ tuan.bui khỏi nhóm' })).toBeInTheDocument()
    expect(screen.getByText('Lê Thu Hà')).toBeInTheDocument()
    // Ô thêm chỉ liệt kê người chưa ở trong nhóm.
    const add = screen.getByLabelText('Thêm thành viên')
    expect(within(add).queryByRole('option', { name: /Lê Thu Hà/ })).not.toBeInTheDocument()

    const nameField = screen.getByLabelText('Tên nhóm')
    await userEvent.clear(nameField)
    await userEvent.type(nameField, 'Kho vận')
    await userEvent.click(screen.getByRole('button', { name: 'Lưu tên' }))
    await waitFor(() => expect(find(calls, 'PATCH', '/api/admin/rooms/10')?.body).toEqual({ name: 'Kho vận' }))
    expect(await screen.findByText('Kho vận', { selector: '.table-row span' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Gỡ tuan.bui khỏi nhóm' }))
    await waitFor(() => expect(find(calls, 'DELETE', '/api/admin/rooms/10/members/3')).toBeDefined())
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Gỡ tuan.bui khỏi nhóm' })).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Thêm' })).toBeDisabled()

    await userEvent.selectOptions(screen.getByLabelText('Thêm thành viên'), '1')
    await userEvent.click(screen.getByRole('button', { name: 'Thêm' }))
    await waitFor(() => expect(find(calls, 'POST', '/api/admin/rooms/10/members')?.body).toEqual({ user_id: 1 }))
    expect(await screen.findByRole('button', { name: 'Gỡ long.pham khỏi nhóm' })).toBeInTheDocument()
    // Mỗi thao tác tải lại danh sách nhóm.
    expect(calls.filter((c) => c.method === 'GET' && c.path === '/api/admin/rooms').length).toBeGreaterThanOrEqual(4)
  })

  it('resets the detail form when another group is selected', async () => {
    mockFetch({
      ...base(),
      'GET /api/admin/rooms/10': { json: detailOf(khoRoom, [2]) },
      'GET /api/admin/rooms/11': { json: detailOf(hnRoom, [3]) },
    })
    await openPage()
    await userEvent.click(screen.getByRole('button', { name: 'Quản lý Dự án kho' }))
    await screen.findByRole('button', { name: 'Gỡ ha.le khỏi nhóm' })
    await userEvent.type(screen.getByLabelText('Gõ tên nhóm để xác nhận'), 'Dự án')
    await userEvent.click(screen.getByRole('button', { name: 'Quản lý Kế toán HN' }))
    await screen.findByRole('button', { name: 'Gỡ tuan.bui khỏi nhóm' })
    expect(screen.getByLabelText('Gõ tên nhóm để xác nhận')).toHaveValue('')
    expect(screen.getByLabelText('Tên nhóm')).toHaveValue('Kế toán HN')
  })

  it('archives only after the exact name is typed', async () => {
    let archived = false
    const { calls } = mockFetch({
      ...base(),
      'GET /api/admin/rooms': () => ({ json: archived ? [hnRoom] : [khoRoom, hnRoom] }),
      'GET /api/admin/rooms/10': { json: detailOf(khoRoom, [2]) },
      'DELETE /api/admin/rooms/10': () => {
        archived = true
        return { status: 204 }
      },
    })
    await openPage()
    await userEvent.click(screen.getByRole('button', { name: 'Quản lý Dự án kho' }))
    const confirm = await screen.findByLabelText('Gõ tên nhóm để xác nhận')
    const archive = screen.getByRole('button', { name: 'Lưu trữ nhóm' })
    expect(screen.getByText(/Tin nhắn được giữ trong thời gian lưu trữ và có thể khôi phục/)).toBeInTheDocument()
    expect(archive).toBeDisabled()
    for (const wrong of ['dự án kho', 'Dự án kho ', ' Dự án kho', 'Dự án']) {
      await userEvent.clear(confirm)
      await userEvent.type(confirm, wrong)
      expect(archive).toBeDisabled()
    }
    expect(find(calls, 'DELETE', '/api/admin/rooms/10')).toBeUndefined()
    await userEvent.clear(confirm)
    await userEvent.type(confirm, 'Dự án kho')
    expect(archive).toBeEnabled()
    await userEvent.click(archive)
    await waitFor(() => expect(find(calls, 'DELETE', '/api/admin/rooms/10')).toBeDefined())
    expect(await screen.findByRole('heading', { name: 'Tạo nhóm mới' })).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText('Dự án kho')).not.toBeInTheDocument())
    expect(screen.getByText('Kế toán HN')).toBeInTheDocument()
  })

  it('shows archived groups with the purge date and restores one', async () => {
    let restored = false
    const { calls } = mockFetch({
      ...base(),
      'GET /api/admin/rooms': () => ({ json: restored ? [khoRoom, hnRoom, archivedRoom] : [khoRoom, hnRoom] }),
      'GET /api/admin/rooms?archived=true': () => ({ json: restored ? [] : [archivedRoom] }),
      'POST /api/admin/rooms/12/restore': () => {
        restored = true
        return { json: detailOf(room({ id: 12, name: 'Nhóm cũ' }), []) }
      },
    })
    await openPage()
    await userEvent.click(screen.getByRole('tab', { name: 'Đã lưu trữ' }))
    expect(await screen.findByText('Nhóm cũ')).toBeInTheDocument()
    expect(calls.some((c) => c.method === 'GET' && c.path === '/api/admin/rooms?archived=true')).toBe(true)
    expect(screen.getByText(`Xoá vĩnh viễn sau ${formatDateTime(purgeAt)}`)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Quản lý/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Gỡ/ })).not.toBeInTheDocument()
    expect(screen.queryByText('Dự án kho')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Khôi phục Nhóm cũ' }))
    await waitFor(() => expect(find(calls, 'POST', '/api/admin/rooms/12/restore')).toBeDefined())
    expect(await screen.findByText('Không có nhóm nào đã lưu trữ.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: 'Đang hoạt động' }))
    expect(await screen.findByText('Nhóm cũ')).toBeInTheDocument()
  })

  it('never shows the other tab rows with the wrong actions while a tab is loading', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const { fn } = mockFetch({
      ...base(),
      'GET /api/admin/rooms?archived=true': { json: [archivedRoom] },
    })
    const original = fn.getMockImplementation()!
    fn.mockImplementation(async (input, init) => {
      if (String(input).includes('archived=true')) await gate
      return original(input, init)
    })
    await openPage()
    await userEvent.click(screen.getByRole('tab', { name: 'Đã lưu trữ' }))
    expect(screen.queryByText('Dự án kho')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Quản lý/ })).not.toBeInTheDocument()
    release()
    expect(await screen.findByText('Nhóm cũ')).toBeInTheDocument()
    expect(screen.queryByText('Dự án kho')).not.toBeInTheDocument()
  })

  it('requests only active users for the member lists', async () => {
    const { calls } = mockFetch(base())
    await openPage()
    expect(calls.some((c) => c.method === 'GET' && c.path === '/api/admin/users?is_active=true')).toBe(true)
  })

  it('fires a single DELETE on a double click and accepts a decomposed (NFD) typed name', async () => {
    const { calls } = mockFetch({
      ...base(),
      'GET /api/admin/rooms/10': { json: detailOf(khoRoom, [2]) },
      'DELETE /api/admin/rooms/10': { status: 204 },
    })
    await openPage()
    await userEvent.click(screen.getByRole('button', { name: 'Quản lý Dự án kho' }))
    const confirm = await screen.findByLabelText('Gõ tên nhóm để xác nhận')
    await userEvent.type(confirm, 'Dự án kho'.normalize('NFD'))
    const archive = screen.getByRole('button', { name: 'Lưu trữ nhóm' })
    expect(archive).toBeEnabled()
    await userEvent.dblClick(archive)
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Tạo nhóm mới' })).toBeInTheDocument())
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1)
  })

  it('shows an empty message when nothing is archived', async () => {
    mockFetch({ ...base(), 'GET /api/admin/rooms?archived=true': { json: [] } })
    await openPage()
    await userEvent.click(screen.getByRole('tab', { name: 'Đã lưu trữ' }))
    expect(await screen.findByText('Không có nhóm nào đã lưu trữ.')).toBeInTheDocument()
  })

  it('shows a Vietnamese error when the group no longer exists', async () => {
    mockFetch({
      ...base(),
      'GET /api/admin/rooms/10': { json: detailOf(khoRoom, [2]) },
      'PATCH /api/admin/rooms/10': { status: 404, json: { detail: 'room_not_found' } },
    })
    await openPage()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Quản lý Dự án kho' }))
    await screen.findByRole('button', { name: 'Gỡ ha.le khỏi nhóm' })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('Tên nhóm'), ' x')
    await userEvent.click(screen.getByRole('button', { name: 'Lưu tên' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Cuộc trò chuyện không tồn tại')
  })
})
