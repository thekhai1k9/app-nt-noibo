import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { chatApi } from '../../lib/chatApi'
import { useChatController } from '../../lib/ChatProvider'
import type { DirectoryUser } from '../../lib/types'
import { ErrorAlert } from '../ErrorAlert'

const SEARCH_DELAY_MS = 250
const TABS = [['direct', 'Nhắn riêng'], ['group', 'Tạo nhóm']] as const

/** Giống quy tắc của server: sau khi cắt khoảng trắng phải còn ít nhất một ký tự nhìn thấy được (không chỉ Cc/Cf/Zs). */
const hasVisibleChar = (text: string) => /[^\p{Cc}\p{Cf}\p{Zs}]/u.test(text.trim())

export function NewChatDialog({ onClose }: { onClose: () => void }) {
  const controller = useChatController()
  const navigate = useNavigate()
  const [mode, setMode] = useState<'direct' | 'group'>('direct')
  const [directTerm, setDirectTerm] = useState('')
  const [groupTerm, setGroupTerm] = useState('')
  const [groupName, setGroupName] = useState('')
  const [selected, setSelected] = useState<Map<number, DirectoryUser>>(new Map())
  const term = mode === 'direct' ? directTerm : groupTerm
  const [users, setUsers] = useState<DirectoryUser[] | null>(null)
  const [searchError, setSearchError] = useState<unknown>(null)
  const [actionError, setActionError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  const focusTabRef = useRef<string | null>(null)

  // Điều hướng bằng phím mũi tên: giữ focus ở tab (ô nhập autoFocus của tab mới không được cướp focus).
  useEffect(() => {
    if (focusTabRef.current) document.getElementById(`newchat-tab-${focusTabRef.current}`)?.focus()
    focusTabRef.current = null
  }, [mode])

  // Đang mở chat thì bỏ qua đóng hộp thoại (tránh điều hướng bất ngờ sau khi người dùng đã đóng).
  const close = () => {
    if (!busyRef.current) onClose()
  }

  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(
      () => {
        chatApi
          .directory(term.trim())
          .then((result) => !cancelled && (setUsers(result), setSearchError(null)))
          .catch((err) => !cancelled && setSearchError(err))
      },
      term ? SEARCH_DELAY_MS : 0,
    )
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [term, mode])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && !busyRef.current && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  /** Giữ Tab/Shift+Tab trong hộp thoại. */
  function trapTab(event: ReactKeyboardEvent) {
    if (event.key !== 'Tab' || !dialogRef.current) return
    const focusable = Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [href], select:not([disabled])'),
    )
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    const active = document.activeElement
    if (event.shiftKey && (active === first || !dialogRef.current.contains(active))) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (active === last || !dialogRef.current.contains(active))) {
      event.preventDefault()
      first.focus()
    }
  }

  async function pick(user: DirectoryUser) {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setActionError(null)
    try {
      const room = await controller.openDirect(user.id)
      busyRef.current = false
      onClose()
      navigate(`/chat/${room.id}`)
    } catch (err) {
      setActionError(err)
      busyRef.current = false
      setBusy(false)
    }
  }

  function toggle(user: DirectoryUser) {
    setSelected((cur) => {
      const next = new Map(cur)
      if (next.has(user.id)) next.delete(user.id)
      else next.set(user.id, user)
      return next
    })
  }

  async function createGroup() {
    const name = groupName.trim()
    if (busyRef.current || !hasVisibleChar(name)) return
    busyRef.current = true
    setBusy(true)
    setActionError(null)
    try {
      const room = await controller.createGroup(name, [...selected.keys()])
      busyRef.current = false
      onClose()
      navigate(`/chat/${room.id}`)
    } catch (err) {
      setActionError(err)
      busyRef.current = false
      setBusy(false)
    }
  }

  function switchMode(next: 'direct' | 'group') {
    if (busyRef.current || next === mode) return
    setMode(next)
    setUsers(null)
    setSearchError(null)
    setActionError(null)
  }

  return (
    <div className="dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <div ref={dialogRef} onKeyDown={trapTab} className="card dialog stack" role="dialog" aria-modal="true" aria-label="Cuộc trò chuyện mới">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ fontSize: 17 }}>Cuộc trò chuyện mới</h2>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={close}>
            Đóng
          </button>
        </div>
        <div className="row" role="tablist" aria-label="Loại cuộc trò chuyện" style={{ gap: 4 }}>
          {TABS.map(([key, label]) => (
            <button
              key={key}
              id={`newchat-tab-${key}`}
              type="button"
              role="tab"
              aria-selected={mode === key}
              aria-controls="newchat-panel"
              tabIndex={mode === key ? 0 : -1}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                event.preventDefault()
                const next = key === 'direct' ? 'group' : 'direct'
                switchMode(next)
                focusTabRef.current = next
              }}
              className={`btn ${mode === key ? '' : 'btn-ghost'}`}
              disabled={busy}
              onClick={() => switchMode(key)}
            >
              {label}
            </button>
          ))}
        </div>
        <div id="newchat-panel" role="tabpanel" aria-labelledby={`newchat-tab-${mode}`} className="stack">
        {mode === 'group' && (
          <>
            <input
              className="input"
              autoFocus
              aria-label="Tên nhóm"
              placeholder="Tên nhóm"
              maxLength={100}
              value={groupName}
              disabled={busy}
              onChange={(event) => setGroupName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                  event.preventDefault()
                  void createGroup()
                }
              }}
            />
            {selected.size > 0 && (
              <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                {[...selected.values()].map((user) => (
                  <span key={user.id} className="chip">
                    {user.full_name}
                    <button type="button" className="chip-remove" aria-label={`Bỏ ${user.full_name}`} disabled={busy} onClick={() => toggle(user)}>
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
          </>
        )}
        <input
          key={mode}
          className="input"
          autoFocus={mode === 'direct'}
          aria-label={mode === 'direct' ? 'Tìm người' : 'Tìm người để thêm'}
          placeholder="Tìm theo tên hoặc tên đăng nhập"
          value={term}
          disabled={busy}
          onChange={(event) => (mode === 'direct' ? setDirectTerm : setGroupTerm)(event.target.value)}
        />
        <ErrorAlert error={actionError ?? searchError} />
        <div className="stack" style={{ gap: 4 }}>
          {users === null && <div className="muted">Đang tải…</div>}
          {users?.length === 0 && <div className="muted">Không tìm thấy ai.</div>}
          {mode === 'direct' &&
            users?.map((user) => (
              <button key={user.id} type="button" className="btn btn-ghost" style={{ justifyContent: 'flex-start' }} disabled={busy} onClick={() => void pick(user)}>
                {user.full_name} <span className="muted">· {user.branch_name}</span>
              </button>
            ))}
          {mode === 'group' &&
            users?.map((user) => (
              <label key={user.id} className="pick-row">
                <input type="checkbox" checked={selected.has(user.id)} disabled={busy} onChange={() => toggle(user)} />
                <span>
                  {user.full_name} <span className="muted">· {user.branch_name}</span>
                </span>
              </label>
            ))}
        </div>
        {mode === 'group' && (
          <button type="button" className="btn" disabled={busy || !hasVisibleChar(groupName)} onClick={() => void createGroup()}>
            {busy ? 'Đang tạo…' : 'Tạo nhóm'}
          </button>
        )}
        </div>
      </div>
    </div>
  )
}
