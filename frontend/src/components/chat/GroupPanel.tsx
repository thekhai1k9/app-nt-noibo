import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { chatApi } from '../../lib/chatApi'
import { useChatController, useChatState, useMembers } from '../../lib/ChatProvider'
import type { DirectoryUser, Room } from '../../lib/types'
import { ErrorAlert } from '../ErrorAlert'
import { acceptableGroupNameInput, useModalFocus } from './dialogFocus'

const SEARCH_DELAY_MS = 250

/** Giống quy tắc của server: sau khi cắt khoảng trắng phải còn ít nhất một ký tự nhìn thấy được. */
const hasVisibleChar = (text: string) => /[^\p{Cc}\p{Cf}\p{Zs}]/u.test(text.trim())

type FocusPref = 'name' | 'search' | 'close'

export function GroupPanel({ room, onClose }: { room: Room; onClose: () => void }) {
  const controller = useChatController()
  const navigate = useNavigate()
  const roomId = room.id
  const members = useMembers(roomId)
  const hasMembers = useChatState((s) => s.members[roomId] !== undefined)
  const [membersSettled, setMembersSettled] = useState(false)
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
  const nameRef = useRef<HTMLInputElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const prefRef = useRef<FocusPref>('close')
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    closeRef.current?.focus()
    let alive = true
    void controller.loadMembers(roomId).finally(() => alive && setMembersSettled(true))
    return () => {
      alive = false
    }
  }, [controller, roomId])

  // Focus rơi ra ngoài (nút bị gỡ khỏi danh sách, nút bị tắt...) thì quay về ô phù hợp với thao tác vừa làm.
  useModalFocus(dialogRef, () => {
    const order: FocusPref[] = prefRef.current === 'name' ? ['name', 'search', 'close'] : prefRef.current === 'search' ? ['search', 'name', 'close'] : ['close']
    const els = { name: nameRef.current, search: searchRef.current, close: closeRef.current }
    return order.map((k) => els[k]).find((el) => el && !el.disabled)
  })

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

  /** Một thao tác tại một thời điểm; luôn tải lại thành viên sau đó (kể cả lỗi) để giao diện không lệch. */
  async function run(action: () => Promise<unknown>, options: { after?: () => void; reload?: boolean; focus?: FocusPref; onError?: () => void } = {}) {
    if (busyRef.current) return
    busyRef.current = true
    prefRef.current = options.focus ?? 'close'
    setBusy(true)
    setActionError(null)
    let ok = false
    try {
      await action()
      ok = true
    } catch (err) {
      if (mounted.current) setActionError(err)
      options.onError?.()
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
    void run(() => controller.renameGroup(roomId, trimmedDraft), {
      focus: 'name',
      after: () => setNameDraft(null),
      // Bản nháp không được thành "sự thật" hiển thị: tải lại tên thật của phòng (bản nháp vẫn sửa được).
      onError: () => void controller.loadRooms(),
    })
  }

  function add(user: DirectoryUser) {
    void run(() => controller.addMember(roomId, user.id), { focus: 'search' })
  }

  function remove(userId: number, name: string) {
    if (busyRef.current) return
    if (!window.confirm(`Gỡ ${name} khỏi nhóm "${roomName}"? Người này sẽ không còn xem được nhóm.`)) return
    void run(() => controller.removeMember(roomId, userId), { focus: isOwner ? 'search' : 'close' })
  }

  // Điều hướng ngay khi server xác nhận (trước khi đối soát danh sách phòng): không nháy thông báo "không còn",
  // và không bao giờ điều hướng muộn đè lên lựa chọn khác của người dùng.
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
    void run(() => controller.leaveGroup(roomId, gone), { reload: false })
  }

  // So khớp NFC, phân biệt hoa thường, không cắt khoảng trắng (như trang quản trị).
  const confirmed = roomName !== '' && typed.normalize('NFC') === roomName.normalize('NFC')

  function dissolve() {
    if (busyRef.current || !confirmed) return
    void run(() => controller.dissolveGroup(roomId, gone), { reload: false })
  }

  const memberIds = new Set(members.map((m) => m.user_id))
  const candidates = users?.filter((u) => !memberIds.has(u.id) && u.id !== meId)
  const loadingMembers = !hasMembers && !membersSettled

  return (
    <div className="dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <div ref={dialogRef} className="card dialog stack" role="dialog" aria-modal="true" aria-label="Thông tin nhóm">
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
                ref={nameRef}
                className="input"
                style={{ flex: 1, minWidth: 0 }}
                value={nameDraft ?? roomName}
                disabled={busy}
                onChange={(event) => acceptableGroupNameInput(event.target.value) && setNameDraft(event.target.value)}
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
          {loadingMembers && <div className="muted">Đang tải…</div>}
          <ul className="member-list" aria-label="Danh sách thành viên">
            {members.map((m) => (
              <li key={m.user_id} className="member-row">
                <span className="ellipsis member-name">{m.full_name}</span>
                {m.user_id === meId && <span className="muted member-tag">· Bạn</span>}
                {m.role === 'owner' && <span className="muted member-tag">· Chủ nhóm</span>}
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
              ref={searchRef}
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
