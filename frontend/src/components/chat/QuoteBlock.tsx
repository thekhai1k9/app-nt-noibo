import type { Reply } from '../../lib/types'

/** Khối trích dẫn tin được trả lời. Là nút chỉ khi có `onJump` (tin gốc đã tải). Chỉ hiển thị text thuần. */
export function QuoteBlock({ reply, onJump }: { reply: Reply; onJump?: () => void }) {
  const content = (
    <>
      <span className="quote-name">{reply.sender_name}</span>
      {reply.deleted ? (
        <em className="quote-text">Tin nhắn đã bị xoá</em>
      ) : (
        <span className="quote-text">{reply.snippet || 'Tin nhắn'}</span>
      )}
    </>
  )
  if (onJump) {
    return (
      <button type="button" className="quote quote-button" aria-label="Đến tin được trả lời" onClick={onJump}>
        {content}
      </button>
    )
  }
  return <div className="quote">{content}</div>
}
