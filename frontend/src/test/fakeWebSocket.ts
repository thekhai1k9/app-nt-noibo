type Handler<T> = ((event: T) => void) | null

/** WebSocket giả cho test: không có mạng; test điều khiển từng bước. */
export class FakeWebSocket {
  static instances: FakeWebSocket[] = []

  static reset(): void {
    FakeWebSocket.instances = []
  }

  static get last(): FakeWebSocket {
    const ws = FakeWebSocket.instances.at(-1)
    if (!ws) throw new Error('chưa có FakeWebSocket nào được tạo')
    return ws
  }

  url: string
  readyState = 0
  sent: string[] = []
  onopen: Handler<unknown> = null
  onmessage: Handler<{ data: string }> = null
  onclose: Handler<{ code: number }> = null
  onerror: Handler<unknown> = null

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  /** Client tự đóng (giống WebSocket thật, đóng xong thì onclose chạy). */
  close(code = 1000): void {
    this.readyState = 3
    this.onclose?.({ code })
  }

  get sentJson(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s))
  }

  open(): void {
    this.readyState = 1
    this.onopen?.({})
  }

  receive(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) })
  }

  serverClose(code: number): void {
    this.readyState = 3
    this.onclose?.({ code })
  }
}
