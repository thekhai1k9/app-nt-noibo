import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import { QuoteBlock } from './QuoteBlock'
import { ReplyBar } from './ReplyBar'
import { MentionPicker } from './MentionPicker'
import type { Message, RoomMember } from '../../lib/types'

const reply = { id: 3, sender_id: 2, sender_name: 'Lê Thu Hà', snippet: '<b>báo cáo</b>', deleted: false }

describe('QuoteBlock', () => {
  it('shows the sender and the snippet as plain text, static when the source is not loaded', () => {
    render(<QuoteBlock reply={reply} />)
    expect(screen.getByText('Lê Thu Hà')).toBeInTheDocument()
    expect(screen.getByText('<b>báo cáo</b>')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('is a button that jumps when the source is loaded', async () => {
    const onJump = vi.fn()
    render(<QuoteBlock reply={reply} onJump={onJump} />)
    await userEvent.click(screen.getByRole('button', { name: 'Đến tin được trả lời' }))
    expect(onJump).toHaveBeenCalledOnce()
  })

  it('shows placeholders for deleted and empty snippets', () => {
    const { rerender } = render(<QuoteBlock reply={{ ...reply, snippet: '', deleted: true }} />)
    expect(screen.getByText('Tin nhắn đã bị xoá')).toBeInTheDocument()
    rerender(<QuoteBlock reply={{ ...reply, snippet: '' }} />)
    expect(screen.getByText('Tin nhắn')).toBeInTheDocument()
  })
})

const source: Message = {
  id: 3, room_id: 1, sender_id: 2, sender_name: 'Lê Thu Hà', body: 'dòng 1\ndòng 2', kind: 'text', client_id: null,
  created_at: '2026-10-15T09:00:00.000Z', edited_at: null, deleted: false, reply_to: null, mentions: [], mention_all: false,
}

describe('ReplyBar', () => {
  it('announces who is being replied to and cancels', async () => {
    const onCancel = vi.fn()
    render(<ReplyBar reply={source} onCancel={onCancel} />)
    expect(screen.getByRole('status')).toHaveTextContent('Đang trả lời Lê Thu Hà: dòng 1 dòng 2')
    await userEvent.click(screen.getByRole('button', { name: 'Huỷ trả lời' }))
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('keeps the live region mounted but empty without a reply', () => {
    const { rerender } = render(<ReplyBar reply={null} onCancel={vi.fn()} />)
    const live = screen.getByRole('status')
    expect(live).toBeEmptyDOMElement()
    rerender(<ReplyBar reply={source} onCancel={vi.fn()} />)
    expect(screen.getByRole('status')).toBe(live)
    expect(live).toHaveTextContent('Đang trả lời')
  })

  it('shows the deleted placeholder', () => {
    render(<ReplyBar reply={{ ...source, deleted: true }} onCancel={vi.fn()} />)
    expect(screen.getByRole('status')).toHaveTextContent('Tin nhắn đã bị xoá')
  })
})

const member = (id: number, name: string): RoomMember => ({ user_id: id, full_name: name, last_read_message_id: null, role: 'member' })

describe('MentionPicker', () => {
  it('renders a listbox with options, the active one selected, and picks on mousedown', () => {
    const onPick = vi.fn()
    const options = [{ kind: 'all' as const }, { kind: 'member' as const, member: member(2, 'Đức Anh') }]
    render(<MentionPicker id="x" options={options} activeIndex={1} onPick={onPick} />)
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    const rows = screen.getAllByRole('option')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('@all — Nhắc tất cả mọi người')
    expect(rows[1]).toHaveAttribute('aria-selected', 'true')
    rows[1].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    expect(onPick).toHaveBeenCalledWith(options[1])
  })
})
