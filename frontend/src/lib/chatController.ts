import type { ChatApi } from './chatApi'
import { EMPTY_THREAD, type ChatMessage, type ChatStore } from './chatStore'
import type { Message, Room, ServerEvent } from './types'

export interface ChatControllerDeps {
  store: ChatStore
  api: ChatApi
  socket: { send(payload: object): boolean }
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
  private readonly latestInFlight = new Map<number, Promise<void>>()
  /** Mốc bù tin theo phòng: CHỈ tăng từ trang REST (không bao giờ từ tin trực tiếp), nên một lần bù lỗi không làm mất khoảng trống. */
  private readonly syncedThrough = new Map<number, number>()
  private readonly catchUpRuns = new Map<number, Promise<void>>()
  private readonly catchUpAgain = new Set<number>()

  constructor(private readonly deps: ChatControllerDeps) {}

  // ---- tải dữ liệu ----

  async loadRooms(): Promise<void> {
    const seq = ++this.roomsSeq
    try {
      const rooms = await this.deps.api.rooms()
      if (seq === this.roomsSeq) {
        this.deps.store.setRooms(rooms)
        this.pruneRemovedRooms(new Set(rooms.map((r) => r.id)))
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

  /** Phòng đã bị lưu trữ/xoá khỏi danh sách: bỏ thread, tin đang chờ, hẹn giờ để khỏi gọi API vô ích. */
  private pruneRemovedRooms(alive: Set<number>): void {
    const threads = this.deps.store.getState().threads
    // Không bỏ phòng đang xem hay thread còn tin chờ gửi; bản chụp sau sẽ dọn nếu phòng thật sự đã mất.
    const gone = Object.keys(threads)
      .map(Number)
      .filter((id) => !alive.has(id) && id !== this.activeRoom && !threads[id].items.some((m) => m.pending))
    if (gone.length === 0) return
    for (const id of gone) {
      this.lastMarked.delete(id)
      this.syncedThrough.delete(id)
    }
    this.deps.store.removeThreads(gone)
  }

  private loadLatest(roomId: number): Promise<void> {
    const run = this.fetchLatest(roomId).finally(() => {
      if (this.latestInFlight.get(roomId) === run) this.latestInFlight.delete(roomId)
    })
    this.latestInFlight.set(roomId, run)
    return run
  }

  private async fetchLatest(roomId: number): Promise<void> {
    try {
      const page = await this.deps.api.messages(roomId, { limit: PAGE_SIZE })
      this.deps.store.applyLatest(roomId, page)
      this.syncedThrough.set(roomId, page.items.reduce((acc, m) => Math.max(acc, m.id), 0))
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

  /** Bù tin từ mốc REST. Nếu đang có một lần bù cho phòng này thì hẹn chạy lại đúng một lần sau khi nó xong. */
  private catchUp(roomId: number): Promise<void> {
    const running = this.catchUpRuns.get(roomId)
    if (running) {
      this.catchUpAgain.add(roomId)
      return running
    }
    const loop = async (): Promise<void> => {
      do {
        this.catchUpAgain.delete(roomId)
        await this.catchUpOnce(roomId)
      } while (this.catchUpAgain.has(roomId))
    }
    const run = loop().finally(() => {
      this.catchUpRuns.delete(roomId)
    })
    this.catchUpRuns.set(roomId, run)
    return run
  }

  private async catchUpOnce(roomId: number): Promise<void> {
    // Mốc 0 (phòng trống lúc mở) hoặc chưa có mốc nghĩa là chưa có gì để bù từ đó: tải lại trang mới nhất
    // (server từ chối after=0, và không được lấy lastRealId vì tin trực tiếp có thể đã vượt khoảng thiếu).
    const mark = this.syncedThrough.get(roomId)
    let after = mark !== undefined ? mark : this.lastRealId(roomId)
    if (!after) return this.loadLatest(roomId)
    try {
      for (let i = 0; i < CATCH_UP_MAX_PAGES; i++) {
        const page = await this.deps.api.messages(roomId, { after, limit: CATCH_UP_PAGE })
        this.deps.store.applyAfter(roomId, page)
        this.confirmDelivered(page.items)
        if (page.items.length > 0) {
          after = page.items[page.items.length - 1].id
          this.syncedThrough.set(roomId, Math.max(this.syncedThrough.get(roomId) ?? 0, after))
        }
        if (!page.has_more_after || page.items.length === 0) return
      }
      await this.loadLatest(roomId) // lỡ quá nhiều tin: tải lại trang mới nhất (đặt lại mốc)
    } catch {
      // mốc giữ nguyên: lần ready/resync/openRoom sau sẽ bù tiếp từ đúng chỗ
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
    // Chỉ hẹn giờ báo lỗi khi tin thực sự đã được gửi đi; khi offline tin nằm chờ và sẽ được gửi lại lúc `ready`.
    if (this.deps.socket.send({ type: 'send', room_id: meta.roomId, body: meta.body, client_id: clientId })) {
      this.armTimeout(clientId)
    }
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
    const threads = this.deps.store.getState().threads
    const loadedRooms = Object.entries(threads).filter(([, t]) => t.loaded).map(([k]) => Number(k))
    const loading: number[] = []
    // Lần tải đầu có thể chưa tạo thread nào trong store, nên duyệt theo các lần tải đang chạy.
    for (const roomId of this.latestInFlight.keys()) if (!loadedRooms.includes(roomId)) loading.push(roomId)
    this.resendPending()
    const work: Promise<void>[] = [this.loadRooms()]
    for (const roomId of loadedRooms) {
      work.push(this.catchUp(roomId).then(() => this.markReadIfViewing(roomId)))
    }
    for (const roomId of loading) {
      // Lần tải đầu đang chạy có thể đã chụp trước khi mất kết nối: tải lại trang mới nhất khi nó xong.
      work.push(
        (this.latestInFlight.get(roomId) ?? Promise.resolve())
          .then(() => this.loadLatest(roomId))
          .then(() => this.markReadIfViewing(roomId)),
      )
    }
    await Promise.all(work)
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
    // Bản chụp /rooms cũ đang bay (không có phòng này) sẽ bị bỏ; tải lại để có bản mới.
    void this.loadRooms()
    this.deps.store.upsertRoom(room)
    return room
  }

  dispose(): void {
    this.timers.forEach((timer) => clearTimeout(timer))
    this.timers.clear()
  }
}
