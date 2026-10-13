import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAuth } from '../../lib/auth'
import { useChatController, useMembers, useOnline, useRooms, useThread, useTyping } from '../../lib/ChatProvider'
import { Composer } from './Composer'
import { ConnectionBanner } from './ConnectionBanner'
import { GroupPanel } from './GroupPanel'
import { MessageList } from './MessageList'
import { PresenceDot } from './PresenceDot'
import { SeenLabel } from './SeenLabel'
import { TypingIndicator } from './TypingIndicator'

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
  const members = useMembers(roomId)
  const typingNames = useTyping(roomId)
  const peerOnline = useOnline(room?.type === 'direct' ? room.peer_id : null)
  const meId = user?.id ?? 0
  const isGroup = room?.type === 'group'
  const [panelOpen, setPanelOpen] = useState(false)
  const infoRef = useRef<HTMLButtonElement>(null)
  const wasOpen = useRef(false)
  const showPanel = panelOpen && isGroup

  // Phòng biến mất (bị gỡ, giải tán, rời) thì đóng bảng; đóng xong trả focus về nút mở nếu còn.
  useEffect(() => {
    if (loaded && !room) setPanelOpen(false)
  }, [loaded, room])
  useEffect(() => {
    if (wasOpen.current && !showPanel) infoRef.current?.focus()
    wasOpen.current = showPanel
  }, [showPanel])

  const seenFor = useMemo(() => {
    if (!thread.loaded) return null
    const last = [...thread.items].reverse().find((m) => m.sender_id === meId && !m.pending && !m.deleted)
    if (!last) return null
    const others = members.filter((m) => m.user_id !== meId)
    const seenBy = others.filter((m) => m.last_read_message_id !== null && m.last_read_message_id >= last.id).map((m) => m.full_name)
    return { messageId: last.id, label: <SeenLabel seenBy={seenBy} isGroup={isGroup} /> }
  }, [thread.loaded, thread.items, members, meId, isGroup])

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
          {room?.type === 'direct' && (
            <div className="muted presence-line" style={{ fontSize: 12 }}>
              {peerOnline && (
                <>
                  <PresenceDot online decorative />
                  <span>Đang hoạt động</span>
                </>
              )}
            </div>
          )}
        </div>
        {isGroup && (
          <button ref={infoRef} type="button" className="btn btn-ghost chat-info" aria-label="Thông tin nhóm" onClick={() => setPanelOpen(true)}>
            ⓘ
          </button>
        )}
      </header>
      {showPanel && room && <GroupPanel room={room} onClose={() => setPanelOpen(false)} />}
      <ConnectionBanner />
      <MessageList
        items={thread.items}
        hasMoreBefore={thread.hasMoreBefore}
        loaded={thread.loaded}
        loadingOlder={thread.loadingOlder}
        error={thread.error}
        meId={meId}
        isGroup={isGroup}
        seenFor={seenFor}
        onLoadOlder={() => void controller.loadOlder(roomId)}
        onRetryLoad={() => void controller.openRoom(roomId)}
        onRetrySend={(clientId) => controller.retry(clientId)}
        onDiscard={(clientId) => controller.discard(clientId)}
        onEdit={(id, body) => controller.edit(id, body)}
        onDelete={(id) => controller.remove(roomId, id)}
      />
      <TypingIndicator names={typingNames} />
      <Composer onSend={(body) => controller.send(roomId, body)} onTyping={() => controller.sendTyping(roomId)} />
    </>
  )
}
