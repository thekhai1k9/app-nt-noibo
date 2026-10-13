import { Fragment, useState } from 'react'
import { ErrorAlert } from '../ErrorAlert'
import type { ChatMessage } from '../../lib/chatStore'
import { ApiError } from '../../lib/api'
import { errorMessage } from '../../lib/errors'
import { formatTime, initials } from '../../lib/format'
import { linkify } from '../../lib/linkify'
import { splitMentions } from '../../lib/mentions'
import { QuoteBlock } from './QuoteBlock'

interface Props {
  message: ChatMessage
  mine: boolean
  showSender: boolean
  onRetry: (clientId: string) => void
  onDiscard?: (clientId: string) => void
  onResendWithoutReply?: (clientId: string) => void
  onResendWithoutMentionAll?: (clientId: string) => void
  onReply?: (message: ChatMessage) => void
  /** Chỉ truyền khi tin gốc của trích dẫn đã được tải (cho phép cuộn tới). */
  onJumpToReply?: (messageId: number) => void
  meId?: number
  flash?: boolean
  onEdit: (messageId: number, body: string) => Promise<void>
  onDelete: (messageId: number) => Promise<void>
}

function renderBody(message: ChatMessage) {
  const nodes = linkify(message.body)
  if (message.mentions.length === 0 && !message.mention_all) return nodes
  // Liên kết trước, rồi mới tách mention trong phần chữ thường: https://x.com/@Bob/p vẫn là một liên kết.
  return nodes.map((node, index) =>
    typeof node !== 'string' ? (
      node
    ) : (
      <Fragment key={`t${index}`}>
        {splitMentions(node, message.mentions, message.mention_all).map((part, i) =>
          part.mention ? (
            <span key={i} className={`mention${part.mention === 'all' ? ' mention-all' : ''}`}>{part.text}</span>
          ) : (
            part.text
          ),
        )}
      </Fragment>
    ),
  )
}

export function MessageItem({ message, mine, showSender, onRetry, onDiscard, onResendWithoutReply, onResendWithoutMentionAll, onReply, onJumpToReply, meId, flash = false, onEdit, onDelete }: Props) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(message.body)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [hint, setHint] = useState(false)
  const allLimited = message.pending === 'failed' && message.errorCode === 'rate_limited' && message.mention_all
  const canAct = mine && !message.deleted && !message.pending
  const canReply = !!onReply && !message.deleted && !message.pending
  const mentionsMe = !mine && !message.deleted && (message.mention_all || (meId !== undefined && message.mentions.some((m) => m.user_id === meId)))
  const reply = message.deleted ? null : message.reply_to

  async function save() {
    const body = draft.trim()
    if (!body) {
      setHint(true)
      return
    }
    if (body === message.body.trim()) {
      setEditing(false) // không đổi gì: chỉ đóng, không gọi máy chủ
      return
    }
    setBusy(true)
    setError(null)
    try {
      await onEdit(message.id, body)
      setEditing(false)
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!window.confirm('Xoá tin nhắn này? Mọi người trong cuộc trò chuyện sẽ không còn thấy nội dung.')) return
    setError(null)
    try {
      await onDelete(message.id)
    } catch (err) {
      setError(err)
    }
  }

  return (
    <div className={`msg${mine ? ' mine' : ''}${flash ? ' msg-flash' : ''}`} data-message-id={message.id}>
      {!mine && (
        <span className="avatar" aria-hidden="true">
          {initials(message.sender_name)}
        </span>
      )}
      <div className="msg-col">
        {showSender && !mine && <div className="msg-sender">{message.sender_name}</div>}
        <div className="bubble-wrap">
        <div className={`bubble${message.pending === 'failed' ? ' bubble-failed' : ''}${editing ? ' bubble-editing' : ''}${mentionsMe ? ' msg-mentions-me' : ''}`}>
          {reply && !editing && <QuoteBlock reply={reply} onJump={onJumpToReply ? () => onJumpToReply(reply.id) : undefined} />}
          {message.deleted ? (
            <em>Tin nhắn đã bị xoá</em>
          ) : editing ? (
            <div className="stack" style={{ gap: 8 }}>
              <textarea
                className="input"
                aria-label="Sửa nội dung tin nhắn"
                rows={2}
                maxLength={4000}
                value={draft}
                onChange={(event) => { setDraft(event.target.value); setHint(false) }}
              />
              {hint && <div className="muted" role="status">Tin nhắn đang trống.</div>}
              <div className="row">
                <button type="button" className="btn" disabled={busy} onClick={() => { setEditing(false); setDraft(message.body); setError(null); setHint(false) }}>
                  Huỷ
                </button>
                <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()}>
                  Lưu
                </button>
              </div>
            </div>
          ) : (
            renderBody(message)
          )}
        </div>
        {canReply && !editing && (
          <button type="button" className="msg-reply" aria-label="Trả lời" onClick={() => onReply(message)}>
            <span aria-hidden="true">↩</span>
          </button>
        )}
        </div>
        <div className="msg-foot">
          <span>{formatTime(message.created_at)}</span>
          {message.edited_at && !message.deleted && <span>(đã sửa)</span>}
          {message.pending === 'sending' && <span>Đang gửi…</span>}
          {message.pending === 'failed' && (
            <>
              <span className="msg-failed">Gửi lỗi</span>
              <span>{errorMessage(new ApiError(0, allLimited ? 'mention_all_limited' : (message.errorCode ?? 'network_error')))}</span>
              {allLimited && onResendWithoutMentionAll ? (
                <button type="button" className="btn btn-ghost" aria-label="Gửi không kèm @all" onClick={() => message.client_id && onResendWithoutMentionAll(message.client_id)}>
                  Gửi không kèm @all
                </button>
              ) : message.errorCode === 'invalid_reply' && onResendWithoutReply ? (
                <button type="button" className="btn btn-ghost" aria-label="Gửi không kèm trả lời" onClick={() => message.client_id && onResendWithoutReply(message.client_id)}>
                  Gửi không kèm trả lời
                </button>
              ) : (
                <button type="button" className="btn btn-ghost" aria-label="Gửi lại tin nhắn" onClick={() => message.client_id && onRetry(message.client_id)}>
                  Thử lại
                </button>
              )}
              {onDiscard && (
                <button type="button" className="btn btn-ghost" aria-label="Bỏ khỏi danh sách" onClick={() => message.client_id && onDiscard(message.client_id)}>
                  Bỏ
                </button>
              )}
            </>
          )}
          {canAct && !editing && (
            <>
              <button type="button" className="btn btn-ghost" aria-label="Sửa tin nhắn" onClick={() => { setDraft(message.body); setEditing(true) }}>
                Sửa
              </button>
              <button type="button" className="btn btn-ghost" aria-label="Xoá tin nhắn" onClick={() => void remove()}>
                Xoá
              </button>
            </>
          )}
        </div>
        <ErrorAlert error={error} />
      </div>
    </div>
  )
}
