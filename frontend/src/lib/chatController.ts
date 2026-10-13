import type { ChatApi } from './chatApi'
import { EMPTY_THREAD, type ChatMessage, type ChatStore } from './chatStore'
import { makeSnippet } from './format'
import type { Mention, Message, Room, RoomMember, ServerEvent } from './types'

export interface ChatControllerDeps {
  store: ChatStore
  api: ChatApi
  socket: { send(payload: object): boolean }
  meId: number
  meName: string
  newClientId?: () => string
  isVisible?: () => boolean
  sendTimeoutMs?: number
  now?: () => number
}

const PAGE_SIZE = 50
const CATCH_UP_PAGE = 100
const CATCH_UP_MAX_PAGES = 20
const PENDING_READ_TTL_MS = 5 * 60_000
const TYPING_TTL_MS = 5000
const TYPING_SEND_INTERVAL_MS = 3000
const READ_DEBOUNCE_MS = 1000

interface PendingMeta {
  roomId: number
  body: string
  replyToId?: number
  mentionIds?: number[]
  mentionAll?: boolean
}

export interface SendOptions {
  replyTo?: Message
  mentions?: Mention[]
  mentionAll?: boolean
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

  private disposed = false
  private readonly typingTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly lastTypingSent = new Map<number, number>()
  private readonly membersInFlight = new Map<number, { token: object; run: Promise<void> }>()
  /** Sự kiện read đến khi danh sách thành viên chưa tải: áp lại sau khi tải để bản REST cũ không làm lùi mốc. */
  private readonly pendingReads = new Map<number, Map<number, { id: number; at: number }>>()
  private readonly membersAgain = new Set<number>()
  /** Số bản chụp /rooms liên tiếp không có phòng này. */
  private readonly absentRuns = new Map<number, number>()
  private readonly groupOps = new Map<string, Promise<unknown>>()
  private presenceRun: Promise<void> | null = null
  private presenceAgain = false
  private roomsRun: Promise<void> | null = null
  private roomsAgain = false
  /** Đánh dấu đã đọc: gửi ngay lần đầu, các lần trong 1 giây sau gộp thành một lần cuối với id mới nhất. */
  private readonly readTimers = new Map<number, ReturnType<typeof setTimeout>>()
  /** Id đã thực sự nhìn thấy lúc yêu cầu đánh dấu; không bao giờ gửi id vượt quá phần đã xem. */
  private readonly readPending = new Map<number, number>()
  private presenceSeq = 0
  private readonly presenceLiveAt = new Map<number, number>()

  constructor(private readonly deps: ChatControllerDeps) {}

