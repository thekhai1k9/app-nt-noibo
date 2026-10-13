import { makeSnippet } from './format'
import type { Message, Room } from './types'

export interface NotifySettings {
  enabled: boolean
  sound: boolean
  showPreview: boolean
  allGroupMessages: boolean
}

export const DEFAULT_SETTINGS: NotifySettings = { enabled: false, sound: true, showPreview: true, allGroupMessages: false }

const STORAGE_KEY = 'kn.notify.v1'
const MAX_AGE_MS = 60_000
const PREVIEW_MAX = 140
const AUTO_CLOSE_MS = 8000
const BEEP_MIN_GAP_MS = 1500
const BASE_TITLE = 'Kết Nối'

// ---- cài đặt ----

/** Bản trong bộ nhớ: chỉ dùng khi localStorage không dùng được (chế độ riêng tư, bị chặn). */
let memorySettings: NotifySettings = { ...DEFAULT_SETTINGS }

function sanitize(raw: unknown): NotifySettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_SETTINGS }
  const r = raw as Record<string, unknown>
  const pick = (key: keyof NotifySettings) => (typeof r[key] === 'boolean' ? (r[key] as boolean) : DEFAULT_SETTINGS[key])
  return { enabled: pick('enabled'), sound: pick('sound'), showPreview: pick('showPreview'), allGroupMessages: pick('allGroupMessages') }
}

export function loadSettings(): NotifySettings {
  let text: string | null
  try {
    text = localStorage.getItem(STORAGE_KEY)
  } catch {
    return { ...memorySettings }
  }
  if (text === null) return { ...DEFAULT_SETTINGS }
  try {
    return sanitize(JSON.parse(text))
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(settings: NotifySettings): void {
  memorySettings = { ...settings }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // bỏ qua: vẫn còn bản trong bộ nhớ
  }
}

// ---- chính sách ----

export type NotifyReason = 'direct' | 'mention' | 'reply' | 'group'

export interface ShouldNotifyInput {
  message: Message
  room: Room
  meId: number
  settings: NotifySettings
  windowVisible: boolean
  windowFocused: boolean
  activeRoomId: number | null
  now: number
}

export function shouldNotify(input: ShouldNotifyInput): { notify: boolean; reason: NotifyReason | null } {
  const no = { notify: false, reason: null } as const
  const { message, room, meId, settings } = input
  if (!settings.enabled) return no
  if (message.sender_id === meId || message.deleted) return no
  const created = Date.parse(message.created_at)
  if (!Number.isNaN(created) && input.now - created > MAX_AGE_MS) return no
  if (input.activeRoomId === room.id && input.windowVisible && input.windowFocused) return no
  if (room.type === 'direct') return { notify: true, reason: 'direct' }
  if (message.mention_all || message.mentions.some((m) => m.user_id === meId)) return { notify: true, reason: 'mention' }
  if (message.reply_to && message.reply_to.sender_id === meId) return { notify: true, reason: 'reply' }
  if (settings.allGroupMessages) return { notify: true, reason: 'group' }
  return no
}

/** Nội dung thông báo; không lộ nội dung tin khi tắt xem trước. */
export function notificationBody(message: Message, showPreview: boolean): string {
  if (!showPreview) return 'Tin nhắn mới'
  const text = Array.from(makeSnippet(message.body)).slice(0, PREVIEW_MAX).join('')
  return `${message.sender_name}: ${text}`
}

// ---- thông báo trình duyệt ----

export type NotificationSupport = 'unsupported' | 'insecure' | 'denied' | 'default' | 'granted'

export function notificationSupport(): NotificationSupport {
  if (typeof Notification === 'undefined') return 'unsupported'
  if (typeof window !== 'undefined' && window.isSecureContext === false) return 'insecure'
  const p = Notification.permission
  return p === 'granted' || p === 'denied' ? p : 'default'
}

export async function requestPermission(): Promise<NotificationPermission | 'unsupported' | 'insecure'> {
  const support = notificationSupport()
  if (support === 'unsupported' || support === 'insecure') return support
  if (support === 'granted' || support === 'denied') return support
  try {
    return await Notification.requestPermission()
  } catch {
    return notificationSupport() === 'granted' ? 'granted' : 'default'
  }
}

export function showNotification(opts: { title: string; body: string; tag: string; onClick?: () => void }): void {
  try {
    if (typeof Notification === 'undefined') return
    const n = new Notification(opts.title, { body: opts.body, tag: opts.tag, silent: true })
    const timer = setTimeout(() => {
      try {
        n.close()
      } catch {
        // bỏ qua
      }
    }, AUTO_CLOSE_MS)
    n.onclick = () => {
      clearTimeout(timer)
      try {
        window.focus()
        n.close()
      } catch {
        // bỏ qua
      }
      opts.onClick?.()
    }
  } catch {
    // bỏ qua: thông báo không bao giờ được làm hỏng luồng chat
  }
}

// ---- âm báo ----

let audioCtx: AudioContext | null = null
let lastBeepAt = -Infinity

type AudioCtor = typeof AudioContext

function audioContext(): AudioContext | null {
  if (audioCtx) return audioCtx
  const w = window as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor }
  const Ctor = w.AudioContext ?? w.webkitAudioContext
  if (!Ctor) return null
  try {
    audioCtx = new Ctor()
  } catch {
    audioCtx = null
  }
  return audioCtx
}

export function playBeep(): void {
  try {
    const now = Date.now()
    if (now - lastBeepAt < BEEP_MIN_GAP_MS) return
    const ctx = audioContext()
    if (!ctx) return
    lastBeepAt = now
    if (ctx.state === 'suspended') void Promise.resolve(ctx.resume()).catch(() => undefined)
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = 880
    gain.gain.value = 0.05
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start()
    osc.stop(ctx.currentTime + 0.12)
  } catch {
    // trình duyệt chặn tự phát: bỏ qua
  }
}

/** Trình duyệt chỉ cho phát âm sau thao tác của người dùng: tạo/tiếp tục AudioContext ở lần chạm đầu tiên. Trả hàm gỡ. */
export function armAudioUnlock(): () => void {
  const events = ['pointerdown', 'keydown'] as const
  const off = () => events.forEach((e) => document.removeEventListener(e, unlock, true))
  function unlock() {
    try {
      const ctx = audioContext()
      if (ctx && ctx.state === 'suspended') void Promise.resolve(ctx.resume()).catch(() => undefined)
    } catch {
      // bỏ qua
    }
    off()
  }
  events.forEach((e) => document.addEventListener(e, unlock, true))
  return off
}

// ---- tiêu đề tab ----

export function unreadTotal(rooms: Room[]): number {
  return rooms.reduce((sum, r) => sum + Math.max(0, r.unread_count), 0)
}

let titleOriginal: string | null = null

function baseTitle(): string {
  if (titleOriginal === null) titleOriginal = document.title
  const stripped = titleOriginal.replace(/^\(\d+\+?\)\s*/, '')
  return stripped || BASE_TITLE
}

export function updateTitle(total: number): void {
  const base = baseTitle()
  document.title = total > 0 ? `(${total > 99 ? '99+' : total}) ${base}` : base
}

export function restoreTitle(): void {
  if (titleOriginal === null) return
  document.title = titleOriginal
  titleOriginal = null
}

/** Chỉ cho test: đặt lại trạng thái mô-đun. */
export function resetNotificationState(): void {
  audioCtx = null
  lastBeepAt = -Infinity
  titleOriginal = null
  memorySettings = { ...DEFAULT_SETTINGS }
}
