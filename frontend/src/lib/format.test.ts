import { dayLabel, formatDateTime, formatTime, initials, listTime, sameDay } from './format'

const now = new Date(2026, 9, 15, 12, 0, 0) // 15/10/2026 12:00 giờ địa phương
const at = (y: number, m: number, d: number, h = 9, min = 5) => new Date(y, m - 1, d, h, min).toISOString()

describe('format', () => {
  it('takes initials from the first and last word', () => {
    expect(initials('Nguyễn Minh Anh')).toBe('NA')
    expect(initials('Hà')).toBe('H')
    expect(initials('  ')).toBe('')
  })

  it('formats the time of day as HH:mm', () => {
    expect(formatTime(at(2026, 10, 15, 9, 5))).toBe('09:05')
  })

  it('formats date and time as dd/MM/yyyy HH:mm', () => {
    expect(formatDateTime(at(2026, 10, 18, 9, 5))).toBe('18/10/2026 09:05')
  })

  it('labels days relative to now', () => {
    expect(dayLabel(at(2026, 10, 15), now)).toBe('Hôm nay')
    expect(dayLabel(at(2026, 10, 14), now)).toBe('Hôm qua')
    expect(dayLabel(at(2026, 9, 1), now)).toBe('01/09/2026')
  })

  it('shows the time for today and a short date otherwise in the room list', () => {
    expect(listTime(at(2026, 10, 15, 8, 30), now)).toBe('08:30')
    expect(listTime(at(2026, 10, 14), now)).toBe('Hôm qua')
    expect(listTime(at(2026, 9, 1), now)).toBe('01/09')
  })

  it('compares local calendar days', () => {
    expect(sameDay(at(2026, 10, 15, 0, 1), at(2026, 10, 15, 23, 59))).toBe(true)
    expect(sameDay(at(2026, 10, 15), at(2026, 10, 16))).toBe(false)
  })

  it('returns an empty string for invalid timestamps', () => {
    for (const fn of [formatTime, formatDateTime, (v: string) => dayLabel(v, now), (v: string) => listTime(v, now)]) {
      expect(fn('không phải ngày')).toBe('')
      expect(fn('')).toBe('')
    }
  })

  it('treats a timestamp a little in the future (client clock behind) as today', () => {
    const early = new Date(2026, 9, 15, 11, 0)
    const future = new Date(2026, 9, 16, 0, 5).toISOString() // 13h sau, sang ngày hôm sau
    expect(dayLabel(future, early)).toBe('Hôm nay')
    expect(listTime(future, early)).toBe('00:05')
    expect(dayLabel(at(2026, 10, 20), now)).toBe('20/10/2026') // quá xa thì hiện ngày
  })

  it('counts calendar days across a month boundary', () => {
    const first = new Date(2026, 9, 1, 0, 30)
    expect(dayLabel(at(2026, 9, 30, 23, 30), first)).toBe('Hôm qua')
    expect(listTime(at(2026, 9, 30, 23, 30), first)).toBe('Hôm qua')
    expect(dayLabel(at(2026, 9, 29, 12, 0), first)).toBe('29/09/2026')
  })
})
