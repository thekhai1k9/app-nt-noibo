export function SeenLabel({ seenBy, isGroup }: { seenBy: string[]; isGroup: boolean }) {
  if (seenBy.length === 0) return null
  if (!isGroup) return <div className="seen-label">Đã xem</div>
  return (
    <div className="seen-label" title={seenBy.join(', ')}>
      {`Đã xem bởi ${seenBy.length} người`}
    </div>
  )
}
