import { vi } from 'vitest'
import { mockFetch } from '../test/mockFetch'
import {
  ApiError,
  api,
  getAccessToken,
  refreshSession,
  resetApiState,
  setAccessToken,
  setAuthLostHandler,
  waitForRefresh,
} from './api'

const tokenJson = (token: string) => ({
  json: { access_token: token, token_type: 'bearer', must_change_password: false },
})

describe('api client', () => {
  it('sends a JSON body and the bearer token', async () => {
    setAccessToken('abc')
    const { calls } = mockFetch({ 'POST /api/admin/branches': { status: 201, json: { id: 1 } } })
    await api('/admin/branches', { method: 'POST', json: { name: 'A' } })
    expect(calls[0].headers.get('Authorization')).toBe('Bearer abc')
    expect(calls[0].headers.get('Content-Type')).toBe('application/json')
    expect(calls[0].body).toEqual({ name: 'A' })
  })

  it('returns undefined for 204', async () => {
    mockFetch({ 'POST /api/auth/logout': { status: 204 } })
    await expect(api('/auth/logout', { method: 'POST' })).resolves.toBeUndefined()
  })

  it('raises ApiError with the server detail code', async () => {
    mockFetch({ 'POST /api/admin/users': { status: 409, json: { detail: 'username_taken' } } })
    await expect(api('/admin/users', { method: 'POST', json: {} })).rejects.toMatchObject({
      status: 409,
      code: 'username_taken',
    })
  })

  it('treats FastAPI 422 as validation_error', async () => {
    mockFetch({ 'POST /api/admin/users': { status: 422, json: { detail: [{ msg: 'x' }] } } })
    await expect(api('/admin/users', { method: 'POST', json: {} })).rejects.toMatchObject({
      code: 'validation_error',
    })
  })

  it('refreshes once on 401 and retries with the new token', async () => {
    setAccessToken('old')
    const { calls } = mockFetch({
      'GET /api/auth/me': (req) =>
        req.headers.get('Authorization') === 'Bearer new'
          ? { json: { id: 1 } }
          : { status: 401, json: { detail: 'not_authenticated' } },
      'POST /api/auth/refresh': tokenJson('new'),
    })
    await expect(api('/auth/me')).resolves.toEqual({ id: 1 })
    expect(getAccessToken()).toBe('new')
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /api/auth/me',
      'POST /api/auth/refresh',
      'GET /api/auth/me',
    ])
  })

  it('shares a single refresh between concurrent 401s', async () => {
    setAccessToken('old')
    let refreshCalls = 0
    const authorized = (req: { headers: Headers }, body: unknown) =>
      req.headers.get('Authorization') === 'Bearer new'
        ? { json: body }
        : { status: 401, json: { detail: 'not_authenticated' } }
    mockFetch({
      'GET /api/admin/users': (req) => authorized(req, []),
      'GET /api/admin/branches': (req) => authorized(req, []),
      'POST /api/auth/refresh': () => {
        refreshCalls += 1
        return tokenJson('new')
      },
    })
    await Promise.all([api('/admin/users'), api('/admin/branches')])
    expect(refreshCalls).toBe(1)
  })

  it('retries the refresh once when it returns 401 (another tab may have rotated the cookie)', async () => {
    setAccessToken('old')
    let refreshCalls = 0
    mockFetch({
      'GET /api/auth/me': (req) =>
        req.headers.get('Authorization') === 'Bearer new'
          ? { json: { id: 1 } }
          : { status: 401, json: { detail: 'not_authenticated' } },
      'POST /api/auth/refresh': () => {
        refreshCalls += 1
        return refreshCalls === 1 ? { status: 401, json: { detail: 'invalid_refresh' } } : tokenJson('new')
      },
    })
    await expect(api('/auth/me')).resolves.toEqual({ id: 1 })
    expect(refreshCalls).toBe(2)
  })

  it('treats a refresh that is denied twice as a lost session', async () => {
    setAccessToken('old')
    const lost = vi.fn()
    setAuthLostHandler(lost)
    let refreshCalls = 0
    mockFetch({
      'GET /api/auth/me': { status: 401, json: { detail: 'not_authenticated' } },
      'POST /api/auth/refresh': () => {
        refreshCalls += 1
        return { status: 401, json: { detail: 'invalid_refresh' } }
      },
    })
    await expect(api('/auth/me')).rejects.toMatchObject({ status: 401, code: 'not_authenticated' })
    expect(refreshCalls).toBe(2)
    expect(lost).toHaveBeenCalledTimes(1)
    expect(getAccessToken()).toBeNull()
  })

  it('does not try to refresh when login itself returns 401', async () => {
    const { fn } = mockFetch({
      'POST /api/auth/login': { status: 401, json: { detail: 'invalid_credentials' } },
    })
    await expect(api('/auth/login', { method: 'POST', json: {} })).rejects.toMatchObject({
      code: 'invalid_credentials',
    })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('reports a network error without losing the session', async () => {
    const lost = vi.fn()
    setAuthLostHandler(lost)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')))
    await expect(api('/admin/users')).rejects.toMatchObject({ status: 0, code: 'network_error' })
    expect(lost).not.toHaveBeenCalled()
  })

  it('does not log the user out when the refresh endpoint is unreachable', async () => {
    setAccessToken('old')
    const lost = vi.fn()
    setAuthLostHandler(lost)
    mockFetch({
      'GET /api/admin/users': { status: 401, json: { detail: 'not_authenticated' } },
      'POST /api/auth/refresh': () => {
        throw new Error('connection reset')
      },
    })
    await expect(api('/admin/users')).rejects.toMatchObject({ code: 'network_error' })
    expect(lost).not.toHaveBeenCalled()
    expect(getAccessToken()).toBe('old')
  })

  it('serializes refresh across tabs with navigator.locks when available', async () => {
    const request = vi.fn((_name: string, cb: () => Promise<unknown>) => cb())
    Object.defineProperty(navigator, 'locks', { value: { request }, configurable: true })
    try {
      mockFetch({ 'POST /api/auth/refresh': tokenJson('t') })
      await expect(refreshSession()).resolves.toBe('ok')
      expect(request).toHaveBeenCalledWith('kn-refresh', expect.any(Function))
    } finally {
      Reflect.deleteProperty(navigator, 'locks') // dọn thuộc tính đã thêm cho test
    }
  })

  it('exposes ApiError with status and code', () => {
    const err = new ApiError(403, 'forbidden')
    expect(err).toBeInstanceOf(Error)
    expect(err.status).toBe(403)
    expect(err.code).toBe('forbidden')
  })
})

