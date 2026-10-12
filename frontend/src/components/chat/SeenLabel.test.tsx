import { render, screen } from '@testing-library/react'
import { SeenLabel } from './SeenLabel'

describe('SeenLabel', () => {
  it('renders nothing when nobody has seen it', () => {
    const direct = render(<SeenLabel seenBy={[]} isGroup={false} />)
    expect(direct.container).toBeEmptyDOMElement()
    const group = render(<SeenLabel seenBy={[]} isGroup />)
    expect(group.container).toBeEmptyDOMElement()
  })
  it('shows "Đã xem" for direct chats', () => {
    render(<SeenLabel seenBy={['Huy']} isGroup={false} />)
    expect(screen.getByText('Đã xem')).toBeInTheDocument()
  })
  it('shows the count with names in the title for groups', () => {
    render(<SeenLabel seenBy={['Hà', 'Huy']} isGroup />)
    expect(screen.getByText('Đã xem bởi 2 người')).toHaveAttribute('title', 'Hà, Huy')
  })
})
