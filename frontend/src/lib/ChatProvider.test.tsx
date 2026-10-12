import { act, render, screen } from '@testing-library/react'
import { vi } from 'vitest'
import { ChatContext, useMembers, useOnline, useTyping } from './ChatProvider'
import { ChatController } from './chatController'
import { ChatStore } from './chatStore'
import type { Room } from './types'

const room: Room = {
  id: 1, type: 'group', name: 'P', branch_id: null, member_count: 3, peer_id: null,
  last_message: null, unread_count: 0, last_activity: '2026-10-15T08:00:00.000Z',
}

function Probe() {
  const members = useMembers(1)
  const typing = useTyping(1)
  const online = useOnline(2)
  return (
    <div>
      <span data-testid="members">{members.map((x) => `${x.user_id}:${x.last_read_message_id}`).join(',')}</span>
      <span data-testid="typing">{typing.join(',')}</span>
      <span data-testid="online">{String(online)}</span>
    </div>
  )
}

describe('chat hooks', () => {
  it('reflect members, typing (excluding me) and online state', () => {
    const store = new ChatStore()
    const api = {} as never
    const controller = new ChatController({ store, api, socket: { send: () => true }, meId: 1, meName: 'Tôi' })
    store.setRooms([room])
    render(
      <ChatContext.Provider value={{ store, controller }}>
        <Probe />
      </ChatContext.Provider>,
    )
    expect(screen.getByTestId('members').textContent).toBe('')
    expect(screen.getByTestId('online').textContent).toBe('false')
    act(() => {
      store.setMembers(1, [{ user_id: 2, full_name: 'Bob', last_read_message_id: 4 }])
      store.setPresence(2, true)
      store.setTyping(1, 2, 'Bob', Date.now() + 5000)
      store.setTyping(1, 1, 'Tôi', Date.now() + 5000)
    })
    expect(screen.getByTestId('members').textContent).toBe('2:4')
    expect(screen.getByTestId('online').textContent).toBe('true')
    expect(screen.getByTestId('typing').textContent).toBe('Bob')
    act(() => store.clearTyping(1, 2))
    expect(screen.getByTestId('typing').textContent).toBe('')
    vi.restoreAllMocks()
  })
})
