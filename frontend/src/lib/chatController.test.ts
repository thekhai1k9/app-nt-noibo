import { vi } from 'vitest'
import { ChatController } from './chatController'
import { ChatStore } from './chatStore'
import type { Message, MessagePage, Room } from './types'

const msg = (id: number, over: Partial<Message> = {}): Message => ({
  id,
  room_id: 1,
  sender_id: 2,
  sender_name: 'Bob',
  body: `tin ${id}`,
  kind: 'text',
  client_id: null,
  created_at: `2026-10-15T09:${String(id % 60).padStart(2, '0')}:00.000Z`,
  edited_at: null,
  deleted: false,
  ...over,
})
const page = (ids: number[], more = false): MessagePage => ({ items: ids.map((i) => msg(i)), has_more_before: more, has_more_after: more })
const room = (id: number, over: Partial<Room> = {}): Room => ({
  id, type: 'group', name: `P${id}`, branch_id: null, member_count: 3, peer_id: null,
  last_message: null, unread_count: 0, last_activity: '2026-10-15T08:00:00.000Z', my_role: 'member', ...over,
})

function setup(opts: { visible?: boolean; open?: boolean } = {}) {
  const store = new ChatStore()
  const api = {
    rooms: vi.fn().mockResolvedValue([room(1), room(2)]),
    messages: vi.fn().mockResolvedValue(page([1, 2, 3])),
    markRead: vi.fn().mockResolvedValue(undefined),
    openDirect: vi.fn(),
    createGroup: vi.fn(),
    renameGroup: vi.fn(),
    addMember: vi.fn(),
    removeMember: vi.fn(),
    leaveGroup: vi.fn().mockResolvedValue(undefined),
    dissolveGroup: vi.fn().mockResolvedValue(undefined),
    editMessage: vi.fn(),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
    directory: vi.fn(),
    // Rejects invalid ids (the real endpoint 404s on room ids < 1), so callers passing bad ids fail loudly.
    members: vi.fn((roomId: number) => {
      if (!(roomId >= 1)) return Promise.reject(new Error('bad room id'))
      return Promise.resolve([
        { user_id: 1, full_name: 'Tôi', last_read_message_id: null as number | null, role: 'member' as 'member' | 'owner' },
        { user_id: 2, full_name: 'Bob', last_read_message_id: null as number | null, role: 'member' as 'member' | 'owner' },
      ])
    }),
    presence: vi.fn().mockResolvedValue({ online_user_ids: [] as number[] }),
  }
  let nowMs = 1_000_000
  let isOpen = opts.open ?? true
  const socket = { send: vi.fn((_payload: Record<string, unknown>) => isOpen) }
  let counter = 0
  const controller = new ChatController({
    store,
    api,
    socket,
    meId: 1,
    meName: 'Tôi',
    newClientId: () => `cid-${++counter}`,
    isVisible: () => opts.visible ?? true,
    sendTimeoutMs: 15_000,
    now: () => nowMs,
  })
  return { store, api, socket, controller, setOpen: (v: boolean) => { isOpen = v }, advance: (ms: number) => { nowMs += ms } }
}

// setTimeout is faked in this file, so flush with microtasks instead
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }))
afterEach(() => vi.useRealTimers())

