import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { ErrorAlert } from '../../components/ErrorAlert'
import { Field } from '../../components/Field'
import { api } from '../../lib/api'
import type { Branch, ResetPasswordOut, Role, User, UserCreated } from '../../lib/types'

interface TempPassword {
  title: string
  password: string
}

function initials(fullName: string): string {
  const words = fullName.trim().split(/\s+/)
  return ((words[0]?.[0] ?? '') + (words.length > 1 ? (words.at(-1)?.[0] ?? '') : '')).toUpperCase()
}

function statusOf(user: User): { label: string; className: string } {
  if (!user.is_active) return { label: 'Đã khoá', className: 'badge badge-danger' }
  if (user.must_change_password) return { label: 'Chờ đổi mật khẩu', className: 'badge badge-warn' }
  return { label: 'Hoạt động', className: 'badge badge-ok' }
}

function TempPasswordNotice({ notice, onDismiss }: { notice: TempPassword; onDismiss: () => void }) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(notice.password)
    } catch {
      // trình duyệt không cho phép; người dùng vẫn chép tay được
    }
  }
  return (
    <div role="status" className="notice-ok stack" style={{ gap: 8 }}>
      <strong>{notice.title}</strong>
      <div>
        Mật khẩu tạm: <code>{notice.password}</code>
      </div>
      <div>Chỉ hiển thị một lần. Hãy chép lại và gửi cho người dùng ngay; người dùng phải đổi mật khẩu khi đăng nhập lần đầu.</div>
      <div className="row">
        <button type="button" className="btn" onClick={() => void copy()}>
          Sao chép
        </button>
        <button type="button" className="btn btn-primary" onClick={onDismiss}>
          Đã ghi lại
        </button>
      </div>
    </div>
  )
}

function CreateUserForm({ branches, onCreated }: { branches: Branch[]; onCreated: (u: UserCreated) => void }) {
  const [fullName, setFullName] = useState('')
  const [username, setUsername] = useState('')
  const [branchId, setBranchId] = useState('')
  const [role, setRole] = useState<Role>('member')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const effectiveBranch = branchId || (branches[0] ? String(branches[0].id) : '')

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const created = await api<UserCreated>('/admin/users', {
        method: 'POST',
        json: { full_name: fullName.trim(), username: username.trim(), branch_id: Number(effectiveBranch), role },
      })
      setFullName('')
      setUsername('')
      setRole('member')
      onCreated(created)
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="card stack" onSubmit={submit}>
      <div>
        <h2 style={{ fontSize: 17 }}>Tạo tài khoản mới</h2>
        <p className="muted" style={{ margin: '4px 0 0' }}>
          Người dùng phải đổi mật khẩu ở lần đăng nhập đầu.
        </p>
      </div>
      <Field id="new-full-name" label="Họ tên" value={fullName} onChange={(e) => setFullName(e.target.value)} required />
      <Field
        id="new-username"
        label="Tên đăng nhập"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        pattern="[A-Za-z0-9._\-]{3,50}"
        title="3-50 ký tự: chữ, số, dấu chấm, gạch dưới hoặc gạch ngang"
        required
      />
      <div className="field">
        <label htmlFor="new-branch">Chi nhánh</label>
        <select id="new-branch" className="input" value={effectiveBranch} onChange={(e) => setBranchId(e.target.value)} required>
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="new-role">Vai trò</label>
        <select id="new-role" className="input" value={role} onChange={(e) => setRole(e.target.value as Role)}>
          <option value="member">Thành viên</option>
          <option value="admin">Quản trị viên</option>
        </select>
      </div>
      <ErrorAlert error={error} />
      <button type="submit" className="btn btn-primary" disabled={busy || branches.length === 0}>
        Tạo tài khoản
      </button>
    </form>
  )
}

