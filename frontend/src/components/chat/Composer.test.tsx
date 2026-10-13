import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import { Composer } from './Composer'

const NONE = { replyTo: undefined, mentions: [], mentionAll: false }

describe('Composer', () => {
  it('sends on Enter, trims the text and clears the box', async () => {
    const onSend = vi.fn()
    render(<Composer onSend={onSend} />)
    await userEvent.type(screen.getByLabelText('Nhập tin nhắn'), '  xin chào  {Enter}')
    expect(onSend).toHaveBeenCalledWith('xin chào', NONE)
    expect(screen.getByLabelText('Nhập tin nhắn')).toHaveValue('')
  })

  it('inserts a new line on Shift+Enter without sending', async () => {
    const onSend = vi.fn()
    render(<Composer onSend={onSend} />)
    await userEvent.type(screen.getByLabelText('Nhập tin nhắn'), 'dòng 1{Shift>}{Enter}{/Shift}dòng 2')
    expect(onSend).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Nhập tin nhắn')).toHaveValue('dòng 1\ndòng 2')
  })

  it('does not send while an IME composition is in progress (Vietnamese input methods)', () => {
    const onSend = vi.fn()
    render(<Composer onSend={onSend} />)
    const box = screen.getByLabelText('Nhập tin nhắn')
    fireEvent.change(box, { target: { value: 'chào' } })
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true })
    fireEvent.keyDown(box, { key: 'Enter', keyCode: 229 })
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('chào', NONE)
  })

  it('does not send empty or whitespace-only text', async () => {
    const onSend = vi.fn()
    render(<Composer onSend={onSend} />)
    await userEvent.type(screen.getByLabelText('Nhập tin nhắn'), '   {Enter}')
    await userEvent.click(screen.getByRole('button', { name: 'Gửi tin nhắn' }))
    expect(onSend).not.toHaveBeenCalled()
  })

  it('sends with the button', async () => {
    const onSend = vi.fn()
    render(<Composer onSend={onSend} />)
    await userEvent.type(screen.getByLabelText('Nhập tin nhắn'), 'hi')
    await userEvent.click(screen.getByRole('button', { name: 'Gửi tin nhắn' }))
    expect(onSend).toHaveBeenCalledWith('hi', NONE)
  })

  it('limits the text to 4000 characters and shows a counter near the limit', async () => {
    render(<Composer onSend={vi.fn()} />)
    const box = screen.getByLabelText('Nhập tin nhắn')
    expect(box).toHaveAttribute('maxlength', '4000')
    fireEvent.change(box, { target: { value: 'a'.repeat(3600) } })
    expect(screen.getByText('3600/4000')).toBeInTheDocument()
  })

  it('is disabled when told so', () => {
    render(<Composer onSend={vi.fn()} disabled />)
    expect(screen.getByLabelText('Nhập tin nhắn')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Gửi tin nhắn' })).toBeDisabled()
  })
  it('calls onTyping when typing non-empty text, not when cleared, blank or disabled', () => {
    const onTyping = vi.fn()
    const { rerender } = render(<Composer onSend={vi.fn()} onTyping={onTyping} />)
    const box = screen.getByLabelText('Nhập tin nhắn')
    fireEvent.change(box, { target: { value: 'a' } })
    expect(onTyping).toHaveBeenCalledTimes(1)
    fireEvent.change(box, { target: { value: '' } })
    fireEvent.change(box, { target: { value: '   ' } })
    expect(onTyping).toHaveBeenCalledTimes(1)
    rerender(<Composer onSend={vi.fn()} onTyping={onTyping} disabled />)
    fireEvent.change(screen.getByLabelText('Nhập tin nhắn'), { target: { value: 'xyz' } })
    expect(onTyping).toHaveBeenCalledTimes(1)
  })
  describe('replies and mentions', () => {
    const mem = (id: number, name: string) => ({ user_id: id, full_name: name, last_read_message_id: null, role: 'member' as const })
    const members = [mem(1, 'Tôi'), mem(2, 'Nguyễn Đức Anh'), mem(3, 'Lê Thu Hà')]
    const source = {
      id: 9, room_id: 1, sender_id: 2, sender_name: 'Nguyễn Đức Anh', body: 'gốc', kind: 'text', client_id: null,
      created_at: '2026-10-15T09:00:00.000Z', edited_at: null, deleted: false, reply_to: null, mentions: [], mention_all: false,
    }
    const box = () => screen.getByLabelText('Nhập tin nhắn')

    it('Enter with the picker open picks the option and does not send', async () => {
      const onSend = vi.fn()
      render(<Composer onSend={onSend} members={members} meId={1} isGroup />)
      await userEvent.type(box(), 'chào @duc')
      expect(screen.getByRole('listbox')).toBeInTheDocument()
      expect(box()).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option')[0].id)
      await userEvent.keyboard('{Enter}')
      expect(onSend).not.toHaveBeenCalled()
      expect(box()).toHaveValue('chào @Nguyễn Đức Anh ')
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
      await userEvent.type(box(), 'ơi{Enter}')
      expect(onSend).toHaveBeenCalledWith('chào @Nguyễn Đức Anh ơi', { replyTo: undefined, mentions: [{ user_id: 2, full_name: 'Nguyễn Đức Anh' }], mentionAll: false })
    })

    it('lists @all first in groups only, navigates with arrows, Tab inserts, Esc closes', async () => {
      const onSend = vi.fn()
      const { unmount } = render(<Composer onSend={onSend} members={members} meId={1} isGroup />)
      await userEvent.type(box(), '@')
      const rows = screen.getAllByRole('option')
      expect(rows).toHaveLength(3)
      expect(rows[0]).toHaveTextContent('@all — Nhắc tất cả mọi người')
      await userEvent.keyboard('{ArrowDown}{ArrowDown}')
      expect(screen.getAllByRole('option')[2]).toHaveAttribute('aria-selected', 'true')
      await userEvent.keyboard('{ArrowUp}{Escape}')
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
      await userEvent.type(box(), '{Backspace}@{ArrowDown}{ArrowDown}{Tab}')
      expect(box()).toHaveValue('@Lê Thu Hà ')
      unmount()
      render(<Composer onSend={onSend} members={members} meId={1} isGroup={false} />)
      await userEvent.type(box(), '@')
      expect(screen.queryByText(/@all/)).not.toBeInTheDocument()
      expect(screen.getAllByRole('option')).toHaveLength(2)
    })

    it('re-picking a same-named member after clearing sends the newest id', async () => {
      const onSend = vi.fn()
      const dup = [mem(1, 'Tôi'), mem(5, 'Trần An'), mem(6, 'Trần An')]
      render(<Composer onSend={onSend} members={dup} meId={1} />)
      await userEvent.type(box(), '@tran{Enter}')
      await userEvent.clear(box())
      await userEvent.type(box(), '@tran{ArrowDown}{Enter}x{Enter}')
      expect(onSend).toHaveBeenCalledWith('@Trần An x', { replyTo: undefined, mentions: [{ user_id: 6, full_name: 'Trần An' }], mentionAll: false })
    })

    it('keeps both ids, in order, when two same-named members are picked without clearing', async () => {
      const onSend = vi.fn()
      const dup = [mem(1, 'Tôi'), mem(5, 'Trần An'), mem(6, 'Trần An')]
      render(<Composer onSend={onSend} members={dup} meId={1} />)
      await userEvent.type(box(), '@tran{Enter}@tran{ArrowDown}{Enter}{Enter}')
      expect(onSend).toHaveBeenCalledWith('@Trần An @Trần An', { replyTo: undefined, mentions: [{ user_id: 5, full_name: 'Trần An' }, { user_id: 6, full_name: 'Trần An' }], mentionAll: false })
    })

    it('does not open the picker for an @ inside an email address', async () => {
      render(<Composer onSend={vi.fn()} members={members} meId={1} />)
      await userEvent.type(box(), 'gửi a@th')
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    })

    it('inserts at the caret mid-text and replaces the rest of the current @word', async () => {
      render(<Composer onSend={vi.fn()} members={members} meId={1} />)
      await userEvent.type(box(), 'xin  chào')
      await userEvent.type(box(), '@Th', { initialSelectionStart: 4, initialSelectionEnd: 4 })
      await userEvent.keyboard('{Enter}')
      expect(box()).toHaveValue('xin @Lê Thu Hà chào')
    })

    it('shows a limit hint and keeps the picker open when the mention does not fit', async () => {
      render(<Composer onSend={vi.fn()} members={members} meId={1} />)
      box().focus()
      fireEvent.change(box(), { target: { value: `${'a'.repeat(3990)} @Th` } })
      await userEvent.keyboard('{Enter}')
      expect(await screen.findByText('Tin nhắn đã đạt giới hạn ký tự')).toBeInTheDocument()
      expect(screen.getByRole('listbox')).toBeInTheDocument()
    })

    it('exposes the textarea as a combobox only when suggestions apply', () => {
      const { rerender } = render(<Composer onSend={vi.fn()} />)
      expect(screen.getByRole('textbox')).toBeInTheDocument()
      rerender(<Composer onSend={vi.fn()} members={members} meId={1} />)
      expect(screen.getByRole('combobox')).toHaveAttribute('aria-expanded', 'false')
    })

    it('does not open without members', async () => {
      render(<Composer onSend={vi.fn()} />)
      await userEvent.type(box(), '@a')
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    })

    it('inserting @all sets the flag, which is dropped once the text is gone', async () => {
      const onSend = vi.fn()
      render(<Composer onSend={onSend} members={members} meId={1} isGroup />)
      await userEvent.type(box(), '@{Enter}xin chào{Enter}')
      expect(onSend).toHaveBeenLastCalledWith('@all xin chào', { replyTo: undefined, mentions: [], mentionAll: true })
      await userEvent.type(box(), '@{Enter}')
      await userEvent.clear(box())
      await userEvent.type(box(), 'không nhắc{Enter}')
      expect(onSend).toHaveBeenLastCalledWith('không nhắc', NONE)
    })

    it('drops a mention whose @name text was edited away', async () => {
      const onSend = vi.fn()
      render(<Composer onSend={onSend} members={members} meId={1} isGroup />)
      await userEvent.type(box(), '@Thu{Enter}')
      await userEvent.type(box(), '{Backspace}{Backspace}{Backspace}x{Enter}') // "@Lê Thu Hà " -> "@Lê Thu x"
      expect(onSend).toHaveBeenCalledWith('@Lê Thu x', NONE)
    })

    it('keeps the chosen id when two members share a full name', async () => {
      const onSend = vi.fn()
      const dup = [mem(1, 'Tôi'), mem(5, 'Trần An'), mem(6, 'Trần An')]
      render(<Composer onSend={onSend} members={dup} meId={1} />)
      await userEvent.type(box(), '@tran{ArrowDown}{Enter}x{Enter}')
      expect(onSend).toHaveBeenCalledWith('@Trần An x', { replyTo: undefined, mentions: [{ user_id: 6, full_name: 'Trần An' }], mentionAll: false })
    })

    it('shows the reply bar, sends replyTo, and Esc / the button cancel it', async () => {
      const onSend = vi.fn()
      const onCancel = vi.fn()
      render(<Composer onSend={onSend} reply={source} onCancelReply={onCancel} members={members} meId={1} />)
      expect(screen.getByRole('status')).toHaveTextContent('Đang trả lời Nguyễn Đức Anh: gốc')
      await userEvent.type(box(), 'ok{Enter}')
      expect(onSend).toHaveBeenCalledWith('ok', { replyTo: source, mentions: [], mentionAll: false })
      await userEvent.type(box(), '{Escape}')
      expect(onCancel).toHaveBeenCalledTimes(1)
      await userEvent.click(screen.getByRole('button', { name: 'Huỷ trả lời' }))
      expect(onCancel).toHaveBeenCalledTimes(2)
    })

    it('Esc closes the picker first and keeps the reply', async () => {
      const onCancel = vi.fn()
      render(<Composer onSend={vi.fn()} reply={source} onCancelReply={onCancel} members={members} meId={1} />)
      await userEvent.type(box(), '@')
      await userEvent.keyboard('{Escape}')
      expect(onCancel).not.toHaveBeenCalled()
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    })

    it('does not pick or send during IME composition with the picker open', async () => {
      const onSend = vi.fn()
      render(<Composer onSend={onSend} members={members} meId={1} />)
      await userEvent.type(box(), '@')
      fireEvent.keyDown(box(), { key: 'Enter', keyCode: 229 })
      expect(onSend).not.toHaveBeenCalled()
      expect(box()).toHaveValue('@')
    })
  })
})
