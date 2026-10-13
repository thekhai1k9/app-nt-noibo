import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import { DEFAULT_SETTINGS, resetNotificationState } from '../lib/notifications'
import { FakeWebSocket } from '../test/fakeWebSocket'
import { mockFetch } from '../test/mockFetch'
import { makeMessage, makeRoom, makeUser, renderApp, sessionRoutes } from '../test/utils'

const me = makeUser({ id: 1 })
const rooms = [
  makeRoom({ id: 1, name: 'Dự án kho', unread_count: 2, last_message: makeMessage({ id: 5, body: 'báo cáo xong' }) }),
  makeRoom({ id: 2, type: 'direct', name: 'Trần Quốc Huy', peer_id: 3, unread_count: 0, last_activity: '2026-10-15T08:00:00.000Z' }),
]

function routes() {
  return {
    ...sessionRoutes(me),
    'GET /api/rooms': { json: rooms },
    'GET /api/rooms/1/messages': { json: { items: [makeMessage({ id: 5, body: 'báo cáo xong' })], has_more_before: false, has_more_after: false } },
    'GET /api/rooms/2/messages': { json: { items: [], has_more_before: false, has_more_after: false } },
    'POST /api/rooms/1/read': { status: 204 },
    'GET /api/presence': { json: { online_user_ids: [] } },
    'GET /api/rooms/1/members': { json: [] },
    'GET /api/rooms/2/members': { json: [] },
  } as Parameters<typeof mockFetch>[0]
}

async function connect() {
  await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0))
  const ws = FakeWebSocket.last
  await act(async () => {
    ws.open()
    ws.receive({ type: 'ready', user_id: 1 })
  })
  return ws
}

type Shown = { title: string; options: { body: string; tag: string; silent: boolean }; close: () => void; onclick?: () => void }
let shown: Shown[]
let beeps: number
let permission: string
let visibility: string

beforeEach(() => {
  resetNotificationState()
  document.title = ''
  shown = []
  beeps = 0
  permission = 'granted'
  visibility = 'hidden'
  const Fake = function (this: unknown, title: string, options: Shown['options']) {
    const n: Shown = { title, options, close: vi.fn() }
    shown.push(n)
    return n
  } as unknown as { permission: string; requestPermission: () => Promise<string> }
  Object.defineProperty(Fake, 'permission', { get: () => permission })
  Fake.requestPermission = vi.fn(async () => {
    permission = 'granted'
    return 'granted'
  })
  vi.stubGlobal('Notification', Fake)
  vi.stubGlobal('isSecureContext', true)
  vi.stubGlobal(
    'AudioContext',
    vi.fn(function () {
      return {
        state: 'running', resume: vi.fn(), currentTime: 0, destination: {},
        createOscillator: () => ({ frequency: { value: 0 }, connect: vi.fn(), start: () => beeps++, stop: vi.fn() }),
        createGain: () => ({ gain: { value: 0 }, connect: vi.fn() }),
      }
    }),
  )
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
  localStorage.setItem('kn.notify.v1', JSON.stringify({ ...DEFAULT_SETTINGS, enabled: true }))
})

afterEach(() => {
  Reflect.deleteProperty(document, 'visibilityState')
  document.title = ''
})

const live = (over: Parameters<typeof makeMessage>[0]) =>
  makeMessage({ created_at: new Date().toISOString(), sender_id: 3, sender_name: 'Trần Quốc Huy', ...over })

describe('notifications in the chat layout', () => {
  it('enables browser notifications from the settings dialog', async () => {
    permission = 'default'
    localStorage.clear()
    mockFetch(routes())
    renderApp('/')
    await userEvent.click(await screen.findByRole('button', { name: 'Cài đặt thông báo' }))
    expect(screen.getByRole('dialog', { name: 'Cài đặt thông báo' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Bật thông báo trình duyệt' }))
    await waitFor(() => expect(JSON.parse(localStorage.getItem('kn.notify.v1')!).enabled).toBe(true))
    expect(screen.getByRole('switch', { name: 'Thông báo trình duyệt' })).toBeChecked()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cài đặt thông báo' })).toHaveFocus()
  })

  it('shows one notification and one beep for a direct message while the window is hidden', async () => {
    mockFetch(routes())
    renderApp('/')
    await screen.findByRole('link', { name: /Trần Quốc Huy/ })
    const ws = await connect()
    await act(async () => ws.receive({ type: 'message', message: live({ id: 10, room_id: 2, body: 'ơi' }) }))
    expect(shown).toHaveLength(1)
    expect(shown[0].title).toBe('Trần Quốc Huy')
    expect(shown[0].options).toEqual({ body: 'Trần Quốc Huy: ơi', tag: 'kn-room-2', silent: true })
    expect(beeps).toBe(1)
  })

  it('stays quiet for a plain group message but notifies for a mention', async () => {
    mockFetch(routes())
    renderApp('/')
    await screen.findByRole('link', { name: /Dự án kho/ })
    const ws = await connect()
    await act(async () => ws.receive({ type: 'message', message: live({ id: 11, room_id: 1, sender_id: 2, sender_name: 'Lê Thu Hà', body: 'chào' }) }))
    expect(shown).toHaveLength(0)
    await act(async () =>
      ws.receive({ type: 'message', message: live({ id: 12, room_id: 1, sender_id: 2, sender_name: 'Lê Thu Hà', body: '@Phạm Đức Long ơi', mentions: [{ user_id: 1, full_name: 'Phạm Đức Long' }] }) }),
    )
    expect(shown).toHaveLength(1)
    expect(shown[0].options.tag).toBe('kn-room-1')
  })

  it('hides the message text when previews are off', async () => {
    localStorage.setItem('kn.notify.v1', JSON.stringify({ ...DEFAULT_SETTINGS, enabled: true, showPreview: false }))
    mockFetch(routes())
    renderApp('/')
    await screen.findByRole('link', { name: /Trần Quốc Huy/ })
    const ws = await connect()
    await act(async () => ws.receive({ type: 'message', message: live({ id: 10, room_id: 2, body: 'bí mật' }) }))
    expect(shown).toHaveLength(1)
    expect(shown[0].options.body).toBe('Tin nhắn mới')
    expect(JSON.stringify(shown[0])).not.toContain('bí mật')
  })

  it('opens the right room when the notification is clicked', async () => {
    mockFetch(routes())
    renderApp('/')
    await screen.findByRole('link', { name: /Trần Quốc Huy/ })
    const ws = await connect()
    await act(async () => ws.receive({ type: 'message', message: live({ id: 10, room_id: 2, body: 'ơi' }) }))
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => undefined)
    await act(async () => shown[0].onclick!())
    expect(focus).toHaveBeenCalled()
    expect(await screen.findByRole('heading', { name: 'Trần Quốc Huy' })).toBeInTheDocument()
  })

  it('shows the unread total in the tab title and clears it after reading', async () => {
    visibility = 'visible'
    mockFetch(routes())
    renderApp('/')
    await waitFor(() => expect(document.title).toBe('(2) Kết Nối'))
    await userEvent.click(await screen.findByRole('link', { name: /Dự án kho/ }))
    await waitFor(() => expect(document.title).toBe('Kết Nối'))
  })
})
