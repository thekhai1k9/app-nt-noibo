import { useEffect, type RefObject } from 'react'

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [href], select:not([disabled])'

/**
 * Giữ focus trong hộp thoại modal:
 * - Tab/Shift+Tab được xử lý ở mức document, kể cả khi focus đã rơi ra <body>.
 * - Sau mỗi lần render, nếu focus không còn trong hộp thoại (nút bị gỡ/tắt) thì trả về `fallback()`.
 */
export function useModalFocus(dialogRef: RefObject<HTMLElement>, fallback: () => HTMLElement | null | undefined) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const dialog = dialogRef.current
      if (event.key !== 'Tab' || !dialog) return
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE))
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement
      const inside = !!active && dialog.contains(active)
      if (event.shiftKey && (!inside || active === first)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (!inside || active === last)) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [dialogRef])

  // Không có mảng phụ thuộc: kiểm tra sau mọi lần render.
  useEffect(() => {
    const dialog = dialogRef.current
    const active = document.activeElement
    if (!dialog || (active && active !== document.body && dialog.contains(active))) return
    fallback()?.focus()
  })
}

/** Tên nhóm: tối đa 100 ký tự (code point như server) và không chứa NUL; server vẫn là nơi quyết định. */
export function acceptableGroupNameInput(value: string): boolean {
  return !value.includes('\u0000') && [...value].length <= 100
}
