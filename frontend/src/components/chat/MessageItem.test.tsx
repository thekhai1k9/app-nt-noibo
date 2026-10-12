import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import type { ChatMessage } from '../../lib/chatStore'
import { MessageItem } from './MessageItem'

const base: ChatMessage = {
  id: 7, room_id: 1, sender_id: 2, sender_name: 'Lê Thu Hà', body: 'xin chào https://example.com',
  kind: 'text', client_id: null, created_at: '2026-10-15T09:05:00.000Z', edited_at: null, deleted: false,
}
const props = { showSender: true, onRetry: vi.fn(), onEdit: vi.fn().mockResolvedValue(undefined), onDelete: vi.fn().mockResolvedValue(undefined) }

describe('MessageItem', () => {
  it('shows the sender name, the text with a safe link and no actions for other people\'s messages', () => {
    render(<MessageItem {...props} message={base} mine={false} />)
    expect(screen.getByText('Lê Thu Hà')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'https://example.com' })).toHaveAttribute('rel', 'noopener noreferrer nofollow')
    expect(screen.queryByRole('button', { name: 'Sửa tin nhắn' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Xoá tin nhắn' })).not.toBeInTheDocument()
  })

  it('hides the sender name when asked', () => {
    render(<MessageItem {...props} message={base} mine={false} showSender={false} />)
    expect(screen.queryByText('Lê Thu Hà')).not.toBeInTheDocument()
  })

  it('shows the edited marker', () => {
    render(<MessageItem {...props} message={{ ...base, edited_at: '2026-10-15T10:00:00.000Z' }} mine={false} />)
    expect(screen.getByText('(đã sửa)')).toBeInTheDocument()
  })

  it('never shows the text of a deleted message', () => {
    render(<MessageItem {...props} message={{ ...base, deleted: true, body: 'bí mật' }} mine />)
    expect(screen.getByText('Tin nhắn đã bị xoá')).toBeInTheDocument()
    expect(screen.queryByText('bí mật')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sửa tin nhắn' })).not.toBeInTheDocument()
  })

  it('renders HTML in the body as plain text', () => {
    render(<MessageItem {...props} message={{ ...base, body: '<b>đậm</b><img src=x onerror=alert(1)>' }} mine={false} />)
    expect(document.querySelector('img')).toBeNull()
    expect(screen.getByText('<b>đậm</b><img src=x onerror=alert(1)>')).toBeInTheDocument()
  })

  it('lets the owner edit inline and calls onEdit with the trimmed text', async () => {
    const onEdit = vi.fn().mockResolvedValue(undefined)
    render(<MessageItem {...props} onEdit={onEdit} message={{ ...base, sender_id: 1, body: 'gốc' }} mine />)
    await userEvent.click(screen.getByRole('button', { name: 'Sửa tin nhắn' }))
    const box = screen.getByLabelText('Sửa nội dung tin nhắn')
    expect(box).toHaveValue('gốc')
    await userEvent.clear(box)
    await userEvent.type(box, '  đã sửa ')
    await userEvent.click(screen.getByRole('button', { name: 'Lưu' }))
    expect(onEdit).toHaveBeenCalledWith(7, 'đã sửa')
    expect(screen.queryByLabelText('Sửa nội dung tin nhắn')).not.toBeInTheDocument()
  })

  it('cancels editing without calling onEdit and shows the server error when saving fails', async () => {
    const onEdit = vi.fn().mockRejectedValue(new Error('x'))
    render(<MessageItem {...props} onEdit={onEdit} message={{ ...base, sender_id: 1 }} mine />)
    await userEvent.click(screen.getByRole('button', { name: 'Sửa tin nhắn' }))
    await userEvent.click(screen.getByRole('button', { name: 'Huỷ' }))
    expect(onEdit).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Sửa tin nhắn' }))
    await userEvent.type(screen.getByLabelText('Sửa nội dung tin nhắn'), ' thêm') // phải khác nội dung hiện tại
    await userEvent.click(screen.getByRole('button', { name: 'Lưu' }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.getByLabelText('Sửa nội dung tin nhắn')).toBeInTheDocument()
  })

  it('asks for confirmation before deleting', async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    render(<MessageItem {...props} onDelete={onDelete} message={{ ...base, sender_id: 1 }} mine />)
    await userEvent.click(screen.getByRole('button', { name: 'Xoá tin nhắn' }))
    expect(onDelete).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Xoá tin nhắn' }))
    expect(onDelete).toHaveBeenCalledWith(7)
    confirm.mockRestore()
  })

  it('shows the sending state without actions', () => {
    render(<MessageItem {...props} message={{ ...base, id: -1, sender_id: 1, pending: 'sending' }} mine />)
    expect(screen.getByText('Đang gửi…')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sửa tin nhắn' })).not.toBeInTheDocument()
  })

  it('shows the failure reason with a retry button', async () => {
    const onRetry = vi.fn()
    render(
      <MessageItem {...props} onRetry={onRetry} message={{ ...base, id: -1, sender_id: 1, client_id: 'c1', pending: 'failed', errorCode: 'rate_limited' }} mine />,
    )
    expect(screen.getByText(/Gửi lỗi/)).toBeInTheDocument()
    expect(screen.getByText('Bạn gửi quá nhanh. Hãy đợi vài giây rồi thử lại.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Gửi lại tin nhắn' }))
    expect(onRetry).toHaveBeenCalledWith('c1')
  })

  it('lets the user discard a failed message when onDiscard is given', async () => {
    const onDiscard = vi.fn()
    render(
      <MessageItem {...props} onDiscard={onDiscard} message={{ ...base, id: -1, sender_id: 1, client_id: 'c1', pending: 'failed', errorCode: 'network_error' }} mine />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Bỏ tin nhắn chưa gửi' }))
    expect(onDiscard).toHaveBeenCalledWith('c1')
  })

  it('shows no discard button without the prop', () => {
    render(<MessageItem {...props} message={{ ...base, id: -1, sender_id: 1, client_id: 'c1', pending: 'failed' }} mine />)
    expect(screen.queryByRole('button', { name: 'Bỏ tin nhắn chưa gửi' })).not.toBeInTheDocument()
  })

  it('does not call onEdit when the text is unchanged, and hints when it is empty', async () => {
    const onEdit = vi.fn().mockResolvedValue(undefined)
    render(<MessageItem {...props} onEdit={onEdit} message={{ ...base, sender_id: 1, body: 'gốc' }} mine />)
    await userEvent.click(screen.getByRole('button', { name: 'Sửa tin nhắn' }))
    await userEvent.click(screen.getByRole('button', { name: 'Lưu' }))
    expect(onEdit).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('Sửa nội dung tin nhắn')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Sửa tin nhắn' }))
    await userEvent.clear(screen.getByLabelText('Sửa nội dung tin nhắn'))
    await userEvent.click(screen.getByRole('button', { name: 'Lưu' }))
    expect(onEdit).not.toHaveBeenCalled()
    expect(screen.getByText('Tin nhắn đang trống.')).toBeInTheDocument()
  })

  it('disables Cancel while saving', async () => {
    let finish: () => void = () => {}
    const onEdit = vi.fn().mockReturnValue(new Promise<void>((resolve) => { finish = resolve }))
    render(<MessageItem {...props} onEdit={onEdit} message={{ ...base, sender_id: 1, body: 'gốc' }} mine />)
    await userEvent.click(screen.getByRole('button', { name: 'Sửa tin nhắn' }))
    await userEvent.type(screen.getByLabelText('Sửa nội dung tin nhắn'), '!')
    await userEvent.click(screen.getByRole('button', { name: 'Lưu' }))
    expect(screen.getByRole('button', { name: 'Huỷ' })).toBeDisabled()
    finish()
  })
})
