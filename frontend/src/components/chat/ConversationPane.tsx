import { useEffect } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAuth } from '../../lib/auth'
import { useChatController, useRooms, useThread } from '../../lib/ChatProvider'
import { Composer } from './Composer'
import { ConnectionBanner } from './ConnectionBanner'
import { MessageList } from './MessageList'

function NotFound() {
  return (
    <div className="center-screen">
      <div className="card stack" style={{ maxWidth: 420 }}>
        <p>Cuộc trò chuyện không tồn tại hoặc bạn không còn trong đó.</p>
        <Link to="/" className="btn btn-primary">
          Về danh sách
        </Link>
      </div>
    </div>
  )
}

export function ConversationPane() {
  const params = useParams()
  const roomId = Number(params.roomId)
  const valid = Number.isInteger(roomId) && roomId > 0
  if (!valid) return <NotFound />
  return <Conversation key={roomId} roomId={roomId} />
}

function Conversation({ roomId }: { roomId: number }) {
  const { user } = useAuth()
  const controller = useChatController()
  const { rooms, loaded } = useRooms()
  const thread = useThread(roomId)
  const room = rooms.find((r) => r.id === roomId)

  useEffect(() => {
    controller.setActiveRoom(roomId)
    void controller.openRoom(roomId)
    return () => controller.leaveRoom(roomId)
  }, [controller, roomId])

  if (loaded && !room) return <NotFound />

  return (
    <>
      <header className="chat-head">
        <Link to="/" className="btn btn-ghost chat-back" aria-label="Về danh sách">
          ←
        </Link>
        <div style={{ minWidth: 0 }}>
          <h2 style={{ fontSize: 17 }} className="ellipsis">{room?.name ?? ''}</h2>
          {room?.type === 'group' && <div className="muted" style={{ fontSize: 12 }}>{room.member_count} thành viên</div>}
        </div>
      </header>
      <ConnectionBanner />
      <MessageList
        items={thread.items}
        hasMoreBefore={thread.hasMoreBefore}
        loaded={thread.loaded}
        loadingOlder={thread.loadingOlder}
        error={thread.error}
        meId={user?.id ?? 0}
        isGroup={room?.type === 'group'}
        onLoadOlder={() => void controller.loadOlder(roomId)}
        onRetryLoad={() => void controller.openRoom(roomId)}
        onRetrySend={(clientId) => controller.retry(clientId)}
        onDiscard={(clientId) => controller.discard(clientId)}
        onEdit={(id, body) => controller.edit(id, body)}
        onDelete={(id) => controller.remove(roomId, id)}
      />
      <Composer onSend={(body) => controller.send(roomId, body)} />
    </>
  )
}
