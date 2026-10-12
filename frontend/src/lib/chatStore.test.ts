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

const page = (ids: number[], more = false): MessagePage => ({
  items: ids.map((id) => msg(id)),
  has_more_before: more,
  has_more_after: more,
})

const room = (id: number, over: Partial<Room> = {}): Room => ({
  id,
  type: 'group',
  name: `Phòng ${id}`,
  branch_id: null,
  member_count: 3,
  peer_id: null,
  last_message: null,
  unread_count: 0,
  last_activity: '2026-10-15T08:00:00.000Z',
  ...over,
})

const ids = (store: ChatStore, roomId = 1) => store.getState().threads[roomId]?.items.map((m) => m.id)

describe('ChatStore threads', () => {
  it('replaces the newest page but keeps pending messages at the end', () => {
    const store = new ChatStore()
    store.applyLatest(1, page([5, 6], true))
    store.addPending(1, { ...msg(-1, { client_id: 'c1', sender_id: 1 }), pending: 'sending' })
    store.applyLatest(1, page([5, 6, 7], true))
    expect(ids(store)).toEqual([5, 6, 7, -1])
    expect(store.getState().threads[1].hasMoreBefore).toBe(true)
    expect(store.getState().threads[1].loaded).toBe(true)
  })

  it('prepends older pages without duplicates and updates hasMoreBefore', () => {
    const store = new ChatStore()
    store.applyLatest(1, page([5, 6], true))
    store.applyOlder(1, page([3, 4, 5], false))
    expect(ids(store)).toEqual([3, 4, 5, 6])
    expect(store.getState().threads[1].hasMoreBefore).toBe(false)
  })

  it('appends catch-up pages in order without duplicates', () => {
    const store = new ChatStore()
    store.applyLatest(1, page([5, 6]))
    store.applyAfter(1, page([6, 7, 8]))
    expect(ids(store)).toEqual([5, 6, 7, 8])
  })

  it('replaces a pending message when the real one arrives with the same client_id', () => {
    const store = new ChatStore()
    store.applyLatest(1, page([5]))
    store.addPending(1, { ...msg(-1, { client_id: 'c1', sender_id: 1, body: 'xin chào' }), pending: 'sending' })
    store.upsertMessage(msg(6, { client_id: 'c1', sender_id: 1, body: 'xin chào' }))
    expect(ids(store)).toEqual([5, 6])
    expect(store.getState().threads[1].items.some((m) => m.pending)).toBe(false)
  })

  it('upserts by id, keeping order, and ignores threads that were never loaded', () => {
    const store = new ChatStore()
    store.upsertMessage(msg(9, { room_id: 2 }))
    expect(store.getState().threads[2]).toBeUndefined()
    store.applyLatest(1, page([5, 7]))
    store.upsertMessage(msg(6))
    store.upsertMessage(msg(7, { body: 'sửa' }))
    expect(ids(store)).toEqual([5, 6, 7])
    expect(store.getState().threads[1].items[2].body).toBe('sửa')
  })

  it('replaces updated messages and hides deleted ones, also in the room preview', () => {
    const store = new ChatStore()
    store.setRooms([room(1, { last_message: msg(7) })])
    store.applyLatest(1, page([6, 7]))
    store.replaceMessage(msg(7, { body: 'đã sửa', edited_at: '2026-10-15T10:00:00.000Z' }))
    expect(store.getState().rooms[0].last_message?.body).toBe('đã sửa')
    store.markDeleted(1, 7)
    const last = store.getState().threads[1].items[1]
    expect(last.deleted).toBe(true)
    expect(last.body).toBe('')
    expect(store.getState().rooms[0].last_message?.deleted).toBe(true)
    expect(store.getState().rooms[0].last_message?.body).toBe('')
  })

  it('tracks pending state, failures with an error code, and removal', () => {
    const store = new ChatStore()
    store.addPending(1, { ...msg(-1, { client_id: 'c1', sender_id: 1 }), pending: 'sending' })
    store.setPendingState('c1', 'failed', 'rate_limited')
    const failed = store.getState().threads[1].items[0]
    expect(failed.pending).toBe('failed')
    expect(failed.errorCode).toBe('rate_limited')
    store.setPendingState('c1', 'sending')
    expect(store.getState().threads[1].items[0].errorCode).toBeUndefined()
    store.removePending('c1')
    expect(ids(store)).toEqual([])
  })

  it('notifies subscribers on every change and produces new snapshots', () => {
    const store = new ChatStore()
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)
    const before = store.getState()
    store.setStatus('open')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.getState()).not.toBe(before)
    unsubscribe()
    store.setStatus('offline')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('reset() clears everything', () => {
    const store = new ChatStore()
    store.setRooms([room(1)])
    store.applyLatest(1, page([1]))
    store.reset()
    expect(store.getState().rooms).toEqual([])
    expect(store.getState().threads).toEqual({})
    expect(store.getState().roomsLoaded).toBe(false)
  })
})

describe('ChatStore rooms', () => {
  it('bumps the preview, activity and unread count and re-sorts the list', () => {
    const store = new ChatStore()
    store.setRooms([room(1, { last_activity: '2026-10-15T09:00:00.000Z' }), room(2, { last_activity: '2026-10-15T08:00:00.000Z' })])
    const found = store.bumpRoom(msg(30, { room_id: 2, created_at: '2026-10-15T10:00:00.000Z' }), true)
    expect(found).toBe(true)
    expect(store.getState().rooms.map((r) => r.id)).toEqual([2, 1])
    expect(store.getState().rooms[0].unread_count).toBe(1)
    expect(store.getState().rooms[0].last_message?.id).toBe(30)
  })

  it('does not bump when the message is older than the current preview or the room is unknown', () => {
    const store = new ChatStore()
    store.setRooms([room(1, { last_message: msg(10), unread_count: 2 })])
    expect(store.bumpRoom(msg(9), true)).toBe(true)
    expect(store.getState().rooms[0].last_message?.id).toBe(10)
    expect(store.getState().rooms[0].unread_count).toBe(2)
    expect(store.bumpRoom(msg(11, { room_id: 99 }), true)).toBe(false)
  })

  it('does not count unread when told not to, and clears unread', () => {
    const store = new ChatStore()
    store.setRooms([room(1, { unread_count: 3 })])
    store.bumpRoom(msg(1), false)
    expect(store.getState().rooms[0].unread_count).toBe(3)
    store.clearUnread(1)
    expect(store.getState().rooms[0].unread_count).toBe(0)
  })

  it('adds a new room with upsertRoom and replaces an existing one', () => {
    const store = new ChatStore()
    store.upsertRoom(room(5, { name: 'A' }))
    store.upsertRoom(room(5, { name: 'B' }))
    expect(store.getState().rooms).toHaveLength(1)
    expect(store.getState().rooms[0].name).toBe('B')
  })
})
