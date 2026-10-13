import { makeSnippet } from '../../lib/format'
import type { Message } from '../../lib/types'

export function ReplyBar({ reply, onCancel }: { reply: Message; onCancel: () => void }) {
  const snippet = reply.deleted ? 'Tin nhắn đã bị xoá' : makeSnippet(reply.body) || 'Tin nhắn'
  return (
    <div className="reply-bar">
      <div className="reply-bar-text ellipsis" role="status">
        Đang trả lời <strong>{reply.sender_name}</strong>: {snippet}
      </div>
      <button type="button" className="btn btn-ghost reply-bar-cancel" aria-label="Huỷ trả lời" onClick={onCancel}>
        ✕
      </button>
    </div>
  )
}
