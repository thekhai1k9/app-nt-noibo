import { render, screen } from '@testing-library/react'
import { TypingIndicator } from './TypingIndicator'

describe('TypingIndicator', () => {
  it('keeps an empty polite status region when nobody types', () => {
    render(<TypingIndicator names={[]} />)
    const el = screen.getByRole('status')
    expect(el).toHaveAttribute('aria-live', 'polite')
    expect(el).toBeEmptyDOMElement()
  })
  it('formats 1, 2 and 3+ people', () => {
    const { rerender } = render(<TypingIndicator names={['Hà']} />)
    expect(screen.getByRole('status')).toHaveTextContent('Hà đang soạn tin…')
    rerender(<TypingIndicator names={['Hà', 'Huy']} />)
    expect(screen.getByRole('status')).toHaveTextContent('Hà và Huy đang soạn tin…')
    rerender(<TypingIndicator names={['Hà', 'Huy', 'An']} />)
    expect(screen.getByRole('status')).toHaveTextContent('Nhiều người đang soạn tin…')
  })
})
