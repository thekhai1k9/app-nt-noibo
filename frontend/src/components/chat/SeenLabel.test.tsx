import { render, screen } from '@testing-library/react'
import { SeenLabel } from './SeenLabel'

describe('SeenLabel', () => {
  it('renders nothing when nobody has seen it', () => {
    const direct = render(<SeenLabel seenBy={[]} total={1} isGroup={false} />)
    expect(direct.container).toBeEmptyDOMElement()
    const group = render(<SeenLabel seenBy={[]} total={3} isGroup />)
    expect(group.container).toBeEmptyDOMElement()
  })
  it('shows "Đã xem" for direct chats', () => {
    render(<SeenLabel seenBy={['Huy']} total={1} isGroup={false} />)
    expect(screen.getByText('Đã xem')).toBeInTheDocument()
  })
  it('shows the count with names in the title for groups', () => {
    render(<SeenLabel seenBy={['Hà', 'Huy']} total={3} isGroup />)
    expect(screen.getByText('Đã xem bởi 2 người')).toHaveAttribute('title', 'Hà, Huy')
  })
})
