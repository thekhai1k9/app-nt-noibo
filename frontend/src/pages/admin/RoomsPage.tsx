import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState, type FormEvent } from 'react'
import { ErrorAlert } from '../../components/ErrorAlert'
import { Field } from '../../components/Field'
import { api } from '../../lib/api'
import { formatDateTime } from '../../lib/format'
import type { AdminRoom, AdminRoomDetail, Branch, User } from '../../lib/types'

type Tab = 'active' | 'archived'

/** Danh sách người dùng đang hoạt động, dùng cho form tạo nhóm và ô thêm thành viên. */
function useActiveUsers() {
  return useQuery({
    queryKey: ['admin', 'users', 'is_active=true'],
    queryFn: () => api<User[]>('/admin/users?is_active=true'),
  })
}

function CreateRoomForm({ branches, users }: { branches: Branch[]; users: User[] }) {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [branchId, setBranchId] = useState('')
  const [filter, setFilter] = useState('')
  const [picked, setPicked] = useState<number[]>([])
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  const needle = filter.trim().toLowerCase()
  const visible = users.filter(
    (u) => !needle || u.full_name.toLowerCase().includes(needle) || u.username.toLowerCase().includes(needle),
  )

  function toggle(id: number) {
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!name.trim()) return
    setBusy(true)
    setError(null)
    try {
      await api<AdminRoomDetail>('/admin/rooms', {
        method: 'POST',
        json: {
          name: name.trim(),
          branch_id: branchId ? Number(branchId) : null,
          member_ids: users.filter((u) => picked.includes(u.id)).map((u) => u.id),
        },
      })
      setName('')
      setBranchId('')
      setFilter('')
      setPicked([])
      await queryClient.invalidateQueries({ queryKey: ['admin', 'rooms'] })
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="card stack" onSubmit={submit}>
      <h2 style={{ fontSize: 17 }}>Tạo nhóm mới</h2>
      <Field id="new-room-name" label="Tên nhóm" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required />
      <div className="field">
        <label htmlFor="new-room-branch">Chi nhánh</label>
        <select id="new-room-branch" className="input" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
          <option value="">Liên chi nhánh</option>
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </div>
      <fieldset className="stack" style={{ gap: 8, border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <legend style={{ fontWeight: 600, marginBottom: 6 }}>Thành viên ({picked.length} đã chọn)</legend>
        <input className="input" aria-label="Lọc người dùng" placeholder="Lọc theo tên" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div className="stack" style={{ gap: 4, maxHeight: 240, overflowY: 'auto' }}>
          {visible.map((u) => (
            <label key={u.id} className="row" style={{ flexWrap: 'nowrap', minHeight: 44 }}>
              <input type="checkbox" checked={picked.includes(u.id)} onChange={() => toggle(u.id)} />
              <span className="ellipsis">
                {u.full_name} <span className="muted">({u.username})</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <ErrorAlert error={error} />
      <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
        Tạo nhóm
      </button>
    </form>
  )
}

function RoomDetail({ roomId, users, onArchived }: { roomId: number; users: User[]; onArchived: () => void }) {
  const queryClient = useQueryClient()
  const detail = useQuery({
    queryKey: ['admin', 'room', roomId],
    queryFn: () => api<AdminRoomDetail>(`/admin/rooms/${roomId}`),
  })
  const [name, setName] = useState<string | null>(null)
  const [addId, setAddId] = useState('')
  const [typed, setTyped] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const archiving = useRef(false)
  const room = detail.data

  async function run(action: () => Promise<unknown>, after?: () => void) {
    setBusy(true)
    setError(null)
    try {
      await action()
      after?.()
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin', 'rooms'] }),
        queryClient.invalidateQueries({ queryKey: ['admin', 'room', roomId] }),
      ])
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  if (!room) {
    return (
      <div className="card stack">
        {detail.isError ? <ErrorAlert error={detail.error} /> : <p className="muted">Đang tải…</p>}
      </div>
    )
  }

  if (room.archived_at) {
    return (
      <div className="card stack">
        <p className="muted" style={{ margin: 0 }}>
          Nhóm này đã được lưu trữ. Hãy khôi phục ở tab "Đã lưu trữ" nếu cần chỉnh sửa.
        </p>
      </div>
    )
  }

  const memberIds = new Set(room.members.map((m) => m.user_id))
  const candidates = users.filter((u) => !memberIds.has(u.id))
  const currentName = name ?? room.name

  function rename(event: FormEvent) {
    event.preventDefault()
    void run(
      () => api(`/admin/rooms/${roomId}`, { method: 'PATCH', json: { name: currentName.trim() } }),
      () => setName(null),
    )
  }

  async function archive() {
    if (!room || typed.normalize('NFC') !== room.name.normalize('NFC') || archiving.current) return
    archiving.current = true
    setBusy(true)
    setError(null)
    try {
      await api(`/admin/rooms/${roomId}`, { method: 'DELETE' })
      onArchived()
      queryClient.removeQueries({ queryKey: ['admin', 'room', roomId] })
      await queryClient.invalidateQueries({ queryKey: ['admin', 'rooms'] })
    } catch (err) {
      setError(err)
      archiving.current = false
      setBusy(false)
    }
  }

  return (
    <div className="stack" style={{ gap: 16 }}>
      <form className="card stack" onSubmit={rename}>
        <h2 style={{ fontSize: 17 }}>Chi tiết nhóm</h2>
        <Field id="room-name" label="Tên nhóm" value={currentName} onChange={(e) => setName(e.target.value)} maxLength={100} required />
        <button type="submit" className="btn btn-primary" disabled={busy || !currentName.trim()}>
          Lưu tên
        </button>
      </form>

      <div className="card stack">
        <h2 style={{ fontSize: 17 }}>Thành viên ({room.members.length})</h2>
        <ul className="stack" style={{ gap: 6, listStyle: 'none', margin: 0, padding: 0 }}>
          {room.members.map((m) => (
            <li key={m.user_id} className="row" style={{ justifyContent: 'space-between', flexWrap: 'nowrap' }}>
              <span style={{ minWidth: 0 }}>
                <span className="ellipsis" style={{ display: 'block', fontWeight: 600 }}>
                  {m.full_name}
                </span>
                <span className="muted ellipsis" style={{ display: 'block', fontSize: 12 }}>
                  {m.username}
                </span>
              </span>
              <button
                type="button"
                className="btn btn-ghost"
                aria-label={`Gỡ ${m.username} khỏi nhóm`}
                disabled={busy}
                onClick={() => void run(() => api(`/admin/rooms/${roomId}/members/${m.user_id}`, { method: 'DELETE' }))}
              >
                Gỡ
              </button>
            </li>
          ))}
        </ul>
        <div className="row" style={{ flexWrap: 'nowrap' }}>
          <select className="input grow" aria-label="Thêm thành viên" value={addId} onChange={(e) => setAddId(e.target.value)}>
            <option value="">Chọn người dùng…</option>
            {candidates.map((u) => (
              <option key={u.id} value={u.id}>
                {u.full_name} ({u.username})
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn"
            disabled={busy || !addId}
            onClick={() =>
              void run(
                () => api(`/admin/rooms/${roomId}/members`, { method: 'POST', json: { user_id: Number(addId) } }),
                () => setAddId(''),
              )
            }
          >
            Thêm
          </button>
        </div>
      </div>

      <ErrorAlert error={error} />

      <div className="card stack">
        <h2 style={{ fontSize: 17 }}>Vùng nguy hiểm</h2>
        <p className="muted" style={{ margin: 0 }}>
          Nhóm sẽ biến mất với mọi thành viên ngay. Tin nhắn được giữ trong thời gian lưu trữ và có thể khôi phục; hạn xoá vĩnh viễn hiển thị ở tab Đã lưu trữ.
        </p>
        <div className="field">
          <input
            className="input"
            aria-label="Gõ tên nhóm để xác nhận"
            placeholder={room.name}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
          />
        </div>
        <button type="button" className="btn btn-danger" disabled={busy || typed.normalize('NFC') !== room.name.normalize('NFC')} onClick={() => void archive()}>
          Lưu trữ nhóm
        </button>
      </div>
    </div>
  )
}

export function RoomsPage() {
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<Tab>('active')
  const [q, setQ] = useState('')
  const [branchId, setBranchId] = useState('')
  const [selected, setSelected] = useState<number | null>(null)
  const [actionError, setActionError] = useState<unknown>(null)
  const [restoring, setRestoring] = useState<number | null>(null)

  const params = new URLSearchParams()
  if (q.trim()) params.set('q', q.trim())
  if (branchId) params.set('branch_id', branchId)
  if (tab === 'archived') params.set('archived', 'true')
  const queryString = params.toString()

  const rooms = useQuery({
    queryKey: ['admin', 'rooms', tab, queryString],
    queryFn: () => api<AdminRoom[]>(`/admin/rooms${queryString ? `?${queryString}` : ''}`),
    // Giữ danh sách cũ khi gõ lọc, nhưng không bao giờ mang hàng của tab khác sang (nút sai hành động).
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[2] === tab ? previous : undefined),
  })
  const branches = useQuery({ queryKey: ['admin', 'branches'], queryFn: () => api<Branch[]>('/admin/branches') })
  const users = useActiveUsers()

  const branchName = (id: number | null) =>
    id === null ? 'Liên chi nhánh' : (branches.data?.find((b) => b.id === id)?.name ?? '—')
  const list = rooms.data ?? []

  function switchTab(next: Tab) {
    setTab(next)
    setSelected(null)
    setActionError(null)
  }

  async function restore(room: AdminRoom) {
    setRestoring(room.id)
    setActionError(null)
    try {
      await api(`/admin/rooms/${room.id}/restore`, { method: 'POST' })
      await queryClient.invalidateQueries({ queryKey: ['admin', 'rooms'] })
    } catch (err) {
      setActionError(err)
    } finally {
      setRestoring(null)
    }
  }

  return (
    <>
      <main className="admin-main">
        <div className="page-head">
          <div>
            <h1>Phòng và nhóm</h1>
            <p className="muted" style={{ margin: '4px 0 0' }}>
              Quản trị viên không xem được nội dung tin nhắn.
            </p>
          </div>
        </div>

        <ErrorAlert error={actionError} />
        {rooms.isError && <ErrorAlert error={rooms.error} />}
        {branches.isError && <ErrorAlert error={branches.error} />}
        {users.isError && <ErrorAlert error={users.error} />}

        <div className="row" role="tablist" aria-label="Trạng thái nhóm">
          <button type="button" role="tab" aria-selected={tab === 'active'} className={`btn${tab === 'active' ? ' btn-primary' : ''}`} onClick={() => switchTab('active')}>
            Đang hoạt động
          </button>
          <button type="button" role="tab" aria-selected={tab === 'archived'} className={`btn${tab === 'archived' ? ' btn-primary' : ''}`} onClick={() => switchTab('archived')}>
            Đã lưu trữ
          </button>
        </div>

        <div className="row">
          <input
            className="input grow"
            style={{ minWidth: 220 }}
            aria-label="Tìm nhóm"
            placeholder="Tìm theo tên nhóm"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <select className="input" style={{ width: 'auto' }} aria-label="Lọc theo chi nhánh" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
            <option value="">Tất cả chi nhánh</option>
            {(branches.data ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </div>

        <div className="table-scroll" role="tabpanel">
          <div className="table-row table-head rooms-grid">
            <span>Tên nhóm</span>
            <span>Phạm vi</span>
            <span>Thành viên</span>
            <span />
          </div>
          {tab === 'archived' && rooms.isSuccess && list.length === 0 && (
            <p className="muted" style={{ padding: '12px 16px', margin: 0 }}>
              Không có nhóm nào đã lưu trữ.
            </p>
          )}
          {list.map((room) => (
            <div key={room.id} className="table-row rooms-grid">
              <span className="ellipsis" style={{ fontWeight: 600 }}>
                {room.name}
              </span>
              <span>{branchName(room.branch_id)}</span>
              <span>{room.member_count}</span>
              {tab === 'active' ? (
                <button type="button" className="btn btn-ghost" aria-label={`Quản lý ${room.name}`} onClick={() => setSelected(room.id)}>
                  Quản lý
                </button>
              ) : (
                <div className="row" style={{ flexWrap: 'nowrap' }}>
                  <span className="muted" style={{ fontSize: 12 }}>
                    {room.purge_at ? `Xoá vĩnh viễn sau ${formatDateTime(room.purge_at)}` : ''}
                  </span>
                  <button
                    type="button"
                    className="btn"
                    aria-label={`Khôi phục ${room.name}`}
                    disabled={restoring === room.id}
                    onClick={() => void restore(room)}
                  >
                    Khôi phục
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </main>

      <aside className="admin-aside" aria-label={selected === null ? 'Tạo nhóm' : 'Chi tiết nhóm'}>
        {selected === null ? (
          <CreateRoomForm branches={branches.data ?? []} users={users.data ?? []} />
        ) : (
          <RoomDetail key={selected} roomId={selected} users={users.data ?? []} onArchived={() => setSelected(null)} />
        )}
      </aside>
    </>
  )
}
