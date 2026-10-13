import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import { FakeWebSocket } from '../test/fakeWebSocket'
import { mockFetch } from '../test/mockFetch'
import { makeMessage, makeRoom, makeUser, renderApp, sessionRoutes } from '../test/utils'

const me = makeUser({ id: 1 })
const rooms = [
  makeRoom({ id: 1, name: 'Dự án kho', unread_count: 2, last_message: makeMessage({ id: 5, body: 'báo cáo xong', sender_name: 'Lê Thu Hà', created_at: '2026-10-15T09:00:00.000Z' }), last_activity: '2026-10-15T09:00:00.000Z' }),
  makeRoom({ id: 2, type: 'direct', name: 'Trần Quốc Huy', peer_id: 3, last_message: makeMessage({ id: 9, room_id: 2, deleted: true, body: '', sender_name: 'Trần Quốc Huy' }), last_activity: '2026-10-15T08:00:00.000Z' }),
]

function membersOf(readByHa: number | null) {
  return [
    { user_id: 1, full_name: 'Phạm Đức Long', last_read_message_id: 99 },
    { user_id: 2, full_name: 'Lê Thu Hà', last_read_message_id: readByHa },
  ]
}

function routes(extra: Record<string, unknown> = {}) {
  return {
    ...sessionRoutes(me),
    'GET /api/rooms': { json: rooms },
    'GET /api/rooms/1/messages': {
      json: { items: [makeMessage({ id: 4, body: 'chào cả nhà' }), makeMessage({ id: 5, body: 'báo cáo xong' })], has_more_before: false, has_more_after: false },
    },
    'POST /api/rooms/1/read': { status: 204 },
    'GET /api/presence': { json: { online_user_ids: [] } },
    'GET /api/rooms/1/members': { json: membersOf(null) },
    'GET /api/rooms/2/members': { json: [] },
    ...extra,
  } as Parameters<typeof mockFetch>[0]
}

async function connect() {
  await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0))
  const ws = FakeWebSocket.last
  await act(async () => {
    ws.open()
    ws.receive({ type: 'ready', user_id: 1 })
  })
  return ws
}

