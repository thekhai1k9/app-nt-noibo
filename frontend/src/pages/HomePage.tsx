import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ErrorAlert } from '../components/ErrorAlert'
import { useAuth } from '../lib/auth'

export function HomePage() {
  const { user, logout } = useAuth()
  const [error, setError] = useState<unknown>(null)
  const [pending, setPending] = useState(false)

  async function onLogout() {
    setError(null)
    setPending(true)
    try {
      await logout()
    } catch (err) {
      setError(err)
      setPending(false)
    }
  }
  return (
    <div>
      <header className="topbar">
        <strong>Kết Nối</strong>
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
      </header>
      <main className="center-screen">
        <div className="card stack" style={{ maxWidth: 480 }}>
          <h1>Xin chào, {user?.full_name}</h1>
          <ErrorAlert error={error} />
          <p className="muted">Giao diện trò chuyện sẽ có ở bản cập nhật sau.</p>
        </div>
      </main>
    </div>
  )
}
