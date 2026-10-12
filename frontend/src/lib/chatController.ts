import type { ChatApi } from './chatApi'
import { EMPTY_THREAD, type ChatMessage, type ChatStore } from './chatStore'
import type { Message, Room, ServerEvent } from './types'
import type { SocketStatus } from './ws'

export interface ChatControllerDeps {
  store: ChatStore
  api: ChatApi
  socket: { send(payload: object): boolean; getStatus(): SocketStatus }
  meId: number
  meName: string
  newClientId?: () => string
  isVisible?: () => boolean
  sendTimeoutMs?: number
}

const PAGE_SIZE = 50
const CATCH_UP_PAGE = 100
const CATCH_UP_MAX_PAGES = 20

interface PendingMeta {
  roomId: number
  body: string
}

export class ChatController {
  private activeRoom: number | null = null
  private roomsSeq = 0
  private nextLocalId = -1
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly pendingMeta = new Map<string, PendingMeta>()
  private readonly lastMarked = new Map<number, number>()

  constructor(private readonly deps: ChatControllerDeps) {}

  // ---- tải dữ liệu ----

  async loadRooms(): Promise<void> {
    const seq = ++this.roomsSeq
    try {
      const rooms = await this.deps.api.rooms()
      if (seq === this.roomsSeq) {
        this.deps.store.setRooms(rooms)
        // Bản chụp cũ có thể khôi phục huy hiệu chưa đọc của phòng đã đánh dấu đọc.
        for (const r of this.deps.store.getState().rooms) {
          if (r.unread_count > 0 && r.last_message && (this.lastMarked.get(r.id) ?? 0) >= r.last_message.id) {
            this.deps.store.clearUnread(r.id)
          }
        }
      }
    } catch {
      if (seq === this.roomsSeq) this.deps.store.setRoomsError()
    }
  }

  async openRoom(roomId: number): Promise<void> {
    const thread = this.deps.store.getState().threads[roomId]
    if (thread?.loaded) await this.catchUp(roomId)
    else await this.loadLatest(roomId)
    this.markReadIfViewing(roomId)
  }

  private async loadLatest(roomId: number): Promise<void> {
    try {
      const page = await this.deps.api.messages(roomId, { limit: PAGE_SIZE })
      this.deps.store.applyLatest(roomId, page)
      this.confirmDelivered(page.items)
    } catch {
      this.deps.store.setThreadError(roomId, true)
    }
  }

  private lastRealId(roomId: number): number | null {
    const items = this.deps.store.getState().threads[roomId]?.items ?? []
    for (let i = items.length - 1; i >= 0; i--) if (!items[i].pending) return items[i].id
    return null
  }

  private async catchUp(roomId: number): Promise<void> {
    let after = this.lastRealId(roomId)
    if (after === null) return this.loadLatest(roomId)
    try {
      for (let i = 0; i < CATCH_UP_MAX_PAGES; i++) {
        const page = await this.deps.api.messages(roomId, { after, limit: CATCH_UP_PAGE })
        this.deps.store.applyAfter(roomId, page)
        this.confirmDelivered(page.items)
        if (!page.has_more_after || page.items.length === 0) return
        after = page.items[page.items.length - 1].id
      }
      await this.loadLatest(roomId) // lỡ quá nhiều tin: tải lại trang mới nhất
    } catch {
      // lần ready/resync sau sẽ bù tiếp
    }
  }

  async loadOlder(roomId: number): Promise<void> {
    const thread = this.deps.store.getState().threads[roomId] ?? EMPTY_THREAD
    if (thread.loadingOlder || !thread.hasMoreBefore) return
    const items = thread.items.filter((m) => !m.pending)
    if (items.length === 0) return
    this.deps.store.setThreadLoadingOlder(roomId, true)
    try {
      const page = await this.deps.api.messages(roomId, { before: items[0].id, limit: PAGE_SIZE })
      this.deps.store.applyOlder(roomId, page)
      this.confirmDelivered(page.items)
    } catch {
      this.deps.store.setThreadLoadingOlder(roomId, false)
    }
  }

  // ---- gửi lạc quan ----

  send(roomId: number, rawBody: string): string | null {
    const body = rawBody.trim()
    if (!body) return null
    const clientId = (this.deps.newClientId ?? (() => crypto.randomUUID()))()
    const message: ChatMessage = {
      id: this.nextLocalId--,
      room_id: roomId,
      sender_id: this.deps.meId,
      sender_name: this.deps.meName,
      body,
      kind: 'text',
      client_id: clientId,
      created_at: new Date().toISOString(),
      edited_at: null,
      deleted: false,
      pending: 'sending',
    }
    this.pendingMeta.set(clientId, { roomId, body })
    this.deps.store.addPending(roomId, message)
    this.transmit(clientId)
    return clientId
  }

  retry(clientId: string): void {
    if (!this.pendingMeta.has(clientId)) return
    this.deps.store.setPendingState(clientId, 'sending')
    this.transmit(clientId)
  }

