const pad = (n: number) => String(n).padStart(2, '0')

export function initials(fullName: string): string {
  const words = fullName.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return ''
  const first = words[0][0] ?? ''
  const last = words.length > 1 ? (words[words.length - 1][0] ?? '') : ''
  return (first + last).toUpperCase()
}

export function formatTime(iso: string): string {
  const d = new Date(iso)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function sameDay(a: string, b: string): boolean {
  const x = new Date(a)
  const y = new Date(b)
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate()
}

function dayDiff(iso: string, now: Date): number {
  const d = new Date(iso)
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  return Math.round((start(now) - start(d)) / 86_400_000)
}

export function dayLabel(iso: string, now: Date = new Date()): string {
  const diff = dayDiff(iso, now)
  if (diff === 0) return 'Hôm nay'
  if (diff === 1) return 'Hôm qua'
  const d = new Date(iso)
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`
}

export function listTime(iso: string, now: Date = new Date()): string {
  const diff = dayDiff(iso, now)
  if (diff === 0) return formatTime(iso)
  if (diff === 1) return 'Hôm qua'
  const d = new Date(iso)
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`
}

/** dd/MM/yyyy HH:mm theo giờ địa phương. */
export function formatDateTime(iso: string): string {
  const d = new Date(iso)
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
