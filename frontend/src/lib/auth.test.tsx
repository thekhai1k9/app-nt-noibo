import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockFetch } from '../test/mockFetch'
import { anonymousRoutes } from '../test/utils'
import { getAccessToken } from './api'
import { AuthProvider, useAuth } from './auth'

function Probe() {
  const { status, login } = useAuth()
  return (
    <div>
      <span>status:{status}</span>
      <button type="button" onClick={() => void login('a', 'b').catch(() => {})}>
        login
      </button>
    </div>
  )
}

describe('AuthProvider.login', () => {
  it('drops the token when /auth/me fails right after a successful login', async () => {
    mockFetch({
      ...anonymousRoutes,
      'POST /api/auth/login': {
        json: { access_token: 'tok-login', token_type: 'bearer', must_change_password: false },
      },
      'GET /api/auth/me': { status: 500, json: { detail: 'boom' } },
    })
    render(
      <QueryClientProvider client={new QueryClient()}>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </QueryClientProvider>,
    )
    expect(await screen.findByText('status:anonymous')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'login' }))
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.getByText('status:anonymous')).toBeInTheDocument()
    expect(getAccessToken()).toBeNull()
  })
})
