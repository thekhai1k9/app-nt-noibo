import { makeSnippet } from '../../lib/format'
import type { Message } from '../../lib/types'

/** Vùng role="status" luôn có mặt (lúc trống không chiếm chỗ) để trình đọc màn hình đọc được khi nội dung xuất hiện. */
export function ReplyBar({ reply, onCancel }: { reply: Message | null; onCancel: () => void }) {
  const snippet = reply ? (reply.deleted ? 'Tin nhắn đã bị xoá' : makeSnippet(reply.body) || 'Tin nhắn') : ''
  return (
    <div className={reply ? 'reply-bar' : undefined}>
      <div className="reply-bar-text ellipsis" role="status">
        {reply && (
          <>
            Đang trả lời <strong>{reply.sender_name}</strong>: {snippet}
          </>
        )}
      </div>
      {reply && (
        <button type="button" className="btn btn-ghost reply-bar-cancel" aria-label="Huỷ trả lời" onClick={onCancel}>
          ✕
        </button>
      )}
    </div>
  )
}
