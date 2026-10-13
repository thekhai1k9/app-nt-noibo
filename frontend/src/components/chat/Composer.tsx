import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type SyntheticEvent } from 'react'
import { detectMention, liveMentions, mentionOptions, MENTION_ALL_RE, type MentionOption } from '../../lib/mentions'
import type { Mention, Message, RoomMember } from '../../lib/types'
import { MentionPicker, optionId } from './MentionPicker'
import { ReplyBar } from './ReplyBar'

export const MAX_MESSAGE_LENGTH = 4000
const COUNTER_FROM = 3500

export interface SendExtras {
  replyTo?: Message
  mentions: Mention[]
  mentionAll: boolean
}

interface Props {
  onSend: (body: string, extras: SendExtras) => void
  onTyping?: () => void
  disabled?: boolean
  reply?: Message | null
  onCancelReply?: () => void
  /** Rỗng ⇒ không bật gợi ý @. */
  members?: RoomMember[]
  meId?: number
  isGroup?: boolean
}

const NO_MEMBERS: RoomMember[] = []

export function Composer({ onSend, onTyping, disabled = false, reply = null, onCancelReply, members = NO_MEMBERS, meId = 0, isGroup = false }: Props) {
  const [text, setText] = useState('')
  const [caret, setCaret] = useState(0)
  const [mentions, setMentions] = useState<Mention[]>([])
  const [mentionAll, setMentionAll] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [dismissedAt, setDismissedAt] = useState<number | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const pendingCaret = useRef<number | null>(null)
  const listId = useId()

  const trigger = members.length > 0 && !disabled ? detectMention(text, caret) : null
  const options: MentionOption[] = trigger ? mentionOptions(members, meId, isGroup, trigger.query) : []
  const open = trigger !== null && options.length > 0 && dismissedAt !== trigger.start
  const active = Math.min(activeIndex, Math.max(0, options.length - 1))

  useLayoutEffect(() => {
    if (pendingCaret.current !== null && inputRef.current) {
      inputRef.current.setSelectionRange(pendingCaret.current, pendingCaret.current)
      pendingCaret.current = null
    }
  })

  const replyId = reply?.id
  useEffect(() => {
    if (replyId !== undefined) inputRef.current?.focus()
  }, [replyId])

  function sync(event: SyntheticEvent<HTMLTextAreaElement>) {
    setCaret(event.currentTarget.selectionStart ?? event.currentTarget.value.length)
  }

  function submit() {
    const body = text.trim()
    if (!body || body.length > MAX_MESSAGE_LENGTH) return
    onSend(body, {
      replyTo: reply ?? undefined,
      mentions: liveMentions(body, mentions),
      mentionAll: isGroup && mentionAll && MENTION_ALL_RE.test(body),
    })
    setText('')
    setCaret(0)
    setMentions([])
    setMentionAll(false)
    setDismissedAt(null)
  }

  function pick(option: MentionOption) {
    if (!trigger) return
    const insert = option.kind === 'all' ? '@all ' : `@${option.member.full_name} `
    const next = text.slice(0, trigger.start) + insert + text.slice(caret)
    if (next.length > MAX_MESSAGE_LENGTH) return
    setText(next)
    const position = trigger.start + insert.length
    setCaret(position)
    pendingCaret.current = position
    setActiveIndex(0)
    if (option.kind === 'all') setMentionAll(true)
    else {
      const { user_id, full_name } = option.member
      setMentions((list) => [...list, { user_id, full_name }])
    }
    inputRef.current?.focus()
  }

  function cancelReply() {
    onCancelReply?.()
    inputRef.current?.focus()
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Bộ gõ tiếng Việt dùng Enter để chốt chữ đang soạn: không được gửi/chọn lúc đó.
    const composing = event.nativeEvent.isComposing || event.keyCode === 229
    if (open && !composing) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const step = event.key === 'ArrowDown' ? 1 : -1
        setActiveIndex((active + step + options.length) % options.length)
        return
      }
      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
        event.preventDefault()
        pick(options[active])
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setDismissedAt(trigger!.start)
        return
      }
    }
    if (event.key === 'Escape' && reply && !composing) {
      event.preventDefault()
      cancelReply()
      return
    }
    if (event.key !== 'Enter' || event.shiftKey) return
    if (composing) return
    event.preventDefault()
    // Gợi ý đang mở mà bị chặn bởi IME: không bao giờ gửi tin lúc gợi ý còn mở.
    if (open) return
    submit()
  }

  return (
    <div className="composer">
      {open && <MentionPicker id={listId} options={options} activeIndex={active} onPick={pick} />}
      {reply && <ReplyBar reply={reply} onCancel={cancelReply} />}
      <div className="composer-box">
        <textarea
          ref={inputRef}
          className="composer-input"
          aria-label="Nhập tin nhắn"
          placeholder="Nhập tin nhắn…"
          rows={Math.min(6, Math.max(1, text.split('\n').length))}
          maxLength={MAX_MESSAGE_LENGTH}
          value={text}
          disabled={disabled}
          aria-autocomplete={members.length > 0 ? 'list' : undefined}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open ? optionId(listId, active) : undefined}
          onChange={(event) => {
            setText(event.target.value)
            sync(event)
            // Esc chỉ đóng gợi ý của đúng cụm `@` đó; xoá cụm đó hoặc gõ `@` khác thì được mở lại.
            const next = detectMention(event.target.value, event.target.selectionStart ?? event.target.value.length)
            if (next?.start !== dismissedAt) setDismissedAt(null)
            setActiveIndex(0)
            if (!disabled && event.target.value.trim()) onTyping?.()
          }}
          onKeyDown={onKeyDown}
          onKeyUp={sync}
          onClick={sync}
          onSelect={sync}
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
