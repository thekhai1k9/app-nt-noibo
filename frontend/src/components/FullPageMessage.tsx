import type { ReactNode } from 'react'

export function FullPageMessage({ children }: { children: ReactNode }) {
  return (
    <div className="center-screen">
      <div className="stack" style={{ alignItems: 'center', textAlign: 'center' }}>
        {children}
      </div>
    </div>
  )
}
