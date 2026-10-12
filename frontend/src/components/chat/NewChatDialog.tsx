import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { chatApi } from '../../lib/chatApi'
import { useChatController } from '../../lib/ChatProvider'
import type { DirectoryUser } from '../../lib/types'
import { ErrorAlert } from '../ErrorAlert'

const SEARCH_DELAY_MS = 250

export function NewChatDialog({ onClose }: { onClose: () => void }) {
  const controller = useChatController()
  const navigate = useNavigate()
  const [term, setTerm] = useState('')
  const [users, setUsers] = useState<DirectoryUser[] | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(
      () => {
        chatApi
          .directory(term.trim())
          .then((result) => !cancelled && (setUsers(result), setError(null)))
          .catch((err) => !cancelled && setError(err))
      },
      term ? SEARCH_DELAY_MS : 0,
    )
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [term])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  async function pick(user: DirectoryUser) {
    setBusy(true)
    setError(null)
    try {
      const room = await controller.openDirect(user.id)
      onClose()
      navigate(`/chat/${room.id}`)
    } catch (err) {
      setError(err)
      setBusy(false)
    }
  }

  return (
    <div className="dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="card dialog stack" role="dialog" aria-modal="true" aria-label="Cuộc trò chuyện mới">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ fontSize: 17 }}>Cuộc trò chuyện mới</h2>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Đóng
          </button>
        </div>
        <input
          className="input"
          autoFocus
          aria-label="Tìm người"
          placeholder="Tìm theo tên hoặc tên đăng nhập"
          value={term}
          onChange={(event) => setTerm(event.target.value)}
        />
        <ErrorAlert error={error} />
        <div className="stack" style={{ gap: 4 }}>
          {users === null && <div className="muted">Đang tải…</div>}
          {users?.length === 0 && <div className="muted">Không tìm thấy ai.</div>}
          {users?.map((user) => (
            <button key={user.id} type="button" className="btn btn-ghost" style={{ justifyContent: 'flex-start' }} disabled={busy} onClick={() => void pick(user)}>
              {user.full_name} <span className="muted">· {user.branch_name}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
