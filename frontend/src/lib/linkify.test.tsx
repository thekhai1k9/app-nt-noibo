import { render } from '@testing-library/react'
import { linkify } from './linkify'

const html = (text: string) => render(<p>{linkify(text)}</p>).container.innerHTML

describe('linkify', () => {
  it('turns http and https URLs into safe links', () => {
    const { container } = render(<p>{linkify('xem https://example.com/a?b=1 nhé')}</p>)
    const link = container.querySelector('a')!
    expect(link.getAttribute('href')).toBe('https://example.com/a?b=1')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer nofollow')
    expect(container.textContent).toBe('xem https://example.com/a?b=1 nhé')
  })

  it('keeps trailing punctuation outside the link', () => {
    const { container } = render(<p>{linkify('vào http://a.vn/x, rồi (https://b.vn).')}</p>)
    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'))
    expect(hrefs).toEqual(['http://a.vn/x', 'https://b.vn'])
    expect(container.textContent).toBe('vào http://a.vn/x, rồi (https://b.vn).')
  })

  it('never links javascript:, data: or other schemes', () => {
    for (const text of ['javascript:alert(1)', 'data:text/html,<script>1</script>', 'ftp://x.vn', 'JaVaScRiPt:alert(1)']) {
      expect(html(text)).not.toContain('<a')
    }
  })

  it('renders HTML in the text as plain text', () => {
    const { container } = render(<p>{linkify('<img src=x onerror=alert(1)> https://ok.vn')}</p>)
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(container.querySelectorAll('a')).toHaveLength(1)
  })

  it('returns plain text unchanged', () => {
    expect(html('không có liên kết')).toBe('<p>không có liên kết</p>')
  })

  it('keeps a closing parenthesis that balances one inside the URL', () => {
    const { container } = render(<p>{linkify('xem https://en.wikipedia.org/wiki/Foo_(bar). và (https://b.vn/x_(y))')}</p>)
    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'))
    expect(hrefs).toEqual(['https://en.wikipedia.org/wiki/Foo_(bar)', 'https://b.vn/x_(y)'])
  })
})
