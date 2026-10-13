import type { Message, MessagePage, Reply, Room, RoomMember } from './types'
import type { SocketStatus } from './ws'

export interface ChatMessage extends Message {
  pending?: 'sending' | 'failed'
  errorCode?: string
}

export interface Thread {
  items: ChatMessage[]
  hasMoreBefore: boolean
  loaded: boolean
  loadingOlder: boolean
  error: boolean
}

export interface ChatState {
  status: SocketStatus
  /** Đã từng kết nối thành công (nhận ready) trong phiên này. */
  hasConnected: boolean
  rooms: Room[]
  roomsLoaded: boolean
  roomsError: boolean
  threads: Record<number, Thread>
  /** Thành viên theo phòng (kèm mốc đã đọc). */
  members: Record<number, RoomMember[]>
  /** Tập user_id đang online. */
  online: Record<number, true>
  /** Phòng -> người đang soạn tin -> hạn (ms epoch). */
  typing: Record<number, Record<number, { name: string; until: number }>>
}

export const EMPTY_THREAD: Thread = { items: [], hasMoreBefore: false, loaded: false, loadingOlder: false, error: false }

const isPending = (m: ChatMessage) => m.pending !== undefined

/** Gộp tin thật (theo id, tăng dần); tin đang chờ luôn nằm cuối, giữ nguyên thứ tự tạo. */
function mergeReal(existing: ChatMessage[], incoming: Message[]): ChatMessage[] {
  const byId = new Map<number, ChatMessage>()
  for (const m of existing) if (!isPending(m)) byId.set(m.id, m)
  for (const m of incoming) byId.set(m.id, m)
  const real = [...byId.values()].sort((a, b) => a.id - b.id)
  // Tin đang chờ đã có bản thật (cùng client_id + người gửi) thì bỏ đi, bất kể đang sending hay failed.
  const delivered = new Set(incoming.filter((m) => m.client_id).map((m) => `${m.sender_id}:${m.client_id}`))
  const pending = existing.filter((m) => isPending(m) && !(m.client_id && delivered.has(`${m.sender_id}:${m.client_id}`)))
  return [...real, ...pending]
}

function sortRooms(rooms: Room[]): Room[] {
  return [...rooms].sort((a, b) => (a.last_activity < b.last_activity ? 1 : a.last_activity > b.last_activity ? -1 : b.id - a.id))
}

export class ChatStore {
  private state: ChatState = { status: 'offline', hasConnected: false, rooms: [], roomsLoaded: false, roomsError: false, threads: {}, members: {}, online: {}, typing: {} }
  private readonly listeners = new Set<() => void>()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getState = (): ChatState => this.state

  private set(patch: Partial<ChatState>): void {
    this.state = { ...this.state, ...patch }
    this.listeners.forEach((listener) => listener())
  }

  private updateThread(roomId: number, fn: (thread: Thread) => Thread): void {
    const current = this.state.threads[roomId] ?? EMPTY_THREAD
    this.set({ threads: { ...this.state.threads, [roomId]: fn(current) } })
  }

  setStatus(status: SocketStatus): void {
    if (this.state.status !== status || (status === 'open' && !this.state.hasConnected)) {
      this.set({ status, hasConnected: this.state.hasConnected || status === 'open' })
    }
  }

  setRooms(rooms: Room[]): void {
    // Không để bản chụp danh sách cũ ghi đè xem trước mới hơn đã nhận qua WebSocket.
    const merged = rooms.map((r) => {
      const cur = this.state.rooms.find((x) => x.id === r.id)
      if (cur?.last_message && (!r.last_message || cur.last_message.id > r.last_message.id)) {
        // Bản chụp cũ: đã bỏ sót các tin mới nhận qua WebSocket nên không được đếm thiếu chưa đọc.
        return {
          ...r,
          last_message: cur.last_message,
          last_activity: cur.last_activity > r.last_activity ? cur.last_activity : r.last_activity,
          unread_count: Math.max(r.unread_count, cur.unread_count),
          unread_mentions: Math.max(r.unread_mentions, cur.unread_mentions),
        }
      }
      return r
    })
    this.set({ rooms: sortRooms(merged), roomsLoaded: true, roomsError: false })
  }

  setRoomsError(): void {
    this.set({ roomsError: true })
  }

  upsertRoom(room: Room): void {
    const others = this.state.rooms.filter((r) => r.id !== room.id)
    this.set({ rooms: sortRooms([...others, room]) })
  }

  applyLatest(roomId: number, page: MessagePage): void {
    this.updateThread(roomId, (t) => {
      // Giữ tin thật mới hơn trang vừa tải (đến qua WebSocket trong lúc đang tải).
      const maxId = page.items.reduce((acc, m) => Math.max(acc, m.id), 0)
      const keep = t.items.filter((m) => isPending(m) || m.id > maxId)
      return { ...t, items: mergeReal(keep, page.items), hasMoreBefore: page.has_more_before, loaded: true, error: false }
    })
  }

