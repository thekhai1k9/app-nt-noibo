import { Outlet, useMatch } from 'react-router-dom'
import { RoomSidebar } from '../components/chat/RoomSidebar'

export function ChatLayout() {
  const open = useMatch('/chat/:roomId') !== null
  return (
    <div className="chat-shell" data-room={open ? 'open' : 'none'}>
      <RoomSidebar />
      <main className="chat-main">
        <Outlet />
      </main>
    </div>
  )
}
