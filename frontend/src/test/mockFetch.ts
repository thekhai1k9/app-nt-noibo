import { vi } from 'vitest'

export interface MockResponse {
  status?: number
  json?: unknown
}
export interface MockRequest {
  method: string
  path: string
  body: unknown
  headers: Headers
}
export type MockHandler = MockResponse | ((req: MockRequest) => MockResponse)

/**
 * Thay `fetch` toàn cục. Khoá có dạng "METHOD /api/duong-dan". Nếu không có khoá khớp
 * cả query, thử khoá không kèm query. Request không có route sẽ ném lỗi để test thất bại rõ ràng.
 */
export function mockFetch(routes: Record<string, MockHandler>) {
  const calls: MockRequest[] = []
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const path = url.replace(/^https?:\/\/[^/]+/, '')
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    const req: MockRequest = { method, path, body, headers: new Headers(init?.headers) }
    calls.push(req)
    const handler = routes[`${method} ${path}`] ?? routes[`${method} ${path.split('?')[0]}`]
    if (!handler) throw new Error(`Unmocked request: ${method} ${path}`)
    const res = typeof handler === 'function' ? handler(req) : handler
    const status = res.status ?? 200
    return new Response(status === 204 ? null : JSON.stringify(res.json ?? {}), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', fn)
  return { fn, calls }
}
