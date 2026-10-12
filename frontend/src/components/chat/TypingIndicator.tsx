function text(names: string[]): string {
  if (names.length === 0) return ''
  if (names.length === 1) return `${names[0]} đang soạn tin…`
  if (names.length === 2) return `${names[0]} và ${names[1]} đang soạn tin…`
  return 'Nhiều người đang soạn tin…'
}

/** Luôn có mặt (chiều cao cố định) để khung chat không nhảy khi dòng này xuất hiện/biến mất. */
export function TypingIndicator({ names }: { names: string[] }) {
  return (
    <div className="typing-indicator" role="status" aria-live="polite">
      {text(names)}
    </div>
  )
}
