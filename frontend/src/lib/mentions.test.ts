import { detectMention, fold, hasStandaloneAll, liveMentions, mentionOptions, splitMentions } from './mentions'
import type { RoomMember } from './types'

const member = (id: number, name: string): RoomMember => ({ user_id: id, full_name: name, last_read_message_id: null, role: 'member' })
const members = [member(1, 'Tôi Đây'), member(2, 'Nguyễn Đức Anh'), member(3, 'Lê Thu Hà'), member(4, 'Đỗ Văn Dũng')]

describe('mentions helpers', () => {
  it('folds diacritics and đ', () => {
    expect(fold('Đức Hà')).toBe('duc ha')
  })

  it('detects an @ at a word start only', () => {
    expect(detectMention('hi @Th', 6)).toEqual({ start: 3, query: 'Th' })
    expect(detectMention('@', 1)).toEqual({ start: 0, query: '' })
    expect(detectMention('mail@x', 6)).toBeNull()
    expect(detectMention('hi @Th ', 7)).toBeNull()
    expect(detectMention('hi', 2)).toBeNull()
  })

  it('filters other members by any word, accent-insensitively, and caps at 6', () => {
    const names = (q: string) => mentionOptions(members, 1, false, q).map((o) => (o.kind === 'member' ? o.member.user_id : 'all'))
    expect(names('duc')).toEqual([2])
    expect(names('d')).toEqual([2, 4])
    expect(names('ha')).toEqual([3])
    expect(names('toi')).toEqual([]) // chính mình không có trong gợi ý
    const many = Array.from({ length: 10 }, (_, i) => member(10 + i, `Người ${i}`))
    expect(mentionOptions(many, 1, true, '')).toHaveLength(6)
  })

  it('offers @all first, in groups only, for all/tatca/moinguoi prefixes', () => {
    expect(mentionOptions(members, 1, true, '')[0]).toEqual({ kind: 'all' })
    expect(mentionOptions(members, 1, true, 'TA')[0]).toEqual({ kind: 'all' })
    expect(mentionOptions(members, 1, true, 'moi')[0]).toEqual({ kind: 'all' })
    expect(mentionOptions(members, 1, true, 'du')[0]).not.toEqual({ kind: 'all' })
    expect(mentionOptions(members, 1, false, '').some((o) => o.kind === 'all')).toBe(false)
  })

  it('keeps only mentions whose @name is still present, deduped by id', () => {
    const a = { user_id: 2, full_name: 'Bob' }
    expect(liveMentions('chào @Bob', [a, a])).toEqual([a])
    expect(liveMentions('chào Bob', [a])).toEqual([])
    const b = { user_id: 3, full_name: 'Bob' }
    expect(liveMentions('@Bob', [a, b])).toEqual([b]) // trùng tên: lượt chọn mới thắng
    expect(liveMentions('@Bob @Bob', [a, b])).toEqual([a, b]) // giữ thứ tự chèn
  })

  it('detects a standalone @all with Unicode word boundaries and no lookbehind', () => {
    for (const ok of ['@all', 'hi @all!', '(@all)', '@ALL ơi', 'x' + String.fromCharCode(10) + '@all']) expect(hasStandaloneAll(ok), ok).toBe(true)
    for (const bad of ['x@all', 'email@all.com', '@allé', 'Hà@all', '@all2', 'a@@all', '@al', '@all_x']) expect(hasStandaloneAll(bad), bad).toBe(false)
  })

  it('splits by names longest first without regexes, and by a standalone @all', () => {
    const parts = splitMentions('hi @A+B (C) và @A+B (C)x @Al @all mail@all.com', [{ user_id: 1, full_name: 'A+B (C)' }, { user_id: 2, full_name: 'A' }], true)
    expect(parts.filter((p) => p.mention).map((p) => [p.text, p.mention])).toEqual([
      ['@A+B (C)', 'name'], ['@A+B (C)', 'name'], ['@A', 'name'], ['@all', 'all'],
    ])
    expect(parts.map((p) => p.text).join('')).toBe('hi @A+B (C) và @A+B (C)x @Al @all mail@all.com')
  })
})
