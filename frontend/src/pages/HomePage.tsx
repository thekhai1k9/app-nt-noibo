import { Link } from 'react-router-dom'
import { useAuth } from '../lib/auth'

export function HomePage() {
  const { user, logout } = useAuth()
  return (
    <div>
      <header className="topbar">
        <strong>Kết Nối</strong>
        <div className="row">
          {user?.role === 'admin' && <Link to="/admin">Quản trị</Link>}
          <button type="button" className="btn" onClick={() => void logout()}>
            Đăng xuất
          </button>
        </div>
      </header>
      <main className="center-screen">
        <div className="card stack" style={{ maxWidth: 480 }}>
          <h1>Xin chào, {user?.full_name}</h1>
          <p className="muted">Giao diện trò chuyện sẽ có ở bản cập nhật sau.</p>
        </div>
      </main>
    </div>
  )
}
