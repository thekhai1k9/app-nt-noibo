import type { ReactNode } from 'react'

const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi
const TRAILING_PUNCTUATION = /[.,;:!?)\]}]+$/

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** Biến các URL http/https trong văn bản thành liên kết; mọi thứ khác giữ nguyên là text. */
export function linkify(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let cursor = 0
  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0
    const url = match[0].replace(TRAILING_PUNCTUATION, '')
    if (!url || !isHttpUrl(url)) continue
    if (start > cursor) nodes.push(text.slice(cursor, start))
    nodes.push(
      <a key={`${start}-${url}`} href={url} target="_blank" rel="noopener noreferrer nofollow">
        {url}
      </a>,
    )
    cursor = start + url.length
  }
  if (cursor < text.length) nodes.push(text.slice(cursor))
  return nodes
}
