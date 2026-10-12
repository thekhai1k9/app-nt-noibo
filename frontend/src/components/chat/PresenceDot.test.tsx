import { render, screen } from '@testing-library/react'
import { PresenceDot } from './PresenceDot'

describe('PresenceDot', () => {
  it('renders a labelled dot when online', () => {
    render(<PresenceDot online />)
    expect(screen.getByLabelText('Đang hoạt động')).toBeInTheDocument()
  })
  it('renders nothing when offline', () => {
    const { container } = render(<PresenceDot online={false} />)
    expect(container).toBeEmptyDOMElement()
  })
})
