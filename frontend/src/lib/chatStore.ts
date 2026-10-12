import type { Message, MessagePage, Room } from './types'
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
  rooms: Room[]
  roomsLoaded: boolean
  roomsError: boolean
  threads: Record<number, Thread>
}

export const EMPTY_THREAD: Thread = { items: [], hasMoreBefore: false, loaded: false, loadingOlder: false, error: false }

const isPending = (m: ChatMessage) => m.pending !== undefined

/** Gộp tin thật (theo id, tăng dần); tin đang chờ luôn nằm cuối, giữ nguyên thứ tự tạo. */
function mergeReal(existing: ChatMessage[], incoming: Message[]): ChatMessage[] {
  const byId = new Map<number, ChatMessage>()
  for (const m of existing) if (!isPending(m)) byId.set(m.id, m)
  for (const m of incoming) byId.set(m.id, m)
  const real = [...byId.values()].sort((a, b) => a.id - b.id)
  return [...real, ...existing.filter(isPending)]
}

function sortRooms(rooms: Room[]): Room[] {
  return [...rooms].sort((a, b) => (a.last_activity < b.last_activity ? 1 : a.last_activity > b.last_activity ? -1 : b.id - a.id))
}

export class ChatStore {
  private state: ChatState = { status: 'offline', rooms: [], roomsLoaded: false, roomsError: false, threads: {} }
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
    if (this.state.status !== status) this.set({ status })
  }

  setRooms(rooms: Room[]): void {
    this.set({ rooms: sortRooms(rooms), roomsLoaded: true, roomsError: false })
  }

  setRoomsError(): void {
    this.set({ roomsError: true })
  }

  upsertRoom(room: Room): void {
    const others = this.state.rooms.filter((r) => r.id !== room.id)
    this.set({ rooms: sortRooms([...others, room]) })
  }

  applyLatest(roomId: number, page: MessagePage): void {
    this.updateThread(roomId, (t) => ({
      ...t,
      items: mergeReal(t.items.filter(isPending), page.items),
      hasMoreBefore: page.has_more_before,
      loaded: true,
      error: false,
    }))
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
    const thread = this.state.threads[message.room_id]
    if (!thread) return
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
  bumpRoom(message: Message, countUnread: boolean): boolean {
    const room = this.state.rooms.find((r) => r.id === message.room_id)
    if (!room) return false
    const newer = !room.last_message || message.id > room.last_message.id
    if (!newer) return true
    this.set({
      rooms: sortRooms(
        this.state.rooms.map((r) =>
          r.id === room.id
            ? { ...r, last_message: message, last_activity: message.created_at, unread_count: r.unread_count + (countUnread ? 1 : 0) }
            : r,
        ),
      ),
    })
    return true
  }

  clearUnread(roomId: number): void {
    this.set({ rooms: this.state.rooms.map((r) => (r.id === roomId && r.unread_count !== 0 ? { ...r, unread_count: 0 } : r)) })
  }

  reset(): void {
    this.set({ rooms: [], roomsLoaded: false, roomsError: false, threads: {} })
  }
}