  get meId(): number {
    return this.deps.meId
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  /** Bật lại sau dispose() (effect React chạy lại trong StrictMode dùng cùng một controller). */
  activate(): void {
    this.disposed = false
  }

  // ---- tải dữ liệu ----

  async loadRooms(): Promise<void> {
    const seq = ++this.roomsSeq
    try {
      const rooms = await this.deps.api.rooms()
      if (seq === this.roomsSeq) this.applyRooms(rooms)
    } catch {
      if (seq === this.roomsSeq) this.deps.store.setRoomsError()
    }
  }

  private applyRooms(rooms: Room[]): void {
    this.deps.store.setRooms(rooms)
    this.pruneRemovedRooms(new Set(rooms.map((r) => r.id)))
    // Bản chụp cũ có thể khôi phục huy hiệu chưa đọc của phòng đã đánh dấu đọc.
    for (const r of this.deps.store.getState().rooms) {
      if ((r.unread_count > 0 || r.unread_mentions > 0) && r.last_message && (this.lastMarked.get(r.id) ?? 0) >= r.last_message.id) {
        this.deps.store.clearUnread(r.id)
      }
    }
  }

  async openRoom(roomId: number): Promise<void> {
    const thread = this.deps.store.getState().threads[roomId]
    const members = this.loadMembers(roomId)
    if (thread?.loaded) await this.catchUp(roomId)
    else await this.loadLatest(roomId)
    this.markReadIfViewing(roomId)
    await members
  }

  /** Phòng đã bị lưu trữ/xoá khỏi danh sách: bỏ thread, tin đang chờ, hẹn giờ để khỏi gọi API vô ích. */
  private pruneRemovedRooms(alive: Set<number>): void {
    const state = this.deps.store.getState()
    const threads = state.threads
    // Thread còn tin chờ gửi chỉ bị bỏ khi phòng vắng mặt trong HAI bản chụp liên tiếp (bản chụp cũ không được
    // xoá phòng vừa tạo). Phòng đang xem thì giữ lại, nhưng tin chờ chuyển sang lỗi room_not_found và không gửi lại nữa.
    const known = new Set([...Object.keys(threads), ...Object.keys(state.members), ...Object.keys(state.typing), ...this.pendingReads.keys(), ...this.membersInFlight.keys()].map(Number))
    for (const id of [...this.absentRuns.keys()]) if (alive.has(id) || !known.has(id)) this.absentRuns.delete(id)
    for (const id of known) if (!alive.has(id)) this.absentRuns.set(id, (this.absentRuns.get(id) ?? 0) + 1)
    const confirmedAbsent = (id: number) => (this.absentRuns.get(id) ?? 0) >= 2
    const hasPending = (id: number) => !!threads[id]?.items.some((m) => m.pending)
    if (this.activeRoom !== null && !alive.has(this.activeRoom) && confirmedAbsent(this.activeRoom)) {
      for (const m of threads[this.activeRoom]?.items ?? []) {
        if (!m.pending || !m.client_id) continue
        this.confirm(m.client_id) // không gửi lại nữa; bong bóng lỗi ở lại cho tới khi rời màn hình
        this.deps.store.setPendingState(m.client_id, 'failed', 'room_not_found')
      }
    }
    const gone = [...known].filter((id) => !alive.has(id) && id !== this.activeRoom && (!hasPending(id) || confirmedAbsent(id)))
    if (gone.length === 0) return
    for (const id of gone) {
      this.lastMarked.delete(id)
      this.syncedThrough.delete(id)
      this.absentRuns.delete(id)
    }
    this.forgetRooms(gone)
    this.deps.store.removeThreads(gone)
  }

  /** Phòng bị bỏ: huỷ hẹn giờ soạn tin, tải thành viên đang bay và dữ liệu đệm của phòng. */
  private forgetRooms(roomIds: number[]): void {
    for (const id of roomIds) {
      // Tin đang chờ/lỗi của phòng bị bỏ: không bao giờ gửi lại, không để bong bóng lỗi nằm trong thread không còn truy cập được.
      for (const [clientId, meta] of [...this.pendingMeta]) if (meta.roomId === id) this.confirm(clientId)
      this.latestInFlight.delete(id)
      this.catchUpAgain.delete(id)
      for (const [key, timer] of this.typingTimers) {
        if (key.startsWith(`${id}:`)) {
          clearTimeout(timer)
          this.typingTimers.delete(key)
        }
      }
      this.membersInFlight.delete(id)
      this.pendingReads.delete(id)
      this.membersAgain.delete(id)
      this.lastTypingSent.delete(id)
      this.dropReadTimer(id)
    }
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

  send(roomId: number, rawBody: string, opts: SendOptions = {}): string | null {
    const body = rawBody.trim()
    if (!body) return null
    const clientId = (this.deps.newClientId ?? (() => crypto.randomUUID()))()
    const replyTo = opts.replyTo && opts.replyTo.id >= 1 ? opts.replyTo : undefined
    const mentions = opts.mentions ?? []
    const mentionAll = opts.mentionAll === true
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
      reply_to: replyTo
        ? { id: replyTo.id, sender_id: replyTo.sender_id, sender_name: replyTo.sender_name, snippet: replyTo.deleted ? '' : makeSnippet(replyTo.body), deleted: replyTo.deleted }
        : null,
      mentions: mentions.map((m) => ({ user_id: m.user_id, full_name: m.full_name })),
      mention_all: mentionAll,
      pending: 'sending',
    }
    this.lastTypingSent.delete(roomId) // vừa gửi tin: lần soạn kế tiếp báo ngay
    this.pendingMeta.set(clientId, {
      roomId,
      body,
      ...(replyTo ? { replyToId: replyTo.id } : {}),
      ...(mentions.length > 0 ? { mentionIds: mentions.map((m) => m.user_id) } : {}),
      ...(mentionAll ? { mentionAll: true } : {}),
    })
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
    const frame = {
      type: 'send',
      room_id: meta.roomId,
      body: meta.body,
      client_id: clientId,
      ...(meta.replyToId !== undefined ? { reply_to_id: meta.replyToId } : {}),
      ...(meta.mentionIds ? { mentions: meta.mentionIds } : {}),
      ...(meta.mentionAll ? { mention_all: true as const } : {}),
    }
    if (this.deps.socket.send(frame)) {
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
        void this.reloadRoomsCoalesced()
        void this.refreshPresence() // phòng chung mới có thể làm lộ thêm người online
        if (this.activeRoom !== null && this.isKnownRoom(this.activeRoom)) void this.loadMembers(this.activeRoom)
        break
      case 'typing':
        this.onTyping(event.room_id, event.user_id, event.user_name)
        break
      case 'read':
        this.onRead(event.room_id, event.user_id, event.message_id)
        break
      case 'presence':
        this.presenceLiveAt.set(event.user_id, ++this.presenceSeq)
        this.deps.store.setPresence(event.user_id, event.online)
        break
      case 'message':
        this.onMessage(event.message)
        break
      case 'message_updated':
        this.deps.store.replaceMessage(event.message)
        this.deps.store.refreshQuotes(
          event.message.room_id,
          event.message.id,
          event.message.deleted ? { snippet: '', deleted: true } : { snippet: makeSnippet(event.message.body), deleted: false },
        )
        break
      case 'message_deleted':
        this.deps.store.markDeleted(event.room_id, event.message_id)
        this.deps.store.refreshQuotes(event.room_id, event.message_id, { snippet: '', deleted: true })
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

  /** Chuỗi rooms_changed dồn dập: tối đa một lần tải đang chạy + một lần chờ. */
  private reloadRoomsCoalesced(): Promise<void> {
    if (this.roomsRun) {
      this.roomsAgain = true
      return this.roomsRun
    }
    let run!: Promise<void>
    run = (async () => {
      try {
        // Bản chụp bị bỏ qua vì đã có rooms_changed mới hơn; chỉ áp dụng nếu lần chạy kế tiếp lỗi.
        let held: Room[] | null = null
        do {
          this.roomsAgain = false
          const seq = ++this.roomsSeq
          let rooms: Room[] | null = null
          try {
            rooms = await this.deps.api.rooms()
          } catch {
            rooms = null
          }
          if (seq !== this.roomsSeq) continue // đã có loadRooms khác thay thế
          const again = this.roomsAgain && !this.disposed
          if (rooms) {
            if (again) held = rooms
            else {
              this.applyRooms(rooms)
              held = null
            }
          } else if (!again) {
            if (held) this.applyRooms(held)
            else this.deps.store.setRoomsError()
            held = null
          }
        } while (this.roomsAgain && !this.disposed)
      } finally {
        if (this.roomsRun === run) this.roomsRun = null
      }
    })()
    this.roomsRun = run
    return run
  }

  private async resync(): Promise<void> {
    const threads = this.deps.store.getState().threads
    const loadedRooms = Object.entries(threads).filter(([, t]) => t.loaded).map(([k]) => Number(k))
    const loading: number[] = []
    // Lần tải đầu có thể chưa tạo thread nào trong store, nên duyệt theo các lần tải đang chạy.
    for (const roomId of this.latestInFlight.keys()) if (!loadedRooms.includes(roomId)) loading.push(roomId)
    this.resendPending()
    const work: Promise<void>[] = [this.loadRooms(), this.refreshPresence()]
    if (this.activeRoom !== null) work.push(this.loadMembers(this.activeRoom))
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
    this.clearTypingEntry(message.room_id, message.sender_id)
    this.deps.store.upsertMessage(message)
    const mentionsMe = message.mention_all || message.mentions.some((m) => m.user_id === this.deps.meId)
    const known = this.deps.store.bumpRoom(message, !mine && !viewing, mentionsMe)
    if (!known) void this.loadRooms()
    if (!mine && viewing) this.markReadIfViewing(message.room_id)
  }

  // ---- đã xem, đang soạn, online ----

  private isKnownRoom(roomId: number): boolean {
    return this.deps.store.getState().rooms.some((r) => r.id === roomId)
  }

  private onTyping(roomId: number, userId: number, name: string): void {
    if (this.disposed || userId === this.deps.meId || !this.isKnownRoom(roomId)) return
    this.deps.store.setTyping(roomId, userId, name, this.now() + TYPING_TTL_MS)
    const key = `${roomId}:${userId}`
    const old = this.typingTimers.get(key)
    if (old) clearTimeout(old)
    this.typingTimers.set(
      key,
      setTimeout(() => {
        this.typingTimers.delete(key)
        this.deps.store.clearTyping(roomId, userId)
      }, TYPING_TTL_MS),
    )
  }

  private clearTypingEntry(roomId: number, userId: number): void {
    const key = `${roomId}:${userId}`
    const timer = this.typingTimers.get(key)
    if (timer) clearTimeout(timer)
    this.typingTimers.delete(key)
    this.deps.store.clearTyping(roomId, userId)
  }

  private onRead(roomId: number, userId: number, messageId: number): void {
    const list = this.deps.store.getState().members[roomId]
    if (list?.some((m) => m.user_id === userId)) {
      this.deps.store.applyRead(roomId, userId, messageId)
    } else if (this.isKnownRoom(roomId) && (list || this.membersInFlight.has(roomId))) {
      // Người này chưa có trong danh sách (mới vào phòng) hoặc danh sách đang tải: đệm mốc và tải lại danh sách.
      // Danh sách chưa tải và không có lần tải nào: bỏ qua, lần tải đầu sẽ lấy mốc mới từ REST.
      const pending = this.pendingReads.get(roomId) ?? new Map<number, { id: number; at: number }>()
      pending.set(userId, { id: Math.max(pending.get(userId)?.id ?? 0, messageId), at: this.now() })
      this.pendingReads.set(roomId, pending)
      if (list || this.membersInFlight.has(roomId)) void this.loadMembers(roomId)
    }
    if (userId === this.deps.meId) {
      // Đồng bộ đa tab; không xoá nếu có tin của người khác mới hơn mốc (tin đến trước sự kiện này).
      const r = this.deps.store.getState().rooms.find((x) => x.id === roomId)
      const lm = r?.last_message
      if (r && (!lm || lm.id <= messageId || lm.sender_id === this.deps.meId)) this.deps.store.clearUnread(roomId)
    }
  }

  /** Tải lại danh sách online (gộp: tối đa một lần đang chạy + một lần chờ). Sự kiện presence trực tiếp đến trong lúc chờ được ưu tiên hơn bản chụp. */
  refreshPresence(): Promise<void> {
    if (this.presenceRun) {
      this.presenceAgain = true
      return this.presenceRun
    }
    let run!: Promise<void>
    run = (async () => {
      try {
        do {
          this.presenceAgain = false
          await this.presenceOnce()
        } while (this.presenceAgain && !this.disposed)
      } finally {
        if (this.presenceRun === run) this.presenceRun = null
      }
    })()
    this.presenceRun = run
    return run
  }

  private async presenceOnce(): Promise<void> {
    const startSeq = this.presenceSeq
    try {
      const res = await this.deps.api.presence()
      if (this.disposed) return
      const keep: number[] = []
      for (const [id, seq] of this.presenceLiveAt) {
        if (seq > startSeq) keep.push(id)
        else this.presenceLiveAt.delete(id) // bản chụp này đã phản ánh sự kiện đó
      }
      this.deps.store.setOnline(res.online_user_ids, keep)
    } catch {
      // giữ nguyên; lần ready/resync/rooms_changed sau sẽ tải lại
    }
  }

  /** Tải thành viên của phòng; một lần cùng lúc cho mỗi phòng, gọi thêm trong lúc đang tải thì chạy lại đúng một lần sau đó. */
  loadMembers(roomId: number): Promise<void> {
    const existing = this.membersInFlight.get(roomId)
    if (existing) {
      this.membersAgain.add(roomId)
      return existing.run
    }
    const token = {}
    const alive = () => !this.disposed && this.membersInFlight.get(roomId)?.token === token
    const run = (async () => {
      try {
        do {
          this.membersAgain.delete(roomId)
          await this.membersOnce(roomId, alive)
        } while (this.membersAgain.has(roomId) && alive())
      } finally {
        if (this.membersInFlight.get(roomId)?.token === token) {
          this.membersInFlight.delete(roomId)
          this.membersAgain.delete(roomId)
        }
      }
    })()
    this.membersInFlight.set(roomId, { token, run })
    return run
  }

  private async membersOnce(roomId: number, alive: () => boolean): Promise<void> {
    try {
      const list = await this.deps.api.members(roomId)
      if (!alive()) return
      this.deps.store.setMembers(roomId, list)
      const pending = this.pendingReads.get(roomId)
      if (pending) {
        const cutoff = this.now() - PENDING_READ_TTL_MS
        for (const [uid, { id, at }] of pending) {
          if (list.some((m) => m.user_id === uid)) {
            this.deps.store.applyRead(roomId, uid, id)
            pending.delete(uid)
          } else if (at < cutoff) pending.delete(uid)
        }
        if (pending.size === 0) this.pendingReads.delete(roomId)
      }
    } catch {
      // danh sách cũ giữ nguyên
    }
  }

  /** Báo "đang soạn" tối đa 1 lần/3 giây mỗi phòng, chỉ khi socket mở; không bao giờ ném lỗi. */
  sendTyping(roomId: number): void {
    if (this.disposed) return
    try {
      const now = this.now()
      const last = this.lastTypingSent.get(roomId)
      if (last !== undefined && now - last < TYPING_SEND_INTERVAL_MS) return
      if (this.deps.socket.send({ type: 'typing', room_id: roomId })) this.lastTypingSent.set(roomId, now)
    } catch {
      // bỏ qua
    }
  }

  // ---- đã đọc ----

  setActiveRoom(roomId: number | null): void {
    if (this.activeRoom !== null && this.activeRoom !== roomId) this.flushRead(this.activeRoom)
    this.activeRoom = roomId
  }

  /** Rời phòng: chỉ xoá phòng đang xem nếu vẫn là phòng đó (tránh cleanup muộn ghi đè phòng mới). */
  leaveRoom(roomId: number): void {
    this.flushRead(roomId)
    if (this.activeRoom === roomId) this.activeRoom = null
    // Phòng đã mất mà người dùng vừa rời màn hình (còn bong bóng lỗi room_not_found): dọn ngay.
    const state = this.deps.store.getState()
    if (state.roomsLoaded && !state.rooms.some((r) => r.id === roomId) && (this.absentRuns.get(roomId) ?? 0) >= 2) {
      this.lastMarked.delete(roomId)
      this.syncedThrough.delete(roomId)
      this.absentRuns.delete(roomId)
      this.forgetRooms([roomId])
      this.deps.store.removeThreads([roomId])
    }
  }

  onVisible(): void {
    if (this.activeRoom !== null) {
      this.flushRead(this.activeRoom)
      this.markReadIfViewing(this.activeRoom)
    }
  }

  private isViewing(roomId: number): boolean {
    const visible = this.deps.isVisible ? this.deps.isVisible() : document.visibilityState === 'visible'
    return this.activeRoom === roomId && visible
  }

  private markReadIfViewing(roomId: number): void {
    if (!this.isViewing(roomId)) return
    const last = this.lastRealId(roomId)
    if (last === null) return
    if (this.readTimers.has(roomId)) {
      this.readPending.set(roomId, last) // đang trong khoảng gộp: gửi đúng id này khi hết hạn / rời phòng
      this.deps.store.clearUnread(roomId)
      return
    }
    this.readPending.delete(roomId)
    this.sendRead(roomId, last, true)
  }

  private sendRead(roomId: number, id: number, startTimer: boolean): void {
    if ((this.lastMarked.get(roomId) ?? 0) >= id) return
    this.lastMarked.set(roomId, id)
    // Chỉ xoá huy hiệu khi đã đọc tới tin mới nhất; tin đến lúc tab ẩn vẫn phải còn chưa đọc.
    if (id >= (this.lastRealId(roomId) ?? 0)) this.deps.store.clearUnread(roomId)
    this.deps.api.markRead(roomId, id).catch(() => {
      if (this.lastMarked.get(roomId) === id) this.lastMarked.delete(roomId) // lỗi muộn của lần cũ không xoá mốc mới hơn
    })
    if (!startTimer || this.disposed) return
    this.readTimers.set(
      roomId,
      setTimeout(() => {
        this.readTimers.delete(roomId)
        const pending = this.readPending.get(roomId)
        // Tab đang ẩn / không còn xem phòng: giữ lại, sẽ gửi khi hiện lại hoặc rời phòng.
        if (pending !== undefined && this.isViewing(roomId)) {
          this.readPending.delete(roomId)
          this.sendRead(roomId, pending, true)
        }
      }, READ_DEBOUNCE_MS),
    )
  }

  /** Gửi ngay phần đã gộp (rời phòng, đổi phòng, tab hiện lại). */
  private flushRead(roomId: number): void {
    const timer = this.readTimers.get(roomId)
    if (timer) clearTimeout(timer)
    this.readTimers.delete(roomId)
    const pending = this.readPending.get(roomId)
    this.readPending.delete(roomId)
    if (pending !== undefined) this.sendRead(roomId, pending, false)
  }

  private dropReadTimer(roomId: number): void {
    const timer = this.readTimers.get(roomId)
    if (timer) clearTimeout(timer)
    this.readTimers.delete(roomId)
    this.readPending.delete(roomId)
  }

  // ---- sửa, xoá, chat mới ----

  async edit(messageId: number, body: string, mentions?: number[]): Promise<void> {
    const updated = await this.deps.api.editMessage(messageId, body, mentions)
    this.deps.store.replaceMessage(updated)
    this.deps.store.refreshQuotes(updated.room_id, updated.id, { snippet: makeSnippet(updated.body), deleted: false })
  }

  async remove(roomId: number, messageId: number): Promise<void> {
    await this.deps.api.deleteMessage(messageId)
    this.deps.store.markDeleted(roomId, messageId)
    this.deps.store.refreshQuotes(roomId, messageId, { snippet: '', deleted: true })
  }

  async openDirect(userId: number): Promise<Room> {
    const room = await this.deps.api.openDirect(userId)
    // Bản chụp /rooms cũ đang bay (không có phòng này) sẽ bị bỏ; tải lại để có bản mới.
    void this.loadRooms()
    this.deps.store.upsertRoom(room)
    return room
  }

  // ---- nhóm ----

  /** Mỗi thao tác nhóm chỉ chạy một lần cùng lúc theo khoá; gọi trùng nhận lại cùng một kết quả. */
  private groupOp<T>(key: string, run: () => Promise<T>): Promise<T> {
    const existing = this.groupOps.get(key)
    if (existing) return existing as Promise<T>
    const p = run().finally(() => {
      if (this.groupOps.get(key) === p) this.groupOps.delete(key)
    })
    this.groupOps.set(key, p)
    return p
  }

  createGroup(name: string, memberIds: number[]): Promise<Room> {
    return this.groupOp(`create:${name}:${memberIds.join(',')}`, async () => {
      const room = await this.deps.api.createGroup(name, memberIds)
      // Bản chụp /rooms cũ đang bay (không có phòng này) sẽ bị bỏ; tải lại để có bản mới.
      void this.loadRooms()
      this.deps.store.upsertRoom(room)
      return room
    })
  }

  renameGroup(roomId: number, name: string): Promise<Room> {
    return this.groupOp(`rename:${roomId}`, async () => {
      const room = await this.deps.api.renameGroup(roomId, name)
      // Chỉ lấy tên/vai trò: bản trả về có thể cũ hơn xem trước/chưa đọc đã nhận qua WebSocket.
      const current = this.deps.store.getState().rooms.find((r) => r.id === roomId)
      this.deps.store.upsertRoom(current ? { ...current, name: room.name, my_role: room.my_role } : room)
      return room
    })
  }

  addMember(roomId: number, userId: number): Promise<void> {
    return this.groupOp(`add:${roomId}:${userId}`, async () => {
      this.applyMemberList(roomId, await this.deps.api.addMember(roomId, userId))
      void this.loadRooms() // member_count đổi
    })
  }

  removeMember(roomId: number, userId: number): Promise<void> {
    return this.groupOp(`remove:${roomId}:${userId}`, async () => {
      this.applyMemberList(roomId, await this.deps.api.removeMember(roomId, userId))
      this.pendingReads.get(roomId)?.delete(userId)
      this.clearTypingEntry(roomId, userId)
      void this.loadRooms()
    })
  }

  /** Danh sách thành viên từ phản hồi ghi; một lần tải cũ đang bay sẽ chạy lại để không ghi đè bằng bản cũ. */
  private applyMemberList(roomId: number, list: RoomMember[]): void {
    if (this.disposed) return
    this.deps.store.setMembers(roomId, list)
    if (this.membersInFlight.has(roomId)) this.membersAgain.add(roomId)
  }

  /** onGone chạy ngay khi server xác nhận, trước khi bỏ phòng khỏi store và trước khi đối soát danh sách phòng. */
  leaveGroup(roomId: number, onGone?: () => void): Promise<void> {
    return this.groupOp(`leave:${roomId}`, async () => {
      await this.deps.api.leaveGroup(roomId)
      onGone?.()
      await this.afterRoomGone(roomId)
    })
  }

  dissolveGroup(roomId: number, onGone?: () => void): Promise<void> {
    return this.groupOp(`dissolve:${roomId}`, async () => {
      await this.deps.api.dissolveGroup(roomId)
      onGone?.()
      await this.afterRoomGone(roomId)
    })
  }

  /** Phòng không còn với mình: bỏ ngay khỏi store (idempotent, không phụ thuộc loadRooms); loadRooms chỉ để đối soát. */
  private async afterRoomGone(roomId: number): Promise<void> {
    if (this.activeRoom === roomId) this.activeRoom = null
    this.lastMarked.delete(roomId)
    this.syncedThrough.delete(roomId)
    this.forgetRooms([roomId])
    this.deps.store.removeRoom(roomId)
    this.deps.store.removeThreads([roomId])
    await this.loadRooms()
  }

  dispose(): void {
    this.timers.forEach((timer) => clearTimeout(timer))
    this.timers.clear()
    this.typingTimers.forEach((timer) => clearTimeout(timer))
    this.typingTimers.clear()
    this.membersInFlight.clear()
    this.pendingReads.clear()
    this.membersAgain.clear()
    // Chỉ gửi nốt phần đã gộp nếu lúc này vẫn đang xem phòng và tab đang hiện; lỗi bị nuốt.
    for (const [roomId, id] of this.readPending) {
      if (this.isViewing(roomId) && (this.lastMarked.get(roomId) ?? 0) < id) {
        this.lastMarked.set(roomId, id)
        void this.deps.api.markRead(roomId, id).catch(() => undefined)
      }
    }
    this.readTimers.forEach((timer) => clearTimeout(timer))
    this.readTimers.clear()
    this.readPending.clear()
    this.presenceAgain = false
    this.presenceLiveAt.clear()
    this.roomsAgain = false
    this.deps.store.pruneTyping(Infinity) // store có thể sống lâu hơn controller
    this.disposed = true
  }
}
