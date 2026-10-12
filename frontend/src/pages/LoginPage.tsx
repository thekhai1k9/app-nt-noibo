import { useState, type FormEvent } from 'react'
import { Navigate } from 'react-router-dom'
import { ErrorAlert } from '../components/ErrorAlert'
import { Field } from '../components/Field'
import { useAuth } from '../lib/auth'

export function LoginPage() {
  const { status, login } = useAuth()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  if (status === 'authenticated') return <Navigate to="/" replace />

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await login(username.trim(), password)
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-shell">
      <section className="login-brand">
        <strong style={{ fontSize: 20 }}>Kết Nối</strong>
        <div>
          <h1>Mọi chi nhánh, một cuộc trò chuyện.</h1>
          <p>
            Nhắn tin nội bộ giữa các chi nhánh của công ty. Dữ liệu nằm trên máy chủ của công ty bạn.
          </p>
        </div>
        <div className="row">
          <span className="pill">Hà Nội</span>
          <span className="pill">Đà Nẵng</span>
          <span className="pill">TP.HCM</span>
        </div>
      </section>
      <section className="login-form-wrap">
        <form className="card stack login-card" onSubmit={submit}>
          <div>
            <h2>Đăng nhập</h2>
            <p className="muted" style={{ margin: '6px 0 0' }}>
              Dùng tài khoản do quản trị viên cấp.
            </p>
          </div>
          <Field
            id="username"
            label="Tên đăng nhập"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
          <Field
            id="password"
            label="Mật khẩu"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <ErrorAlert error={error} />
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Đăng nhập
          </button>
          <p className="muted" style={{ margin: 0 }}>
            Quên mật khẩu hoặc chưa có tài khoản? Liên hệ quản trị viên của chi nhánh bạn.
          </p>
        </form>
      </section>
    </div>
  )
}