describe('chat layout', () => {
  it('shows the room list with previews, deleted placeholders and unread badges', async () => {
    mockFetch(routes())
    renderApp('/')
    const first = await screen.findByRole('link', { name: /Dự án kho/ })
    expect(within(first).getByText('Lê Thu Hà: báo cáo xong')).toBeInTheDocument()
    expect(within(first).getByText('2')).toBeInTheDocument()
    const second = screen.getByRole('link', { name: /Trần Quốc Huy/ })
    expect(within(second).getByText('Tin nhắn đã bị xoá')).toBeInTheDocument()
    expect(screen.getByText('Xin chào, Phạm Đức Long')).toBeInTheDocument()
  })

  it('authenticates the socket with the first frame only', async () => {
    mockFetch(routes())
    renderApp('/')
    await screen.findByRole('link', { name: /Dự án kho/ })
    await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0))
    const ws = FakeWebSocket.last
    expect(ws.url).not.toContain('tok-1')
    ws.open()
    expect(ws.sentJson).toEqual([{ type: 'auth', token: 'tok-1' }])
  })

  it('opens a room, shows its messages and marks it as read', async () => {
    const { calls } = mockFetch(routes())
    renderApp('/chat/1')
    expect(await screen.findByText('chào cả nhà')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Dự án kho' })).toBeInTheDocument()
    await waitFor(() => expect(calls.some((c) => c.path === '/api/rooms/1/read' && (c.body as { message_id: number }).message_id === 5)).toBe(true))
    await waitFor(() => expect(within(screen.getByRole('link', { name: /Dự án kho/ })).queryByText('2')).not.toBeInTheDocument())
  })

  it('shows a live message from another user in the open room', async () => {
    mockFetch(routes())
    renderApp('/chat/1')
    await screen.findByText('chào cả nhà')
    const ws = await connect()
    await act(async () => ws.receive({ type: 'message', message: makeMessage({ id: 6, body: 'tin mới realtime' }) }))
    expect(await screen.findByText('tin mới realtime')).toBeInTheDocument()
  })

  it('counts a message for another room as unread', async () => {
    mockFetch(routes())
    renderApp('/chat/1')
    await screen.findByText('chào cả nhà')
    const ws = await connect()
    await act(async () => ws.receive({ type: 'message', message: makeMessage({ id: 10, room_id: 2, sender_id: 3, sender_name: 'Trần Quốc Huy', body: 'ơi' }) }))
    const item = await screen.findByRole('link', { name: /Trần Quốc Huy/ })
    await waitFor(() => expect(within(item).getByText('1')).toBeInTheDocument())
    expect(within(item).getByText('Trần Quốc Huy: ơi')).toBeInTheDocument()
  })

  it('sends a message optimistically, then reconciles it with the server echo', async () => {
    mockFetch(routes())
    renderApp('/chat/1')
    await screen.findByText('chào cả nhà')
    const ws = await connect()
    await userEvent.type(screen.getByLabelText('Nhập tin nhắn'), 'tôi gửi{Enter}')
    expect(screen.getByText('tôi gửi')).toBeInTheDocument()
    expect(screen.getByText('Đang gửi…')).toBeInTheDocument()
    const sent = ws.sentJson.find((m) => m.type === 'send')!
    expect(sent).toMatchObject({ room_id: 1, body: 'tôi gửi' })
    await act(async () =>
      ws.receive({ type: 'message', message: makeMessage({ id: 7, sender_id: 1, sender_name: 'Phạm Đức Long', body: 'tôi gửi', client_id: sent.client_id as string }) }),
    )
    await waitFor(() => expect(screen.queryByText('Đang gửi…')).not.toBeInTheDocument())
    expect(screen.getAllByText('tôi gửi')).toHaveLength(1)
  })

  it('shows a reconnecting banner when the socket drops and catches up after the next ready', async () => {
    const { calls } = mockFetch(routes())
    renderApp('/chat/1')
    await screen.findByText('chào cả nhà')
    const ws = await connect()
    expect(screen.queryByText(/Đang kết nối lại/)).not.toBeInTheDocument()
    vi.useFakeTimers({ shouldAdvanceTime: true }) // trước khi đóng để hẹn giờ backoff dùng đồng hồ giả
    await act(async () => ws.serverClose(1006))
    expect(await screen.findByText(/Đang kết nối lại/)).toBeInTheDocument()
    const catchUp = routes({
      'GET /api/rooms/1/messages': { json: { items: [makeMessage({ id: 6, body: 'tin lỡ' })], has_more_before: false, has_more_after: false } },
    })
    mockFetch(catchUp)
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1300) // backoff 1s (+ jitter) rồi kết nối lại
      })
    } finally {
      vi.useRealTimers()
    }
    const ws2 = await connect()
    expect(ws2).not.toBe(ws)
    expect(await screen.findByText('tin lỡ')).toBeInTheDocument()
    void calls
  })

  it('shows a not-found message for rooms the user is not in', async () => {
    mockFetch(routes())
    renderApp('/chat/999')
    expect(await screen.findByText('Cuộc trò chuyện không tồn tại hoặc bạn không còn trong đó.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Về danh sách' })).toBeInTheDocument()
  })

  it('filters the room list by name', async () => {
    mockFetch(routes())
    renderApp('/')
    await screen.findByRole('link', { name: /Dự án kho/ })
    await userEvent.type(screen.getByLabelText('Lọc cuộc trò chuyện'), 'huy')
    expect(screen.queryByRole('link', { name: /Dự án kho/ })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Trần Quốc Huy/ })).toBeInTheDocument()
  })

  it('filters without diacritics or case and says so when nothing matches', async () => {
    mockFetch(routes())
    renderApp('/')
    await screen.findByRole('link', { name: /Dự án kho/ })
    const input = screen.getByLabelText('Lọc cuộc trò chuyện')
    await userEvent.type(input, 'DU AN')
    expect(screen.getByRole('link', { name: /Dự án kho/ })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Trần Quốc Huy/ })).not.toBeInTheDocument()
    await userEvent.clear(input)
    await userEvent.type(input, 'khoa')
    expect(screen.getByText('Không có cuộc trò chuyện nào khớp.')).toBeInTheDocument()
    await userEvent.clear(input)
    await userEvent.type(input, 'tran quoc')
    expect(screen.getByRole('link', { name: /Trần Quốc Huy/ })).toBeInTheDocument()
  })

  it('matches đ/Đ with d', async () => {
    mockFetch({ ...routes(), 'GET /api/rooms': { json: [makeRoom({ id: 7, name: 'Đức Anh' })] } } as Parameters<typeof mockFetch>[0])
    renderApp('/')
    await screen.findByRole('link', { name: /Đức Anh/ })
    await userEvent.type(screen.getByLabelText('Lọc cuộc trò chuyện'), 'duc')
    expect(screen.getByRole('link', { name: /Đức Anh/ })).toBeInTheDocument()
  })

  it('ignores Escape, Đóng and backdrop while opening a chat, then returns focus to the trigger on close', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const { fn } = mockFetch(
      routes({
        'GET /api/users/directory': { json: [{ id: 3, username: 'huy', full_name: 'Trần Quốc Huy', branch_id: 2, branch_name: 'TP.HCM' }] },
        'POST /api/rooms/direct': { status: 200, json: makeRoom({ id: 2, type: 'direct', name: 'Trần Quốc Huy', peer_id: 3 }) },
        'GET /api/rooms/2/messages': { json: { items: [], has_more_before: false, has_more_after: false } },
      }),
    )
    const original = fn.getMockImplementation()!
    fn.mockImplementation(async (input, init) => {
      if (String(input).endsWith('/rooms/direct')) await gate
      return original(input, init)
    })
    renderApp('/')
    const trigger = await screen.findByRole('button', { name: 'Cuộc trò chuyện mới' })
    await userEvent.click(trigger)
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(await within(dialog).findByRole('button', { name: /Trần Quốc Huy/ }))
    await userEvent.keyboard('{Escape}')
    await userEvent.click(document.querySelector('.dialog-backdrop') as HTMLElement)
    expect(within(dialog).getByRole('button', { name: 'Đóng' })).toBeDisabled()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    release()
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(trigger).toHaveFocus()
  })

  it('focuses the search box, keeps Tab inside the dialog and returns focus when closed', async () => {
    mockFetch(routes({ 'GET /api/users/directory': { json: [] } }))
    renderApp('/')
    const trigger = await screen.findByRole('button', { name: 'Cuộc trò chuyện mới' })
    await userEvent.click(trigger)
    const search = await screen.findByLabelText('Tìm người')
    expect(search).toHaveFocus()
    const dialog = screen.getByRole('dialog')
    for (let i = 0; i < 4; i++) {
      await userEvent.tab()
      expect(dialog.contains(document.activeElement)).toBe(true)
    }
    await userEvent.tab({ shift: true })
    expect(dialog.contains(document.activeElement)).toBe(true)
    await userEvent.keyboard('{Escape}')
    expect(trigger).toHaveFocus()
  })

  it('starts a direct chat from the directory', async () => {
    const { calls } = mockFetch(
      routes({
        'GET /api/users/directory': { json: [{ id: 3, username: 'huy', full_name: 'Trần Quốc Huy', branch_id: 2, branch_name: 'TP.HCM' }] },
        'POST /api/rooms/direct': { status: 200, json: makeRoom({ id: 2, type: 'direct', name: 'Trần Quốc Huy', peer_id: 3 }) },
        'GET /api/rooms/2/messages': { json: { items: [], has_more_before: false, has_more_after: false } },
      }),
    )
    renderApp('/')
    await userEvent.click(await screen.findByRole('button', { name: 'Cuộc trò chuyện mới' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(await within(dialog).findByRole('button', { name: /Trần Quốc Huy/ }))
    expect(await screen.findByText('Chưa có tin nhắn. Hãy gửi lời chào!')).toBeInTheDocument()
    expect(calls.find((c) => c.path === '/api/rooms/direct')?.body).toEqual({ user_id: 3 })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('closes the new-chat dialog with Escape', async () => {
    mockFetch(routes({ 'GET /api/users/directory': { json: [] } }))
    renderApp('/')
    await userEvent.click(await screen.findByRole('button', { name: 'Cuộc trò chuyện mới' }))
    await screen.findByRole('dialog')
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('searches the directory with a short delay and shows the empty result', async () => {
    const { calls } = mockFetch(routes({ 'GET /api/users/directory': { json: [] } }))
    renderApp('/')
    await userEvent.click(await screen.findByRole('button', { name: 'Cuộc trò chuyện mới' }))
    await userEvent.type(await screen.findByLabelText('Tìm người'), 'zzz')
    await waitFor(() => expect(calls.some((c) => c.path === '/api/users/directory?q=zzz')).toBe(true))
    expect(await screen.findByText('Không tìm thấy ai.')).toBeInTheDocument()
  })

  it('goes back to the login page when the socket is closed with 4403 (account locked)', async () => {
    mockFetch(routes())
    renderApp('/chat/1')
    await screen.findByText('chào cả nhà')
    const ws = await connect()
    await act(async () => ws.serverClose(4403))
    expect(await screen.findByRole('heading', { name: 'Đăng nhập' })).toBeInTheDocument()
  })

  it('keeps the greeting, admin link and logout in the sidebar footer', async () => {
    mockFetch({ ...routes(), ...sessionRoutes(makeUser({ role: 'admin' })), 'GET /api/rooms': { json: rooms } } as Parameters<typeof mockFetch>[0])
    renderApp('/')
    expect(await screen.findByRole('link', { name: 'Quản trị' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Đổi mật khẩu' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Đăng xuất' })).toBeInTheDocument()
    void vi
  })
})

describe('chat provider lifetime', () => {
  it('does not show the reconnecting banner during the very first connect', async () => {
    mockFetch(routes())
    renderApp('/chat/1')
    await screen.findByText('chào cả nhà')
    await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0))
    expect(screen.queryByText(/Đang kết nối lại/)).not.toBeInTheDocument()
  })

  it('keeps a pending message and the socket when navigating chat -> admin -> chat', async () => {
    mockFetch({ ...routes(), ...sessionRoutes(makeUser({ id: 1, role: 'admin' })) } as Parameters<typeof mockFetch>[0])
    renderApp('/chat/1')
    await screen.findByText('chào cả nhà')
    const ws = await connect()
    await userEvent.type(screen.getByLabelText('Nhập tin nhắn'), 'chờ gửi{Enter}')
    const sent = ws.sentJson.find((m) => m.type === 'send')!
    await userEvent.click(await screen.findByRole('link', { name: 'Quản trị' }))
    await userEvent.click(await screen.findByRole('link', { name: 'Về trò chuyện' }))
    await userEvent.click(await screen.findByRole('link', { name: /Dự án kho/ }))
    expect(await screen.findByText('chờ gửi')).toBeInTheDocument()
    expect(screen.getByText('Đang gửi…')).toBeInTheDocument()
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(ws.readyState).toBe(1)
    await act(async () =>
      ws.receive({ type: 'message', message: makeMessage({ id: 8, sender_id: 1, body: 'chờ gửi', client_id: sent.client_id as string }) }),
    )
    await waitFor(() => expect(screen.queryByText('Đang gửi…')).not.toBeInTheDocument())
    expect(screen.getAllByText('chờ gửi')).toHaveLength(1)
  })

  it('opens no socket while the password change is pending, and starts one afterwards', async () => {
    let changed = false
    mockFetch({
      ...routes(),
      'POST /api/auth/refresh': { json: { access_token: 'tok-1', token_type: 'bearer', must_change_password: true } },
      'GET /api/auth/me': () => ({ json: makeUser({ id: 1, must_change_password: !changed }) }),
      'POST /api/auth/change-password': () => {
        changed = true
        return { json: { access_token: 'tok-2', token_type: 'bearer', must_change_password: false } }
      },
    } as Parameters<typeof mockFetch>[0])
    renderApp('/')
    await userEvent.type(await screen.findByLabelText('Mật khẩu hiện tại'), 'TempPass1234')
    expect(FakeWebSocket.instances).toHaveLength(0)
    await userEvent.type(screen.getByLabelText('Mật khẩu mới'), 'NewPassw0rd!')
    await userEvent.type(screen.getByLabelText('Nhập lại mật khẩu mới'), 'NewPassw0rd!')
    await userEvent.click(screen.getByRole('button', { name: 'Lưu mật khẩu mới' }))
    await screen.findByRole('link', { name: /Dự án kho/ })
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1))
  })
})

describe('realtime status UI', () => {
  async function sendOwn(ws: FakeWebSocket, body: string, id: number) {
    await userEvent.type(screen.getByLabelText('Nhập tin nhắn'), `${body}{Enter}`)
    const sent = ws.sentJson.filter((m) => m.type === 'send').at(-1)!
    await act(async () =>
      ws.receive({ type: 'message', message: makeMessage({ id, sender_id: 1, sender_name: 'Phạm Đức Long', body, client_id: sent.client_id as string }) }),
    )
  }

  it('shows the seen label after a read event and moves it to the newest own message', async () => {
    mockFetch(routes())
    renderApp('/chat/1')
    await screen.findByText('chào cả nhà')
    const ws = await connect()
    await sendOwn(ws, 'tin một', 7)
    expect(screen.queryByText(/Đã xem/)).not.toBeInTheDocument()
    await act(async () => ws.receive({ type: 'read', room_id: 1, user_id: 2, message_id: 7 }))
    const label = await screen.findByText('Đã xem bởi 1 người')
    expect(label).toHaveAttribute('title', 'Lê Thu Hà')
    expect(label.closest('.msg')).toBeNull()
    await sendOwn(ws, 'tin hai', 8)
    expect(screen.queryByText(/Đã xem/)).not.toBeInTheDocument()
    await act(async () => ws.receive({ type: 'read', room_id: 1, user_id: 2, message_id: 8 }))
    expect(await screen.findAllByText('Đã xem bởi 1 người')).toHaveLength(1)
  })

  it('puts the seen label on the last delivered own message, ignoring deleted/pending/failed ones and the viewer own read', async () => {
    mockFetch(
      routes({
        'GET /api/rooms/1/messages': {
          json: {
            items: [
              makeMessage({ id: 4, sender_id: 1, sender_name: 'Phạm Đức Long', body: 'tin thật' }),
              makeMessage({ id: 5, sender_id: 1, sender_name: 'Phạm Đức Long', body: '', deleted: true }),
            ],
            has_more_before: false,
            has_more_after: false,
          },
        },
        'GET /api/rooms/1/members': { json: membersOf(4) }, // người xem (id 1) đã đọc 99 nhưng không được tính
      }),
    )
    renderApp('/chat/1')
    await screen.findByText('tin thật')
    const label = await screen.findByText('Đã xem bởi 1 người') // chỉ Hà, không tính người xem
    expect(label).toHaveAttribute('title', 'Lê Thu Hà')
    const msgOf = () => document.querySelector('.seen-row')?.previousElementSibling?.getAttribute('data-message-id')
    expect(msgOf()).toBe('4')
    const ws = await connect()
    await userEvent.type(screen.getByLabelText('Nhập tin nhắn'), 'đang gửi{Enter}')
    expect(msgOf()).toBe('4') // tin đang gửi không nhận nhãn
    const sent = ws.sentJson.filter((m) => m.type === 'send').at(-1)!
    await act(async () => ws.receive({ type: 'error', code: 'rate_limited', client_id: sent.client_id as string }))
    expect(await screen.findByText("Gửi lỗi")).toBeInTheDocument()
    expect(msgOf()).toBe('4') // tin gửi lỗi cũng không
  })

  it('shows and clears the typing line (5 s expiry, and when the typer sends a message)', async () => {
    mockFetch(routes())
    renderApp('/chat/1')
    await screen.findByText('chào cả nhà')
    const ws = await connect()
    expect(document.querySelector('.typing-indicator')!).toBeEmptyDOMElement()
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      await act(async () => ws.receive({ type: 'typing', room_id: 1, user_id: 2, user_name: 'Lê Thu Hà' }))
      expect(document.querySelector('.typing-indicator')!).toHaveTextContent('Lê Thu Hà đang soạn tin…')
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5100)
      })
      expect(document.querySelector('.typing-indicator')!).toBeEmptyDOMElement()
      await act(async () => ws.receive({ type: 'typing', room_id: 1, user_id: 2, user_name: 'Lê Thu Hà' }))
      expect(document.querySelector('.typing-indicator')!).toHaveTextContent('đang soạn tin')
      await act(async () => ws.receive({ type: 'message', message: makeMessage({ id: 8, sender_id: 2, body: 'xong' }) }))
      expect(document.querySelector('.typing-indicator')!).toBeEmptyDOMElement()
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows the presence dot in the sidebar and header of a direct room', async () => {
    mockFetch(routes({ 'GET /api/rooms/2/messages': { json: { items: [], has_more_before: false, has_more_after: false } } }))
    renderApp('/chat/2')
    const ws = await connect()
    const link = await screen.findByRole('link', { name: /Trần Quốc Huy/ })
    expect(screen.queryByLabelText('Đang hoạt động')).not.toBeInTheDocument()
    await act(async () => ws.receive({ type: 'presence', user_id: 3, online: true }))
    expect(within(link).getByLabelText('Đang hoạt động')).toBeInTheDocument()
    expect(screen.getAllByText('Đang hoạt động').length).toBeGreaterThan(0)
    expect(screen.getAllByLabelText('Đang hoạt động')).toHaveLength(1) // chấm ở tiêu đề chỉ để trang trí
    await act(async () => ws.receive({ type: 'presence', user_id: 3, online: false }))
    expect(screen.queryByLabelText('Đang hoạt động')).not.toBeInTheDocument()
    expect(screen.queryByText('Đang hoạt động')).not.toBeInTheDocument()
  })

  it('reloads presence and members after a reconnect', async () => {
    const { calls } = mockFetch(routes())
    renderApp('/chat/1')
    await screen.findByText('chào cả nhà')
    const ws = await connect()
    const count = (path: string) => calls.filter((c) => c.path === path).length
    await waitFor(() => expect(count('/api/presence')).toBeGreaterThan(0))
    const before = { p: count('/api/presence'), m: count('/api/rooms/1/members') }
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await act(async () => ws.serverClose(1006))
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1300)
      })
    } finally {
      vi.useRealTimers()
    }
    await connect()
    await waitFor(() => expect(count('/api/presence')).toBeGreaterThan(before.p))
    await waitFor(() => expect(count('/api/rooms/1/members')).toBeGreaterThan(before.m))
  })

  it('sends a typing frame once per 3 seconds while typing', async () => {
    mockFetch(routes())
    renderApp('/chat/1')
    await screen.findByText('chào cả nhà')
    const ws = await connect()
    await userEvent.type(screen.getByLabelText('Nhập tin nhắn'), 'xin chào')
    expect(ws.sentJson.filter((m) => m.type === 'typing')).toEqual([{ type: 'typing', room_id: 1 }])
  })
})

