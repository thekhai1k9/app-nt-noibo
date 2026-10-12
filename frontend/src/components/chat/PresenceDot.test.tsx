import { render, screen } from '@testing-library/react'
import { PresenceDot } from './PresenceDot'

describe('PresenceDot', () => {
  it('renders a labelled dot when online', () => {
    render(<PresenceDot online />)
    expect(screen.getByLabelText('Đang hoạt động')).toBeInTheDocument()
  })
  it('is hidden from assistive tech when decorative', () => {
    const { container } = render(<PresenceDot online decorative />)
    const dot = container.querySelector('.presence-dot')!
    expect(dot).toHaveAttribute('aria-hidden', 'true')
    expect(dot).not.toHaveAttribute('role')
    expect(dot).not.toHaveAttribute('aria-label')
  })
  it('renders nothing when offline', () => {
    const { container } = render(<PresenceDot online={false} />)
    expect(container).toBeEmptyDOMElement()
  })
})
