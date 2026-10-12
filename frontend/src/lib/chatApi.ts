import { api } from './api'
import type { DirectoryUser, Message, MessagePage, Room } from './types'

export interface MessageQuery {
  before?: number
  after?: number
  around?: number
  limit?: number
}

function query(params: MessageQuery): string {
  const search = new URLSearchParams()
  if (params.before !== undefined) search.set('before', String(params.before))
  if (params.after !== undefined) search.set('after', String(params.after))
  if (params.around !== undefined) search.set('around', String(params.around))
  if (params.limit !== undefined) search.set('limit', String(params.limit))
  const text = search.toString()
  return text ? `?${text}` : ''
}

export const chatApi = {
  rooms: () => api<Room[]>('/rooms'),
  messages: (roomId: number, params: MessageQuery) => api<MessagePage>(`/rooms/${roomId}/messages${query(params)}`),
  markRead: (roomId: number, messageId: number) =>
    api(`/rooms/${roomId}/read`, { method: 'POST', json: { message_id: messageId } }),
  openDirect: (userId: number) => api<Room>('/rooms/direct', { method: 'POST', json: { user_id: userId } }),
  editMessage: (messageId: number, body: string) =>
    api<Message>(`/messages/${messageId}`, { method: 'PATCH', json: { body } }),
  deleteMessage: (messageId: number) => api(`/messages/${messageId}`, { method: 'DELETE' }),
  directory: (q: string) => api<DirectoryUser[]>(`/users/directory${q ? `?q=${encodeURIComponent(q)}` : ''}`),
}

export type ChatApi = typeof chatApi
