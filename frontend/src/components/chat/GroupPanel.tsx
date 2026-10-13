import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { chatApi } from '../../lib/chatApi'
import { useChatController, useMembers } from '../../lib/ChatProvider'
import type { DirectoryUser, Room } from '../../lib/types'
import { ErrorAlert } from '../ErrorAlert'

const SEARCH_DELAY_MS = 250

/** Giống quy tắc của server: sau khi cắt khoảng trắng phải còn ít nhất một ký tự nhìn thấy được. */
const hasVisibleChar = (text: string) => /[^\p{Cc}\p{Cf}\p{Zs}]/u.test(text.trim())

export function GroupPanel({ room, onClose }: { room: Room; onClose: () => void }) {
  const controller = useChatController()
  const navigate = useNavigate()
  const roomId = room.id
  const members = useMembers(roomId)
  const meId = controller.meId
  // Quyền lấy từ phòng "sống" trong danh sách phòng: đổi chủ khi bảng đang mở thì giao diện đổi ngay.
  const isOwner = room.my_role === 'owner'
  const roomName = room.name ?? ''

  const [nameDraft, setNameDraft] = useState<string | null>(null)
  const [term, setTerm] = useState('')
  const [users, setUsers] = useState<DirectoryUser[] | null>(null)
  const [searchError, setSearchError] = useState<unknown>(null)
  const [actionError, setActionError] = useState<unknown>(null)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    closeRef.current?.focus()
    void controller.loadMembers(roomId)
  }, [controller, roomId])

  const close = () => {
    if (!busyRef.current) onClose()
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && !busyRef.current && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    if (!isOwner) return
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
  }, [term, isOwner])

  function trapTab(event: ReactKeyboardEvent) {
    if (event.key !== 'Tab' || !dialogRef.current) return
    const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [href], select:not([disabled])'))
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

  /** Một thao tác tại một thời điểm; luôn tải lại thành viên sau đó (kể cả lỗi) để giao diện không lệch. */
  async function run(action: () => Promise<unknown>, options: { after?: () => void; reload?: boolean } = {}) {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setActionError(null)
    let ok = false
    try {
      await action()
      ok = true
    } catch (err) {
      if (mounted.current) setActionError(err)
    }
    busyRef.current = false
    if (mounted.current) setBusy(false)
    if (options.reload !== false || !ok) void controller.loadMembers(roomId)
    if (ok) options.after?.()
  }

  const trimmedDraft = (nameDraft ?? roomName).trim()
  const nameChanged = nameDraft !== null && trimmedDraft !== roomName && hasVisibleChar(nameDraft)

  function saveName() {
    if (!nameChanged) return
    void run(() => controller.renameGroup(roomId, trimmedDraft), { after: () => setNameDraft(null) })
  }

  function add(user: DirectoryUser) {
    void run(() => controller.addMember(roomId, user.id))
  }

  function remove(userId: number, name: string) {
    if (busyRef.current) return
    if (!window.confirm(`Gỡ ${name} khỏi nhóm "${roomName}"? Người này sẽ không còn xem được nhóm.`)) return
    void run(() => controller.removeMember(roomId, userId))
  }

  function gone() {
    onClose()
    navigate('/')
  }

  function leave() {
    if (busyRef.current) return
    const text = isOwner
      ? `Bạn là chủ nhóm "${roomName}". Nếu rời nhóm, quyền chủ nhóm sẽ chuyển cho người vào nhóm sớm nhất; nếu bạn là người cuối cùng thì nhóm sẽ được lưu trữ. Bạn vẫn muốn rời nhóm?`
      : `Rời nhóm "${roomName}"? Bạn sẽ không còn nhận tin nhắn của nhóm này.`
    if (!window.confirm(text)) return
    void run(() => controller.leaveGroup(roomId), { reload: false, after: gone })
  }

  // So khớp NFC, phân biệt hoa thường, không cắt khoảng trắng (như trang quản trị).
  const confirmed = roomName !== '' && typed.normalize('NFC') === roomName.normalize('NFC')

  function dissolve() {
    if (busyRef.current || !confirmed) return
    void run(() => controller.dissolveGroup(roomId), { reload: false, after: gone })
  }

  const memberIds = new Set(members.map((m) => m.user_id))
  const candidates = users?.filter((u) => !memberIds.has(u.id) && u.id !== meId)

  return (
    <div className="dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <div ref={dialogRef} onKeyDown={trapTab} className="card dialog stack" role="dialog" aria-modal="true" aria-label="Thông tin nhóm">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div style={{ minWidth: 0 }}>
            <h2 style={{ fontSize: 17 }} className="ellipsis">{roomName}</h2>
            <div className="muted" style={{ fontSize: 12 }}>{room.member_count} thành viên</div>
          </div>
          <button ref={closeRef} type="button" className="btn btn-ghost" disabled={busy} onClick={close}>
            Đóng
          </button>
        </div>

        <ErrorAlert error={actionError} />

        {isOwner && (
          <div className="stack" style={{ gap: 6 }}>
            <label htmlFor="group-name-input" style={{ fontWeight: 600 }}>Tên nhóm</label>
            <div className="row" style={{ gap: 8 }}>
              <input
                id="group-name-input"
                className="input"
                style={{ flex: 1, minWidth: 0 }}
                maxLength={100}
                value={nameDraft ?? roomName}
                disabled={busy}
                onChange={(event) => setNameDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                    event.preventDefault()
                    saveName()
                  }
                }}
              />
              <button type="button" className="btn" disabled={busy || !nameChanged} onClick={saveName}>
                Lưu tên
              </button>
            </div>
          </div>
        )}

        <div className="stack" style={{ gap: 4 }}>
          <div style={{ fontWeight: 600 }}>Thành viên</div>
          <ul className="member-list" aria-label="Danh sách thành viên">
            {members.map((m) => (
              <li key={m.user_id} className="member-row">
                <span className="ellipsis" style={{ flex: 1, minWidth: 0 }}>
                  {m.full_name}
                  {m.user_id === meId && <span className="muted"> · Bạn</span>}
                  {m.role === 'owner' && <span className="muted"> · Chủ nhóm</span>}
                </span>
                {isOwner && m.user_id !== meId && (
                  <button type="button" className="btn btn-ghost" aria-label={`Gỡ ${m.full_name} khỏi nhóm`} disabled={busy} onClick={() => remove(m.user_id, m.full_name)}>
                    Gỡ
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>

        {isOwner && (
          <div className="stack" style={{ gap: 6 }}>
            <input
              className="input"
              aria-label="Thêm thành viên"
              placeholder="Tìm người để thêm"
              value={term}
              disabled={busy}
              onChange={(event) => setTerm(event.target.value)}
            />
            <ErrorAlert error={searchError} />
            <div className="stack" style={{ gap: 4 }}>
              {users === null && <div className="muted">Đang tải…</div>}
              {candidates?.length === 0 && <div className="muted">Không có ai để thêm.</div>}
              {candidates?.map((user) => (
                <button key={user.id} type="button" className="btn btn-ghost" style={{ justifyContent: 'flex-start' }} disabled={busy} onClick={() => add(user)}>
                  {user.full_name} <span className="muted">· {user.branch_name}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <button type="button" className="btn btn-danger" disabled={busy} onClick={leave}>
          Rời nhóm
        </button>

        {isOwner && (
          <div className="danger-zone stack" style={{ gap: 8 }}>
            <div style={{ fontWeight: 600 }}>Giải tán nhóm</div>
            <p className="muted" style={{ fontSize: 13 }}>
              Nhóm biến mất với mọi người ngay. Tin nhắn được giữ một thời gian để quản trị viên khôi phục khi cần, sau đó bị xoá vĩnh viễn.
            </p>
            <input
              className="input"
              aria-label="Gõ tên nhóm để xác nhận giải tán"
              placeholder={roomName}
              value={typed}
              disabled={busy}
              autoComplete="off"
              onChange={(event) => setTyped(event.target.value)}
            />
            <button type="button" className="btn btn-danger" disabled={busy || !confirmed} onClick={dissolve}>
              Giải tán nhóm
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
