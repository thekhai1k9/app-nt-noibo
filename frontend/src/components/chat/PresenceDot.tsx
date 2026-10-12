export function PresenceDot({
  online,
  label = 'Đang hoạt động',
  decorative = false,
}: {
  online: boolean
  label?: string
  /** Đi kèm chữ hiển thị cạnh bên: ẩn khỏi trình đọc màn hình. */
  decorative?: boolean
}) {
  if (!online) return null
  if (decorative) return <span className="presence-dot" aria-hidden="true" />
  return <span className="presence-dot" role="img" aria-label={label} />
}
