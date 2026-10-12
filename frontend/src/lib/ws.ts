import type { RefreshResult } from './api'
import type { ServerEvent } from './types'

export type SocketStatus = 'connecting' | 'open' | 'offline'

export interface ChatSocketOptions {
  getToken: () => string | null
  refresh: () => Promise<RefreshResult>
  onAuthLost: () => void
  url?: string
  backoffMs?: number[]
  random?: () => number
  createSocket?: (url: string) => WebSocket
}

const DEFAULT_BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000]
const MAX_CONSECUTIVE_AUTH_FAILURES = 2
const CLOSE_UNAUTHENTICATED = 4401
const CLOSE_ACCOUNT_LOCKED = 4403

function defaultUrl(): string {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${window.location.host}/api/ws`
}

export class ChatSocket {
  private ws: WebSocket | null = null
  private status: SocketStatus = 'offline'
  private stopped = true
  private attempt = 0
  private authFailures = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly eventListeners = new Set<(event: ServerEvent) => void>()
  private readonly statusListeners = new Set<(status: SocketStatus) => void>()

  constructor(private readonly opts: ChatSocketOptions) {}

  getStatus(): SocketStatus {
    return this.status
  }

  onEvent(listener: (event: ServerEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  onStatus(listener: (status: SocketStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.attempt = 0
    this.authFailures = 0
    this.connect()
  }

  stop(): void {
    this.stopped = true
    this.clearTimer()
    const ws = this.ws
    this.ws = null
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null
      try {
        ws.close(1000)
      } catch {
        // đã đóng
      }
    }
    this.setStatus('offline')
  }

  send(payload: object): boolean {
    if (this.status !== 'open' || !this.ws) return false
    try {
      this.ws.send(JSON.stringify(payload))
      return true
    } catch {
      return false
    }
  }

  /** Dùng khi mạng có lại hoặc tab hiển thị lại: không chờ hết thời gian backoff. */
  reconnectNow(): void {
    if (this.stopped || this.status !== 'offline') return
    this.clearTimer()
    this.connect()
  }

  private setStatus(status: SocketStatus): void {
    if (this.status === status) return
    this.status = status
    this.statusListeners.forEach((listener) => listener(status))
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private connect(): void {
    if (this.stopped) return
    this.setStatus('connecting')
    const token = this.opts.getToken()
    if (!token) {
      void this.refreshThenConnect()
      return
    }
    const url = this.opts.url ?? defaultUrl()
    let ws: WebSocket
    try {
      ws = (this.opts.createSocket ?? ((u: string) => new WebSocket(u)))(url)
    } catch {
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    // Token chỉ đi trong khung đầu tiên, không bao giờ nằm trong URL.
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token }))
    ws.onmessage = (event) => this.handleMessage(ws, event.data)
    ws.onclose = (event) => this.handleClose(ws, event.code)
    ws.onerror = () => {} // onclose luôn chạy sau onerror
  }

  private handleMessage(ws: WebSocket, data: unknown): void {
    if (ws !== this.ws || typeof data !== 'string') return
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      return
    }
    if (!parsed || typeof parsed !== 'object' || typeof (parsed as { type?: unknown }).type !== 'string') return
    const event = parsed as ServerEvent
    if (event.type === 'ready') {
      this.attempt = 0
      this.authFailures = 0
      this.setStatus('open')
    }
    this.eventListeners.forEach((listener) => listener(event))
  }

  private handleClose(ws: WebSocket, code: number): void {
    if (ws !== this.ws) return // kết nối cũ đã bị thay thế
    this.ws = null
    this.setStatus('offline')
    if (this.stopped) return
    if (code === CLOSE_ACCOUNT_LOCKED) {
      this.giveUp()
    } else if (code === CLOSE_UNAUTHENTICATED) {
      this.authFailures += 1
      if (this.authFailures >= MAX_CONSECUTIVE_AUTH_FAILURES) {
        this.giveUp()
        return
      }
      void this.refreshThenConnect()
    } else {
      this.scheduleReconnect()
    }
  }

  /** Chỉ lỗi 4401 liên tiếp mới tính vào bộ đếm; thiếu token hay refresh không khả dụng thì backoff. */
  private async refreshThenConnect(): Promise<void> {
    const result = await this.opts.refresh()
    if (this.stopped) return
    if (result === 'ok' && this.opts.getToken()) this.connect()
    else if (result === 'denied') this.giveUp()
    else this.scheduleReconnect()
  }

  private giveUp(): void {
    this.stopped = true
    this.clearTimer()
    this.setStatus('offline')
    this.opts.onAuthLost()
  }

  private scheduleReconnect(): void {
    if (this.stopped) return
    this.setStatus('offline')
    const backoff = this.opts.backoffMs ?? DEFAULT_BACKOFF_MS
    const base = backoff[Math.min(this.attempt, backoff.length - 1)]
    this.attempt += 1
    const random = this.opts.random ?? Math.random
    const delay = Math.round(base * (0.8 + random() * 0.4))
    this.clearTimer()
    this.timer = setTimeout(() => {
      this.timer = null
      this.connect()
    }, delay)
  }
}
