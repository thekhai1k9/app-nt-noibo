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
})
