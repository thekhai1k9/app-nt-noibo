import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { FullPageMessage } from './FullPageMessage'

export function RequireAuth({
  allowPasswordChange = false,
  children,
}: {
  allowPasswordChange?: boolean
  children: ReactNode
}) {
  const { status, user, reload } = useAuth()
  const location = useLocation()

  if (status === 'loading') return <FullPageMessage role="status">Đang tải…</FullPageMessage>
  if (status === 'error') {
    return (
      <FullPageMessage role="alert">
        <p>Không kết nối được máy chủ.</p>
        <button type="button" className="btn btn-primary" onClick={reload}>
          Thử lại
        </button>
      </FullPageMessage>
    )
  }
  if (status === 'anonymous' || !user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }
  if (user.must_change_password && !allowPasswordChange) {
    return <Navigate to="/change-password" replace />
  }
  return <>{children}</>
}

export function RequireAdmin({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  if (user?.role !== 'admin') return <Navigate to="/" replace />
  return <>{children}</>
}
