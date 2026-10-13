import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import { loadSettings, resetNotificationState } from '../lib/notifications'
import { NotificationSettings } from './NotificationSettings'

beforeEach(() => resetNotificationState())

describe('NotificationSettings', () => {
  it('explains an unsupported browser', () => {
    vi.stubGlobal('Notification', undefined)
    render(<NotificationSettings onClose={() => undefined} />)
    expect(screen.getByText('Trình duyệt không hỗ trợ thông báo.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Bật thông báo trình duyệt' })).not.toBeInTheDocument()
  })

  it('explains that HTTPS is required', () => {
    vi.stubGlobal('Notification', Object.assign(vi.fn(), { permission: 'default' }))
    vi.stubGlobal('isSecureContext', false)
    render(<NotificationSettings onClose={() => undefined} />)
    expect(screen.getByText('Cần HTTPS để bật thông báo (âm báo và số chưa đọc trên tiêu đề vẫn hoạt động).')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Bật thông báo trình duyệt' })).not.toBeInTheDocument()
  })

  it('explains how to unblock a denied permission', () => {
    vi.stubGlobal('Notification', Object.assign(vi.fn(), { permission: 'denied' }))
    vi.stubGlobal('isSecureContext', true)
    render(<NotificationSettings onClose={() => undefined} />)
    expect(screen.getByText(/cài đặt của trình duyệt/)).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Thông báo trình duyệt' })).toBeDisabled()
  })

  it('persists toggles, shows the preview warning and sends a test notification', async () => {
    const shown = vi.fn()
    vi.stubGlobal('Notification', Object.assign(function (...args: unknown[]) { shown(...args); return { close: vi.fn() } }, { permission: 'granted' }))
    vi.stubGlobal('isSecureContext', true)
    render(<NotificationSettings onClose={() => undefined} />)
    expect(screen.getByText(/màn hình khoá/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('switch', { name: 'Mọi tin trong nhóm' }))
    expect(loadSettings().allGroupMessages).toBe(true)
    await userEvent.click(screen.getByRole('button', { name: 'Gửi thử' }))
    expect(shown).toHaveBeenCalledTimes(1)
  })
})
