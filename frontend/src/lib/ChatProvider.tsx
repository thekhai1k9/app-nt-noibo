import { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore, type MutableRefObject, type ReactNode } from 'react'
import { useInRouterContext, useNavigate } from 'react-router-dom'
import { getAccessToken, handleAuthLost, refreshSession } from './api'
import { useAuth } from './auth'
import { chatApi } from './chatApi'
import { ChatController, type IncomingEvent } from './chatController'
import { ChatStore, EMPTY_THREAD, type ChatState, type Thread } from './chatStore'
import {
  armAudioUnlock,
  closeAllNotifications,
  setNotifyUser,
  liveNow,
  loadSettings,
  notificationSupport,
  notificationBody,
  playBeep,
  restoreTitle,
  shouldNotify,
  showNotification,
  unreadTotal,
  updateTitle,
} from './notifications'
import type { Room, RoomMember } from './types'
import { ChatSocket, type SocketStatus } from './ws'

export interface ChatContextValue {
  store: ChatStore
  controller: ChatController
}

const noopSubscribe = () => () => undefined

export const ChatContext = createContext<ChatContextValue | null>(null)

function build(userId: number, userName: string, onIncoming: (event: IncomingEvent) => void): { socket: ChatSocket } & ChatContextValue {
  const store = new ChatStore()
  const socket = new ChatSocket({ getToken: getAccessToken, refresh: refreshSession, onAuthLost: handleAuthLost })
  const controller = new ChatController({ store, api: chatApi, socket, meId: userId, meName: userName, onIncoming })
  socket.onStatus((status) => store.setStatus(status))
  socket.onEvent((event) => controller.handleSocketEvent(event))
  return { store, controller, socket }
}

/** Cầu nối: lấy `navigate` của router (nếu có) để bấm thông báo mở đúng phòng. */
function NavigateBridge({ target }: { target: MutableRefObject<((path: string) => void) | null> }) {
  const navigate = useNavigate()
  useEffect(() => {
    target.current = (path) => navigate(path)
    return () => {
      target.current = null
    }
  }, [navigate, target])
  return null
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
  const navigateRef = useRef<((path: string) => void) | null>(null)
  const inRouter = useInRouterContext()
  const instance = useMemo(
    () =>
      userId !== undefined
        ? build(userId, userName, (event) => {
            const settings = loadSettings()
            const visible = document.visibilityState === 'visible'
            // Chính sách tính như đã bật: âm báo và số chưa đọc vẫn hoạt động khi thông báo trình duyệt không dùng được.
            const result = shouldNotify({
              message: event.message,
              room: event.room,
              meId: userId,
              settings: { ...settings, enabled: true },
              windowVisible: visible,
              windowFocused: visible && (typeof document.hasFocus === 'function' ? document.hasFocus() : true),
              activeRoomId: event.activeRoomId,
              now: liveNow(event.message.created_at),
            })
            if (!result.notify) return
            const roomId = event.room.id
            if (settings.enabled && notificationSupport() === 'granted') {
              showNotification({
                title: event.room.name ?? event.message.sender_name,
                body: notificationBody(event.message, settings.showPreview),
                tag: `kn-room-${roomId}`,
                onClick: () => navigateRef.current?.(`/chat/${roomId}`),
              })
            }
            if (settings.sound) playBeep()
          })
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [userId],
  )

  const unread = useSyncExternalStore(
    instance ? instance.store.subscribe : noopSubscribe,
    () => (instance ? unreadTotal(instance.store.getState().rooms) : 0),
  )
  useEffect(() => {
    if (!instance) return
    updateTitle(unread)
  }, [instance, unread])
  useEffect(() => restoreTitle, [])
  useEffect(() => armAudioUnlock(), [])
  useEffect(() => {
    setNotifyUser(userId ?? null)
    return () => {
      closeAllNotifications()
      setNotifyUser(null)
    }
  }, [userId])

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
  return (
    <ChatContext.Provider value={{ store: instance.store, controller: instance.controller }}>
      {inRouter && <NavigateBridge target={navigateRef} />}
      {children}
    </ChatContext.Provider>
  )
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

/** Tên những người khác đang soạn tin trong phòng; hết hạn do hẹn giờ của controller xoá khỏi store. */
export function useTyping(roomId: number): string[] {
  const { controller } = useChatContext()
  const entries = useChatState((s) => s.typing[roomId])
  return useMemo(() => {
    if (!entries) return NO_NAMES
    const names = Object.entries(entries)
      .filter(([id]) => Number(id) !== controller.meId)
      .map(([, v]) => v.name)
    return names.length === 0 ? NO_NAMES : names
  }, [entries, controller])
}

export function useOnline(userId: number | null | undefined): boolean {
  return useChatState((s) => (userId != null ? s.online[userId] === true : false))
}
