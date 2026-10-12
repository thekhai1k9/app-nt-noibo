import { vi } from 'vitest'
import type { RefreshResult } from './api'
import type { ServerEvent } from './types'
import { ChatSocket } from './ws'
import { FakeWebSocket } from '../test/fakeWebSocket'

function setup(overrides: Partial<ConstructorParameters<typeof ChatSocket>[0]> = {}) {
  const events: ServerEvent[] = []
  const statuses: string[] = []
  const onAuthLost = vi.fn()
  const refresh = vi.fn<() => Promise<RefreshResult>>().mockResolvedValue('ok')
  const socket = new ChatSocket({
    getToken: () => 'tok-1',
    refresh,
    onAuthLost,
    url: 'ws://test/api/ws',
    random: () => 0.5, // jitter = delay * 1.0
    ...overrides,
  })
  socket.onEvent((e) => events.push(e))
  socket.onStatus((s) => statuses.push(s))
  return { socket, events, statuses, onAuthLost, refresh }
}

const ready = { type: 'ready', user_id: 1 }

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('ChatSocket', () => {
  it('authenticates with the first frame and keeps the token out of the URL', () => {
    const { socket } = setup()
    socket.start()
    const ws = FakeWebSocket.last
    expect(ws.url).toBe('ws://test/api/ws')
    expect(ws.url).not.toContain('tok-1')
    ws.open()
    expect(ws.sentJson).toEqual([{ type: 'auth', token: 'tok-1' }])
  })

  it('becomes open on ready, emits ready and later events', () => {
    const { socket, events, statuses } = setup()
    socket.start()
    const ws = FakeWebSocket.last
    ws.open()
    expect(socket.getStatus()).toBe('connecting')
    ws.receive(ready)
    ws.receive({ type: 'rooms_changed' })
    expect(socket.getStatus()).toBe('open')
    expect(statuses).toEqual(['connecting', 'open'])
    expect(events).toEqual([ready, { type: 'rooms_changed' }])
  })

  it('sends only while open', () => {
    const { socket } = setup()
    expect(socket.send({ type: 'ping' })).toBe(false)
    socket.start()
    const ws = FakeWebSocket.last
    ws.open()
    expect(socket.send({ type: 'ping' })).toBe(false) // chưa ready
    ws.receive(ready)
    expect(socket.send({ type: 'send', room_id: 1, body: 'hi', client_id: 'c1' })).toBe(true)
    expect(ws.sentJson.at(-1)).toEqual({ type: 'send', room_id: 1, body: 'hi', client_id: 'c1' })
  })

  it('ignores malformed frames', () => {
    const { socket, events } = setup()
    socket.start()
    const ws = FakeWebSocket.last
    ws.open()
    ws.onmessage?.({ data: 'không phải json' })
    ws.onmessage?.({ data: JSON.stringify([1, 2]) })
    ws.receive(ready)
    expect(events).toEqual([ready])
  })

  it('reconnects with growing backoff and resets it after ready', () => {
    const { socket } = setup()
    socket.start()
    FakeWebSocket.last.serverClose(1006)
    expect(FakeWebSocket.instances).toHaveLength(1)
    vi.advanceTimersByTime(999)
    expect(FakeWebSocket.instances).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(FakeWebSocket.instances).toHaveLength(2) // sau 1s
    FakeWebSocket.last.serverClose(1006)
    vi.advanceTimersByTime(2000)
    expect(FakeWebSocket.instances).toHaveLength(3) // sau 2s
    FakeWebSocket.last.serverClose(1006)
    vi.advanceTimersByTime(4999)
    expect(FakeWebSocket.instances).toHaveLength(3)
    vi.advanceTimersByTime(1)
    expect(FakeWebSocket.instances).toHaveLength(4) // sau 5s
    FakeWebSocket.last.open()
    FakeWebSocket.last.receive(ready) // thành công: đặt lại backoff
    FakeWebSocket.last.serverClose(1006)
    vi.advanceTimersByTime(1000)
    expect(FakeWebSocket.instances).toHaveLength(5)
  })

  it('caps the backoff at the last value', () => {
    const { socket } = setup({ backoffMs: [100, 200] })
    socket.start()
    for (let i = 0; i < 4; i++) {
      FakeWebSocket.last.serverClose(1006)
      vi.advanceTimersByTime(200)
    }
    expect(FakeWebSocket.instances.length).toBe(5)
    FakeWebSocket.last.serverClose(1006)
    vi.advanceTimersByTime(199)
    expect(FakeWebSocket.instances.length).toBe(5)
    vi.advanceTimersByTime(1)
    expect(FakeWebSocket.instances.length).toBe(6)
  })

  it('applies jitter to the delay', () => {
    const { socket } = setup({ random: () => 1 }) // jitter = delay * 1.2
    socket.start()
    FakeWebSocket.last.serverClose(1006)
    vi.advanceTimersByTime(1199)
    expect(FakeWebSocket.instances).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(FakeWebSocket.instances).toHaveLength(2)
  })

  it('does not reconnect after 4403 and reports the lost session', () => {
    const { socket, onAuthLost, statuses } = setup()
    socket.start()
    FakeWebSocket.last.open()
    FakeWebSocket.last.receive(ready)
    FakeWebSocket.last.serverClose(4403)
    vi.advanceTimersByTime(60_000)
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(onAuthLost).toHaveBeenCalledTimes(1)
    expect(statuses.at(-1)).toBe('offline')
  })

  it('refreshes the token on 4401 and reconnects immediately', async () => {
    const { socket, refresh, onAuthLost } = setup()
    socket.start()
    FakeWebSocket.last.open()
    FakeWebSocket.last.serverClose(4401)
    await vi.advanceTimersByTimeAsync(0)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(onAuthLost).not.toHaveBeenCalled()
  })

  it('gives up when the refresh is denied after 4401', async () => {
    const refresh = vi.fn<() => Promise<RefreshResult>>().mockResolvedValue('denied')
    const { socket, onAuthLost } = setup({ refresh })
    socket.start()
    FakeWebSocket.last.serverClose(4401)
    await vi.advanceTimersByTimeAsync(0)
    expect(onAuthLost).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(socket.getStatus()).toBe('offline')
  })

  it('does not loop on repeated 4401 without a ready in between', async () => {
    const { socket, refresh, onAuthLost } = setup()
    socket.start()
    FakeWebSocket.last.serverClose(4401)
    await vi.advanceTimersByTimeAsync(0)
    FakeWebSocket.last.serverClose(4401) // lần hai liên tiếp, vẫn chưa có ready
    await vi.advanceTimersByTimeAsync(0)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(onAuthLost).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(FakeWebSocket.instances).toHaveLength(2)
  })

  it('counts 4401 failures again after a successful ready', async () => {
    const { socket, onAuthLost } = setup()
    socket.start()
    FakeWebSocket.last.serverClose(4401)
    await vi.advanceTimersByTimeAsync(0)
    FakeWebSocket.last.open()
    FakeWebSocket.last.receive(ready)
    FakeWebSocket.last.serverClose(4401)
    await vi.advanceTimersByTimeAsync(0)
    expect(onAuthLost).not.toHaveBeenCalled()
    expect(FakeWebSocket.instances).toHaveLength(3)
  })

  it('tries to refresh first when there is no token', async () => {
    let token: string | null = null
    const refresh = vi.fn<() => Promise<RefreshResult>>().mockImplementation(async () => {
      token = 'tok-new'
      return 'ok'
    })
    const { socket } = setup({ getToken: () => token, refresh })
    socket.start()
    expect(FakeWebSocket.instances).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(FakeWebSocket.instances).toHaveLength(1)
    FakeWebSocket.last.open()
    expect(FakeWebSocket.last.sentJson).toEqual([{ type: 'auth', token: 'tok-new' }])
  })

  it('backs off when the refresh endpoint is unavailable', async () => {
    const refresh = vi.fn<() => Promise<RefreshResult>>().mockResolvedValue('unavailable')
    const { socket, onAuthLost } = setup({ getToken: () => null, refresh })
    socket.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(refresh).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(onAuthLost).not.toHaveBeenCalled()
  })

  it('stop() closes quietly: no reconnect and stale events are ignored', () => {
    const { socket, events } = setup()
    socket.start()
    const ws = FakeWebSocket.last
    ws.open()
    socket.stop()
    vi.advanceTimersByTime(60_000)
    ws.receive({ type: 'rooms_changed' })
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(events).toEqual([])
    expect(socket.getStatus()).toBe('offline')
  })

  it('can be started again after stop()', () => {
    const { socket } = setup()
    socket.start()
    socket.stop()
    socket.start()
    expect(FakeWebSocket.instances).toHaveLength(2)
  })

  it('reconnectNow() skips the waiting time', () => {
    const { socket } = setup()
    socket.start()
    FakeWebSocket.last.serverClose(1006)
    socket.reconnectNow()
    expect(FakeWebSocket.instances).toHaveLength(2)
    vi.advanceTimersByTime(60_000) // hẹn giờ cũ đã bị huỷ: không tạo thêm kết nối
    expect(FakeWebSocket.instances).toHaveLength(2)
  })

  it('reconnectNow() does nothing while connected', () => {
    const { socket } = setup()
    socket.start()
    FakeWebSocket.last.open()
    FakeWebSocket.last.receive(ready)
    socket.reconnectNow()
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('does not reconnect twice when an old socket closes after a newer one exists', () => {
    const { socket } = setup()
    socket.start()
    const first = FakeWebSocket.last
    first.serverClose(1006)
    socket.reconnectNow()
    first.serverClose(1006) // sự kiện đóng trễ của kết nối cũ
    vi.advanceTimersByTime(60_000)
    expect(FakeWebSocket.instances).toHaveLength(2)
  })
})
