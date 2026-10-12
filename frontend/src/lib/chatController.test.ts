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
  last_message: null, unread_count: 0, last_activity: '2026-10-15T08:00:00.000Z', ...over,
})

function setup(opts: { visible?: boolean; open?: boolean } = {}) {
  const store = new ChatStore()
  const api = {
    rooms: vi.fn().mockResolvedValue([room(1), room(2)]),
    messages: vi.fn().mockResolvedValue(page([1, 2, 3])),
    markRead: vi.fn().mockResolvedValue(undefined),
    openDirect: vi.fn(),
    editMessage: vi.fn(),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
    directory: vi.fn(),
  }
  let isOpen = opts.open ?? true
  const socket = { send: vi.fn((_payload: Record<string, unknown>) => isOpen), getStatus: () => (isOpen ? 'open' : 'offline') as 'open' | 'offline' }
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
  })
  return { store, api, socket, controller, setOpen: (v: boolean) => { isOpen = v } }
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
    controller.handleSocketEvent({ type: 'message', message: msg(10, { room_id: 1 }) })
    expect(store.getState().rooms.find((r) => r.id === 1)!.unread_count).toBe(0)
    expect(api.markRead).toHaveBeenCalledWith(1, 10)
  })

  it('counts as unread when the room is open but the tab is hidden, then marks read when it becomes visible', async () => {
    let visible = false
    const store = new ChatStore()
    const api = { rooms: vi.fn().mockResolvedValue([room(1)]), messages: vi.fn().mockResolvedValue(page([1])), markRead: vi.fn().mockResolvedValue(undefined), openDirect: vi.fn(), editMessage: vi.fn(), deleteMessage: vi.fn(), directory: vi.fn() }
    const controller = new ChatController({ store, api, socket: { send: vi.fn(() => true), getStatus: () => 'open' }, meId: 1, meName: 'Tôi', isVisible: () => visible })
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
