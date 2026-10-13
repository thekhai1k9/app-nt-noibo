import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { vi } from 'vitest'
import { chatApi } from '../../lib/chatApi'
import { ChatContext, useRooms } from '../../lib/ChatProvider'
import { ChatController } from '../../lib/chatController'
import { ChatStore } from '../../lib/chatStore'
import type { Room, RoomMember } from '../../lib/types'
import { mockFetch, type MockHandler } from '../../test/mockFetch'
import { makeRoom } from '../../test/utils'
import { GroupPanel } from './GroupPanel'

const people = [
  { id: 3, username: 'huy', full_name: 'Trần Quốc Huy', branch_id: 2, branch_name: 'TP.HCM' },
  { id: 4, username: 'an', full_name: 'Vũ Minh An', branch_id: 1, branch_name: 'Hà Nội' },
  { id: 2, username: 'ha', full_name: 'Lê Thu Hà', branch_id: 1, branch_name: 'Hà Nội' },
]

const ownerMembers: RoomMember[] = [
  { user_id: 1, full_name: 'Phạm Đức Long', last_read_message_id: null, role: 'owner' },
  { user_id: 2, full_name: 'Lê Thu Hà', last_read_message_id: null, role: 'member' },
]

function Live({ roomId, onClose }: { roomId: number; onClose: () => void }) {
  const { rooms } = useRooms()
  const room = rooms.find((r) => r.id === roomId)
  return room ? <GroupPanel room={room} onClose={onClose} /> : <div>không còn</div>
}

function setup(room: Room, handlers: Record<string, MockHandler> = {}, members: RoomMember[] = ownerMembers) {
  const store = new ChatStore()
  store.setRooms([room])
  const controller = new ChatController({ store, api: chatApi, socket: { send: vi.fn(() => true) } as never, meId: 1, meName: 'Phạm Đức Long' })
  const onClose = vi.fn()
  const { calls } = mockFetch({
    'GET /api/users/directory': { json: people },
    [`GET /api/rooms/${room.id}/members`]: () => ({ json: members }),
    'GET /api/rooms': () => ({ json: store.getState().rooms }),
    ...handlers,
  })
  const view = render(
    <ChatContext.Provider value={{ store, controller }}>
      <MemoryRouter initialEntries={['/chat/1']}>
        <Routes>
          <Route path="/chat/:id" element={<Live roomId={room.id} onClose={onClose} />} />
          <Route path="/" element={<div>trang chủ</div>} />
        </Routes>
      </MemoryRouter>
    </ChatContext.Provider>,
  )
  return { store, controller, onClose, calls, ...view }
}

const owner = () => makeRoom({ id: 1, name: 'Dự án kho', my_role: 'owner' })