describe('replies and mentions', () => {
  const box = () => screen.getByLabelText('Nhập tin nhắn')
  const sends = (ws: FakeWebSocket) => ws.sentJson.filter((m) => m.type === 'send')

  it('replies to a message: bar, wire frame, optimistic quote, and the bar clears after sending', async () => {
    mockFetch(routes())
    renderApp('/chat/1')
    await screen.findByText('chào cả nhà')
    const ws = await connect()
    await userEvent.click(screen.getAllByRole('button', { name: 'Trả lời' })[0])
    expect(screen.getAllByRole('status').map((e) => e.textContent)).toContain('Đang trả lời Lê Thu Hà: chào cả nhà')
    await userEvent.type(box(), 'đồng ý{Enter}')
    const frame = sends(ws)[0]
    expect(frame).toMatchObject({ room_id: 1, body: 'đồng ý', reply_to_id: 4 })
    expect(screen.queryByRole('button', { name: 'Huỷ trả lời' })).not.toBeInTheDocument()
    const mine = screen.getByText('đồng ý').closest('.msg') as HTMLElement
    expect(within(mine).getByText('chào cả nhà')).toBeInTheDocument()
    expect(within(mine).getByRole('button', { name: 'Đến tin được trả lời' })).toBeInTheDocument()
  })

  it('drops the pending reply when switching rooms', async () => {
    mockFetch(routes())
    renderApp('/chat/1')
    await screen.findByText('chào cả nhà')
    await userEvent.click(screen.getAllByRole('button', { name: 'Trả lời' })[0])
    expect(screen.getByRole('button', { name: 'Huỷ trả lời' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('link', { name: /Trần Quốc Huy/ }))
    await userEvent.click(await screen.findByRole('link', { name: /Dự án kho/ }))
    await screen.findByText('chào cả nhà')
    expect(screen.queryByRole('button', { name: 'Huỷ trả lời' })).not.toBeInTheDocument()
  })

  it('picks a member from the @ suggestions and sends the mention id', async () => {
    const { calls } = mockFetch(routes())
    renderApp('/chat/1')
    await screen.findByText('chào cả nhà')
    const ws = await connect()
    await waitFor(() => expect(calls.some((c) => c.path === '/api/rooms/1/members')).toBe(true))
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    await userEvent.type(box(), '@Th')
    await screen.findByRole('listbox')
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['LHLê Thu Hà'])
    await userEvent.keyboard('{Enter}')
    expect(sends(ws)).toHaveLength(0)
    await userEvent.type(box(), 'xem giúp{Enter}')
    expect(sends(ws)[0]).toMatchObject({ body: '@Lê Thu Hà xem giúp', mentions: [2] })
    expect(sends(ws)[0]).not.toHaveProperty('mention_all')
  })

  it('sends @all as mention_all in a group', async () => {
    const { calls } = mockFetch(routes())
    renderApp('/chat/1')
    await screen.findByText('chào cả nhà')
    const ws = await connect()
    await waitFor(() => expect(calls.some((c) => c.path === '/api/rooms/1/members')).toBe(true))
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    await userEvent.type(box(), '@')
    expect((await screen.findAllByRole('option'))[0]).toHaveTextContent('@all')
    await userEvent.keyboard('{Enter}')
    await userEvent.type(box(), 'họp lúc 9h{Enter}')
    expect(sends(ws)[0]).toMatchObject({ body: '@all họp lúc 9h', mention_all: true })
    expect(sends(ws)[0]).not.toHaveProperty('mentions')
  })

  it('shows an @ badge for a mention of me in another room', async () => {
    mockFetch(routes())
    renderApp('/chat/1')
    await screen.findByText('chào cả nhà')
    const ws = await connect()
    await act(async () =>
      ws.receive({ type: 'message', message: makeMessage({ id: 10, room_id: 2, sender_id: 3, sender_name: 'Trần Quốc Huy', body: 'ê @Phạm Đức Long', mentions: [{ user_id: 1, full_name: 'Phạm Đức Long' }] }) }),
    )
    const item = await screen.findByRole('link', { name: /Trần Quốc Huy/ })
    await waitFor(() => expect(within(item).getByLabelText('1 lần được nhắc')).toBeInTheDocument())
  })

  it('turns a loaded quote into the deleted placeholder when its source is deleted', async () => {
    mockFetch(routes())
    renderApp('/chat/1')
    await screen.findByText('chào cả nhà')
    const ws = await connect()
    const quote = { id: 4, sender_id: 2, sender_name: 'Lê Thu Hà', snippet: 'chào cả nhà', deleted: false }
    await act(async () => ws.receive({ type: 'message', message: makeMessage({ id: 6, body: 'trả lời đây', reply_to: quote }) }))
    const reply = (await screen.findByText('trả lời đây')).closest('.msg') as HTMLElement
    expect(within(reply).getByText('chào cả nhà')).toBeInTheDocument()
    await act(async () => ws.receive({ type: 'message_deleted', room_id: 1, message_id: 4 }))
    await waitFor(() => expect(within(reply).getByText('Tin nhắn đã bị xoá')).toBeInTheDocument())
    expect(within(reply).queryByText('chào cả nhà')).not.toBeInTheDocument()
  })

  it('offers to resend without the reply after an invalid_reply error', async () => {
    mockFetch(routes())
    renderApp('/chat/1')
    await screen.findByText('chào cả nhà')
    const ws = await connect()
    await userEvent.click(screen.getAllByRole('button', { name: 'Trả lời' })[0])
    await userEvent.type(box(), 'đồng ý{Enter}')
    const first = sends(ws)[0]
    await act(async () => ws.receive({ type: 'error', code: 'invalid_reply', client_id: first.client_id as string }))
    expect(await screen.findByText('Không trả lời được tin này.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Gửi lại tin nhắn' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Gửi không kèm trả lời' }))
    const second = sends(ws)[1]
    expect(second).toMatchObject({ body: 'đồng ý' })
    expect(second).not.toHaveProperty('reply_to_id')
    expect(second.client_id).not.toBe(first.client_id)
    expect(screen.getAllByText('đồng ý')).toHaveLength(1)
  })
})

describe('new chat dialog: group tab', () => {
  const people = [
    { id: 3, username: 'huy', full_name: 'Trần Quốc Huy', branch_id: 2, branch_name: 'TP.HCM' },
    { id: 4, username: 'an', full_name: 'Vũ Minh An', branch_id: 1, branch_name: 'Hà Nội' },
  ]
  const directory = (req: { path: string }) => ({
    json: req.path.includes('q=an') ? [people[1]] : people,
  })

  async function openGroupTab() {
    await userEvent.click(await screen.findByRole('button', { name: 'Cuộc trò chuyện mới' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('tab', { name: 'Tạo nhóm' }))
    return dialog
  }

  it('has two tabs and switching keeps the typed group name and selection', async () => {
    mockFetch(routes({ 'GET /api/users/directory': directory }))
    renderApp('/')
    const dialog = await openGroupTab()
    expect(within(dialog).getByRole('tab', { name: 'Tạo nhóm' })).toHaveAttribute('aria-selected', 'true')
    await userEvent.type(within(dialog).getByLabelText('Tên nhóm'), 'Kho')
    await userEvent.click(await within(dialog).findByRole('checkbox', { name: /Trần Quốc Huy/ }))
    await userEvent.click(within(dialog).getByRole('tab', { name: 'Nhắn riêng' }))
    expect(within(dialog).getByLabelText('Tìm người')).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('tab', { name: 'Tạo nhóm' }))
    expect(within(dialog).getByLabelText('Tên nhóm')).toHaveValue('Kho')
    expect(within(dialog).getByRole('button', { name: 'Bỏ Trần Quốc Huy' })).toBeInTheDocument()
  })

  it('keeps the selection across searches, lets chips deselect, and creates with the exact payload', async () => {
    const { calls } = mockFetch(
      routes({
        'GET /api/users/directory': directory,
        'POST /api/rooms/group': { status: 201, json: makeRoom({ id: 2, name: 'Kho', my_role: 'owner' }) },
        'GET /api/rooms/2/messages': { json: { items: [], has_more_before: false, has_more_after: false } },
        'GET /api/rooms/2/members': { json: [] },
      }),
    )
    renderApp('/')
    const dialog = await openGroupTab()
    await userEvent.type(within(dialog).getByLabelText('Tên nhóm'), '  Kho  ')
    await userEvent.click(await within(dialog).findByRole('checkbox', { name: /Trần Quốc Huy/ }))
    await userEvent.type(within(dialog).getByLabelText('Tìm người để thêm'), 'an')
    await waitFor(() => expect(within(dialog).queryByRole('checkbox', { name: /Trần Quốc Huy/ })).not.toBeInTheDocument())
    await userEvent.click(await within(dialog).findByRole('checkbox', { name: /Vũ Minh An/ }))
    expect(within(dialog).getByRole('button', { name: 'Bỏ Trần Quốc Huy' })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Bỏ Vũ Minh An' })).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Bỏ Vũ Minh An' }))
    expect(within(dialog).queryByRole('button', { name: 'Bỏ Vũ Minh An' })).not.toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Tạo nhóm' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(calls.find((c) => c.path === '/api/rooms/group')?.body).toEqual({ name: 'Kho', member_ids: [3] })
    expect(await screen.findByText('Chưa có tin nhắn. Hãy gửi lời chào!')).toBeInTheDocument()
  })

  it('disables creation for an empty or blank name, but allows zero other members', async () => {
    const { calls } = mockFetch(
      routes({
        'GET /api/users/directory': directory,
        'POST /api/rooms/group': { status: 201, json: makeRoom({ id: 2, name: 'Solo', my_role: 'owner' }) },
        'GET /api/rooms/2/messages': { json: { items: [], has_more_before: false, has_more_after: false } },
        'GET /api/rooms/2/members': { json: [] },
      }),
    )
    renderApp('/')
    const dialog = await openGroupTab()
    const create = within(dialog).getByRole('button', { name: 'Tạo nhóm' })
    expect(create).toBeDisabled()
    await userEvent.type(within(dialog).getByLabelText('Tên nhóm'), '   ')
    expect(create).toBeDisabled()
    await userEvent.type(within(dialog).getByLabelText('Tên nhóm'), 'Solo')
    expect(create).toBeEnabled()
    await userEvent.click(create)
    await waitFor(() => expect(calls.find((c) => c.path === '/api/rooms/group')?.body).toEqual({ name: 'Solo', member_ids: [] }))
  })

  it('shows the Vietnamese too_many_groups error and stays open', async () => {
    mockFetch(
      routes({
        'GET /api/users/directory': directory,
        'POST /api/rooms/group': { status: 409, json: { detail: 'too_many_groups' } },
      }),
    )
    renderApp('/')
    const dialog = await openGroupTab()
    await userEvent.type(within(dialog).getByLabelText('Tên nhóm'), 'Kho')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Tạo nhóm' }))
    expect(await within(dialog).findByText('Bạn đang quản lý quá nhiều nhóm. Hãy giải tán bớt.')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Tạo nhóm' })).toBeEnabled()
  })

  it('ignores Escape, Đóng and backdrop while creating, and blocks double submit', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const { fn, calls } = mockFetch(
      routes({
        'GET /api/users/directory': directory,
        'POST /api/rooms/group': { status: 201, json: makeRoom({ id: 2, name: 'Kho', my_role: 'owner' }) },
        'GET /api/rooms/2/messages': { json: { items: [], has_more_before: false, has_more_after: false } },
        'GET /api/rooms/2/members': { json: [] },
      }),
    )
    const original = fn.getMockImplementation()!
    fn.mockImplementation(async (input, init) => {
      if (String(input).endsWith('/rooms/group')) await gate
      return original(input, init)
    })
    renderApp('/')
    const trigger = await screen.findByRole('button', { name: 'Cuộc trò chuyện mới' })
    const dialog = await openGroupTab()
    await userEvent.type(within(dialog).getByLabelText('Tên nhóm'), 'Kho')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Tạo nhóm' }))
    expect(within(dialog).getByRole('button', { name: /Đang tạo/ })).toBeDisabled()
    await userEvent.keyboard('{Escape}')
    await userEvent.click(document.querySelector('.dialog-backdrop') as HTMLElement)
    expect(within(dialog).getByRole('button', { name: 'Đóng' })).toBeDisabled()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    release()
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(calls.filter((c) => c.path === '/api/rooms/group')).toHaveLength(1)
    expect(trigger).toHaveFocus()
  })
})

describe('new chat dialog: group tab input rules', () => {
  const noUsers = { 'GET /api/users/directory': { json: [] } }

  async function groupDialog() {
    await userEvent.click(await screen.findByRole('button', { name: 'Cuộc trò chuyện mới' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('tab', { name: 'Tạo nhóm' }))
    return dialog
  }

  it('does not submit on Enter during IME composition, but does on a plain Enter', async () => {
    const { calls } = mockFetch(
      routes({
        ...noUsers,
        'POST /api/rooms/group': { status: 201, json: makeRoom({ id: 2, name: 'Kho', my_role: 'owner' }) },
        'GET /api/rooms/2/messages': { json: { items: [], has_more_before: false, has_more_after: false } },
        'GET /api/rooms/2/members': { json: [] },
      }),
    )
    renderApp('/')
    const dialog = await groupDialog()
    const box = within(dialog).getByLabelText('Tên nhóm')
    await userEvent.type(box, 'Kho')
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true })
    fireEvent.keyDown(box, { key: 'Enter', keyCode: 229 })
    expect(calls.some((c) => c.path === '/api/rooms/group')).toBe(false)
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(calls.some((c) => c.path === '/api/rooms/group')).toBe(true))
  })

  it('keeps Tạo nhóm disabled for names made only of invisible characters', async () => {
    mockFetch(routes(noUsers))
    renderApp('/')
    const dialog = await groupDialog()
    const create = within(dialog).getByRole('button', { name: 'Tạo nhóm' })
    fireEvent.change(within(dialog).getByLabelText('Tên nhóm'), { target: { value: '​​ \t' } })
    expect(create).toBeDisabled()
    fireEvent.change(within(dialog).getByLabelText('Tên nhóm'), { target: { value: '​A' } })
    expect(create).toBeEnabled()
  })

  it('switches tabs with the arrow keys and links tabs to the panel', async () => {
    mockFetch(routes(noUsers))
    renderApp('/')
    const dialog = await groupDialog()
    const direct = within(dialog).getByRole('tab', { name: 'Nhắn riêng' })
    expect(direct).toHaveAttribute('aria-controls', 'newchat-panel')
    expect(within(dialog).getByRole('tabpanel')).toBeInTheDocument()
    fireEvent.keyDown(within(dialog).getByRole('tab', { name: 'Tạo nhóm' }), { key: 'ArrowLeft' })
    expect(direct).toHaveAttribute('aria-selected', 'true')
    expect(direct).toHaveFocus()
  })
})

describe('group info panel', () => {
  const ownerRoom = { ...rooms[0], my_role: 'owner' as const }
  const mem = (id: number, name: string, role: 'owner' | 'member') => ({ user_id: id, full_name: name, last_read_message_id: null, role })
  const long = mem(1, 'Phạm Đức Long', 'owner')
  const ha = mem(2, 'Lê Thu Hà', 'member')
  const huy = mem(3, 'Trần Quốc Huy', 'member')
  const person = { id: 3, username: 'huy', full_name: 'Trần Quốc Huy', branch_id: 2, branch_name: 'TP.HCM' }

  it('shows the button for group rooms only', async () => {
    mockFetch(routes({ 'GET /api/rooms/2/messages': { json: { items: [], has_more_before: false, has_more_after: false } } }))
    renderApp('/chat/2')
    await screen.findByRole('heading', { name: 'Trần Quốc Huy' })
    expect(screen.queryByRole('button', { name: 'Thông tin nhóm' })).not.toBeInTheDocument()
  })

  it('opens the panel, adds a member and shows the updated list, then returns focus on close', async () => {
    let list = [long, ha]
    let current = [ownerRoom, rooms[1]]
    const { calls } = mockFetch(
      routes({
        'GET /api/rooms': () => ({ json: current }),
        'GET /api/rooms/1/members': () => ({ json: list }),
        'GET /api/users/directory': { json: [person] },
        'POST /api/rooms/1/members': () => {
          list = [long, ha, huy]
          current = [{ ...ownerRoom, member_count: 4 }, rooms[1]]
          return { json: list }
        },
      }),
    )
    renderApp('/chat/1')
    await screen.findByText('chào cả nhà')
    const opener = screen.getByRole('button', { name: 'Thông tin nhóm' })
    await userEvent.click(opener)
    const dialog = await screen.findByRole('dialog', { name: 'Thông tin nhóm' })
    await userEvent.click(await within(dialog).findByRole('button', { name: /Trần Quốc Huy/ }))
    expect(await within(dialog).findByRole('button', { name: 'Gỡ Trần Quốc Huy khỏi nhóm' })).toBeInTheDocument()
    expect(calls.find((c) => c.method === 'POST' && c.path === '/api/rooms/1/members')!.body).toEqual({ user_id: 3 })
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(opener).toHaveFocus()
  })

  it('closes the panel and shows the not-found view when the room disappears from rooms_changed', async () => {
    let current = [ownerRoom, rooms[1]]
    mockFetch(routes({ 'GET /api/rooms': () => ({ json: current }), 'GET /api/users/directory': { json: [] } }))
    renderApp('/chat/1')
    await screen.findByText('chào cả nhà')
    const ws = await connect()
    await userEvent.click(screen.getByRole('button', { name: 'Thông tin nhóm' }))
    await screen.findByRole('dialog')
    current = [rooms[1]]
    await act(async () => ws.receive({ type: 'rooms_changed' }))
    expect(await screen.findByText('Cuộc trò chuyện không tồn tại hoặc bạn không còn trong đó.')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('dissolves the group: navigates home and removes it from the sidebar', async () => {
    let current = [ownerRoom, rooms[1]]
    const { calls } = mockFetch(
      routes({
        'GET /api/rooms': () => ({ json: current }),
        'GET /api/rooms/1/members': { json: [long, ha] },
        'GET /api/users/directory': { json: [] },
        'DELETE /api/rooms/1': () => ((current = [rooms[1]]), { status: 204 }),
      }),
    )
    renderApp('/chat/1')
    await screen.findByText('chào cả nhà')
    await userEvent.click(screen.getByRole('button', { name: 'Thông tin nhóm' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.type(within(dialog).getByLabelText('Gõ tên nhóm để xác nhận giải tán'), 'Dự án kho')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Giải tán nhóm' }))
    await waitFor(() => expect(screen.queryByRole('link', { name: /Dự án kho/ })).not.toBeInTheDocument())
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByText('Cuộc trò chuyện không tồn tại hoặc bạn không còn trong đó.')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Trần Quốc Huy/ })).toBeInTheDocument()
  })
})

describe('focus safety', () => {
  const people = [{ id: 3, username: 'huy', full_name: 'Trần Quốc Huy', branch_id: 2, branch_name: 'TP.HCM' }]

  it('keeps focus in the new-chat dialog after removing a chip, and Tab from body re-enters it', async () => {
    mockFetch(routes({ 'GET /api/users/directory': { json: people } }))
    renderApp('/')
    await userEvent.click(await screen.findByRole('button', { name: 'Cuộc trò chuyện mới' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('tab', { name: 'Tạo nhóm' }))
    await userEvent.click(await within(dialog).findByRole('checkbox'))
    const chipRemove = within(dialog).getByRole('button', { name: 'Bỏ Trần Quốc Huy' })
    chipRemove.focus()
    await userEvent.keyboard('{Enter}')
    await waitFor(() => expect(within(dialog).queryByRole('button', { name: 'Bỏ Trần Quốc Huy' })).not.toBeInTheDocument())
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))
    ;(document.activeElement as HTMLElement).blur()
    await userEvent.tab()
    expect(dialog.contains(document.activeElement)).toBe(true)
  })

  it('moves focus to the back link when the opener disappears with the room', async () => {
    let current = [{ ...rooms[0], my_role: 'owner' as const }, rooms[1]]
    mockFetch(routes({ 'GET /api/rooms': () => ({ json: current }), 'GET /api/users/directory': { json: [] } }))
    renderApp('/chat/1')
    await screen.findByText('chào cả nhà')
    const ws = await connect()
    await userEvent.click(screen.getByRole('button', { name: 'Thông tin nhóm' }))
    await screen.findByRole('dialog')
    current = [rooms[1]]
    await act(async () => ws.receive({ type: 'rooms_changed' }))
    const link = await screen.findByRole('link', { name: 'Về danh sách' })
    await waitFor(() => expect(link).toHaveFocus())
  })
})
