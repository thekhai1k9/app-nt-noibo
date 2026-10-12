import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockFetch } from '../../test/mockFetch'
import { makeUser, renderApp, sessionRoutes } from '../../test/utils'

const admin = () => sessionRoutes(makeUser({ role: 'admin' }))
const emptyAdminData = {
  'GET /api/admin/users': { json: [] },
  'GET /api/admin/branches': { json: [] },
}

describe('AdminLayout', () => {
  it('redirects /admin to the users page and marks the current nav item', async () => {
    mockFetch({ ...admin(), ...emptyAdminData })
    renderApp('/admin')
    const nav = await screen.findByRole('navigation', { name: 'Quản trị' })
    // Nav hiện trước khi <Navigate> kịp chuyển /admin sang /admin/users, nên chờ.
    await waitFor(() =>
      expect(within(nav).getByRole('link', { name: 'Người dùng' })).toHaveAttribute('aria-current', 'page'),
    )
    expect(within(nav).getByRole('link', { name: 'Chi nhánh' })).not.toHaveAttribute('aria-current')
  })

  it('navigates between sections and back to the chat', async () => {
    mockFetch({ ...admin(), ...emptyAdminData })
    renderApp('/admin/users')
    const nav = await screen.findByRole('navigation', { name: 'Quản trị' })
    await userEvent.click(within(nav).getByRole('link', { name: 'Chi nhánh' }))
    expect(await screen.findByRole('heading', { name: 'Chi nhánh' })).toBeInTheDocument()
    await userEvent.click(within(nav).getByRole('link', { name: 'Về trò chuyện' }))
    expect(await screen.findByText('Xin chào, Phạm Đức Long')).toBeInTheDocument()
  })
})
