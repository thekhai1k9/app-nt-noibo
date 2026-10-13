import type { Mention, RoomMember } from './types'

const WORD_CHAR = /[\p{L}\p{N}_]/u

/** Ký tự "chữ" theo nghĩa Unicode (giống `\w` của Python bên máy chủ, vốn là Unicode). */
function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && ch !== '' && WORD_CHAR.test(ch)
}

function lastChar(text: string, end: number): string {
  return Array.from(text.slice(Math.max(0, end - 2), end)).at(-1) ?? ''
}

/** `@all` (không phân biệt hoa thường) bắt đầu tại `i`, đứng riêng: trước không phải chữ/`@`, sau không phải chữ. Không dùng lookbehind (Safari < 16.4). */
export function isStandaloneAllAt(body: string, i: number): boolean {
  if (body[i] !== '@' || body.slice(i, i + 4).toLowerCase() !== '@all') return false
  const prev = lastChar(body, i)
  if (prev === '@' || isWordChar(prev)) return false
  const next = i + 4 < body.length ? String.fromCodePoint(body.codePointAt(i + 4)!) : ''
  return !isWordChar(next)
}

export function hasStandaloneAll(body: string): boolean {
  for (let i = body.indexOf('@'); i !== -1; i = body.indexOf('@', i + 1)) if (isStandaloneAllAt(body, i)) return true
  return false
}

export const MAX_SUGGESTIONS = 6

/** Bỏ dấu tiếng Việt, đ=d, chữ thường: "duc" khớp "Đức". */
export function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
}

export type MentionOption = { kind: 'all' } | { kind: 'member'; member: RoomMember }

const ALL_KEYWORDS = ['all', 'tatca', 'moinguoi']

/** Vị trí `@` đang gõ dở tại con trỏ: `@` đứng đầu từ (đầu chuỗi hoặc sau khoảng trắng), chưa có khoảng trắng sau nó. */
export function detectMention(text: string, caret: number): { start: number; query: string } | null {
  let i = caret - 1
  while (i >= 0 && !/\s/.test(text[i]) && text[i] !== '@') i--
  if (i < 0 || text[i] !== '@') return null
  if (i > 0 && !/\s/.test(text[i - 1])) return null
  return { start: i, query: text.slice(i + 1, caret) }
}

export function mentionOptions(members: RoomMember[], meId: number, isGroup: boolean, query: string): MentionOption[] {
  const q = fold(query)
  const options: MentionOption[] = []
  if (isGroup && (q === '' || ALL_KEYWORDS.some((k) => k.startsWith(q)))) options.push({ kind: 'all' })
  for (const member of members) {
    if (member.user_id === meId) continue
    const words = fold(member.full_name).split(/\s+/)
    if (q === '' || words.some((w) => w.startsWith(q))) options.push({ kind: 'member', member })
  }
  return options.slice(0, MAX_SUGGESTIONS)
}

function countOccurrences(text: string, needle: string): number {
  let n = 0
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) n++
  return n
}

/**
 * Giữ các mention đã nhớ khớp với chữ `@Tên` còn trong nội dung. Duyệt từ mới đến cũ: lượt chọn MỚI thắng khi nhiều người trùng tên
 * và số lần `@Tên` xuất hiện ít hơn số người đã nhớ; mỗi id chỉ giữ một lần; thứ tự chèn được giữ nguyên.
 */
export function liveMentions(body: string, remembered: Mention[]): Mention[] {
  const seen = new Set<number>()
  const used = new Map<string, number>()
  const kept: Mention[] = []
  for (let i = remembered.length - 1; i >= 0; i--) {
    const m = remembered[i]
    if (seen.has(m.user_id)) continue
    const needle = `@${m.full_name}`
    const taken = used.get(needle) ?? 0
    if (taken >= countOccurrences(body, needle)) continue
    used.set(needle, taken + 1)
    seen.add(m.user_id)
    kept.push(m)
  }
  return kept.reverse()
}

export type BodyPart = { text: string; mention: 'name' | 'all' | null }

/** Tách nội dung theo các `@Tên` (dài trước, tránh khớp nhầm tiền tố) và `@all` đứng riêng; chỉ tìm chuỗi thường, không dựng regex từ tên. */
export function splitMentions(body: string, mentions: Mention[], mentionAll: boolean): BodyPart[] {
  const needles = [...new Set(mentions.map((m) => `@${m.full_name}`))].sort((a, b) => b.length - a.length)
  if (needles.length === 0 && !mentionAll) return [{ text: body, mention: null }]
  const parts: BodyPart[] = []
  let plain = ''
  let i = 0
  while (i < body.length) {
    let hit: BodyPart | null = null
    if (body[i] === '@') {
      const name = needles.find((n) => body.startsWith(n, i))
      const all = mentionAll && isStandaloneAllAt(body, i)
      if (name && !(all && name.length < 4)) hit = { text: name, mention: 'name' }
      else if (all) hit = { text: body.slice(i, i + 4), mention: 'all' }
    }
    if (hit) {
      if (plain) parts.push({ text: plain, mention: null })
      plain = ''
      parts.push(hit)
      i += hit.text.length
    } else {
      plain += body[i]
      i++
    }
  }
  if (plain) parts.push({ text: plain, mention: null })
  return parts
}
