import type { TokenOut } from './types'

export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string) {
    super(code)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

export type RefreshResult = 'ok' | 'denied' | 'unavailable'

// Access token chỉ nằm trong bộ nhớ của tab này. Không ghi vào localStorage/sessionStorage.
let accessToken: string | null = null
let authLostHandler: (() => void) | null = null
let refreshInFlight: Promise<RefreshResult> | null = null

export function setAccessToken(token: string | null): void {
  accessToken = token
}

export function getAccessToken(): string | null {
  return accessToken
}

export function setAuthLostHandler(handler: (() => void) | null): void {
  authLostHandler = handler
}

export function resetApiState(): void {
  accessToken = null
  authLostHandler = null
  refreshInFlight = null
}

interface RequestOptions {
  method?: string
  json?: unknown
}

async function send(path: string, options: RequestOptions, withAuth: boolean): Promise<Response> {
  const headers = new Headers()
  let body: string | undefined
  if (options.json !== undefined) {
    headers.set('Content-Type', 'application/json')
    body = JSON.stringify(options.json)
  }
  if (withAuth && accessToken) headers.set('Authorization', `Bearer ${accessToken}`)
  try {
    return await fetch(`/api${path}`, {
      method: options.method ?? 'GET',
      headers,
      body,
      credentials: 'same-origin',
    })
  } catch {
    throw new ApiError(0, 'network_error')
  }
}

async function toApiError(res: Response): Promise<ApiError> {
  let code = res.status === 422 ? 'validation_error' : 'unknown_error'
  try {
    const data = await res.json()
    if (data && typeof data.detail === 'string') code = data.detail
  } catch {
    // thân phản hồi không phải JSON
  }
  return new ApiError(res.status, code)
}

async function refreshOnce(): Promise<RefreshResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response
    try {
      res = await send('/auth/refresh', { method: 'POST' }, false)
    } catch {
      return 'unavailable'
    }
    if (res.ok) {
      const data = (await res.json()) as TokenOut
      accessToken = data.access_token
      return 'ok'
    }
    if (res.status !== 401) return 'unavailable'
    // 401: có thể tab khác vừa xoay cookie. Thử lại một lần với cookie mới.
  }
  return 'denied'
}

/** Gộp các lần refresh đồng thời trong tab và tuần tự hoá giữa các tab bằng Web Locks. */
export function refreshSession(): Promise<RefreshResult> {
  if (!refreshInFlight) {
    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
    const run = locks ? locks.request('kn-refresh', () => refreshOnce()) : refreshOnce()
    const tracked: Promise<RefreshResult> = run.finally(() => {
      // Chỉ xoá nếu vẫn là lần refresh này (resetApiState có thể đã thay bằng lần mới).
      if (refreshInFlight === tracked) refreshInFlight = null
    })
    refreshInFlight = tracked
  }
  return refreshInFlight
}

/** Resolve khi lần refresh đang chạy (nếu có) đã kết thúc; không bao giờ reject. */
export async function waitForRefresh(): Promise<void> {
  const pending = refreshInFlight
  if (!pending) return
  try {
    await pending
  } catch {
    // kết quả refresh không quan trọng với người gọi
  }
}

const NO_REFRESH_PATHS = new Set(['/auth/login', '/auth/refresh', '/auth/logout'])

export async function api<T = void>(path: string, options: RequestOptions = {}): Promise<T> {
  let res = await send(path, options, true)
  if (res.status === 401 && !NO_REFRESH_PATHS.has(path)) {
    const result = await refreshSession()
    if (result === 'denied') {
      accessToken = null
      authLostHandler?.()
      throw await toApiError(res)
    }
    if (result === 'unavailable') throw new ApiError(0, 'network_error')
    res = await send(path, options, true)
  }
  if (!res.ok) throw await toApiError(res)
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}