/** fetch giả: mỗi lần gọi trả về một promise do test tự quyết định lúc nào hoàn tất. */
function deferredFetch() {
  const pending: Array<(token: string) => void> = []
  const fn = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        pending.push((token) =>
          resolve(
            new Response(
              JSON.stringify({ access_token: token, token_type: 'bearer', must_change_password: false }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
          ),
        )
      }),
  )
  vi.stubGlobal('fetch', fn)
  return { fn, pending }
}

describe('waitForRefresh', () => {
  it('resolves immediately when no refresh is in flight', async () => {
    await expect(waitForRefresh()).resolves.toBeUndefined()
  })

  it('resolves only after an in-flight refresh has settled', async () => {
    const { pending } = deferredFetch()
    const refresh = refreshSession()
    let waited = false
    const waiter = waitForRefresh().then(() => {
      waited = true
    })
    await new Promise((r) => setTimeout(r, 0))
    expect(waited).toBe(false)
    pending[0]('fresh')
    await waiter
    expect(waited).toBe(true)
    await expect(refresh).resolves.toBe('ok')
    expect(getAccessToken()).toBe('fresh')
  })

  it('never rejects, even when the refresh fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')))
    void refreshSession()
    await expect(waitForRefresh()).resolves.toBeUndefined()
  })

  it('does not let a stale refresh clear a newer in-flight refresh', async () => {
    const { fn, pending } = deferredFetch()
    const stale = refreshSession()
    resetApiState()
    const newer = refreshSession()
    expect(fn).toHaveBeenCalledTimes(2)
    pending[0]('old')
    await stale
    // refresh mới vẫn đang chạy: lời gọi tiếp theo phải dùng lại nó, không tạo request thứ ba
    const joined = refreshSession()
    expect(fn).toHaveBeenCalledTimes(2)
    pending[1]('new')
    await expect(joined).resolves.toBe('ok')
    await newer
  })
})