  applyOlder(roomId: number, page: MessagePage): void {
    this.updateThread(roomId, (t) => ({
      ...t,
      items: mergeReal(t.items, page.items),
      hasMoreBefore: page.has_more_before,
      loadingOlder: false,
    }))
  }

  applyAfter(roomId: number, page: MessagePage): void {
    this.updateThread(roomId, (t) => ({ ...t, items: mergeReal(t.items, page.items) }))
  }

  setThreadLoadingOlder(roomId: number, loadingOlder: boolean): void {
    this.updateThread(roomId, (t) => ({ ...t, loadingOlder }))
  }

  setThreadError(roomId: number, error: boolean): void {
    this.updateThread(roomId, (t) => ({ ...t, error }))
  }

  /** Tin mới (từ WebSocket): cập nhật thread đã tải và thay thế tin lạc quan cùng client_id. */
  upsertMessage(message: Message): void {
    // Thread chưa tải: đệm tin (loaded:false) để applyLatest gộp lại, không mất tin.
    const thread = this.state.threads[message.room_id] ?? EMPTY_THREAD
    const items = message.client_id
      ? thread.items.filter((m) => !(isPending(m) && m.client_id === message.client_id))
      : thread.items
    this.set({
      threads: { ...this.state.threads, [message.room_id]: { ...thread, items: mergeReal(items, [message]) } },
    })
  }

  replaceMessage(message: Message): void {
    const thread = this.state.threads[message.room_id]
    const threads = thread
      ? {
          ...this.state.threads,
          [message.room_id]: { ...thread, items: thread.items.map((m) => (m.id === message.id ? { ...message } : m)) },
        }
      : this.state.threads
    const rooms = this.state.rooms.map((r) => (r.id === message.room_id && r.last_message?.id === message.id ? { ...r, last_message: message } : r))
    this.set({ threads, rooms })
  }

  markDeleted(roomId: number, messageId: number): void {
    const hide = (m: Message): Message => (m.id === messageId ? { ...m, deleted: true, body: '' } : m)
    const thread = this.state.threads[roomId]
    const threads = thread
      ? { ...this.state.threads, [roomId]: { ...thread, items: thread.items.map((m) => hide(m) as ChatMessage) } }
      : this.state.threads
    const rooms = this.state.rooms.map((r) => (r.id === roomId && r.last_message ? { ...r, last_message: hide(r.last_message) } : r))
    this.set({ threads, rooms })
  }

  /** Cập nhật trích dẫn của mọi tin đã tải (và xem trước phòng) đang trả lời `messageId`; không đổi gì thì không phát sự kiện. */
  refreshQuotes(roomId: number, messageId: number, patch: Partial<Pick<Reply, 'snippet' | 'deleted'>>): void {
    const apply = <T extends Message>(m: T): T => (m.reply_to?.id === messageId ? { ...m, reply_to: { ...m.reply_to, ...patch } } : m)
    const thread = this.state.threads[roomId]
    const items = thread?.items.map(apply)
    const threadChanged = !!thread && items!.some((m, i) => m !== thread.items[i])
    const rooms = this.state.rooms.map((r) => {
      if (r.id !== roomId || !r.last_message) return r
      const lm = apply(r.last_message)
      return lm === r.last_message ? r : { ...r, last_message: lm }
    })
    const roomsChanged = rooms.some((r, i) => r !== this.state.rooms[i])
    if (!threadChanged && !roomsChanged) return
    this.set({
      ...(threadChanged ? { threads: { ...this.state.threads, [roomId]: { ...thread!, items: items! } } } : {}),
      ...(roomsChanged ? { rooms } : {}),
    })
  }

  /** Tin có nằm trong danh sách đã tải của phòng không (cho phép bấm trích dẫn để cuộn tới). */
  hasLoaded(roomId: number, messageId: number): boolean {
    return !!this.state.threads[roomId]?.items.some((m) => !m.pending && m.id === messageId)
  }

  addPending(roomId: number, message: ChatMessage): void {
    this.updateThread(roomId, (t) => ({ ...t, items: [...t.items, message] }))
  }

  setPendingState(clientId: string, pending: 'sending' | 'failed', errorCode?: string): void {
    const threads: Record<number, Thread> = {}
    for (const [key, thread] of Object.entries(this.state.threads)) {
      threads[Number(key)] = {
        ...thread,
        items: thread.items.map((m) => {
          if (!isPending(m) || m.client_id !== clientId) return m
          const { errorCode: _drop, ...rest } = m
          return { ...rest, pending, ...(pending === 'failed' && errorCode ? { errorCode } : {}) }
        }),
      }
    }
    this.set({ threads })
  }

