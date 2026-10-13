import { useEffect, useId, useRef, useState } from 'react'
import {
  loadSettings,
  notificationSupport,
  playBeep,
  requestPermission,
  saveSettings,
  showNotification,
  type NotifySettings,
} from '../lib/notifications'
import { useModalFocus } from './chat/dialogFocus'

const SUPPORT_TEXT = {
  unsupported: 'Trình duyệt không hỗ trợ thông báo.',
  insecure: 'Cần HTTPS để bật thông báo (âm báo và số chưa đọc trên tiêu đề vẫn hoạt động).',
  denied: 'Bạn đã chặn thông báo cho trang này. Hãy mở lại quyền Thông báo trong cài đặt của trình duyệt (biểu tượng ổ khoá cạnh địa chỉ), rồi tải lại trang.',
} as const

function Switch({ label, hint, checked, disabled, onChange }: { label: string; hint?: string; checked: boolean; disabled?: boolean; onChange: (value: boolean) => void }) {
  const id = useId()
  return (
    <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'nowrap', alignItems: 'flex-start' }}>
      <span style={{ minWidth: 0 }}>
        <span id={id} style={{ fontWeight: 600 }}>{label}</span>
        {hint && <span className="muted" style={{ display: 'block', fontSize: 13 }}>{hint}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={id}
        disabled={disabled}
        className={`btn ${checked ? '' : 'btn-ghost'}`}
        onClick={() => onChange(!checked)}
      >
        {checked ? 'Bật' : 'Tắt'}
      </button>
    </div>
  )
}

export function NotificationSettings({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<NotifySettings>(() => loadSettings())
  const [support, setSupport] = useState(() => notificationSupport())
  const [asking, setAsking] = useState(false)
  const askingRef = useRef(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  useModalFocus(dialogRef, () => closeRef.current)

  const close = () => {
    if (!askingRef.current) onClose()
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && !askingRef.current && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  function update(patch: Partial<NotifySettings>) {
    setSettings((cur) => {
      const next = { ...cur, ...patch }
      saveSettings(next)
      return next
    })
  }

  async function ask() {
    if (askingRef.current) return
    askingRef.current = true
    setAsking(true)
    try {
      const result = await requestPermission()
      setSupport(notificationSupport())
      if (result === 'granted') update({ enabled: true })
    } finally {
      askingRef.current = false
      setAsking(false)
    }
  }

  function sendTest() {
    if (support === 'granted') showNotification({ title: 'Kết Nối', body: 'Đây là thông báo thử.', tag: 'kn-test', onClick: () => undefined })
    if (settings.sound) playBeep()
  }

  const granted = support === 'granted'

  return (
    <div className="dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <div ref={dialogRef} className="card dialog stack" role="dialog" aria-modal="true" aria-label="Cài đặt thông báo">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ fontSize: 17 }}>Cài đặt thông báo</h2>
          <button ref={closeRef} type="button" className="btn btn-ghost" disabled={asking} onClick={close}>
            Đóng
          </button>
        </div>
        {!granted && support in SUPPORT_TEXT && <div className="muted" role="note">{SUPPORT_TEXT[support as keyof typeof SUPPORT_TEXT]}</div>}
        {support === 'default' && (
          <button type="button" className="btn" disabled={asking} onClick={() => void ask()}>
            Bật thông báo trình duyệt
          </button>
        )}
        <Switch label="Thông báo trình duyệt" checked={granted && settings.enabled} disabled={!granted} onChange={(enabled) => update({ enabled })} />
        <Switch label="Âm báo" checked={settings.sound} onChange={(sound) => update({ sound })} />
        <Switch
          label="Hiện nội dung tin"
          hint="Nội dung tin sẽ hiện trên màn hình khoá/khu vực thông báo của máy"
          checked={settings.showPreview}
          onChange={(showPreview) => update({ showPreview })}
        />
        <Switch
          label="Mọi tin trong nhóm"
          hint="Mặc định chỉ báo khi được nhắc tên hoặc có người trả lời tin của bạn."
          checked={settings.allGroupMessages}
          onChange={(allGroupMessages) => update({ allGroupMessages })}
        />
        <button type="button" className="btn btn-ghost" onClick={sendTest}>
          Gửi thử
        </button>
      </div>
    </div>
  )
}
