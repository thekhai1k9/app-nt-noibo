import { vi } from 'vitest'
import { makeMessage, makeRoom } from '../test/utils'
import {
  DEFAULT_SETTINGS, loadSettings, notificationBody, notificationSupport, playBeep, requestPermission, resetNotificationState,
  liveNow, cleanText, restoreTitle, saveSettings, shouldNotify, showNotification, unreadTotal, updateTitle, type NotifySettings, type ShouldNotifyInput,
} from './notifications'

const NOW = Date.parse('2026-10-15T09:00:30.000Z')
const on: NotifySettings = { ...DEFAULT_SETTINGS, enabled: true }

function input(over: Partial<ShouldNotifyInput> = {}): ShouldNotifyInput {
  return {
    message: makeMessage(), room: makeRoom({ type: 'group' }), meId: 1, settings: on,
    windowVisible: true, windowFocused: true, activeRoomId: null, now: NOW, ...over,
  }
}

describe('shouldNotify', () => {
  const direct = makeRoom({ type: 'direct' })
  const table: [string, Partial<ShouldNotifyInput>, boolean, string | null][] = [
    ['direct chat, other room active', { room: direct }, true, 'direct'],
    ['direct chat open and focused', { room: direct, activeRoomId: direct.id }, false, null],
    ['direct chat open but window hidden', { room: direct, activeRoomId: direct.id, windowVisible: false }, true, 'direct'],
    ['direct chat open, visible but unfocused', { room: direct, activeRoomId: direct.id, windowFocused: false }, true, 'direct'],
    ['plain group message', {}, false, null],
    ['plain group message with allGroupMessages', { settings: { ...on, allGroupMessages: true } }, true, 'group'],
    ['mention of me', { message: makeMessage({ mentions: [{ user_id: 1, full_name: 'Tôi' }] }) }, true, 'mention'],
    ['mention of someone else', { message: makeMessage({ mentions: [{ user_id: 5, full_name: 'X' }] }) }, false, null],
    ['@all in group', { message: makeMessage({ mention_all: true }) }, true, 'mention'],
    ['reply to my message', { message: makeMessage({ reply_to: { id: 3, sender_id: 1, sender_name: 'Tôi', snippet: 'a', deleted: false } }) }, true, 'reply'],
    ['reply to someone else', { message: makeMessage({ reply_to: { id: 3, sender_id: 9, sender_name: 'Z', snippet: 'a', deleted: false } }) }, false, null],
    ['own message', { room: direct, message: makeMessage({ sender_id: 1 }) }, false, null],
    ['deleted message', { room: direct, message: makeMessage({ deleted: true }) }, false, null],
    ['older than 60s', { room: direct, now: NOW + 40_000 }, false, null],
    ['disabled', { room: direct, settings: DEFAULT_SETTINGS }, false, null],
  ]
  it.each(table)('%s', (_name, over, notify, reason) => {
    expect(shouldNotify(input(over))).toEqual({ notify, reason })
  })
})

describe('notificationBody', () => {
  it('caps previews at 140 characters and hides them on request', () => {
    const long = 'a'.repeat(500)
    expect(notificationBody(makeMessage({ body: long }), true).length).toBeLessThanOrEqual('Lê Thu Hà: '.length + 140)
    expect(notificationBody(makeMessage({ body: 'bí mật' }), false)).toBe('Tin nhắn mới')
  })
})

describe('settings', () => {
  beforeEach(() => resetNotificationState())
  it('returns defaults, round-trips, and survives corrupt data', () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS)
    saveSettings({ ...on, sound: false })
    expect(loadSettings()).toEqual({ ...on, sound: false })
    localStorage.setItem('kn.notify.v1', '{not json')
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS)
    localStorage.setItem('kn.notify.v1', JSON.stringify({ enabled: 'yes', sound: false }))
    expect(loadSettings()).toEqual({ ...DEFAULT_SETTINGS, sound: false })
  })

  it('falls back to memory when localStorage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS)
    expect(() => saveSettings(on)).not.toThrow()
    expect(loadSettings()).toEqual(on)
  })
})

