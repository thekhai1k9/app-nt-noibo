import type { ReactNode } from 'react'

export function FullPageMessage({ children, role }: { children: ReactNode; role?: 'status' | 'alert' }) {
  return (
    <div className="center-screen" role={role}>
      <div className="stack" style={{ alignItems: 'center', textAlign: 'center' }}>
        {children}
      </div>
    </div>
  )
}