export function UsersPage() {
  const queryClient = useQueryClient()
  const [q, setQ] = useState('')
  const [branchId, setBranchId] = useState('')
  const [activeFilter, setActiveFilter] = useState('')
  const [notice, setNotice] = useState<TempPassword | null>(null)
  const [actionError, setActionError] = useState<unknown>(null)

  const params = new URLSearchParams()
  if (q.trim()) params.set('q', q.trim())
  if (branchId) params.set('branch_id', branchId)
  if (activeFilter) params.set('is_active', activeFilter)
  const queryString = params.toString()

  const users = useQuery({
    queryKey: ['admin', 'users', queryString],
    queryFn: () => api<User[]>(`/admin/users${queryString ? `?${queryString}` : ''}`),
  })
  const branches = useQuery({ queryKey: ['admin', 'branches'], queryFn: () => api<Branch[]>('/admin/branches') })

  const refreshUsers = () => queryClient.invalidateQueries({ queryKey: ['admin', 'users'] })

  const toggleActive = useMutation({
    mutationFn: (user: User) =>
      api<User>(`/admin/users/${user.id}`, { method: 'PATCH', json: { is_active: !user.is_active } }),
    onSuccess: () => {
      setActionError(null)
      void refreshUsers()
    },
    onError: setActionError,
  })

  const resetPassword = useMutation({
    mutationFn: async (user: User) => {
      const result = await api<ResetPasswordOut>(`/admin/users/${user.id}/reset-password`, { method: 'POST' })
      return { user, password: result.temp_password }
    },
    onSuccess: ({ user, password }) => {
      setActionError(null)
      setNotice({ title: `Mật khẩu tạm mới của ${user.username}`, password })
      void refreshUsers()
    },
    onError: setActionError,
  })

  const branchName = (id: number) => branches.data?.find((b) => b.id === id)?.name ?? '—'
  const list = users.data ?? []
  const activeCount = list.filter((u) => u.is_active).length

  function confirmReset(user: User) {
    if (window.confirm(`Đặt lại mật khẩu của ${user.username}? Họ sẽ bị đăng xuất khỏi mọi thiết bị.`)) {
      resetPassword.mutate(user)
    }
  }

  return (
    <>
      <main className="admin-main">
        <div className="page-head">
          <div>
            <h1>Người dùng</h1>
            <p className="muted" style={{ margin: '4px 0 0' }}>
              {list.length} tài khoản · {activeCount} đang hoạt động
            </p>
          </div>
        </div>

        {notice && <TempPasswordNotice notice={notice} onDismiss={() => setNotice(null)} />}
        <ErrorAlert error={actionError} />
        {users.isError && <ErrorAlert error={users.error} />}

        <div className="row">
          <input
            className="input grow"
            style={{ minWidth: 220 }}
            aria-label="Tìm người dùng"
            placeholder="Tìm theo tên hoặc tên đăng nhập"
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
          <select className="input" style={{ width: 'auto' }} aria-label="Lọc theo trạng thái" value={activeFilter} onChange={(e) => setActiveFilter(e.target.value)}>
            <option value="">Mọi trạng thái</option>
            <option value="true">Hoạt động</option>
            <option value="false">Đã khoá</option>
          </select>
        </div>

        <div className="table-scroll">
          <div className="table-row table-head users-grid">
            <span>Họ tên</span>
            <span>Chi nhánh</span>
            <span>Vai trò</span>
            <span>Trạng thái</span>
            <span />
          </div>
          {list.map((user) => {
            const status = statusOf(user)
            return (
              <div key={user.id} className="table-row users-grid">
                <div className="row" style={{ flexWrap: 'nowrap', minWidth: 0 }}>
                  <span className="avatar" aria-hidden="true">
                    {initials(user.full_name)}
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div className="ellipsis" style={{ fontWeight: 600 }}>
                      {user.full_name}
                    </div>
                    <div className="muted ellipsis" style={{ fontSize: 12 }}>
                      {user.username}
                    </div>
                  </div>
                </div>
                <span>{branchName(user.branch_id)}</span>
                <span>{user.role === 'admin' ? 'Quản trị viên' : 'Thành viên'}</span>
                <span className={status.className} style={{ justifySelf: 'start' }}>
                  {status.label}
                </span>
                <div className="row" style={{ flexWrap: 'nowrap', gap: 4 }}>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    style={{ padding: '0 10px' }}
                    aria-label={`Đặt lại mật khẩu của ${user.username}`}
                    onClick={() => confirmReset(user)}
                  >
                    Đặt lại MK
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    style={{ padding: '0 10px' }}
                    aria-label={`${user.is_active ? 'Khoá' : 'Mở khoá'} ${user.username}`}
                    onClick={() => toggleActive.mutate(user)}
                  >
                    {user.is_active ? 'Khoá' : 'Mở khoá'}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </main>

      <aside className="admin-aside" aria-label="Tạo tài khoản">
        <CreateUserForm
          branches={branches.data ?? []}
          onCreated={(created) => {
            setNotice({ title: `Đã tạo tài khoản ${created.username}`, password: created.temp_password })
            void refreshUsers()
            void queryClient.invalidateQueries({ queryKey: ['admin', 'branches'] })
          }}
        />
      </aside>
    </>
  )
}
