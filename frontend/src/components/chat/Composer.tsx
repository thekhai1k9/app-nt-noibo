import { useState, type KeyboardEvent } from 'react'

export const MAX_MESSAGE_LENGTH = 4000
const COUNTER_FROM = 3500

export function Composer({ onSend, onTyping, disabled = false }: { onSend: (body: string) => void; onTyping?: () => void; disabled?: boolean }) {
  const [text, setText] = useState('')

  function submit() {
    const body = text.trim()
    if (!body || body.length > MAX_MESSAGE_LENGTH) return
    onSend(body)
    setText('')
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey) return
    // Bộ gõ tiếng Việt dùng Enter để chốt chữ đang soạn: không được gửi tin lúc đó.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    event.preventDefault()
    submit()
  }

  return (
    <div className="composer">
      <div className="composer-box">
        <textarea
          className="composer-input"
          aria-label="Nhập tin nhắn"
          placeholder="Nhập tin nhắn…"
          rows={Math.min(6, Math.max(1, text.split('\n').length))}
          maxLength={MAX_MESSAGE_LENGTH}
          value={text}
          disabled={disabled}
          onChange={(event) => {
            setText(event.target.value)
            if (!disabled && event.target.value.trim()) onTyping?.()
          }}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          className="btn btn-primary composer-send"
          aria-label="Gửi tin nhắn"
          disabled={disabled}
          onClick={submit}
        >
          Gửi
        </button>
      </div>
      {text.length >= COUNTER_FROM && <div className="muted composer-counter">{`${text.length}/${MAX_MESSAGE_LENGTH}`}</div>}
    </div>
  )
}
