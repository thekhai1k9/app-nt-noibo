import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import { Composer } from './Composer'

describe('Composer', () => {
  it('sends on Enter, trims the text and clears the box', async () => {
    const onSend = vi.fn()
    render(<Composer onSend={onSend} />)
    await userEvent.type(screen.getByLabelText('Nhập tin nhắn'), '  xin chào  {Enter}')
    expect(onSend).toHaveBeenCalledWith('xin chào')
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
    expect(onSend).toHaveBeenCalledWith('chào')
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
    expect(onSend).toHaveBeenCalledWith('hi')
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
})
