import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import { getAccessToken, handleAuthLost, refreshSession } from './api'
import { useAuth } from './auth'
import { chatApi } from './chatApi'
import { ChatController } from './chatController'
import { ChatStore, EMPTY_THREAD, type ChatState, type Thread } from './chatStore'
import type { Room, RoomMember } from './types'
import { ChatSocket, type SocketStatus } from './ws'

interface ChatContextValue {
  store: ChatStore
  controller: ChatController
}

const ChatContext = createContext<ChatContextValue | null>(null)

function build(userId: number, userName: string): { socket: ChatSocket } & ChatContextValue {
  const store = new ChatStore()
  const socket = new ChatSocket({ getToken: getAccessToken, refresh: refreshSession, onAuthLost: handleAuthLost })
  const controller = new ChatController({ store, api: chatApi, socket, meId: userId, meName: userName })
  socket.onStatus((status) => store.setStatus(status))
  socket.onEvent((event) => controller.handleSocketEvent(event))
  return { store, controller, socket }
}

/**
 * Chỉ dùng dưới RequireAuth, phía trên mọi route đã đăng nhập (chat, admin, đổi mật khẩu) để
 * trạng thái và tin đang chờ gửi còn nguyên khi chuyển trang. Giữ một WebSocket cho cả phiên.
 */
export function ChatProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const userId = user?.id
  const userName = user?.full_name ?? ''
  // Máy chủ đóng WebSocket (4401) khi người dùng còn phải đổi mật khẩu: chỉ kết nối sau khi đổi xong.
  const mustChange = user?.must_change_password ?? false
  // Một instance cho mỗi người dùng; effect bên dưới start/stop được (an toàn với StrictMode).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const instance = useMemo(() => (userId !== undefined ? build(userId, userName) : null), [userId])

  useEffect(() => {
    if (!instance || mustChange) return
    const { socket, controller } = instance
    controller.activate()
    socket.start()
    void controller.loadRooms()
    const onOnline = () => socket.reconnectNow()
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        socket.reconnectNow()
        controller.onVisible()
      }
    }
    window.addEventListener('online', onOnline)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('online', onOnline)
      document.removeEventListener('visibilitychange', onVisibility)
      socket.stop()
      controller.dispose()
    }
  }, [instance, mustChange])

  if (!instance) return null
  return <ChatContext.Provider value={{ store: instance.store, controller: instance.controller }}>{children}</ChatContext.Provider>
}

function useChatContext(): ChatContextValue {
  const ctx = useContext(ChatContext)
  if (!ctx) throw new Error('useChat* must be used inside ChatProvider')
  return ctx
}

export function useChatController(): ChatController {
  return useChatContext().controller
}

export function useChatState<T>(selector: (state: ChatState) => T): T {
  const { store } = useChatContext()
  return useSyncExternalStore(store.subscribe, () => selector(store.getState()))
}

export function useRooms(): { rooms: Room[]; loaded: boolean; error: boolean } {
  const rooms = useChatState((s) => s.rooms)
  const loaded = useChatState((s) => s.roomsLoaded)
  const error = useChatState((s) => s.roomsError)
  return { rooms, loaded, error }
}

export function useThread(roomId: number): Thread {
  return useChatState((s) => s.threads[roomId] ?? EMPTY_THREAD)
}

export function useSocketStatus(): SocketStatus {
  return useChatState((s) => s.status)
}

const NO_MEMBERS: RoomMember[] = []

export function useMembers(roomId: number): RoomMember[] {
  return useChatState((s) => s.members[roomId] ?? NO_MEMBERS)
}

const NO_NAMES: string[] = []

/** Tên những người khác đang soạn tin trong phòng (còn hạn, loại chính mình). */
export function useTyping(roomId: number): string[] {
  const { store, controller } = useChatContext()
  const entries = useChatState((s) => s.typing[roomId])
  return useMemo(() => {
    void store
    if (!entries) return NO_NAMES
    const now = Date.now()
    const names = Object.entries(entries)
      .filter(([id, v]) => Number(id) !== controller.meId && v.until > now)
      .map(([, v]) => v.name)
    return names.length === 0 ? NO_NAMES : names
  }, [entries, store, controller])
}

export function useOnline(userId: number | null | undefined): boolean {
  return useChatState((s) => (userId != null ? s.online[userId] === true : false))
}
