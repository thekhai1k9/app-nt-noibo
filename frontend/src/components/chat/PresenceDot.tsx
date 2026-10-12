export function PresenceDot({ online, label = 'Đang hoạt động' }: { online: boolean; label?: string }) {
  if (!online) return null
  return <span className="presence-dot" role="img" aria-label={label} />
}