describe('notificationSupport / requestPermission', () => {
  it('covers each branch', async () => {
    vi.stubGlobal('Notification', undefined)
    expect(notificationSupport()).toBe('unsupported')
    expect(await requestPermission()).toBe('unsupported')
    const fake = Object.assign(vi.fn(), { permission: 'default', requestPermission: vi.fn().mockResolvedValue('granted') })
    vi.stubGlobal('Notification', fake)
    vi.stubGlobal('isSecureContext', false)
    expect(notificationSupport()).toBe('insecure')
    expect(await requestPermission()).toBe('insecure')
    expect(fake.requestPermission).not.toHaveBeenCalled()
    vi.stubGlobal('isSecureContext', true)
    expect(notificationSupport()).toBe('default')
    expect(await requestPermission()).toBe('granted')
    fake.permission = 'denied'
    expect(notificationSupport()).toBe('denied')
    fake.permission = 'granted'
    expect(notificationSupport()).toBe('granted')
  })
})

describe('showNotification', () => {
  afterEach(() => vi.useRealTimers())
  it('uses a per-room tag, silent, closes after 8s and focuses on click', () => {
    vi.useFakeTimers()
    const instances: { close: ReturnType<typeof vi.fn>; onclick?: () => void; args: unknown[] }[] = []
    vi.stubGlobal('Notification', function (...args: unknown[]) {
      const n = { close: vi.fn(), args }
      instances.push(n)
      return n
    })
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => undefined)
    const onClick = vi.fn()
    showNotification({ title: 'T', body: 'B', tag: 'kn-room-4', onClick })
    expect(instances[0].args).toEqual(['T', { body: 'B', tag: 'kn-room-4', silent: true }])
    vi.advanceTimersByTime(8000)
    expect(instances[0].close).toHaveBeenCalledTimes(1)
    instances[0].onclick!()
    expect(focus).toHaveBeenCalled()
    expect(onClick).toHaveBeenCalled()
  })

  it('does not throw when Notification throws', () => {
    vi.stubGlobal('Notification', function () {
      throw new Error('nope')
    })
    expect(() => showNotification({ title: 'T', body: 'B', tag: 'x' })).not.toThrow()
  })
})

describe('playBeep', () => {
  beforeEach(() => resetNotificationState())
  afterEach(() => vi.useRealTimers())
  it('throttles to one beep per 1.5s and reuses one context', () => {
    vi.useFakeTimers({ now: 10_000 })
    const osc = { type: '', frequency: { value: 0 }, connect: vi.fn(), start: vi.fn(), stop: vi.fn() }
    const ctor = vi.fn(function () {
      return {
        state: 'suspended', resume: vi.fn(function (this: { state: string }) { this.state = 'running'; return Promise.resolve() }), currentTime: 0, destination: {},
        createOscillator: () => osc, createGain: () => ({ gain: { value: 0 }, connect: vi.fn() }),
      }
    })
    vi.stubGlobal('AudioContext', ctor)
    playBeep()
    playBeep()
    expect(osc.start).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1600)
    playBeep()
    expect(osc.start).toHaveBeenCalledTimes(2)
    expect(ctor).toHaveBeenCalledTimes(1)
  })

  it('is silent without AudioContext or when it throws', () => {
    vi.stubGlobal('AudioContext', undefined)
    expect(() => playBeep()).not.toThrow()
    resetNotificationState()
    vi.stubGlobal('AudioContext', function () {
      throw new Error('blocked')
    })
    expect(() => playBeep()).not.toThrow()
  })
})