describe('GroupPanel', () => {
  afterEach(() => vi.restoreAllMocks())

  it('shows owner controls, member labels and no stray alert', async () => {
    setup(owner())
    const dialog = await screen.findByRole('dialog', { name: 'Thông tin nhóm' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(await within(dialog).findByText(/Chủ nhóm/)).toBeInTheDocument()
    expect(within(dialog).getByText(/· Bạn/)).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Lưu tên' })).toBeDisabled()
    expect(within(dialog).getByLabelText('Thêm thành viên')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Gỡ Lê Thu Hà khỏi nhóm' })).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: /Gỡ Phạm/ })).not.toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Giải tán nhóm' })).toBeDisabled()
    expect(within(dialog).getByRole('button', { name: 'Rời nhóm' })).toBeEnabled()
    expect(within(dialog).getByText(/Nhóm biến mất với mọi người ngay/)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows a plain member only the list and the leave button (also for admin-created groups)', async () => {
    setup(makeRoom({ id: 1, my_role: 'member' }), {}, [
      { user_id: 1, full_name: 'Phạm Đức Long', last_read_message_id: null, role: 'member' },
      { user_id: 2, full_name: 'Lê Thu Hà', last_read_message_id: null, role: 'member' },
    ])
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText('Lê Thu Hà')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Rời nhóm' })).toBeInTheDocument()
    expect(within(dialog).queryByLabelText('Thêm thành viên')).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: /Gỡ/ })).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Lưu tên' })).not.toBeInTheDocument()
    expect(within(dialog).queryByText('Giải tán nhóm')).not.toBeInTheDocument()
  })

  it('renders member names as plain text', async () => {
    setup(owner(), {}, [{ user_id: 2, full_name: '<b>Hà</b>', last_read_message_id: null, role: 'member' }])
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText('<b>Hà</b>')).toBeInTheDocument()
  })

  it('renames with the exact body and does not send when unchanged', async () => {
    const { calls } = setup(owner(), { 'PATCH /api/rooms/1': { json: makeRoom({ id: 1, name: 'Kho mới', my_role: 'owner' }) } })
    const dialog = await screen.findByRole('dialog')
    const input = within(dialog).getByLabelText('Tên nhóm')
    await userEvent.type(input, '{Enter}')
    expect(within(dialog).getByRole('button', { name: 'Lưu tên' })).toBeDisabled()
    await userEvent.clear(input)
    await userEvent.type(input, '  Kho mới  ')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Lưu tên' }))
    await waitFor(() => expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(1))
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ name: 'Kho mới' })
    expect(await within(dialog).findByRole('heading', { name: 'Kho mới' })).toBeInTheDocument()
  })

  it('adds a member from the directory excluding people already in the group', async () => {
    let list = ownerMembers
    const { calls } = setup(
      owner(),
      {
        'POST /api/rooms/1/members': () => {
          list = [...ownerMembers, { user_id: 3, full_name: 'Trần Quốc Huy', last_read_message_id: null, role: 'member' }]
          return { json: list }
        },
        'GET /api/rooms/1/members': () => ({ json: list }),
      },
    )
    const dialog = await screen.findByRole('dialog')
    const huy = await within(dialog).findByRole('button', { name: /Trần Quốc Huy/ })
    expect(within(dialog).getByRole('button', { name: /Vũ Minh An/ })).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: /Lê Thu Hà · / })).not.toBeInTheDocument() // đã trong nhóm
    await userEvent.click(huy)
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.path === '/api/rooms/1/members')!.body).toEqual({ user_id: 3 }))
    expect(await within(dialog).findByRole('button', { name: 'Gỡ Trần Quốc Huy khỏi nhóm' })).toBeInTheDocument()
    await waitFor(() => expect(within(dialog).queryByRole('button', { name: /Trần Quốc Huy · / })).not.toBeInTheDocument())
  })

  it('debounces the member search and ignores stale responses', async () => {
    const { calls } = setup(owner(), {
      'GET /api/users/directory': (req) => ({ json: req.path.includes('q=an') ? [people[1]] : people }),
    })
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByRole('button', { name: /Trần Quốc Huy/ })
    const before = calls.filter((c) => c.path.startsWith('/api/users/directory')).length
    await userEvent.type(within(dialog).getByLabelText('Thêm thành viên'), 'an')
    await within(dialog).findByRole('button', { name: /Vũ Minh An/ })
    await waitFor(() => expect(within(dialog).queryByRole('button', { name: /Trần Quốc Huy/ })).not.toBeInTheDocument())
    expect(calls.filter((c) => c.path.startsWith('/api/users/directory')).length - before).toBe(1)
  })

  it('asks before removing a member: cancel sends nothing, confirm sends DELETE', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    let list = ownerMembers
    const { calls } = setup(owner(), {
      'DELETE /api/rooms/1/members/2': () => ((list = [ownerMembers[0]]), { json: list }),
      'GET /api/rooms/1/members': () => ({ json: list }),
    })
    const dialog = await screen.findByRole('dialog')
    const button = await within(dialog).findByRole('button', { name: 'Gỡ Lê Thu Hà khỏi nhóm' })
    await userEvent.click(button)
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    confirm.mockReturnValue(true)
    await userEvent.click(button)
    await waitFor(() => expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1))
    await waitFor(() => expect(within(dialog).queryByRole('button', { name: 'Gỡ Lê Thu Hà khỏi nhóm' })).not.toBeInTheDocument())
  })

  it('enables dissolving only for the exact name (NFC, case-sensitive, no trim) and sends one DELETE on double click', async () => {
    const { calls, store } = setup(makeRoom({ id: 1, name: 'Dự án kho', my_role: 'owner' }), {
      'DELETE /api/rooms/1': { status: 204 },
      'GET /api/rooms': { json: [] },
    })
    const dialog = await screen.findByRole('dialog')
    const input = within(dialog).getByLabelText('Gõ tên nhóm để xác nhận giải tán')
    const button = within(dialog).getByRole('button', { name: 'Giải tán nhóm' })
    await userEvent.type(input, 'dự án kho')
    expect(button).toBeDisabled()
    await userEvent.clear(input)
    await userEvent.type(input, 'Dự án kho ')
    expect(button).toBeDisabled()
    await userEvent.clear(input)
    await userEvent.clear(input)
    await userEvent.type(input, 'Dự án kho'.normalize('NFD')) // dạng NFD vẫn khớp sau khi chuẩn hoá
    expect(button).toBeEnabled()
    await userEvent.dblClick(button)
    await waitFor(() => expect(screen.getByText('trang chủ')).toBeInTheDocument())
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1)
    expect(store.getState().rooms).toHaveLength(0)
  })

  it('asks a different leave confirmation for the owner, then leaves and goes home', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const { calls } = setup(owner(), { 'POST /api/rooms/1/leave': { status: 204 }, 'GET /api/rooms': { json: [] } })
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Rời nhóm' }))
    expect(confirm.mock.calls[0][0]).toMatch(/quyền chủ nhóm sẽ chuyển cho người vào nhóm sớm nhất/)
    expect(confirm.mock.calls[0][0]).toMatch(/lưu trữ/)
    expect(calls.some((c) => c.path === '/api/rooms/1/leave')).toBe(false)
    confirm.mockReturnValue(true)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Rời nhóm' }))
    await waitFor(() => expect(screen.getByText('trang chủ')).toBeInTheDocument())
    expect(calls.filter((c) => c.path === '/api/rooms/1/leave')).toHaveLength(1)
  })

  it('uses a plain confirmation for ordinary members', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    setup(makeRoom({ id: 1, my_role: 'member' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Rời nhóm' }))
    expect(confirm.mock.calls[0][0]).not.toMatch(/quyền chủ nhóm/)
  })

  it.each([
    ['PATCH /api/rooms/1', 403, 'forbidden', 'Bạn không có quyền thực hiện thao tác này.'],
    ['POST /api/rooms/1/members', 409, 'group_full', 'Nhóm đã đủ số thành viên tối đa.'],
  ])('shows a Vietnamese error for %s and stays open', async (key, status, code, text) => {
    const { onClose } = setup(owner(), { [key]: { status, json: { detail: code } } })
    const dialog = await screen.findByRole('dialog')
    if (key.startsWith('PATCH')) {
      await userEvent.type(within(dialog).getByLabelText('Tên nhóm'), 'x')
      await userEvent.click(within(dialog).getByRole('button', { name: 'Lưu tên' }))
    } else {
      await userEvent.click(await within(dialog).findByRole('button', { name: /Trần Quốc Huy/ }))
    }
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(text)
    expect(onClose).not.toHaveBeenCalled()
    expect(within(dialog).getByRole('button', { name: 'Rời nhóm' })).toBeEnabled()
  })

  it('updates the controls at once when ownership changes while open', async () => {
    const { store } = setup(makeRoom({ id: 1, my_role: 'member' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).queryByLabelText('Thêm thành viên')).not.toBeInTheDocument()
    act(() => store.upsertRoom(makeRoom({ id: 1, my_role: 'owner' })))
    expect(await within(dialog).findByLabelText('Thêm thành viên')).toBeInTheDocument()
    act(() => store.upsertRoom(makeRoom({ id: 1, my_role: 'member' })))
    await waitFor(() => expect(within(dialog).queryByLabelText('Thêm thành viên')).not.toBeInTheDocument())
  })

  it('closes with Escape and Đóng', async () => {
    const { onClose } = setup(owner())
    const dialog = await screen.findByRole('dialog')
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Đóng' }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