describe('ChatController: loading', () => {
  it('opens a room by loading the newest page, then only catches up on later opens', async () => {
    const { controller, api, store } = setup()
    await controller.openRoom(1)
    expect(api.messages).toHaveBeenCalledWith(1, { limit: 50 })
    expect(store.getState().threads[1].items.map((m) => m.id)).toEqual([1, 2, 3])
    api.messages.mockResolvedValueOnce({ items: [msg(4)], has_more_before: false, has_more_after: false })
    await controller.openRoom(1)
    expect(api.messages).toHaveBeenLastCalledWith(1, { after: 3, limit: 100 })
    expect(store.getState().threads[1].items.map((m) => m.id)).toEqual([1, 2, 3, 4])
  })

  it('catch-up keeps paging while the server says there is more', async () => {
    const { controller, api, store } = setup()
    await controller.openRoom(1)
    api.messages
      .mockResolvedValueOnce({ items: [msg(4), msg(5)], has_more_before: false, has_more_after: true })
      .mockResolvedValueOnce({ items: [msg(6)], has_more_before: false, has_more_after: false })
    await controller.openRoom(1)
    expect(api.messages).toHaveBeenNthCalledWith(2, 1, { after: 3, limit: 100 })
    expect(api.messages).toHaveBeenNthCalledWith(3, 1, { after: 5, limit: 100 })
    expect(store.getState().threads[1].items.map((m) => m.id)).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('flags a thread error when the first load fails and recovers on retry', async () => {
    const { controller, api, store } = setup()
    api.messages.mockRejectedValueOnce(new Error('x'))
    await controller.openRoom(1)
    expect(store.getState().threads[1].error).toBe(true)
    await controller.openRoom(1)
    expect(store.getState().threads[1].error).toBe(false)
    expect(store.getState().threads[1].loaded).toBe(true)
  })

  it('loads older messages once at a time and stops when there is nothing more', async () => {
    const { controller, api, store } = setup()
    api.messages.mockResolvedValueOnce(page([5, 6, 7], true))
    await controller.openRoom(1)
    api.messages.mockResolvedValueOnce(page([2, 3, 4], false))
    await Promise.all([controller.loadOlder(1), controller.loadOlder(1)])
    expect(api.messages).toHaveBeenCalledTimes(2)
    expect(api.messages).toHaveBeenLastCalledWith(1, { before: 5, limit: 50 })
    expect(store.getState().threads[1].items.map((m) => m.id)).toEqual([2, 3, 4, 5, 6, 7])
    await controller.loadOlder(1)
    expect(api.messages).toHaveBeenCalledTimes(2)
  })

  it('ignores a stale rooms response when a newer request was made', async () => {
    const { controller, api, store } = setup()
    let resolveFirst: (rooms: Room[]) => void = () => {}
    api.rooms.mockImplementationOnce(() => new Promise<Room[]>((r) => { resolveFirst = r }))
    const first = controller.loadRooms()
    api.rooms.mockResolvedValueOnce([room(7)])
    await controller.loadRooms()
    resolveFirst([room(1)])
    await first
    expect(store.getState().rooms.map((r) => r.id)).toEqual([7])
  })

  it('marks the rooms as failed to load when the request fails', async () => {
    const { controller, api, store } = setup()
    api.rooms.mockRejectedValueOnce(new Error('x'))
    await controller.loadRooms()
    expect(store.getState().roomsError).toBe(true)
  })
})

describe('ChatController: optimistic send', () => {
  it('adds a pending message, sends it with its client_id and reconciles when the server echoes it', async () => {
    const { controller, socket, store } = setup()
    await controller.openRoom(1)
    const clientId = controller.send(1, '  xin chào  ')
    expect(clientId).toBe('cid-1')
    expect(socket.send).toHaveBeenCalledWith({ type: 'send', room_id: 1, body: 'xin chào', client_id: 'cid-1' })
    const pending = store.getState().threads[1].items.at(-1)!
    expect(pending).toMatchObject({ pending: 'sending', body: 'xin chào', sender_id: 1, sender_name: 'Tôi', client_id: 'cid-1' })
    expect(pending.id).toBeLessThan(0)

    controller.handleSocketEvent({ type: 'message', message: msg(4, { sender_id: 1, sender_name: 'Tôi', body: 'xin chào', client_id: 'cid-1' }) })
    const items = store.getState().threads[1].items
    expect(items.map((m) => m.id)).toEqual([1, 2, 3, 4])
    expect(items.some((m) => m.pending)).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(60_000) // hẹn giờ lỗi đã bị huỷ
    expect(store.getState().threads[1].items.some((m) => m.pending)).toBe(false)
  })

  it('ignores empty messages', async () => {
    const { controller, socket } = setup()
    await controller.openRoom(1)
    expect(controller.send(1, '   ')).toBeNull()
    expect(socket.send).not.toHaveBeenCalled()
  })

  it('keeps the message pending while offline and resends it (same client_id) after ready', async () => {
    const { controller, socket, setOpen, store } = setup({ open: false })
    await controller.openRoom(1)
    controller.send(1, 'gửi sau')
    expect(store.getState().threads[1].items.at(-1)!.pending).toBe('sending')
    setOpen(true)
    controller.handleSocketEvent({ type: 'ready', user_id: 1 })
    await flush()
    const payloads = socket.send.mock.calls.map((c) => c[0])
    expect(payloads.filter((p) => p.client_id === 'cid-1').length).toBeGreaterThanOrEqual(2)
    expect(payloads.at(-1)).toEqual({ type: 'send', room_id: 1, body: 'gửi sau', client_id: 'cid-1' })
  })

  it('does not fail a message queued while offline for longer than the timeout; it is sent on ready', async () => {
    const { controller, socket, setOpen, store } = setup({ open: false })
    await controller.openRoom(1)
    controller.send(1, 'chờ lâu')
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(60_000)
    expect(store.getState().threads[1].items.at(-1)!.pending).toBe('sending')
    setOpen(true)
    socket.send.mockClear()
    controller.handleSocketEvent({ type: 'ready', user_id: 1 })
    await flush()
    expect(socket.send).toHaveBeenCalledWith({ type: 'send', room_id: 1, body: 'chờ lâu', client_id: 'cid-1' })
    controller.handleSocketEvent({ type: 'message', message: msg(4, { sender_id: 1, body: 'chờ lâu', client_id: 'cid-1' }) })
    const items = store.getState().threads[1].items
    expect(items.some((m) => m.pending)).toBe(false)
    expect(items.at(-1)!.id).toBe(4)
  })

  it('still fails an online send after the timeout when no echo arrives', async () => {
    const { controller, store } = setup()
    await controller.openRoom(1)
    controller.send(1, 'không echo')
    vi.advanceTimersByTime(14_999)
    expect(store.getState().threads[1].items.at(-1)!.pending).toBe('sending')
    vi.advanceTimersByTime(1)
    expect(store.getState().threads[1].items.at(-1)!.pending).toBe('failed')
  })

  it('marks a message as failed after the timeout, and retry resends it with the same client_id', async () => {
    const { controller, socket, store } = setup()
    await controller.openRoom(1)
    controller.send(1, 'mất mạng')
    vi.advanceTimersByTime(15_000)
    expect(store.getState().threads[1].items.at(-1)!.pending).toBe('failed')
    controller.retry('cid-1')
    expect(store.getState().threads[1].items.at(-1)!.pending).toBe('sending')
    expect(socket.send).toHaveBeenLastCalledWith({ type: 'send', room_id: 1, body: 'mất mạng', client_id: 'cid-1' })
    controller.handleSocketEvent({ type: 'message', message: msg(9, { sender_id: 1, body: 'mất mạng', client_id: 'cid-1' }) })
    expect(store.getState().threads[1].items.filter((m) => m.body === 'mất mạng')).toHaveLength(1)
  })

  it('marks the pending message as failed with the server error code', async () => {
    const { controller, store } = setup()
    await controller.openRoom(1)
    controller.send(1, 'nhanh quá')
    controller.handleSocketEvent({ type: 'error', code: 'rate_limited', client_id: 'cid-1' })
    expect(store.getState().threads[1].items.at(-1)).toMatchObject({ pending: 'failed', errorCode: 'rate_limited' })
  })

  it('ignores errors that do not belong to a pending message', async () => {
    const { controller, store } = setup()
    await controller.openRoom(1)
    controller.handleSocketEvent({ type: 'error', code: 'invalid_json', client_id: null })
    controller.handleSocketEvent({ type: 'error', code: 'x', client_id: 'unknown' })
    expect(store.getState().threads[1].items).toHaveLength(3)
  })
})

describe('ChatController: unread counts and read markers', () => {
  it('counts an incoming message as unread when the room is not being viewed', async () => {
    const { controller, store, api } = setup()
    await controller.loadRooms()
    controller.handleSocketEvent({ type: 'message', message: msg(10, { room_id: 2 }) })
    expect(store.getState().rooms.find((r) => r.id === 2)!.unread_count).toBe(1)
    expect(api.markRead).not.toHaveBeenCalled()
  })

  it('does not count and marks as read when the room is open and the tab is visible', async () => {
    const { controller, store, api } = setup()
    await controller.loadRooms()
    controller.setActiveRoom(1)
    await controller.openRoom(1)
    api.markRead.mockClear()
    vi.advanceTimersByTime(1000) // het khoang gop cua lan danh dau luc mo phong
    controller.handleSocketEvent({ type: 'message', message: msg(10, { room_id: 1 }) })
    expect(store.getState().rooms.find((r) => r.id === 1)!.unread_count).toBe(0)
    expect(api.markRead).toHaveBeenCalledWith(1, 10)
  })

  it('counts as unread when the room is open but the tab is hidden, then marks read when it becomes visible', async () => {
    let visible = false
    const store = new ChatStore()
    const api = { rooms: vi.fn().mockResolvedValue([room(1)]), messages: vi.fn().mockResolvedValue(page([1])), markRead: vi.fn().mockResolvedValue(undefined), openDirect: vi.fn(), createGroup: vi.fn(), renameGroup: vi.fn(), addMember: vi.fn(), removeMember: vi.fn(), leaveGroup: vi.fn(), dissolveGroup: vi.fn(), editMessage: vi.fn(), deleteMessage: vi.fn(), directory: vi.fn(), members: vi.fn().mockResolvedValue([]), presence: vi.fn().mockResolvedValue({ online_user_ids: [] }) }
    const controller = new ChatController({ store, api, socket: { send: vi.fn(() => true) }, meId: 1, meName: 'Tôi', isVisible: () => visible })
    await controller.loadRooms()
    controller.setActiveRoom(1)
    await controller.openRoom(1)
    controller.handleSocketEvent({ type: 'message', message: msg(5, { room_id: 1 }) })
    expect(store.getState().rooms[0].unread_count).toBe(1)
    expect(api.markRead).not.toHaveBeenCalled()
    visible = true
    controller.onVisible()
    expect(store.getState().rooms[0].unread_count).toBe(0)
    expect(api.markRead).toHaveBeenCalledWith(1, 5)
  })

  it('never counts the user\'s own messages (for example sent from another tab)', async () => {
    const { controller, store } = setup()
    await controller.loadRooms()
    controller.handleSocketEvent({ type: 'message', message: msg(11, { room_id: 2, sender_id: 1 }) })
    expect(store.getState().rooms.find((r) => r.id === 2)!.unread_count).toBe(0)
  })

  it('does not send the same read marker twice', async () => {
    const { controller, api } = setup()
    await controller.loadRooms()
    controller.setActiveRoom(1)
    await controller.openRoom(1)
    expect(api.markRead).toHaveBeenCalledTimes(1)
    controller.onVisible()
    controller.onVisible()
    expect(api.markRead).toHaveBeenCalledTimes(1)
  })

  it('reloads the room list when a message arrives for an unknown room', async () => {
    const { controller, api } = setup()
    await controller.loadRooms()
    api.rooms.mockClear()
    controller.handleSocketEvent({ type: 'message', message: msg(12, { room_id: 77 }) })
    expect(api.rooms).toHaveBeenCalledTimes(1)
  })
})

describe('ChatController: socket events', () => {
  it('after ready and after resync: reloads rooms and catches up on every loaded thread only', async () => {
    const { controller, api } = setup()
    await controller.loadRooms()
    await controller.openRoom(1) // chỉ phòng 1 đã tải
    api.rooms.mockClear()
    api.messages.mockClear()
    api.messages.mockResolvedValue({ items: [], has_more_before: false, has_more_after: false })
    controller.handleSocketEvent({ type: 'ready', user_id: 1 })
    await flush()
    expect(api.rooms).toHaveBeenCalledTimes(1)
    expect(api.messages).toHaveBeenCalledTimes(1)
    expect(api.messages).toHaveBeenCalledWith(1, { after: 3, limit: 100 })
    controller.handleSocketEvent({ type: 'resync' })
    await flush()
    expect(api.rooms).toHaveBeenCalledTimes(2)
    expect(api.messages).toHaveBeenCalledTimes(2)
  })

  it('reloads the room list on rooms_changed', async () => {
    const { controller, api } = setup()
    controller.handleSocketEvent({ type: 'rooms_changed' })
    await flush()
    expect(api.rooms).toHaveBeenCalledTimes(1)
  })

  it('applies message_updated and message_deleted events', async () => {
    const { controller, store } = setup()
    await controller.openRoom(1)
    controller.handleSocketEvent({ type: 'message_updated', message: msg(2, { body: 'đã sửa', edited_at: '2026-10-15T10:00:00.000Z' }) })
    controller.handleSocketEvent({ type: 'message_deleted', room_id: 1, message_id: 3 })
    const items = store.getState().threads[1].items
    expect(items[1].body).toBe('đã sửa')
    expect(items[2]).toMatchObject({ deleted: true, body: '' })
  })
})

describe('ChatController: edit, delete, direct rooms', () => {
  it('edits and deletes through the API and updates the store', async () => {
    const { controller, api, store } = setup()
    await controller.openRoom(1)
    api.editMessage.mockResolvedValueOnce(msg(2, { body: 'mới', edited_at: '2026-10-15T10:00:00.000Z' }))
    await controller.edit(2, 'mới')
    expect(store.getState().threads[1].items[1].body).toBe('mới')
    await controller.remove(1, 3)
    expect(api.deleteMessage).toHaveBeenCalledWith(3)
    expect(store.getState().threads[1].items[2].deleted).toBe(true)
  })

  it('lets API errors propagate to the caller', async () => {
    const { controller, api } = setup()
    api.editMessage.mockRejectedValueOnce(new Error('403'))
    await expect(controller.edit(2, 'x')).rejects.toThrow('403')
  })

  it('opens a direct room and adds it to the list', async () => {
    const { controller, api, store } = setup()
    api.openDirect.mockResolvedValueOnce(room(9, { type: 'direct', name: 'Hà', peer_id: 5 }))
    api.rooms.mockResolvedValue([room(1), room(9, { type: 'direct', name: 'Hà', peer_id: 5 })]) // the server list includes the new room
    const opened = await controller.openDirect(5)
    expect(opened.id).toBe(9)
    expect(store.getState().rooms.some((r) => r.id === 9)).toBe(true)
  })

  it('dispose() cancels pending timers', async () => {
    const { controller, store } = setup()
    await controller.openRoom(1)
    controller.send(1, 'x')
    controller.dispose()
    vi.advanceTimersByTime(60_000)
    expect(store.getState().threads[1].items.at(-1)!.pending).toBe('sending')
  })
})

describe('ChatController: hazards', () => {
  it('resends only messages that are still sending, and re-arms their failure timer', async () => {
    const { controller, socket, store } = setup()
    await controller.openRoom(1)
    controller.send(1, 'a') // cid-1
    controller.send(1, 'b') // cid-2
    controller.handleSocketEvent({ type: 'error', code: 'rate_limited', client_id: 'cid-2' })
    socket.send.mockClear()
    vi.advanceTimersByTime(10_000)
    controller.handleSocketEvent({ type: 'ready', user_id: 1 })
    await flush()
    const sent = socket.send.mock.calls.map((c) => c[0].client_id)
    expect(sent).toEqual(['cid-1'])
    vi.advanceTimersByTime(10_000) // would have expired under the original timer
    const items = store.getState().threads[1].items
    expect(items.find((m) => m.client_id === 'cid-1')!.pending).toBe('sending')
    vi.advanceTimersByTime(5_000)
    expect(store.getState().threads[1].items.find((m) => m.client_id === 'cid-1')!.pending).toBe('failed')
  })

  it('reconciles a timed-out message when the server echo arrives later', async () => {
    const { controller, store } = setup()
    await controller.openRoom(1)
    controller.send(1, 'trễ')
    vi.advanceTimersByTime(15_000)
    expect(store.getState().threads[1].items.at(-1)!.pending).toBe('failed')
    controller.handleSocketEvent({ type: 'message', message: msg(4, { sender_id: 1, body: 'trễ', client_id: 'cid-1' }) })
    const items = store.getState().threads[1].items
    expect(items.map((m) => m.id)).toEqual([1, 2, 3, 4])
    expect(items.some((m) => m.pending)).toBe(false)
  })

  it('never sends a read marker for local (negative) ids', async () => {
    const { controller, api } = setup()
    api.messages.mockResolvedValueOnce(page([]))
    await controller.loadRooms()
    controller.setActiveRoom(1)
    await controller.openRoom(1)
    controller.send(1, 'x')
    controller.onVisible()
    expect(api.markRead).not.toHaveBeenCalled()
  })

  it('does not mark a room read after the user already switched to another room', async () => {
    const { controller, api } = setup()
    await controller.loadRooms()
    controller.setActiveRoom(1)
    const opening = controller.openRoom(1)
    controller.setActiveRoom(2)
    await opening
    expect(api.markRead).not.toHaveBeenCalledWith(1, expect.anything())
  })

  it('leaveRoom only clears the active room if it is still that room', async () => {
    const { controller, store } = setup()
    await controller.loadRooms()
    controller.setActiveRoom(1)
    controller.setActiveRoom(2)
    controller.leaveRoom(1) // late cleanup of the previous room
    controller.handleSocketEvent({ type: 'message', message: msg(50, { room_id: 2 }) })
    expect(store.getState().rooms.find((r) => r.id === 2)!.unread_count).toBe(0)
    controller.leaveRoom(2)
    controller.handleSocketEvent({ type: 'message', message: msg(51, { room_id: 2 }) })
    expect(store.getState().rooms.find((r) => r.id === 2)!.unread_count).toBe(1)
  })
})

describe('ChatController: REST reconciliation, buffering, discard', () => {
  const mineEcho = (id: number, cid: string) => msg(id, { sender_id: 1, body: 'x', client_id: cid })
  const one = (m: Message): MessagePage => ({ items: [m], has_more_before: false, has_more_after: false })

  it('a failed message is reconciled by catch-up when the server had stored it', async () => {
    const { controller, api, store, socket } = setup()
    await controller.openRoom(1)
    controller.send(1, 'x')
    vi.advanceTimersByTime(15_000)
    api.messages.mockResolvedValueOnce(one(mineEcho(4, 'cid-1')))
    controller.handleSocketEvent({ type: 'ready', user_id: 1 })
    await flush()
    expect(store.getState().threads[1].items.map((m) => m.id)).toEqual([1, 2, 3, 4])
    socket.send.mockClear()
    controller.retry('cid-1') // meta cleared: no-op
    expect(socket.send).not.toHaveBeenCalled()
    expect(store.getState().threads[1].items).toHaveLength(4)
  })

  it('reopening (applyLatest) reconciles a pending message already stored by the server', async () => {
    const { controller, api, store } = setup()
    api.messages.mockRejectedValueOnce(new Error('x'))
    await controller.openRoom(1) // thread errored, not loaded
    controller.send(1, 'x')
    vi.advanceTimersByTime(15_000)
    expect(store.getState().threads[1].items[0].pending).toBe('failed')
    api.messages.mockResolvedValueOnce({ items: [msg(1), mineEcho(4, 'cid-1')], has_more_before: false, has_more_after: false })
    await controller.openRoom(1)
    const items = store.getState().threads[1].items
    expect(items.map((m) => m.id)).toEqual([1, 4])
    expect(items.some((m) => m.pending)).toBe(false)
  })

  it('a sending message reconciled by catch-up cancels its failure timer', async () => {
    const { controller, api, store } = setup()
    await controller.openRoom(1)
    controller.send(1, 'x')
    expect(vi.getTimerCount()).toBe(1)
    api.messages.mockResolvedValueOnce(one(mineEcho(4, 'cid-1')))
    await controller.openRoom(1)
    expect(store.getState().threads[1].items.map((m) => m.id)).toEqual([1, 2, 3, 4])
    expect(vi.getTimerCount()).toBe(0) // hẹn giờ lỗi đã bị huỷ, không chỉ là vô hại
    vi.advanceTimersByTime(60_000)
    controller.handleSocketEvent({ type: 'message', message: mineEcho(4, 'cid-1') })
    expect(store.getState().threads[1].items.map((m) => m.id)).toEqual([1, 2, 3, 4])
  })

  it('does not lose a live message that arrives while the first page is loading', async () => {
    const { controller, api, store } = setup()
    await controller.loadRooms()
    controller.setActiveRoom(1)
    let resolve: (p: MessagePage) => void = () => {}
    api.messages.mockImplementationOnce(() => new Promise<MessagePage>((r) => { resolve = r }))
    const opening = controller.openRoom(1)
    controller.handleSocketEvent({ type: 'message', message: msg(4) })
    resolve(page([1, 2, 3]))
    await opening
    expect(store.getState().threads[1].items.map((m) => m.id)).toEqual([1, 2, 3, 4])
    expect(store.getState().threads[1].loaded).toBe(true)
    expect(api.markRead).toHaveBeenLastCalledWith(1, 4)
  })

  it('keeps a live message when an errored first load is retried', async () => {
    const { controller, api, store } = setup()
    api.messages.mockRejectedValueOnce(new Error('x'))
    await controller.openRoom(1)
    controller.handleSocketEvent({ type: 'message', message: msg(4) })
    await controller.openRoom(1)
    expect(store.getState().threads[1].items.map((m) => m.id)).toEqual([1, 2, 3, 4])
  })

  it('a stale rooms snapshot does not restore the unread badge of a room already marked read', async () => {
    const { controller, api, store } = setup()
    await controller.loadRooms()
    controller.setActiveRoom(1)
    await controller.openRoom(1)
    vi.advanceTimersByTime(1000)
    controller.handleSocketEvent({ type: 'message', message: msg(10) })
    expect(api.markRead).toHaveBeenLastCalledWith(1, 10)
    api.rooms.mockResolvedValueOnce([room(1, { last_message: msg(10), unread_count: 1 }), room(2)])
    await controller.loadRooms()
    expect(store.getState().rooms.find((r) => r.id === 1)!.unread_count).toBe(0)
  })

  it('discard() cancels the timer and removes the pending message', async () => {
    const { controller, store } = setup()
    await controller.openRoom(1)
    controller.send(1, 'x')
    controller.discard('cid-1')
    vi.advanceTimersByTime(60_000)
    expect(store.getState().threads[1].items.map((m) => m.id)).toEqual([1, 2, 3])
    controller.retry('cid-1')
    expect(store.getState().threads[1].items).toHaveLength(3)
  })
})

describe('ChatController: resync cursor and room pruning', () => {
  const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i)
  const idsOf = (store: ChatStore) => store.getState().threads[1].items.map((m) => m.id)

  async function loadedTo50() {
    const ctx = setup({ open: false })
    ctx.api.messages.mockResolvedValueOnce(page([49, 50]))
    await ctx.controller.openRoom(1)
    return ctx
  }

  it('does not skip the gap when the echo of a resent message arrives while /rooms is pending', async () => {
    const { controller, api, store, setOpen } = await loadedTo50()
    controller.send(1, 'ok') // queued offline, cid-1
    let resolveRooms: (r: Room[]) => void = () => {}
    api.rooms.mockImplementationOnce(() => new Promise<Room[]>((r) => { resolveRooms = r }))
    api.messages.mockImplementation(async (_room: number, q: { after?: number }) => {
      const all = range(51, 99)
      const items = all.filter((i) => i > (q.after ?? 0)).slice(0, 100).map((i) => msg(i))
      return { items, has_more_before: false, has_more_after: false }
    })
    setOpen(true)
    controller.handleSocketEvent({ type: 'ready', user_id: 1 })
    controller.handleSocketEvent({ type: 'message', message: msg(100, { sender_id: 1, body: 'ok', client_id: 'cid-1' }) })
    resolveRooms([room(1)])
    await flush()
    expect(idsOf(store)).toEqual([49, 50, ...range(51, 99), 100])
  })

  it('does not skip the gap when a live message arrives during the rooms wait', async () => {
    const { controller, api, store } = await loadedTo50()
    let resolveRooms: (r: Room[]) => void = () => {}
    api.rooms.mockImplementationOnce(() => new Promise<Room[]>((r) => { resolveRooms = r }))
    api.messages.mockResolvedValue({ items: range(51, 59).map((i) => msg(i)), has_more_before: false, has_more_after: false })
    controller.handleSocketEvent({ type: 'ready', user_id: 1 })
    controller.handleSocketEvent({ type: 'message', message: msg(60) })
    resolveRooms([room(1)])
    await flush()
    expect(api.messages).toHaveBeenLastCalledWith(1, { after: 50, limit: 100 })
    expect(idsOf(store)).toEqual([49, 50, ...range(51, 60)])
  })

  it('reloads the newest page when ready arrives while the first load is still in flight', async () => {
    const { controller, api, store } = setup()
    let resolveFirst: (p: MessagePage) => void = () => {}
    api.messages.mockImplementationOnce(() => new Promise<MessagePage>((r) => { resolveFirst = r }))
    const opening = controller.openRoom(1)
    controller.handleSocketEvent({ type: 'ready', user_id: 1 })
    api.messages.mockResolvedValueOnce(page([1, 2, 3, 4, 5]))
    resolveFirst(page([1, 2, 3]))
    await opening
    await flush()
    expect(api.messages).toHaveBeenCalledTimes(2)
    expect(idsOf(store)).toEqual([1, 2, 3, 4, 5])
  })

  it('drops threads of rooms that left the list, but keeps the active room and threads with pending messages', async () => {
    const { controller, api, store } = setup()
    api.rooms.mockResolvedValue([room(1), room(2), room(3), room(4)])
    await controller.loadRooms()
    for (const id of [1, 2, 3, 4]) await controller.openRoom(id)
    controller.setActiveRoom(2)
    controller.send(3, 'x')
    api.rooms.mockResolvedValueOnce([room(5)])
    await controller.loadRooms()
    const keys = Object.keys(store.getState().threads).map(Number).sort()
    expect(keys).toEqual([2, 3])
  })

  it('prunes a pending thread once the room is absent from two consecutive snapshots, and stops resending to it', async () => {
    const { controller, api, store, socket } = setup()
    api.rooms.mockResolvedValue([room(1), room(2)])
    await controller.loadRooms()
    await controller.openRoom(2)
    controller.setActiveRoom(1)
    controller.send(2, 'đang chờ')
    api.rooms.mockResolvedValue([room(1)])
    await controller.loadRooms() // một bản chụp cũ: chưa đủ để xoá
    expect(store.getState().threads[2]).toBeDefined()
    await controller.loadRooms() // bản thứ hai vẫn vắng: bỏ
    expect(store.getState().threads[2]).toBeUndefined()
    socket.send.mockClear()
    controller.handleSocketEvent({ type: 'ready', user_id: 1 })
    await flush()
    expect(socket.send.mock.calls.some(([p]) => p.room_id === 2)).toBe(false)
  })

  it('a snapshot that includes the room again resets the absence count (stale snapshot cannot delete it)', async () => {
    const { controller, api, store } = setup()
    api.rooms.mockResolvedValue([room(1), room(2)])
    await controller.loadRooms()
    await controller.openRoom(2)
    controller.setActiveRoom(1)
    controller.send(2, 'x')
    api.rooms.mockResolvedValue([room(1)])
    await controller.loadRooms()
    api.rooms.mockResolvedValue([room(1), room(2)])
    await controller.loadRooms()
    api.rooms.mockResolvedValue([room(1)])
    await controller.loadRooms()
    expect(store.getState().threads[2]?.items.some((m) => m.pending)).toBe(true)
  })

  it('for the active room that is gone, fails pending messages with room_not_found and stops resending', async () => {
    const { controller, api, store, socket } = setup()
    api.rooms.mockResolvedValue([room(1), room(2)])
    await controller.loadRooms()
    await controller.openRoom(1)
    controller.setActiveRoom(1)
    controller.send(1, 'xin chào')
    api.rooms.mockResolvedValue([room(2)])
    await controller.loadRooms()
    await controller.loadRooms()
    const item = store.getState().threads[1].items.find((m) => m.pending)
    expect(item).toMatchObject({ pending: 'failed', errorCode: 'room_not_found' })
    socket.send.mockClear()
    controller.handleSocketEvent({ type: 'ready', user_id: 1 })
    await flush()
    expect(socket.send).not.toHaveBeenCalled()
    controller.retry(item!.client_id!) // không còn gì để gửi lại
    expect(socket.send).not.toHaveBeenCalled()
    controller.leaveRoom(1)
    expect(store.getState().threads[1]).toBeUndefined()
  })

  it('does not GET messages for a pruned room on the next ready', async () => {
    const { controller, api } = setup()
    await controller.loadRooms()
    await controller.openRoom(1)
    api.rooms.mockResolvedValueOnce([room(2)])
    await controller.loadRooms()
    api.messages.mockClear()
    controller.handleSocketEvent({ type: 'ready', user_id: 1 })
    await flush()
    expect(api.messages).not.toHaveBeenCalled()
  })

  it('keeps the gap recoverable after a failed catch-up followed by a live message and a second ready', async () => {
    const { controller, api, store } = await loadedTo50()
    api.messages.mockRejectedValueOnce(new Error('x'))
    controller.handleSocketEvent({ type: 'ready', user_id: 1 })
    controller.handleSocketEvent({ type: 'message', message: msg(100) })
    await flush()
    expect(api.messages).toHaveBeenLastCalledWith(1, { after: 50, limit: 100 })
    api.messages.mockResolvedValue({ items: range(51, 99).map((i) => msg(i)), has_more_before: false, has_more_after: false })
    controller.handleSocketEvent({ type: 'ready', user_id: 1 })
    await flush()
    expect(api.messages).toHaveBeenLastCalledWith(1, { after: 50, limit: 100 })
    expect(idsOf(store)).toEqual([49, 50, ...range(51, 99), 100])
  })

  it('advances the watermark from REST pages only, and openRoom retries from it after a failure', async () => {
    const { controller, api } = await loadedTo50()
    controller.handleSocketEvent({ type: 'message', message: msg(80) }) // live: must not move the watermark
    api.messages.mockRejectedValueOnce(new Error('x'))
    await controller.openRoom(1)
    expect(api.messages).toHaveBeenLastCalledWith(1, { after: 50, limit: 100 })
    api.messages.mockResolvedValueOnce({ items: range(51, 60).map((i) => msg(i)), has_more_before: false, has_more_after: false })
    await controller.openRoom(1)
    expect(api.messages).toHaveBeenLastCalledWith(1, { after: 50, limit: 100 })
    api.messages.mockResolvedValueOnce({ items: [msg(61)], has_more_before: false, has_more_after: false })
    await controller.openRoom(1)
    expect(api.messages).toHaveBeenLastCalledWith(1, { after: 60, limit: 100 })
  })

  it('never asks the server for after=0: an empty room reloads its latest page and recovers messages missed while offline', async () => {
    const { controller, api, store } = await loadedTo50()
    api.messages.mockResolvedValueOnce({ items: [], has_more_before: false, has_more_after: false })
    await controller.openRoom(2) // phòng trống: mốc 0
    controller.handleSocketEvent({ type: 'message', message: msg(1, { room_id: 2 }) })
    api.messages.mockClear()
    api.messages.mockResolvedValue({ items: range(1, 40).map((i) => msg(i, { room_id: 2 })), has_more_before: false, has_more_after: false })
    controller.handleSocketEvent({ type: 'ready', user_id: 1 })
    await flush()
    for (const call of api.messages.mock.calls) expect(call[1].after).not.toBe(0)
    expect(api.messages).toHaveBeenCalledWith(2, { limit: 50 })
    expect(store.getState().threads[2].items.map((m) => m.id)).toEqual(range(1, 40))
  })

  it('runs one more catch-up after the running one instead of starting a duplicate', async () => {
    const { controller, api } = await loadedTo50()
    let resolveFirst: (p: MessagePage) => void = () => {}
    api.messages.mockImplementationOnce(() => new Promise<MessagePage>((r) => { resolveFirst = r }))
    const first = controller.openRoom(1)
    const second = controller.openRoom(1)
    const third = controller.openRoom(1)
    expect(api.messages).toHaveBeenCalledTimes(2) // initial load + one running catch-up
    api.messages.mockResolvedValue({ items: [], has_more_before: false, has_more_after: false })
    resolveFirst({ items: [msg(51)], has_more_before: false, has_more_after: false })
    await Promise.all([first, second, third])
    expect(api.messages).toHaveBeenCalledTimes(3)
    expect(api.messages).toHaveBeenLastCalledWith(1, { after: 51, limit: 100 })
  })

  it('an older in-flight rooms snapshot cannot overwrite a direct room added meanwhile', async () => {
    const { controller, api, store } = setup()
    let resolveRooms: (r: Room[]) => void = () => {}
    api.rooms.mockImplementationOnce(() => new Promise<Room[]>((r) => { resolveRooms = r }))
    const loading = controller.loadRooms()
    api.openDirect.mockResolvedValueOnce(room(9, { type: 'direct' }))
    api.rooms.mockResolvedValueOnce([room(1), room(9, { type: 'direct' })])
    await controller.openDirect(5)
    resolveRooms([room(1)])
    await loading
    await flush()
    expect(store.getState().rooms.some((r) => r.id === 9)).toBe(true)
  })
})

describe('ChatController: read receipts, typing, presence', () => {
  const typing = (room_id: number, user_id: number, user_name = 'Bob') => ({ type: 'typing' as const, room_id, user_id, user_name })

  it('typing from others expires after 5s; own typing and unknown rooms are ignored', async () => {
    const { controller, store } = setup()
    await controller.loadRooms()
    controller.handleSocketEvent(typing(1, 1, 'Tôi'))
    controller.handleSocketEvent(typing(99, 2))
    expect(store.getState().typing).toEqual({})
    controller.handleSocketEvent(typing(1, 2))
    expect(store.getState().typing[1][2].name).toBe('Bob')
    vi.advanceTimersByTime(4999)
    expect(store.getState().typing[1]?.[2]).toBeDefined()
    vi.advanceTimersByTime(1)
    expect(store.getState().typing).toEqual({})
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a message from the typist clears their typing immediately', async () => {
    const { controller, store } = setup()
    await controller.loadRooms()
    controller.handleSocketEvent(typing(1, 2))
    controller.handleSocketEvent({ type: 'message', message: msg(10) })
    expect(store.getState().typing).toEqual({})
    expect(vi.getTimerCount()).toBe(0)
  })

  it('read events update member markers; own read clears unread; unknown rooms do not throw', async () => {
    const { controller, store, api } = setup()
    api.rooms.mockResolvedValue([room(1, { unread_count: 3 }), room(2)])
    await controller.loadRooms()
    await controller.loadMembers(1)
    controller.handleSocketEvent({ type: 'read', room_id: 1, user_id: 2, message_id: 5 })
    expect(store.getState().members[1].find((m) => m.user_id === 2)?.last_read_message_id).toBe(5)
    expect(store.getState().rooms.find((r) => r.id === 1)?.unread_count).toBe(3)
    controller.handleSocketEvent({ type: 'read', room_id: 1, user_id: 1, message_id: 5 })
    expect(store.getState().rooms.find((r) => r.id === 1)?.unread_count).toBe(0)
    expect(() => controller.handleSocketEvent({ type: 'read', room_id: 77, user_id: 1, message_id: 5 })).not.toThrow()
  })

  it('own read from another tab does not clear unread when a newer message already arrived', async () => {
    const { controller, store, api } = setup()
    api.rooms.mockResolvedValue([room(1, { unread_count: 1, last_message: msg(9) })])
    await controller.loadRooms()
    controller.handleSocketEvent({ type: 'read', room_id: 1, user_id: 1, message_id: 5 })
    expect(store.getState().rooms[0].unread_count).toBe(1)
  })

  it('a read event that lands while members are loading is applied on top of the stale snapshot', async () => {
    const { controller, store, api } = setup()
    await controller.loadRooms()
    let resolve: (m: { user_id: number; full_name: string; last_read_message_id: number | null; role: 'member' | 'owner' }[]) => void = () => {}
    api.members.mockImplementationOnce(() => new Promise((r) => { resolve = r }))
    // the re-run scheduled by the in-flight read sees the server's up-to-date marker
    api.members.mockResolvedValue([{ user_id: 2, full_name: 'Bob', last_read_message_id: 8, role: 'member' as const }])
    const p = controller.loadMembers(1)
    controller.handleSocketEvent({ type: 'read', room_id: 1, user_id: 2, message_id: 8 })
    resolve([{ user_id: 2, full_name: 'Bob', last_read_message_id: 3, role: 'member' as const }])
    await p
    expect(store.getState().members[1][0].last_read_message_id).toBe(8)
  })

  it('presence events toggle online, and live events win over an older in-flight snapshot', async () => {
    const { controller, store, api } = setup()
    controller.handleSocketEvent({ type: 'presence', user_id: 2, online: true })
    expect(store.getState().online[2]).toBe(true)
    controller.handleSocketEvent({ type: 'presence', user_id: 2, online: false })
    expect(store.getState().online[2]).toBeUndefined()
    let resolve: (v: { online_user_ids: number[] }) => void = () => {}
    api.presence.mockImplementationOnce(() => new Promise((r) => { resolve = r }))
    const p = controller.refreshPresence()
    controller.handleSocketEvent({ type: 'presence', user_id: 2, online: true })
    controller.handleSocketEvent({ type: 'presence', user_id: 3, online: false })
    resolve({ online_user_ids: [3, 4] })
    await p
    expect(Object.keys(store.getState().online).map(Number).sort()).toEqual([2, 4])
  })

  it('ready and rooms_changed refresh presence; ready loads members only for the open room', async () => {
    const { controller, api } = setup()
    controller.handleSocketEvent({ type: 'ready', user_id: 1 })
    await flush()
    expect(api.presence).toHaveBeenCalledTimes(1)
    expect(api.members).not.toHaveBeenCalled()
    controller.setActiveRoom(1)
    await controller.openRoom(1)
    expect(api.members).toHaveBeenCalledTimes(1)
    controller.handleSocketEvent({ type: 'ready', user_id: 1 })
    await flush()
    expect(api.presence).toHaveBeenCalledTimes(2)
    expect(api.members).toHaveBeenCalledTimes(2)
    expect(api.members).toHaveBeenLastCalledWith(1)
    controller.handleSocketEvent({ type: 'rooms_changed' })
    await flush()
    expect(api.presence).toHaveBeenCalledTimes(3)
  })

  it('sendTyping is throttled to once per 3s, needs an open socket and never throws', () => {
    const { controller, socket, advance, setOpen } = setup()
    for (let i = 0; i < 10; i++) controller.sendTyping(1)
    expect(socket.send).toHaveBeenCalledTimes(1)
    expect(socket.send).toHaveBeenCalledWith({ type: 'typing', room_id: 1 })
    advance(2999)
    controller.sendTyping(1)
    expect(socket.send).toHaveBeenCalledTimes(1)
    advance(1)
    controller.sendTyping(1)
    expect(socket.send).toHaveBeenCalledTimes(2)
    setOpen(false)
    advance(5000)
    controller.sendTyping(1)
    controller.sendTyping(1)
    expect(socket.send).toHaveBeenCalledTimes(4) // a closed socket does not start the throttle window
    socket.send.mockImplementation(() => { throw new Error('boom') })
    expect(() => controller.sendTyping(2)).not.toThrow()
    controller.dispose()
    socket.send.mockClear()
    controller.sendTyping(3)
    expect(socket.send).not.toHaveBeenCalled()
  })

  it('concurrent loadMembers coalesce into one in-flight request plus one re-run; a failure keeps the old list', async () => {
    const { controller, store, api } = setup()
    await Promise.all([controller.loadMembers(1), controller.loadMembers(1)])
    expect(api.members).toHaveBeenCalledTimes(2)
    const old = store.getState().members[1]
    api.members.mockRejectedValueOnce(new Error('x'))
    await controller.loadMembers(1)
    expect(store.getState().members[1]).toBe(old)
  })

  it('dispose clears typing timers', async () => {
    const { controller } = setup()
    await controller.loadRooms()
    controller.handleSocketEvent(typing(1, 2))
    expect(vi.getTimerCount()).toBe(1)
    controller.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('pruning removed rooms drops their typing timers, members and in-flight member loads', async () => {
    const { controller, store, api } = setup()
    await controller.loadRooms()
    await controller.loadMembers(2)
    controller.handleSocketEvent(typing(2, 2))
    expect(vi.getTimerCount()).toBe(1)
    let resolve: (m: never[]) => void = () => {}
    api.members.mockImplementationOnce(() => new Promise((r) => { resolve = r }))
    const inflight = controller.loadMembers(2)
    api.rooms.mockResolvedValue([room(1)])
    await controller.loadRooms()
    resolve([])
    await inflight
    expect(store.getState().typing[2]).toBeUndefined()
    expect(store.getState().members[2]).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('ChatController: review follow-ups', () => {
  type Mem = { user_id: number; full_name: string; last_read_message_id: number | null; role: 'member' }
  const deferred = () => {
    let resolve: (m: Mem[]) => void = () => {}
    const promise = new Promise<Mem[]>((r) => { resolve = r })
    return { promise, resolve }
  }
  const m = (user_id: number, last: number | null = null): Mem => ({ user_id, full_name: `U${user_id}`, last_read_message_id: last, role: 'member' })

  it('a loadMembers call during an in-flight load re-runs exactly once, so a member added meanwhile is not lost', async () => {
    const { controller, store, api } = setup()
    await controller.loadRooms()
    const first = deferred()
    api.members.mockImplementationOnce(() => first.promise)
    const open = controller.loadMembers(1)
    const again1 = controller.loadMembers(1)
    const again2 = controller.loadMembers(1)
    api.members.mockResolvedValueOnce([m(1), m(2), m(3)])
    first.resolve([m(1), m(2)])
    await Promise.all([open, again1, again2])
    expect(api.members).toHaveBeenCalledTimes(2)
    expect(store.getState().members[1].map((x) => x.user_id)).toEqual([1, 2, 3])
  })

  it('a read from a user missing from the loaded list reloads members and applies the buffered marker', async () => {
    const { controller, store, api } = setup()
    await controller.loadRooms()
    await controller.loadMembers(1)
    api.members.mockResolvedValueOnce([m(1), m(2), m(3)])
    controller.handleSocketEvent({ type: 'read', room_id: 1, user_id: 3, message_id: 6 })
    await flush()
    expect(api.members).toHaveBeenCalledTimes(2)
    expect(store.getState().members[1].find((x) => x.user_id === 3)?.last_read_message_id).toBe(6)
  })

  it('own read clears unread when the newer last message is my own reply, but not another person\'s', async () => {
    const { controller, store, api } = setup()
    api.rooms.mockResolvedValue([room(1, { unread_count: 1, last_message: msg(11, { sender_id: 1 }) }), room(2, { unread_count: 1, last_message: msg(11, { room_id: 2 }) })])
    await controller.loadRooms()
    controller.handleSocketEvent({ type: 'read', room_id: 1, user_id: 1, message_id: 10 })
    controller.handleSocketEvent({ type: 'read', room_id: 2, user_id: 1, message_id: 10 })
    expect(store.getState().rooms.find((r) => r.id === 1)?.unread_count).toBe(0)
    expect(store.getState().rooms.find((r) => r.id === 2)?.unread_count).toBe(1)
  })

  it('a burst of rooms_changed makes one or two presence and rooms requests', async () => {
    const { controller, api } = setup()
    for (let i = 0; i < 5; i++) controller.handleSocketEvent({ type: 'rooms_changed' })
    await flush()
    for (const calls of [api.presence.mock.calls.length, api.rooms.mock.calls.length]) {
      expect(calls).toBeGreaterThanOrEqual(1)
      expect(calls).toBeLessThanOrEqual(2)
    }
  })

  it('a failed trailing presence refresh keeps the snapshot that already arrived', async () => {
    const { controller, store, api } = setup()
    api.presence.mockResolvedValueOnce({ online_user_ids: [5] }).mockRejectedValueOnce(new Error('x'))
    const a = controller.refreshPresence()
    const b = controller.refreshPresence()
    await Promise.all([a, b])
    expect(Object.keys(store.getState().online)).toEqual(['5'])
  })

  it('resync reloads presence and the open room members', async () => {
    const { controller, api } = setup()
    controller.setActiveRoom(1)
    controller.handleSocketEvent({ type: 'resync' })
    await flush()
    expect(api.presence).toHaveBeenCalledTimes(1)
    expect(api.members).toHaveBeenCalledWith(1)
  })

  it('dispose clears typing entries from the store; activate makes typing work again', async () => {
    const { controller, store } = setup()
    await controller.loadRooms()
    const ev = { type: 'typing' as const, room_id: 1, user_id: 2, user_name: 'Bob' }
    controller.handleSocketEvent(ev)
    controller.dispose()
    expect(store.getState().typing).toEqual({})
    controller.handleSocketEvent(ev)
    expect(store.getState().typing).toEqual({})
    controller.activate()
    controller.handleSocketEvent(ev)
    expect(store.getState().typing[1][2].name).toBe('Bob')
    expect(vi.getTimerCount()).toBe(1)
    controller.dispose()
  })

  it('stale buffered reads expire on the next members load (fresh ones are kept)', async () => {
    const buffered = (c: ChatController) => (c as unknown as { pendingReads: Map<number, unknown> }).pendingReads
    for (const expire of [true, false]) {
      const { controller, store, api, advance } = setup()
      await controller.loadRooms()
      await controller.loadMembers(1)
      controller.handleSocketEvent({ type: 'read', room_id: 1, user_id: 9, message_id: 4 })
      await flush()
      expect(buffered(controller).has(1)).toBe(true) // 9 is not a member yet
      if (expire) advance(6 * 60_000)
      await controller.loadMembers(1) // still no user 9
      expect(buffered(controller).has(1)).toBe(!expire)
      api.members.mockResolvedValue([
        { user_id: 1, full_name: 'Tôi', last_read_message_id: null, role: 'member' as 'member' | 'owner' },
        { user_id: 9, full_name: 'Newcomer', last_read_message_id: null, role: 'member' as 'member' | 'owner' },
      ])
      await controller.loadMembers(1)
      expect(store.getState().members[1].find((x) => x.user_id === 9)?.last_read_message_id).toBe(expire ? null : 4)
    }
  })

  it('a rooms_changed that arrives mid-load skips the stale snapshot and applies the trailing one', async () => {
    const { controller, store, api } = setup()
    let release!: (v: Room[]) => void
    api.rooms.mockImplementationOnce(() => new Promise<Room[]>((r) => (release = r)))
    api.rooms.mockResolvedValueOnce([room(1), room(2), room(3)])
    controller.handleSocketEvent({ type: 'rooms_changed' })
    controller.handleSocketEvent({ type: 'rooms_changed' })
    release([room(1)])
    await flush()
    expect(api.rooms).toHaveBeenCalledTimes(2)
    expect(store.getState().rooms.map((r) => r.id).sort()).toEqual([1, 2, 3])
  })

  it('falls back to the skipped snapshot when the trailing rooms_changed reload fails', async () => {
    const { controller, store, api } = setup()
    let release!: (v: Room[]) => void
    api.rooms.mockImplementationOnce(() => new Promise<Room[]>((r) => (release = r)))
    api.rooms.mockRejectedValueOnce(new Error('x'))
    controller.handleSocketEvent({ type: 'rooms_changed' })
    controller.handleSocketEvent({ type: 'rooms_changed' })
    release([room(7)])
    await flush()
    expect(store.getState().rooms.map((r) => r.id)).toEqual([7])
  })

  it('a rooms_changed after a finished burst starts a fresh reload', async () => {
    const { controller, api } = setup()
    controller.handleSocketEvent({ type: 'rooms_changed' })
    await flush()
    controller.handleSocketEvent({ type: 'rooms_changed' })
    await flush()
    expect(api.rooms).toHaveBeenCalledTimes(2)
  })

  it('a read that lands while the first members load is in flight is re-run and applied', async () => {
    const { controller, store, api } = setup()
    await controller.loadRooms()
    let release!: (v: { user_id: number; full_name: string; last_read_message_id: number | null; role: 'member' | 'owner' }[]) => void
    api.members.mockImplementationOnce(() => new Promise((r) => (release = r)))
    void controller.loadMembers(1)
    controller.handleSocketEvent({ type: 'read', room_id: 1, user_id: 2, message_id: 3 })
    release([
      { user_id: 1, full_name: 'Tôi', last_read_message_id: null, role: 'member' as 'member' | 'owner' },
      { user_id: 2, full_name: 'Bob', last_read_message_id: null, role: 'member' as 'member' | 'owner' },
    ])
    await flush()
    expect(api.members.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(store.getState().members[1].find((x) => x.user_id === 2)?.last_read_message_id).toBe(3)
  })

  it('drops buffered reads of rooms that disappear from the list', async () => {
    const { controller, api } = setup()
    await controller.loadRooms()
    controller.handleSocketEvent({ type: 'read', room_id: 2, user_id: 9, message_id: 4 })
    api.rooms.mockResolvedValue([room(1)])
    await controller.loadRooms()
    expect((controller as unknown as { pendingReads: Map<number, unknown> }).pendingReads.has(2)).toBe(false)
  })

  it('coalesces mark-read calls: 5 messages in 500 ms send one POST with the last id', async () => {
    const { controller, api } = setup()
    await controller.loadRooms()
    controller.setActiveRoom(1)
    await controller.openRoom(1)
    vi.advanceTimersByTime(1000)
    api.markRead.mockClear()
    for (let i = 10; i < 15; i++) {
      controller.handleSocketEvent({ type: 'message', message: msg(i) })
      vi.advanceTimersByTime(100)
    }
    expect(api.markRead).toHaveBeenCalledTimes(1) // lan dau gui ngay
    expect(api.markRead).toHaveBeenLastCalledWith(1, 10)
    vi.advanceTimersByTime(1000)
    expect(api.markRead).toHaveBeenCalledTimes(2)
    expect(api.markRead).toHaveBeenLastCalledWith(1, 14)
    vi.advanceTimersByTime(5000)
    expect(api.markRead).toHaveBeenCalledTimes(2)
  })

  it('leaving the room flushes the coalesced mark-read immediately', async () => {
    const { controller, api } = setup()
    await controller.loadRooms()
    controller.setActiveRoom(1)
    await controller.openRoom(1)
    vi.advanceTimersByTime(1000)
    controller.handleSocketEvent({ type: 'message', message: msg(10) })
    controller.handleSocketEvent({ type: 'message', message: msg(11) })
    expect(api.markRead).toHaveBeenLastCalledWith(1, 10)
    controller.leaveRoom(1)
    expect(api.markRead).toHaveBeenLastCalledWith(1, 11)
    vi.advanceTimersByTime(5000)
    expect(api.markRead.mock.calls.filter((c) => c[1] === 11)).toHaveLength(1)
  })

  it('dispose clears the mark-read coalescing timer', async () => {
    const { controller, api } = setup()
    await controller.loadRooms()
    controller.setActiveRoom(1)
    await controller.openRoom(1)
    controller.dispose()
    expect(vi.getTimerCount()).toBe(0)
    expect(api.markRead).toHaveBeenCalled()
  })

  it('typing is reported again right after sending a message', async () => {
    const { controller, socket } = setup()
    controller.sendTyping(1)
    controller.sendTyping(1)
    expect(socket.send.mock.calls.filter((c) => c[0].type === 'typing')).toHaveLength(1)
    controller.send(1, 'xin chào')
    controller.sendTyping(1)
    expect(socket.send.mock.calls.filter((c) => c[0].type === 'typing')).toHaveLength(2)
  })

  it('does not buffer a read for a room whose members were never requested', async () => {
    const { controller } = setup()
    await controller.loadRooms()
    controller.handleSocketEvent({ type: 'read', room_id: 1, user_id: 9, message_id: 4 })
    expect((controller as unknown as { pendingReads: Map<number, unknown> }).pendingReads.has(1)).toBe(false)
  })

  function hiddenSetup() {
    let visible = true
    const store = new ChatStore()
    const api = { rooms: vi.fn().mockResolvedValue([room(1)]), messages: vi.fn().mockResolvedValue(page([1, 2, 3])), markRead: vi.fn().mockResolvedValue(undefined), openDirect: vi.fn(), createGroup: vi.fn(), renameGroup: vi.fn(), addMember: vi.fn(), removeMember: vi.fn(), leaveGroup: vi.fn(), dissolveGroup: vi.fn(), editMessage: vi.fn(), deleteMessage: vi.fn(), directory: vi.fn(), members: vi.fn().mockResolvedValue([]), presence: vi.fn().mockResolvedValue({ online_user_ids: [] }) }
    const controller = new ChatController({ store, api, socket: { send: vi.fn(() => true) }, meId: 1, meName: 'Tôi', isVisible: () => visible })
    return { store, api, controller, setVisible: (v: boolean) => { visible = v } }
  }

  it('the trailing mark-read never covers messages that arrived while the tab was hidden', async () => {
    const { store, api, controller, setVisible } = hiddenSetup()
    await controller.loadRooms()
    controller.setActiveRoom(1)
    await controller.openRoom(1)
    vi.advanceTimersByTime(1000)
    api.markRead.mockClear()
    controller.handleSocketEvent({ type: 'message', message: msg(10) }) // gui ngay
    vi.advanceTimersByTime(200)
    controller.handleSocketEvent({ type: 'message', message: msg(11) }) // dang gop
    vi.advanceTimersByTime(300)
    setVisible(false)
    vi.advanceTimersByTime(500)
    controller.handleSocketEvent({ type: 'message', message: msg(12) }) // an: chua doc
    expect(store.getState().rooms.find((r) => r.id === 1)!.unread_count).toBe(1)
    vi.advanceTimersByTime(1000)
    expect(api.markRead.mock.calls).toEqual([[1, 10]]) // hen gio khi tab an: khong gui gi them
    expect(store.getState().rooms.find((r) => r.id === 1)!.unread_count).toBe(1)
    setVisible(true)
    controller.onVisible()
    expect(api.markRead.mock.calls).toEqual([[1, 10], [1, 11], [1, 12]])
    expect(store.getState().rooms.find((r) => r.id === 1)!.unread_count).toBe(0)
  })

  it('a late failure of an older mark-read does not wipe a newer mark', async () => {
    const { controller, api } = setup()
    await controller.loadRooms()
    controller.setActiveRoom(1)
    let fail!: (e: Error) => void
    api.markRead.mockImplementationOnce(() => new Promise((_, rej) => (fail = rej)))
    await controller.openRoom(1) // POST(1,3) dang bay
    vi.advanceTimersByTime(1000)
    controller.handleSocketEvent({ type: 'message', message: msg(10) }) // POST(1,10)
    fail(new Error('late'))
    await flush()
    vi.advanceTimersByTime(1000)
    controller.handleSocketEvent({ type: 'message', message: msg(10, { id: 10 }) })
    expect(api.markRead.mock.calls.filter((c) => c[1] === 10)).toHaveLength(1) // mốc 10 con nguyen, khong gui lai
  })

  it('dispose flushes a pending coalesced read only when still viewing and visible', async () => {
    for (const visibleAtDispose of [true, false]) {
      const { api, controller, setVisible } = hiddenSetup()
      await controller.loadRooms()
      controller.setActiveRoom(1)
      await controller.openRoom(1)
      vi.advanceTimersByTime(1000)
      api.markRead.mockClear()
      controller.handleSocketEvent({ type: 'message', message: msg(10) })
      controller.handleSocketEvent({ type: 'message', message: msg(11) })
      setVisible(visibleAtDispose)
      api.markRead.mockRejectedValue(new Error('x'))
      controller.dispose()
      await flush()
      expect(api.markRead.mock.calls).toEqual(visibleAtDispose ? [[1, 10], [1, 11]] : [[1, 10]])
    }
  })
})

describe('ChatController: groups', () => {
  const owner = (id: number) => room(id, { my_role: 'owner' })

  it('createGroup upserts the room from the response and returns it', async () => {
    const { controller, api, store } = setup()
    api.createGroup.mockResolvedValueOnce(owner(9))
    api.rooms.mockResolvedValue([room(1), owner(9)]) // the server list includes the new room
    const created = await controller.createGroup('Kho', [2, 3])
    expect(api.createGroup).toHaveBeenCalledWith('Kho', [2, 3])
    expect(created.id).toBe(9)
    expect(store.getState().rooms.find((r) => r.id === 9)?.my_role).toBe('owner')
  })

  it('does not touch the store when the API fails, and rethrows', async () => {
    const { controller, api, store } = setup()
    await controller.loadRooms()
    const before = store.getState().rooms
    api.createGroup.mockRejectedValueOnce(new Error('too_many_groups'))
    await expect(controller.createGroup('Kho', [])).rejects.toThrow('too_many_groups')
    expect(store.getState().rooms).toBe(before)
  })

  it('shares one request between duplicate calls while it is running', async () => {
    const { controller, api } = setup()
    let resolve!: (r: Room) => void
    api.createGroup.mockImplementationOnce(() => new Promise<Room>((r) => (resolve = r)))
    const a = controller.createGroup('Kho', [2])
    const b = controller.createGroup('Kho', [2])
    resolve(owner(9))
    expect((await a).id).toBe(9)
    expect((await b).id).toBe(9)
    expect(api.createGroup).toHaveBeenCalledTimes(1)
  })

  it('renameGroup upserts the returned room', async () => {
    const { controller, api, store } = setup()
    await controller.loadRooms()
    api.renameGroup.mockResolvedValueOnce(room(1, { name: 'Tên mới' }))
    await controller.renameGroup(1, 'Tên mới')
    expect(store.getState().rooms.find((r) => r.id === 1)?.name).toBe('Tên mới')
  })

  it('addMember and removeMember store the returned member list', async () => {
    const { controller, api, store } = setup()
    await controller.loadRooms()
    api.addMember.mockResolvedValueOnce([
      { user_id: 1, full_name: 'Tôi', last_read_message_id: null, role: 'owner' },
      { user_id: 5, full_name: 'Hà', last_read_message_id: null, role: 'member' },
    ])
    await controller.addMember(1, 5)
    expect(api.addMember).toHaveBeenCalledWith(1, 5)
    expect(store.getState().members[1].map((m) => m.user_id)).toEqual([1, 5])
    api.removeMember.mockResolvedValueOnce([{ user_id: 1, full_name: 'Tôi', last_read_message_id: null, role: 'owner' }])
    await controller.removeMember(1, 5)
    expect(store.getState().members[1].map((m) => m.user_id)).toEqual([1])
  })

  it('removeMember failure leaves members untouched', async () => {
    const { controller, api, store } = setup()
    await controller.openRoom(1)
    const before = store.getState().members[1]
    api.removeMember.mockRejectedValueOnce(new Error('forbidden'))
    await expect(controller.removeMember(1, 2)).rejects.toThrow('forbidden')
    expect(store.getState().members[1]).toBe(before)
  })

  it.each(['leaveGroup', 'dissolveGroup'] as const)('%s reloads rooms and prunes the thread, members and typing of that room', async (method) => {
    const { controller, api, store } = setup()
    await controller.loadRooms()
    await controller.openRoom(1)
    controller.handleSocketEvent({ type: 'typing', room_id: 1, user_id: 2, user_name: 'Bob' })
    controller.setActiveRoom(1)
    api.rooms.mockResolvedValue([room(2)])
    await controller[method](1)
    expect(api[method]).toHaveBeenCalledWith(1)
    const s = store.getState()
    expect(s.rooms.map((r) => r.id)).toEqual([2])
    expect(s.threads[1]).toBeUndefined()
    expect(s.members[1]).toBeUndefined()
    expect(s.typing[1]).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('leaveGroup failure keeps the room and thread', async () => {
    const { controller, api, store } = setup()
    await controller.loadRooms()
    await controller.openRoom(1)
    api.leaveGroup.mockRejectedValueOnce(new Error('forbidden'))
    await expect(controller.leaveGroup(1)).rejects.toThrow('forbidden')
    expect(store.getState().rooms.map((r) => r.id).sort()).toEqual([1, 2])
    expect(store.getState().threads[1]).toBeDefined()
  })

  it.each(['leaveGroup', 'dissolveGroup'] as const)('%s removes the room locally even when the reconcile reload fails', async (method) => {
    const { controller, api, store } = setup()
    await controller.loadRooms()
    await controller.openRoom(1)
    controller.handleSocketEvent({ type: 'typing', room_id: 1, user_id: 2, user_name: 'Bob' })
    controller.setActiveRoom(1)
    api.rooms.mockRejectedValue(new Error('down'))
    await expect(controller[method](1)).resolves.toBeUndefined()
    const s = store.getState()
    expect(s.rooms.map((r) => r.id)).toEqual([2])
    expect(s.threads[1]).toBeUndefined()
    expect(s.members[1]).toBeUndefined()
    expect(s.typing[1]).toBeUndefined()
  })

  it('handles rooms_changed arriving before the HTTP response without loading members of the gone room', async () => {
    const { controller, api, store } = setup()
    await controller.loadRooms()
    await controller.openRoom(1)
    controller.setActiveRoom(1)
    let resolve!: () => void
    api.leaveGroup.mockImplementationOnce(() => new Promise<void>((r) => (resolve = r)))
    api.rooms.mockResolvedValue([room(2)])
    const p = controller.leaveGroup(1)
    controller.handleSocketEvent({ type: 'rooms_changed' })
    await vi.waitFor(() => expect(store.getState().rooms.map((r) => r.id)).toEqual([2]))
    api.members.mockClear()
    resolve()
    await p
    controller.handleSocketEvent({ type: 'rooms_changed' })
    await Promise.resolve()
    expect(api.members).not.toHaveBeenCalled()
    expect(store.getState().rooms.map((r) => r.id)).toEqual([2])
    expect(store.getState().threads[1]).toBeUndefined()
  })

  it('drops pending and failed messages of the left group and never resends them', async () => {
    const { controller, api, store, socket } = setup()
    await controller.loadRooms()
    await controller.openRoom(1)
    controller.send(1, 'chờ gửi')
    api.rooms.mockResolvedValue([room(2)])
    await controller.leaveGroup(1)
    expect(store.getState().threads[1]).toBeUndefined()
    socket.send.mockClear()
    controller.handleSocketEvent({ type: 'ready', user_id: 1 })
    vi.advanceTimersByTime(60_000)
    expect(socket.send.mock.calls.filter(([p]) => p.room_id === 1)).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('renameGroup keeps a newer last_message and unread count received before the response', async () => {
    const { controller, api, store } = setup()
    await controller.loadRooms()
    let resolve!: (r: Room) => void
    api.renameGroup.mockImplementationOnce(() => new Promise<Room>((r) => (resolve = r)))
    const p = controller.renameGroup(1, 'Tên mới')
    controller.handleSocketEvent({ type: 'message', message: msg(50, { room_id: 1 }) })
    resolve(room(1, { name: 'Tên mới', my_role: 'owner' }))
    await p
    const r = store.getState().rooms.find((x) => x.id === 1)!
    expect(r.name).toBe('Tên mới')
    expect(r.my_role).toBe('owner')
    expect(r.last_message?.id).toBe(50)
    expect(r.unread_count).toBe(1)
  })

  it('does not merge createGroup calls that have different arguments', async () => {
    const { controller, api } = setup()
    api.createGroup.mockResolvedValueOnce(owner(8)).mockResolvedValueOnce(owner(9))
    const [a, b] = await Promise.all([controller.createGroup('A', [2]), controller.createGroup('B', [3])])
    expect([a.id, b.id]).toEqual([8, 9])
    expect(api.createGroup).toHaveBeenCalledTimes(2)
  })
})
