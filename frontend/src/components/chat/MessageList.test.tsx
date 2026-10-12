import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import type { ChatMessage } from '../../lib/chatStore'
import { MessageList } from './MessageList'

const m = (id: number, over: Partial<ChatMessage> = {}): ChatMessage => ({
  id, room_id: 1, sender_id: 2, sender_name: 'Bob', body: `tin ${id}`, kind: 'text', client_id: null,
  created_at: '2026-10-15T09:00:00.000Z', edited_at: null, deleted: false, ...over,
})

const base = {
  hasMoreBefore: false, loaded: true, loadingOlder: false, error: false, meId: 1, isGroup: true,
  onLoadOlder: vi.fn(), onRetryLoad: vi.fn(), onRetrySend: vi.fn(),
  onEdit: vi.fn().mockResolvedValue(undefined), onDelete: vi.fn().mockResolvedValue(undefined),
}

/** jsdom không có layout: định nghĩa các số đo cuộn để kiểm tra logic. */
function mockMetrics(el: HTMLElement, metrics: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => metrics.scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => metrics.clientHeight })
  Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => metrics.scrollTop, set: (v: number) => { metrics.scrollTop = v } })
}

const listOf = () => screen.getByTestId('message-list')

describe('MessageList', () => {
  it('shows an empty state for a loaded room without messages', () => {
    render(<MessageList {...base} items={[]} />)
    expect(screen.getByText('Chưa có tin nhắn. Hãy gửi lời chào!')).toBeInTheDocument()
  })

  it('shows the start marker only when there is nothing older', () => {
    const { rerender } = render(<MessageList {...base} items={[m(1)]} hasMoreBefore />)
    expect(screen.queryByText('Đầu cuộc trò chuyện')).not.toBeInTheDocument()
    rerender(<MessageList {...base} items={[m(1)]} hasMoreBefore={false} />)
    expect(screen.getByText('Đầu cuộc trò chuyện')).toBeInTheDocument()
  })

  it('shows day separators and groups sender names for consecutive messages in a group', () => {
    render(
      <MessageList
        {...base}
        items={[
          m(1, { created_at: '2026-10-14T09:00:00.000Z' }),
          m(2, { created_at: '2026-10-14T09:01:00.000Z' }),
          m(3, { created_at: '2026-10-15T09:00:00.000Z' }),
        ]}
      />,
    )
    expect(screen.getAllByTestId('day-separator')).toHaveLength(2)
    expect(screen.getAllByText('Bob')).toHaveLength(2) // tin 1 và tin 3 (đầu ngày); tin 2 liền kề thì ẩn tên
  })

  it('hides sender names in direct chats', () => {
    render(<MessageList {...base} isGroup={false} items={[m(1)]} />)
    expect(screen.queryByText('Bob')).not.toBeInTheDocument()
  })

  it('asks for older messages when scrolled near the top, but not while loading or when there is nothing older', () => {
    const onLoadOlder = vi.fn()
    const { rerender } = render(<MessageList {...base} onLoadOlder={onLoadOlder} hasMoreBefore items={[m(5)]} />)
    const el = listOf()
    mockMetrics(el, { scrollHeight: 1000, clientHeight: 400, scrollTop: 50 })
    el.dispatchEvent(new Event('scroll'))
    expect(onLoadOlder).toHaveBeenCalledTimes(1)
    mockMetrics(el, { scrollHeight: 1000, clientHeight: 400, scrollTop: 600 })
    el.dispatchEvent(new Event('scroll'))
    expect(onLoadOlder).toHaveBeenCalledTimes(1)
    rerender(<MessageList {...base} onLoadOlder={onLoadOlder} hasMoreBefore={false} items={[m(5)]} />)
    mockMetrics(listOf(), { scrollHeight: 1000, clientHeight: 400, scrollTop: 10 })
    listOf().dispatchEvent(new Event('scroll'))
    expect(onLoadOlder).toHaveBeenCalledTimes(1)
  })

  it('keeps the scroll position when older messages are prepended', () => {
    const metrics = { scrollHeight: 500, clientHeight: 400, scrollTop: 0 }
    const { rerender } = render(<MessageList {...base} hasMoreBefore items={[m(5), m(6)]} />)
    mockMetrics(listOf(), metrics)
    listOf().dispatchEvent(new Event('scroll')) // ghi nhận số đo hiện tại
    metrics.scrollHeight = 800 // thêm 300px tin cũ ở trên
    rerender(<MessageList {...base} hasMoreBefore items={[m(3), m(4), m(5), m(6)]} />)
    expect(metrics.scrollTop).toBe(300)
  })

  it('follows new messages when the user is at the bottom', () => {
    const metrics = { scrollHeight: 1000, clientHeight: 400, scrollTop: 600 } // đang ở cuối
    const { rerender } = render(<MessageList {...base} items={[m(1)]} />)
    mockMetrics(listOf(), metrics)
    listOf().dispatchEvent(new Event('scroll'))
    metrics.scrollHeight = 1100
    rerender(<MessageList {...base} items={[m(1), m(2)]} />)
    expect(metrics.scrollTop).toBe(1100)
    expect(screen.queryByRole('button', { name: /tin mới/ })).not.toBeInTheDocument()
  })

  it('shows a counter instead of jumping when new messages arrive while reading older ones', async () => {
    const metrics = { scrollHeight: 1000, clientHeight: 400, scrollTop: 100 } // đang đọc tin cũ
    const { rerender } = render(<MessageList {...base} items={[m(1)]} />)
    mockMetrics(listOf(), metrics)
    listOf().dispatchEvent(new Event('scroll'))
    metrics.scrollHeight = 1100
    rerender(<MessageList {...base} items={[m(1), m(2), m(3)]} />)
    expect(metrics.scrollTop).toBe(100)
    const button = screen.getByRole('button', { name: '↓ 2 tin mới' })
    await userEvent.click(button)
    expect(metrics.scrollTop).toBe(1100)
    expect(screen.queryByRole('button', { name: /tin mới/ })).not.toBeInTheDocument()
  })

  it('always scrolls to the bottom for the user\'s own new messages', () => {
    const metrics = { scrollHeight: 1000, clientHeight: 400, scrollTop: 100 }
    const { rerender } = render(<MessageList {...base} items={[m(1)]} />)
    mockMetrics(listOf(), metrics)
    listOf().dispatchEvent(new Event('scroll'))
    metrics.scrollHeight = 1100
    rerender(<MessageList {...base} items={[m(1), m(-1, { sender_id: 1, pending: 'sending', client_id: 'c1' })]} />)
    expect(metrics.scrollTop).toBe(1100)
  })

  it('shows loading and error states with a retry button', async () => {
    const onRetryLoad = vi.fn()
    const { rerender } = render(<MessageList {...base} hasMoreBefore loadingOlder items={[m(1)]} />)
    expect(screen.getByText('Đang tải tin cũ…')).toBeInTheDocument()
    rerender(<MessageList {...base} onRetryLoad={onRetryLoad} error loaded={false} items={[]} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Không tải được tin nhắn')
    await userEvent.click(screen.getByRole('button', { name: 'Thử lại' }))
    expect(onRetryLoad).toHaveBeenCalled()
  })

  it('shows a loading indicator before the first page arrives', () => {
    render(<MessageList {...base} loaded={false} items={[]} />)
    expect(screen.getByText('Đang tải…')).toBeInTheDocument()
  })

  it('does not render buffered items before the thread is loaded', () => {
    render(<MessageList {...base} loaded={false} items={[m(1)]} />)
    expect(screen.queryByText('tin 1')).not.toBeInTheDocument()
    expect(screen.getByText('Đang tải…')).toBeInTheDocument()
  })

  it('offers a button to load older messages when there are more and none is loading', async () => {
    const onLoadOlder = vi.fn()
    const { rerender } = render(<MessageList {...base} onLoadOlder={onLoadOlder} hasMoreBefore items={[m(5)]} />)
    await userEvent.click(screen.getByRole('button', { name: 'Tải thêm tin cũ' }))
    expect(onLoadOlder).toHaveBeenCalledTimes(1)
    rerender(<MessageList {...base} onLoadOlder={onLoadOlder} hasMoreBefore loadingOlder items={[m(5)]} />)
    expect(screen.queryByRole('button', { name: 'Tải thêm tin cũ' })).not.toBeInTheDocument()
  })

  it('keeps the same older-messages control while loading so the content above the messages does not change height', () => {
    // Trình duyệt thật: đổi nút "Tải thêm tin cũ" (cao 44px) thành một dòng chữ thấp hơn lúc bắt đầu tải
    // làm nội dung đang đọc nhảy lên ~24px mà không có gì bù lại (scrollTop đã ở 0 hoặc gần 0).
    const { rerender } = render(<MessageList {...base} hasMoreBefore items={[m(5)]} />)
    const control = screen.getByRole('button', { name: 'Tải thêm tin cũ' })
    rerender(<MessageList {...base} hasMoreBefore loadingOlder items={[m(5)]} />)
    const loading = screen.getByRole('button', { name: 'Đang tải tin cũ…' })
    expect(loading).toBe(control)
    expect(loading).toBeDisabled()
    rerender(<MessageList {...base} hasMoreBefore items={[m(5)]} />) // tải lỗi: trở lại như cũ
    expect(screen.getByRole('button', { name: 'Tải thêm tin cũ' })).toBe(control)
  })

  it('keeps the previous height reference fresh when the height changes without item changes', () => {
    const metrics = { scrollHeight: 500, clientHeight: 400, scrollTop: 0 }
    const { rerender } = render(<MessageList {...base} hasMoreBefore items={[m(5), m(6)]} />)
    mockMetrics(listOf(), metrics)
    listOf().dispatchEvent(new Event('scroll'))
    metrics.scrollHeight = 560 // ví dụ ghi chú "đang tải" xuất hiện, không có tin mới
    rerender(<MessageList {...base} hasMoreBefore loadingOlder items={[m(5), m(6)]} />)
    metrics.scrollHeight = 860 // tin cũ được thêm lên đầu (300px) và ghi chú biến mất
    rerender(<MessageList {...base} hasMoreBefore items={[m(3), m(4), m(5), m(6)]} />)
    expect(metrics.scrollTop).toBe(300)
  })

  it('re-pins to the bottom when the scroll container itself resizes while at the bottom', () => {
    const callbacks: Array<() => void> = []
    const observed: Element[] = []
    class FakeRO {
      constructor(cb: () => void) {
        callbacks.push(cb)
      }
      observe(el: Element) {
        observed.push(el)
      }
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', FakeRO)
    try {
      const metrics = { scrollHeight: 500, clientHeight: 400, scrollTop: 100 }
      render(<MessageList {...base} items={[m(5), m(6)]} />)
      expect(observed).toContain(listOf())
      mockMetrics(listOf(), metrics)
      metrics.scrollHeight = 520
      callbacks.forEach((cb) => cb())
      expect(metrics.scrollTop).toBe(520)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
