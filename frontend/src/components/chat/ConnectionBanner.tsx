import { useSocketStatus } from '../../lib/ChatProvider'

export function ConnectionBanner() {
  const status = useSocketStatus()
  if (status === 'open') return null
  return (
    <div role="status" className="conn-banner">
      Đang kết nối lại… Tin nhắn mới sẽ hiện khi có kết nối.
    </div>
  )
}
