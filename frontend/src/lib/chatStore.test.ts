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
  reply_to: null,
  mentions: [],
  mention_all: false,
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
  unread_mentions: 0,
  last_activity: '2026-10-15T08:00:00.000Z',
  my_role: 'member',
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

  it('upserts by id, keeping order, and buffers messages for threads that are not loaded yet', () => {
    const store = new ChatStore()
    store.upsertMessage(msg(9, { room_id: 2 }))
    expect(store.getState().threads[2].loaded).toBe(false)
    expect(store.getState().threads[2].items.map((m) => m.id)).toEqual([9])
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
})

describe('ChatStore reconciliation and buffering', () => {
  it('drops a pending (failed or sending) message when a page contains the same client_id from the same sender', () => {
    for (const apply of ['applyAfter', 'applyLatest', 'applyOlder'] as const) {
      const store = new ChatStore()
      store.applyLatest(1, page([5]))
      store.addPending(1, { ...msg(-1, { client_id: 'c1', sender_id: 1 }), pending: 'failed' })
      store.addPending(1, { ...msg(-2, { client_id: 'c2', sender_id: 1 }), pending: 'sending' })
      store[apply](1, { items: [msg(6, { client_id: 'c1', sender_id: 1 })], has_more_before: false, has_more_after: false })
      expect(ids(store)).toEqual(apply === 'applyLatest' ? [6, -2] : [5, 6, -2]) // applyLatest replaces the real items
    }
  })

  it('keeps a pending message when the same client_id belongs to another sender', () => {
    const store = new ChatStore()
    store.addPending(1, { ...msg(-1, { client_id: 'c1', sender_id: 1 }), pending: 'sending' })
    store.applyAfter(1, { items: [msg(6, { client_id: 'c1', sender_id: 2 })], has_more_before: false, has_more_after: false })
    expect(ids(store)).toEqual([6, -1])
  })

  it('applyLatest keeps live messages newer than the page (arrived while loading)', () => {
    const store = new ChatStore()
    store.upsertMessage(msg(4))
    store.applyLatest(1, page([1, 2, 3]))
    expect(ids(store)).toEqual([1, 2, 3, 4])
    expect(store.getState().threads[1].loaded).toBe(true)
  })

  it('a buffered message in an errored thread survives the retry', () => {
    const store = new ChatStore()
    store.setThreadError(1, true)
    store.upsertMessage(msg(4))
    store.applyLatest(1, page([1, 2, 3]))
    expect(ids(store)).toEqual([1, 2, 3, 4])
    expect(store.getState().threads[1].error).toBe(false)
  })

  it('setRooms keeps the higher unread count only when the store saw newer messages', () => {
    const store = new ChatStore()
    store.setRooms([room(1, { last_message: msg(10), unread_count: 3 })])
    store.setRooms([room(1, { last_message: msg(8), unread_count: 1 })]) // snapshot older: store wins
    expect(store.getState().rooms[0].unread_count).toBe(3)
    store.setRooms([room(1, { last_message: msg(12), unread_count: 0 })]) // snapshot newer: read elsewhere
    expect(store.getState().rooms[0].unread_count).toBe(0)
    store.setRooms([room(1, { last_message: msg(12), unread_count: 5 })]) // same message: snapshot wins
    expect(store.getState().rooms[0].unread_count).toBe(5)
  })

  it('setRooms does not replace a newer preview with an older snapshot', () => {
    const store = new ChatStore()
    store.setRooms([room(1, { last_message: msg(10) })])
    store.setRooms([room(1, { last_message: msg(8) })])
    expect(store.getState().rooms[0].last_message?.id).toBe(10)
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

describe('ChatStore members, presence and typing', () => {
  const mem = (user_id: number, last: number | null) => ({ user_id, full_name: `U${user_id}`, last_read_message_id: last, role: 'member' as const })

  it('applyRead only increases and is ignored before members load or for unknown users', () => {
    const store = new ChatStore()
    store.applyRead(1, 2, 5)
    expect(store.getState().members[1]).toBeUndefined()
    store.setMembers(1, [mem(2, 3), mem(3, null)])
    const before = store.getState()
    store.applyRead(1, 2, 2)
    store.applyRead(1, 99, 9)
    expect(store.getState()).toBe(before)
    store.applyRead(1, 2, 7)
    store.applyRead(1, 3, 1)
    expect(store.getState()).not.toBe(before)
    expect(store.getState().members[1].map((m) => m.last_read_message_id)).toEqual([7, 1])
  })

  it('setMembers keeps the higher read marker so a stale snapshot never regresses', () => {
    const store = new ChatStore()
    store.setMembers(1, [mem(2, 3)])
    store.applyRead(1, 2, 8)
    store.setMembers(1, [mem(2, 5), mem(4, null)])
    expect(store.getState().members[1].map((m) => [m.user_id, m.last_read_message_id])).toEqual([[2, 8], [4, null]])
    store.setMembers(1, [mem(2, 9)])
    expect(store.getState().members[1][0].last_read_message_id).toBe(9)
  })

  it('setTyping, clearTyping and pruneTyping remove exactly the expired entries', () => {
    const store = new ChatStore()
    store.setTyping(1, 2, 'B', 100)
    store.setTyping(1, 3, 'C', 200)
    store.setTyping(2, 4, 'D', 50)
    store.pruneTyping(100)
    expect(store.getState().typing).toEqual({ 1: { 3: { name: 'C', until: 200 } } })
    store.clearTyping(1, 3)
    expect(store.getState().typing).toEqual({})
  })

  it('setPresence and setOnline produce new snapshots; setOnline honours keep', () => {
    const store = new ChatStore()
    store.setOnline([1, 2])
    store.setPresence(3, true)
    const s = store.getState()
    store.setPresence(3, true)
    expect(store.getState()).toBe(s)
    store.setOnline([1], [2, 3])
    expect(Object.keys(store.getState().online).sort()).toEqual(['1', '2', '3'])
    store.setPresence(2, false)
    expect(store.getState().online[2]).toBeUndefined()
  })

  it('removeThreads also drops members and typing of those rooms', () => {
    const store = new ChatStore()
    store.setMembers(1, [mem(2, null)])
    store.setMembers(2, [mem(2, null)])
    store.setTyping(1, 2, 'B', 10)
    store.setTyping(2, 2, 'B', 10)
    store.removeThreads([1])
    expect(Object.keys(store.getState().members)).toEqual(['2'])
    expect(Object.keys(store.getState().typing)).toEqual(['2'])
  })
})

describe('ChatStore replies and mentions', () => {
  const reply = (id: number) => ({ id, sender_id: 3, sender_name: 'Cy', snippet: 'gốc', deleted: false })

  it('refreshQuotes updates only loaded messages quoting that id, with new snapshots', () => {
    const store = new ChatStore()
    store.applyLatest(1, { items: [msg(1), msg(2, { reply_to: reply(1) }), msg(3, { reply_to: reply(9) })], has_more_before: false, has_more_after: false })
    const before = store.getState().threads[1].items
    store.refreshQuotes(1, 1, { snippet: 'mới', deleted: false })
    const after = store.getState().threads[1].items
    expect(after[1].reply_to).toMatchObject({ id: 1, snippet: 'mới' })
    expect(after[2]).toBe(before[2])
    expect(after[1]).not.toBe(before[1])
    expect(before[1].reply_to?.snippet).toBe('gốc')
    store.refreshQuotes(1, 1, { snippet: '', deleted: true })
    expect(store.getState().threads[1].items[1].reply_to).toMatchObject({ snippet: '', deleted: true })
  })

  it('refreshQuotes is a no-op (no notification) when nothing quotes the id', () => {
    const store = new ChatStore()
    store.applyLatest(1, { items: [msg(1)], has_more_before: false, has_more_after: false })
    const listener = vi.fn()
    store.subscribe(listener)
    store.refreshQuotes(1, 5, { deleted: true })
    store.refreshQuotes(7, 5, { deleted: true })
    expect(listener).not.toHaveBeenCalled()
  })

  it('hasLoaded reports only real loaded messages', () => {
    const store = new ChatStore()
    store.applyLatest(1, { items: [msg(4)], has_more_before: false, has_more_after: false })
    expect(store.hasLoaded(1, 4)).toBe(true)
    expect(store.hasLoaded(1, 5)).toBe(false)
    expect(store.hasLoaded(2, 4)).toBe(false)
  })

  it('bumpRoom counts unread_mentions only when asked and unread is counted', () => {
    const store = new ChatStore()
    store.setRooms([room(1)])
    store.bumpRoom(msg(1), true, true)
    store.bumpRoom(msg(2), true, false)
    store.bumpRoom(msg(3), false, true)
    const r = store.getState().rooms[0]
    expect(r.unread_count).toBe(2)
    expect(r.unread_mentions).toBe(1)
  })

  it('clearUnread resets unread_mentions and setRooms does not let a stale snapshot lower it', () => {
    const store = new ChatStore()
    store.setRooms([room(1, { last_message: msg(10), unread_count: 3, unread_mentions: 2 })])
    store.setRooms([room(1, { last_message: msg(8), unread_count: 1, unread_mentions: 0 })])
    expect(store.getState().rooms[0]).toMatchObject({ unread_count: 3, unread_mentions: 2 })
    store.clearUnread(1)
    expect(store.getState().rooms[0]).toMatchObject({ unread_count: 0, unread_mentions: 0 })
  })
})
