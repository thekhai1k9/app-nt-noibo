import { useState } from 'react'
import { ErrorAlert } from '../ErrorAlert'
import type { ChatMessage } from '../../lib/chatStore'
import { ApiError } from '../../lib/api'
import { errorMessage } from '../../lib/errors'
import { formatTime, initials } from '../../lib/format'
import { linkify } from '../../lib/linkify'

interface Props {
  message: ChatMessage
  mine: boolean
  showSender: boolean
  onRetry: (clientId: string) => void
  onDiscard?: (clientId: string) => void
  onEdit: (messageId: number, body: string) => Promise<void>
  onDelete: (messageId: number) => Promise<void>
}

export function MessageItem({ message, mine, showSender, onRetry, onDiscard, onEdit, onDelete }: Props) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(message.body)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const canAct = mine && !message.deleted && !message.pending

  async function save() {
    const body = draft.trim()
    if (!body) return
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
    <div className={`msg${mine ? ' mine' : ''}`} data-message-id={message.id}>
      {!mine && (
        <span className="avatar" aria-hidden="true">
          {initials(message.sender_name)}
        </span>
      )}
      <div className="msg-col">
        {showSender && !mine && <div className="msg-sender">{message.sender_name}</div>}
        <div className={`bubble${message.pending === 'failed' ? ' bubble-failed' : ''}`}>
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
                onChange={(event) => setDraft(event.target.value)}
              />
              <div className="row">
                <button type="button" className="btn" onClick={() => { setEditing(false); setDraft(message.body); setError(null) }}>
                  Huỷ
                </button>
                <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()}>
                  Lưu
                </button>
              </div>
            </div>
          ) : (
            linkify(message.body)
          )}
        </div>
        <div className="msg-foot">
          <span>{formatTime(message.created_at)}</span>
          {message.edited_at && !message.deleted && <span>(đã sửa)</span>}
          {message.pending === 'sending' && <span>Đang gửi…</span>}
          {message.pending === 'failed' && (
            <>
              <span className="msg-failed">Gửi lỗi</span>
              <span>{errorMessage(new ApiError(0, message.errorCode ?? 'network_error'))}</span>
              <button type="button" className="btn btn-ghost" onClick={() => message.client_id && onRetry(message.client_id)}>
                Thử lại
              </button>
              {onDiscard && (
                <button type="button" className="btn btn-ghost" onClick={() => message.client_id && onDiscard(message.client_id)}>
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
