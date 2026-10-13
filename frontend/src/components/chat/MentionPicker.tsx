import { initials } from '../../lib/format'
import type { MentionOption } from '../../lib/mentions'

export const optionId = (listId: string, index: number) => `${listId}-opt-${index}`

export function MentionPicker({
  id,
  options,
  activeIndex,
  onPick,
}: {
  id: string
  options: MentionOption[]
  activeIndex: number
  onPick: (option: MentionOption) => void
}) {
  return (
    <ul className="mention-picker" id={id} role="listbox" aria-label="Gợi ý nhắc tên">
      {options.map((option, index) => (
        <li
          key={option.kind === 'all' ? 'all' : option.member.user_id}
          id={optionId(id, index)}
          role="option"
          aria-selected={index === activeIndex}
          className={`mention-option${index === activeIndex ? ' active' : ''}`}
          // mousedown (không phải click) để ô soạn không mất focus/con trỏ.
          onMouseDown={(event) => {
            event.preventDefault()
            onPick(option)
          }}
        >
          {option.kind === 'all' ? (
            <>
              <span className="avatar" aria-hidden="true">@</span>
              <span className="ellipsis">@all — Nhắc tất cả mọi người</span>
            </>
          ) : (
            <>
              <span className="avatar" aria-hidden="true">{initials(option.member.full_name)}</span>
              <span className="ellipsis">{option.member.full_name}</span>
            </>
          )}
        </li>
      ))}
    </ul>
  )
}
