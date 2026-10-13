import type { Mention, RoomMember } from './types'

/** `@all` đứng riêng: không dính vào từ hoặc `@` khác. Phải khớp đúng luật của máy chủ/controller. */
export const MENTION_ALL_RE = /(?<![\w@])@all(?!\w)/i

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

/** Mention còn hiệu lực khi gửi: bỏ trùng id, bỏ cái mà chữ `@Tên` đã bị xoá (trùng tên: tối đa bằng số lần chữ còn xuất hiện). */
export function liveMentions(body: string, remembered: Mention[]): Mention[] {
  const seen = new Set<number>()
  const used = new Map<string, number>()
  const out: Mention[] = []
  for (const m of remembered) {
    if (seen.has(m.user_id)) continue
    const needle = `@${m.full_name}`
    const taken = used.get(needle) ?? 0
    if (taken >= countOccurrences(body, needle)) continue
    used.set(needle, taken + 1)
    seen.add(m.user_id)
    out.push(m)
  }
  return out
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
      const all = mentionAll && body.slice(i, i + 4).toLowerCase() === '@all' && !/[\w@]/.test(body[i - 1] ?? '') && !/\w/.test(body[i + 4] ?? '')
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
