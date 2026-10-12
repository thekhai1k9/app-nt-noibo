import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { ErrorAlert } from '../../components/ErrorAlert'
import { Field } from '../../components/Field'
import { api } from '../../lib/api'
import type { Branch } from '../../lib/types'

type Editing = Branch | 'new' | null

function BranchForm({ branch, onDone }: { branch: Branch | null; onDone: () => void }) {
  const queryClient = useQueryClient()
  const [name, setName] = useState(branch?.name ?? '')
  const [code, setCode] = useState(branch?.code ?? '')
  const [address, setAddress] = useState(branch?.address ?? '')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  async function run(action: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      await action()
      await queryClient.invalidateQueries({ queryKey: ['admin', 'branches'] })
      onDone()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    const json = { name: name.trim(), code: code.trim(), address: address.trim() }
    void run(() =>
      branch
        ? api<Branch>(`/admin/branches/${branch.id}`, { method: 'PATCH', json })
        : api<Branch>('/admin/branches', { method: 'POST', json }),
    )
  }

  function remove() {
    if (!branch) return
    if (window.confirm(`Xoá chi nhánh ${branch.name}? Thao tác này không thể hoàn tác.`)) {
      void run(() => api(`/admin/branches/${branch.id}`, { method: 'DELETE' }))
    }
  }

  return (
    <form className="card stack" onSubmit={submit}>
      <div>
        <h2 style={{ fontSize: 17 }}>{branch ? 'Sửa chi nhánh' : 'Thêm chi nhánh'}</h2>
        {branch && (
          <p className="muted" style={{ margin: '4px 0 0' }}>
            {branch.name} · {branch.user_count} người dùng
          </p>
        )}
      </div>
      <Field id="branch-name" label="Tên chi nhánh" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required />
      <Field id="branch-code" label="Mã chi nhánh" value={code} onChange={(e) => setCode(e.target.value)} maxLength={10} required />
      <Field id="branch-address" label="Địa chỉ" value={address} onChange={(e) => setAddress(e.target.value)} maxLength={200} />
      <ErrorAlert error={error} />
      <div className="row">
        <button type="button" className="btn grow" onClick={onDone}>
          Huỷ
        </button>
        <button type="submit" className="btn btn-primary grow" disabled={busy}>
          {branch ? 'Lưu thay đổi' : 'Tạo chi nhánh'}
        </button>
      </div>
      {branch && (
        <button type="button" className="btn btn-danger" onClick={remove} disabled={busy}>
          Xoá chi nhánh
        </button>
      )}
    </form>
  )
}

export function BranchesPage() {
  const [editing, setEditing] = useState<Editing>(null)
  const branches = useQuery({ queryKey: ['admin', 'branches'], queryFn: () => api<Branch[]>('/admin/branches') })
  const list = branches.data ?? []

  return (
    <>
      <main className="admin-main">
        <div className="page-head">
          <div>
            <h1>Chi nhánh</h1>
            <p className="muted" style={{ margin: '4px 0 0' }}>
              Mỗi người dùng thuộc một chi nhánh.
            </p>
          </div>
          <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>
            Thêm chi nhánh
          </button>
        </div>
        {branches.isError && <ErrorAlert error={branches.error} />}
        <div className="cards-grid">
          {list.map((b) => (
            <div key={b.id} className="card stack" style={{ gap: 12, padding: 18 }}>
              <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'nowrap' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 16, fontWeight: 700 }}>{b.name}</div>
                  <div className="muted ellipsis" style={{ fontSize: 12 }}>
                    {b.address}
                  </div>
                </div>
                <span className="badge">{b.code}</span>
              </div>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="muted">{b.user_count} người dùng</span>
                <button
                  type="button"
                  className="btn btn-ghost"
                  aria-label={`Sửa ${b.name}`}
                  onClick={() => setEditing(b)}
                >
                  Sửa
                </button>
              </div>
            </div>
          ))}
        </div>
      </main>
      {editing && (
        <aside className="admin-aside" aria-label="Biểu mẫu chi nhánh">
          <BranchForm
            key={editing === 'new' ? 'new' : editing.id}
            branch={editing === 'new' ? null : editing}
            onDone={() => setEditing(null)}
          />
        </aside>
      )}
    </>
  )
}
