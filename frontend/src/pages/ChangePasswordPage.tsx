import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { ErrorAlert } from '../components/ErrorAlert'
import { Field } from '../components/Field'
import { useAuth } from '../lib/auth'

export function ChangePasswordPage() {
  const { user, changePassword, logout } = useAuth()
  const navigate = useNavigate()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [validation, setValidation] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    if (next.length < 8) {
      setValidation('Mật khẩu mới cần ít nhất 8 ký tự.')
      return
    }
    if (next !== confirm) {
      setValidation('Hai mật khẩu mới không khớp.')
      return
    }
    setValidation(undefined)
    setBusy(true)
    try {
      await changePassword(current, next)
      navigate('/', { replace: true })
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  async function signOut() {
    setError(null)
    setValidation(undefined)
    setLoggingOut(true)
    try {
      await logout()
    } catch (err) {
      setError(err)
      setLoggingOut(false)
    }
  }

  return (
    <div className="center-screen">
      <form className="card stack" style={{ width: '100%', maxWidth: 420 }} onSubmit={submit}>
        <div>
          <h2>Đổi mật khẩu</h2>
          {user?.must_change_password && (
            <p className="muted" style={{ margin: '6px 0 0' }}>
              Bạn cần đặt mật khẩu mới trước khi tiếp tục.
            </p>
          )}
        </div>
        <Field
          id="current"
          label="Mật khẩu hiện tại"
          type="password"
          autoComplete="current-password"
          maxLength={256}
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          required
        />
        <Field
          id="next"
          label="Mật khẩu mới"
          type="password"
          autoComplete="new-password"
          maxLength={128}
          value={next}
          onChange={(e) => setNext(e.target.value)}
          required
        />
        <Field
          id="confirm"
          label="Nhập lại mật khẩu mới"
          type="password"
          autoComplete="new-password"
          maxLength={128}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
        />
        <ErrorAlert error={error} message={validation} />
        <button type="submit" className="btn btn-primary" disabled={busy}>
          Lưu mật khẩu mới
        </button>
        <button type="button" className="btn btn-ghost" disabled={loggingOut} onClick={() => void signOut()}>
          Đăng xuất
        </button>
      </form>
    </div>
  )
}