describe('title', () => {
  afterEach(() => {
    restoreTitle()
    document.title = ''
  })
  it('sums unread, never stacks prefixes, caps at 99+ and restores', () => {
    expect(unreadTotal([makeRoom({ unread_count: 2 }), makeRoom({ id: 2, unread_count: 3 })])).toBe(5)
    document.title = 'Kết Nối'
    updateTitle(2)
    expect(document.title).toBe('(2) Kết Nối')
    updateTitle(3)
    expect(document.title).toBe('(3) Kết Nối')
    updateTitle(150)
    expect(document.title).toBe('(99+) Kết Nối')
    updateTitle(0)
    expect(document.title).toBe('Kết Nối')
    updateTitle(1)
    restoreTitle()
    expect(document.title).toBe('Kết Nối')
  })
})

describe('liveNow', () => {
  const created = '2026-10-15T09:00:00.000Z'
  const t = Date.parse(created)
  it('tolerates client clocks 5 minutes ahead or behind', () => {
    const msg = makeMessage({ created_at: created })
    const room = makeRoom({ type: 'direct' })
    const base = { room, meId: 1, settings: on, windowVisible: false, windowFocused: false, activeRoomId: null }
    expect(shouldNotify({ ...base, message: msg, now: liveNow(created, t + 300_000) }).notify).toBe(true)
    expect(shouldNotify({ ...base, message: msg, now: liveNow(created, t - 300_000) }).notify).toBe(true)
    expect(liveNow('garbage', 42)).toBe(42)
  })
})

describe('extra notification behaviours', () => {
  beforeEach(() => resetNotificationState())
  afterEach(() => vi.useRealTimers())

  it('keeps using memory settings after a failed write', () => {
    saveSettings({ ...on, sound: false })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('full')
    })
    saveSettings({ ...on, sound: true, allGroupMessages: true })
    expect(loadSettings()).toEqual({ ...on, sound: true, allGroupMessages: true })
  })

  it('reports unsupported after the constructor throws a TypeError', () => {
    vi.stubGlobal('isSecureContext', true)
    vi.stubGlobal('Notification', Object.assign(function () {
      throw new TypeError('Illegal constructor')
    }, { permission: 'granted' }))
    expect(notificationSupport()).toBe('granted')
    showNotification({ title: 'T', body: 'B', tag: 'x' })
    expect(notificationSupport()).toBe('unsupported')
  })

  it('replaces the previous notification with the same tag and clears its timer', () => {
    vi.useFakeTimers()
    const made: { close: ReturnType<typeof vi.fn> }[] = []
    vi.stubGlobal('Notification', function () {
      const n = { close: vi.fn() }
      made.push(n)
      return n
    })
    showNotification({ title: 'A', body: 'B', tag: 'kn-room-1' })
    showNotification({ title: 'A', body: 'C', tag: 'kn-room-1' })
    expect(made[0].close).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(8000)
    expect(made[0].close).toHaveBeenCalledTimes(1)
    expect(made[1].close).toHaveBeenCalledTimes(1)
  })

  it('strips bidi/format characters from titles and sender names', () => {
    expect(cleanText('‮Huy⁦')).toBe('Huy')
    expect(notificationBody(makeMessage({ sender_name: '‮Hà', body: 'x' }), true)).toBe('Hà: x')
  })

  it('does not consume the throttle slot while the audio context cannot run', () => {
    vi.useFakeTimers({ now: 10_000 })
    const osc = { frequency: { value: 0 }, connect: vi.fn(), start: vi.fn(), stop: vi.fn() }
    const ctx = {
      state: 'suspended', resume: vi.fn().mockResolvedValue(undefined), currentTime: 0, destination: {},
      createOscillator: () => osc, createGain: () => ({ gain: { value: 0 }, connect: vi.fn() }),
    }
    vi.stubGlobal('AudioContext', vi.fn(function () { return ctx }))
    playBeep()
    expect(osc.start).not.toHaveBeenCalled()
    ctx.state = 'running'
    playBeep()
    expect(osc.start).toHaveBeenCalledTimes(1)
  })
})
