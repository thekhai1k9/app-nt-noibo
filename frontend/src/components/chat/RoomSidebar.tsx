import { useState } from 'react'
import { Link, NavLink } from 'react-router-dom'
import { useAuth } from '../../lib/auth'
import { initials, listTime } from '../../lib/format'
import { useRooms } from '../../lib/ChatProvider'
import type { Room } from '../../lib/types'
import { ErrorAlert } from '../ErrorAlert'
import { NewChatDialog } from './NewChatDialog'

function preview(room: Room): string {
  const last = room.last_message
  if (!last) return 'Chưa có tin nhắn'
  if (last.deleted) return 'Tin nhắn đã bị xoá'
  return `${last.sender_name}: ${last.body}`
}

export function RoomSidebar() {
  const { user, logout } = useAuth()
  const { rooms, loaded, error } = useRooms()
  const [filter, setFilter] = useState('')
  const [dialog, setDialog] = useState(false)
  const [logoutError, setLogoutError] = useState<unknown>(null)
  const [pending, setPending] = useState(false)

  const shown = rooms.filter((room) => (room.name ?? '').toLowerCase().includes(filter.trim().toLowerCase()))

  async function onLogout() {
    setLogoutError(null)
    setPending(true)
    try {
      await logout()
    } catch (err) {
      setLogoutError(err)
      setPending(false)
    }
  }

  return (
    <aside className="chat-side" aria-label="Danh sách cuộc trò chuyện">
      <div className="chat-side-head">
        <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'nowrap' }}>
          <strong style={{ fontSize: 18 }}>Kết Nối</strong>
          <button type="button" className="btn" aria-label="Cuộc trò chuyện mới" onClick={() => setDialog(true)}>
            + Mới
          </button>
        </div>
        <input className="input" aria-label="Lọc cuộc trò chuyện" placeholder="Lọc theo tên" value={filter} onChange={(event) => setFilter(event.target.value)} />
      </div>
      <nav className="chat-side-list" aria-label="Cuộc trò chuyện">
        {error && !loaded && <div className="alert-error">Không tải được danh sách. Đang thử lại khi có kết nối.</div>}
        {loaded && rooms.length === 0 && <div className="muted" style={{ padding: 12 }}>Chưa có cuộc trò chuyện nào. Bấm "+ Mới" để bắt đầu.</div>}
        {shown.map((room) => (
          <NavLink key={room.id} to={`/chat/${room.id}`} className="room-item">
            <span className={`room-avatar${room.type === 'direct' ? ' direct' : ''}`} aria-hidden="true">
              {initials(room.name ?? '')}
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span className="row" style={{ justifyContent: 'space-between', flexWrap: 'nowrap' }}>
                <strong className="ellipsis">{room.name}</strong>
                <span className="muted" style={{ fontSize: 12, flex: 'none' }}>{listTime(room.last_activity)}</span>
              </span>
              <span className="row" style={{ justifyContent: 'space-between', flexWrap: 'nowrap' }}>
                <span className="muted ellipsis" style={{ fontSize: 13 }}>{preview(room)}</span>
                {room.unread_count > 0 && <span className="unread-badge">{room.unread_count}</span>}
              </span>
            </span>
          </NavLink>
        ))}
      </nav>
      <div className="chat-side-foot">
        <div style={{ fontWeight: 600 }}>Xin chào, {user?.full_name}</div>
        <div className="row">
          {user?.role === 'admin' && (
            <Link to="/admin" className="btn">
              Quản trị
            </Link>
          )}
          <Link to="/change-password" className="btn">
            Đổi mật khẩu
          </Link>
          <button type="button" className="btn" disabled={pending} onClick={() => void onLogout()}>
            Đăng xuất
          </button>
        </div>
        <ErrorAlert error={logoutError} />
      </div>
      {dialog && <NewChatDialog onClose={() => setDialog(false)} />}
    </aside>
  )
}