  private transmit(clientId: string): void {
    const meta = this.pendingMeta.get(clientId)
    if (!meta) return
    this.armTimeout(clientId)
    this.deps.socket.send({ type: 'send', room_id: meta.roomId, body: meta.body, client_id: clientId })
  }

  private armTimeout(clientId: string): void {
    const existing = this.timers.get(clientId)
    if (existing) clearTimeout(existing)
    this.timers.set(
      clientId,
      setTimeout(() => {
        this.timers.delete(clientId)
        this.deps.store.setPendingState(clientId, 'failed')
      }, this.deps.sendTimeoutMs ?? 15_000),
    )
  }

  private confirm(clientId: string): void {
    const timer = this.timers.get(clientId)
    if (timer) clearTimeout(timer)
    this.timers.delete(clientId)
    this.pendingMeta.delete(clientId)
  }

  /** Tin của mình đã về qua REST (bù tin/tải lại): huỷ hẹn giờ và quên tin đang chờ tương ứng. */
  private confirmDelivered(items: Message[]): void {
    for (const m of items) if (m.sender_id === this.deps.meId && m.client_id) this.confirm(m.client_id)
  }

  /** Bỏ hẳn một tin gửi lỗi. */
  discard(clientId: string): void {
    this.confirm(clientId)
    this.deps.store.removePending(clientId)
  }

  private resendPending(): void {
    for (const clientId of this.pendingMeta.keys()) {
      const thread = Object.values(this.deps.store.getState().threads).find((t) =>
        t.items.some((m) => m.pending === 'sending' && m.client_id === clientId),
      )
      if (thread) this.transmit(clientId)
    }
  }

  // ---- sự kiện từ WebSocket ----

  handleSocketEvent(event: ServerEvent): void {
    switch (event.type) {
      case 'ready':
      case 'resync':
        void this.resync()
        break
      case 'rooms_changed':
        void this.loadRooms()
        break
      case 'message':
        this.onMessage(event.message)
        break
      case 'message_updated':
        this.deps.store.replaceMessage(event.message)
        break
      case 'message_deleted':
        this.deps.store.markDeleted(event.room_id, event.message_id)
        break
      case 'error':
        if (event.client_id && this.pendingMeta.has(event.client_id)) {
          const timer = this.timers.get(event.client_id)
          if (timer) clearTimeout(timer)
          this.timers.delete(event.client_id)
          this.deps.store.setPendingState(event.client_id, 'failed', event.code)
        }
        break
      default:
        break
    }
  }

  private async resync(): Promise<void> {
    this.resendPending()
    await this.loadRooms()
    const threads = this.deps.store.getState().threads
    await Promise.all(
      Object.entries(threads)
        .filter(([, thread]) => thread.loaded)
        .map(async ([roomId]) => {
          await this.catchUp(Number(roomId))
          this.markReadIfViewing(Number(roomId))
        }),
    )
  }

  private onMessage(message: Message): void {
    const mine = message.sender_id === this.deps.meId
    if (mine && message.client_id) this.confirm(message.client_id)
    const viewing = this.isViewing(message.room_id)
    this.deps.store.upsertMessage(message)
    const known = this.deps.store.bumpRoom(message, !mine && !viewing)
    if (!known) void this.loadRooms()
    if (!mine && viewing) this.markReadIfViewing(message.room_id)
  }

  // ---- đã đọc ----

  setActiveRoom(roomId: number | null): void {
    this.activeRoom = roomId
  }

  /** Rời phòng: chỉ xoá phòng đang xem nếu vẫn là phòng đó (tránh cleanup muộn ghi đè phòng mới). */
  leaveRoom(roomId: number): void {
    if (this.activeRoom === roomId) this.activeRoom = null
  }

  onVisible(): void {
    if (this.activeRoom !== null) this.markReadIfViewing(this.activeRoom)
  }

  private isViewing(roomId: number): boolean {
    const visible = this.deps.isVisible ? this.deps.isVisible() : document.visibilityState === 'visible'
    return this.activeRoom === roomId && visible
  }

  private markReadIfViewing(roomId: number): void {
    if (!this.isViewing(roomId)) return
    const last = this.lastRealId(roomId)
    if (last === null || (this.lastMarked.get(roomId) ?? 0) >= last) return
    this.lastMarked.set(roomId, last)
    this.deps.store.clearUnread(roomId)
    this.deps.api.markRead(roomId, last).catch(() => {
      this.lastMarked.delete(roomId)
    })
  }

  // ---- sửa, xoá, chat mới ----

  async edit(messageId: number, body: string): Promise<void> {
    this.deps.store.replaceMessage(await this.deps.api.editMessage(messageId, body))
  }

  async remove(roomId: number, messageId: number): Promise<void> {
    await this.deps.api.deleteMessage(messageId)
    this.deps.store.markDeleted(roomId, messageId)
  }

  async openDirect(userId: number): Promise<Room> {
    const room = await this.deps.api.openDirect(userId)
    this.deps.store.upsertRoom(room)
    return room
  }

  dispose(): void {
    this.timers.forEach((timer) => clearTimeout(timer))
    this.timers.clear()
  }
}
