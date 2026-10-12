import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import { mockFetch } from '../test/mockFetch'
import { makeUser, renderApp, sessionRoutes } from '../test/utils'

// Giả lập chunk lazy tải thất bại (mất mạng, bản build cũ đã bị xoá).
vi.mock('../pages/admin/AdminLayout', () => {
  throw new Error('Failed to fetch dynamically imported module')
})

describe('ErrorBoundary', () => {
  it('shows a reload screen instead of a white page when a lazy chunk fails to load', async () => {
    mockFetch(sessionRoutes(makeUser({ role: 'admin' })))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const reload = vi.fn()
    const original = window.location
    Object.defineProperty(window, 'location', { value: { ...original, reload }, configurable: true })
    try {
      renderApp('/admin/users')
      expect(await screen.findByText('Có lỗi khi tải trang.')).toBeInTheDocument()
      await userEvent.click(screen.getByRole('button', { name: 'Tải lại trang' }))
      expect(reload).toHaveBeenCalledTimes(1)
    } finally {
      Object.defineProperty(window, 'location', { value: original, configurable: true })
    }
  })
})
