import { useQueryClient } from '@tanstack/react-query'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { ApiError, api, refreshSession, setAccessToken, setAuthLostHandler, waitForRefresh } from './api'
import type { TokenOut, User } from './types'

type Status = 'loading' | 'anonymous' | 'authenticated' | 'error'

interface AuthContextValue {
  status: Status
  user: User | null
  login: (username: string, password: string) => Promise<void>
  logout: () => Promise<void>
  changePassword: (current: string, next: string) => Promise<void>
  reload: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const [status, setStatus] = useState<Status>('loading')
  const [user, setUser] = useState<User | null>(null)

  const bootstrap = useCallback(async () => {
    setStatus('loading')
    const result = await refreshSession()
    if (result === 'denied') {
      setUser(null)
      setStatus('anonymous')
      return
    }
    if (result === 'unavailable') {
      setStatus('error')
      return
    }
    try {
      setUser(await api<User>('/auth/me'))
      setStatus('authenticated')
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setUser(null)
        setStatus('anonymous')
      } else {
        setStatus('error')
      }
    }
  }, [])

  useEffect(() => {
    // Có thể được gọi một lần cho mỗi request đang chờ khi refresh bị từ chối: phải idempotent.
    setAuthLostHandler(() => {
      setUser(null)
      setStatus('anonymous')
      queryClient.clear()
    })
    void bootstrap()
    return () => setAuthLostHandler(null)
  }, [bootstrap, queryClient])

  const login = useCallback(async (username: string, password: string) => {
    const token = await api<TokenOut>('/auth/login', { method: 'POST', json: { username, password } })
    setAccessToken(token.access_token)
    try {
      setUser(await api<User>('/auth/me'))
    } catch (err) {
      setAccessToken(null) // không để token trong bộ nhớ khi vẫn là anonymous
      throw err
    }
    setStatus('authenticated')
  }, [])

  const logout = useCallback(async () => {
    // Chờ refresh đang chạy xong để logout nhắm đúng cookie mới nhất (tránh phiên sống sót sau đăng xuất).
    await waitForRefresh()
    try {
      await api('/auth/logout', { method: 'POST' })
    } catch (err) {
      // Máy chủ không phản hồi: cookie refresh vẫn còn hiệu lực, nên giữ phiên để người dùng thử lại.
      if (err instanceof ApiError && (err.status === 0 || err.status >= 500)) throw err
    }
    setAccessToken(null)
    setUser(null)
    setStatus('anonymous')
    queryClient.clear()
  }, [queryClient])

  const changePassword = useCallback(async (current: string, next: string) => {
    const token = await api<TokenOut>('/auth/change-password', {
      method: 'POST',
      json: { current_password: current, new_password: next },
    })
    setAccessToken(token.access_token)
    try {
      setUser(await api<User>('/auth/me'))
    } catch (err) {
      void bootstrap() // đồng bộ lại trạng thái vì mật khẩu đã đổi và token đã xoay
      throw err
    }
  }, [bootstrap])

  const reload = useCallback(() => {
    void bootstrap()
  }, [bootstrap])

  const value = useMemo(
    () => ({ status, user, login, logout, changePassword, reload }),
    [status, user, login, logout, changePassword, reload],
  )
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
