import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ChatMessage } from '../../lib/chatStore'
import { dayLabel, sameDay } from '../../lib/format'
import { MessageItem } from './MessageItem'

const NEAR_BOTTOM_PX = 80
const NEAR_TOP_PX = 120

interface Props {
  items: ChatMessage[]
  hasMoreBefore: boolean
  loaded: boolean
  loadingOlder: boolean
  error: boolean
  meId: number
  isGroup: boolean
  onLoadOlder: () => void
  onRetryLoad: () => void
  onRetrySend: (clientId: string) => void
  onDiscard?: (clientId: string) => void
  onEdit: (messageId: number, body: string) => Promise<void>
  onDelete: (messageId: number) => Promise<void>
}

const EMPTY: ChatMessage[] = []

function nearBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX
}

/**
 * Phải được mount lại cho mỗi phòng (ConversationPane dùng `key={roomId}`): snapshot cuộn
 * không được mang từ phòng này sang phòng khác.
 */
export function MessageList(props: Props) {
  const { items: allItems, hasMoreBefore, loaded, loadingOlder, error, meId, isGroup } = props
  // Tin được đệm khi chưa tải xong không được hiển thị như thể đã đầy đủ.
  const items = loaded ? allItems : EMPTY
  const listRef = useRef<HTMLDivElement>(null)
  const snapshot = useRef({ firstReal: null as number | null, lastReal: null as number | null, pending: 0, scrollHeight: 0, atBottom: true })
  const innerRef = useRef<HTMLDivElement>(null)
  const [unseen, setUnseen] = useState(0)

  const real = items.filter((m) => !m.pending)
  const firstReal = real[0]?.id ?? null
  const lastReal = real.at(-1)?.id ?? null
  const pendingCount = items.length - real.length

  // Chạy sau mọi lần commit (không có danh sách phụ thuộc) để scrollHeight luôn mới;
  // phần so sánh bên dưới dựa trên snapshot của lần commit TRƯỚC.
  useLayoutEffect(() => {
    const el = listRef.current
    if (!el) return
    const prev = snapshot.current
    const scrollToBottom = () => {
      el.scrollTop = el.scrollHeight
      snapshot.current.atBottom = true
      setUnseen(0)
    }
    if (prev.firstReal === null && prev.lastReal === null && prev.pending === 0) {
      if (items.length > 0) scrollToBottom() // lần đầu có dữ liệu: xuống cuối
    } else if (firstReal !== null && prev.firstReal !== null && firstReal < prev.firstReal) {
      el.scrollTop += el.scrollHeight - prev.scrollHeight // tin cũ được thêm lên đầu: giữ nguyên vị trí
    }
    const newReal = prev.lastReal !== null && lastReal !== null && lastReal > prev.lastReal
    const newPending = pendingCount > prev.pending
    if (newPending) {
      scrollToBottom() // tin của chính mình luôn cuộn xuống
    } else if (newReal) {
      const incoming = real.filter((m) => m.id > (prev.lastReal ?? 0))
      // Tin của chính mình từ thiết bị khác (sender_id === meId) cũng cuộn xuống: coi như đang tham gia hội thoại.
      const foreign = incoming.filter((m) => m.sender_id !== meId).length
      if (prev.atBottom || foreign === 0) scrollToBottom()
      else setUnseen((n) => n + foreign)
    }
    snapshot.current = { firstReal, lastReal, pending: pendingCount, scrollHeight: el.scrollHeight, atBottom: snapshot.current.atBottom }
  })

  // Khi đang ở cuối, giữ ghim ở cuối nếu chiều cao nội dung đổi (ảnh/phông tải xong, đổi cỡ cửa sổ...).
  useEffect(() => {
    const el = listRef.current
    const inner = innerRef.current
    if (!el || !inner || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (snapshot.current.atBottom) el.scrollTop = el.scrollHeight
      snapshot.current.scrollHeight = el.scrollHeight
    })
    observer.observe(inner)
    observer.observe(el) // ô soạn tin to ra / đổi cỡ cửa sổ làm đổi chiều cao khung cuộn
    return () => observer.disconnect()
  }, [])

  function onScroll() {
    const el = listRef.current
    if (!el) return
    const atBottom = nearBottom(el)
    snapshot.current.atBottom = atBottom
    snapshot.current.scrollHeight = el.scrollHeight
    if (atBottom) setUnseen(0)
    if (el.scrollTop < NEAR_TOP_PX && hasMoreBefore && !loadingOlder) props.onLoadOlder()
  }

  function jumpToBottom() {
    const el = listRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    snapshot.current.atBottom = true
    setUnseen(0)
  }

  return (
    <div className="msg-list-wrap">
      <div className="msg-list" data-testid="message-list" ref={listRef} onScroll={onScroll}>
        <div className="msg-list-inner" ref={innerRef}>
        {error && !loaded && (
          <div role="alert" className="alert-error stack" style={{ gap: 8 }}>
            <span>Không tải được tin nhắn.</span>
            <button type="button" className="btn" onClick={props.onRetryLoad}>
              Thử lại
            </button>
          </div>
        )}
        {!loaded && !error && <div className="muted msg-note">Đang tải…</div>}
        {loaded && hasMoreBefore && (
          // Một nút cho cả hai trạng thái: thay nút bằng dòng chữ thấp hơn lúc bắt đầu tải sẽ làm nội dung
          // đang đọc nhảy lên (không có tin mới nên phần bù vị trí cuộn không chạy).
          <div className="msg-note">
            <button type="button" className="btn btn-ghost" disabled={loadingOlder} onClick={props.onLoadOlder}>
              {loadingOlder ? 'Đang tải tin cũ…' : 'Tải thêm tin cũ'}
            </button>
          </div>
        )}
        {loaded && !hasMoreBefore && items.length > 0 && <div className="muted msg-note">Đầu cuộc trò chuyện</div>}
        {loaded && items.length === 0 && <div className="muted msg-note">Chưa có tin nhắn. Hãy gửi lời chào!</div>}
        {items.map((message, index) => {
          const previous = items[index - 1]
          const newDay = !previous || !sameDay(previous.created_at, message.created_at)
          const showSender = isGroup && (newDay || previous.sender_id !== message.sender_id)
          return (
            <Fragment key={message.pending ? `p-${message.client_id}` : message.id}>
              {newDay && (
                <div className="day-separator" data-testid="day-separator">
                  {dayLabel(message.created_at)}
                </div>
              )}
              <MessageItem
                message={message}
                mine={message.sender_id === meId}
                showSender={showSender}
                onRetry={props.onRetrySend}
                onDiscard={props.onDiscard}
                onEdit={props.onEdit}
                onDelete={props.onDelete}
              />
            </Fragment>
          )
        })}
        </div>
      </div>
      {unseen > 0 && (
        <button type="button" className="btn btn-primary msg-unseen" onClick={jumpToBottom}>
          {`↓ ${unseen} tin mới`}
        </button>
      )}
    </div>
  )
}
