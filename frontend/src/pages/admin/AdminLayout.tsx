import { NavLink, Outlet } from 'react-router-dom'

export function AdminLayout() {
  return (
    <div className="admin-shell">
      <nav className="admin-nav" aria-label="Quản trị">
        <div>
          <strong style={{ fontSize: 16 }}>Kết Nối</strong>
          <div style={{ fontSize: 12, color: '#98a2b3' }}>Quản trị</div>
        </div>
        <div className="stack" style={{ gap: 4 }}>
          <NavLink to="/admin/users">Người dùng</NavLink>
          <NavLink to="/admin/branches">Chi nhánh</NavLink>
          <NavLink to="/admin/rooms">Phòng và nhóm</NavLink>
        </div>
        <NavLink to="/" className="back" end>
          Về trò chuyện
        </NavLink>
      </nav>
      <Outlet />
    </div>
  )
}