  removePending(clientId: string): void {
    const threads: Record<number, Thread> = {}
    for (const [key, thread] of Object.entries(this.state.threads)) {
      threads[Number(key)] = { ...thread, items: thread.items.filter((m) => !(isPending(m) && m.client_id === clientId)) }
    }
    this.set({ threads })
  }

  /** Cập nhật xem trước/hoạt động/chưa đọc của phòng. Trả false nếu phòng chưa có trong danh sách. */
  bumpRoom(message: Message, countUnread: boolean, countMention = false): boolean {
    const room = this.state.rooms.find((r) => r.id === message.room_id)
    if (!room) return false
    const newer = !room.last_message || message.id > room.last_message.id
    if (!newer) return true
    this.set({
      rooms: sortRooms(
        this.state.rooms.map((r) =>
          r.id === room.id
            ? { ...r, last_message: message, last_activity: message.created_at, unread_count: r.unread_count + (countUnread ? 1 : 0),
                unread_mentions: r.unread_mentions + (countUnread && countMention ? 1 : 0),
              }
            : r,
        ),
      ),
    })
    return true
  }

  clearUnread(roomId: number): void {
    this.set({ rooms: this.state.rooms.map((r) => (r.id === roomId && (r.unread_count !== 0 || r.unread_mentions !== 0) ? { ...r, unread_count: 0, unread_mentions: 0 } : r)) })
  }

  removeRoom(roomId: number): void {
    if (!this.state.rooms.some((r) => r.id === roomId)) return
    this.set({ rooms: this.state.rooms.filter((r) => r.id !== roomId) })
  }

  removeThreads(roomIds: number[]): void {
    const threads = { ...this.state.threads }
    const members = { ...this.state.members }
    const typing = { ...this.state.typing }
    for (const id of roomIds) {
      delete threads[id]
      delete members[id]
      delete typing[id]
    }
    this.set({ threads, members, typing })
  }

  /** Thay danh sách thành viên; mốc đã đọc chỉ tăng nên bản REST cũ không làm lùi mốc đã nhận qua WebSocket. */
  setMembers(roomId: number, incoming: RoomMember[]): void {
    const existing = new Map((this.state.members[roomId] ?? []).map((m) => [m.user_id, m.last_read_message_id]))
    const merged = incoming.map((m) => {
      const cur = existing.get(m.user_id)
      const next = cur != null && (m.last_read_message_id == null || cur > m.last_read_message_id) ? cur : m.last_read_message_id
      return { ...m, last_read_message_id: next }
    })
    this.set({ members: { ...this.state.members, [roomId]: merged } })
  }

  /** Chỉ tăng mốc của thành viên đã biết; bỏ qua khi danh sách chưa tải. Trả true nếu có thay đổi. */
  applyRead(roomId: number, userId: number, messageId: number): boolean {
    const list = this.state.members[roomId]
    if (!list) return false
    const idx = list.findIndex((m) => m.user_id === userId)
    if (idx < 0) return false
    const cur = list[idx].last_read_message_id
    if (cur != null && cur >= messageId) return false
    const next = list.map((m, i) => (i === idx ? { ...m, last_read_message_id: messageId } : m))
    this.set({ members: { ...this.state.members, [roomId]: next } })
    return true
  }

  /** Thay tập online bằng bản chụp; `keep` là các user có cập nhật trực tiếp mới hơn bản chụp nên giữ nguyên trạng thái hiện tại. */
  setOnline(ids: number[], keep: number[] = []): void {
    const online: Record<number, true> = {}
    for (const id of ids) online[id] = true
    for (const id of keep) {
      if (this.state.online[id]) online[id] = true
      else delete online[id]
    }
    this.set({ online })
  }

  setPresence(userId: number, isOnline: boolean): void {
    if (!!this.state.online[userId] === isOnline) return
    const online = { ...this.state.online }
    if (isOnline) online[userId] = true
    else delete online[userId]
    this.set({ online })
  }

  setTyping(roomId: number, userId: number, name: string, until: number): void {
    this.set({ typing: { ...this.state.typing, [roomId]: { ...this.state.typing[roomId], [userId]: { name, until } } } })
  }

  clearTyping(roomId: number, userId: number): void {
    const room = this.state.typing[roomId]
    if (!room || !(userId in room)) return
    const { [userId]: _drop, ...rest } = room
    const typing = { ...this.state.typing }
    if (Object.keys(rest).length === 0) delete typing[roomId]
    else typing[roomId] = rest
    this.set({ typing })
  }

  pruneTyping(now: number): void {
    let changed = false
    const typing: ChatState['typing'] = {}
    for (const [roomKey, users] of Object.entries(this.state.typing)) {
      const kept = Object.fromEntries(Object.entries(users).filter(([, v]) => v.until > now))
      if (Object.keys(kept).length !== Object.keys(users).length) changed = true
      if (Object.keys(kept).length > 0) typing[Number(roomKey)] = kept as Record<number, { name: string; until: number }>
    }
    if (changed) this.set({ typing })
  }
}
