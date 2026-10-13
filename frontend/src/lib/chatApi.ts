import { api } from './api'
import type { DirectoryUser, Message, MessagePage, Room, RoomMember } from './types'

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
  members: (roomId: number) => api<RoomMember[]>(`/rooms/${roomId}/members`),
  presence: () => api<{ online_user_ids: number[] }>('/presence'),
  openDirect: (userId: number) => api<Room>('/rooms/direct', { method: 'POST', json: { user_id: userId } }),
  createGroup: (name: string, memberIds: number[]) =>
    api<Room>('/rooms/group', { method: 'POST', json: { name, member_ids: memberIds } }),
  renameGroup: (roomId: number, name: string) => api<Room>(`/rooms/${roomId}`, { method: 'PATCH', json: { name } }),
  addMember: (roomId: number, userId: number) =>
    api<RoomMember[]>(`/rooms/${roomId}/members`, { method: 'POST', json: { user_id: userId } }),
  removeMember: (roomId: number, userId: number) =>
    api<RoomMember[]>(`/rooms/${roomId}/members/${userId}`, { method: 'DELETE' }),
  leaveGroup: (roomId: number) => api(`/rooms/${roomId}/leave`, { method: 'POST' }),
  dissolveGroup: (roomId: number) => api(`/rooms/${roomId}`, { method: 'DELETE' }),
  editMessage: (messageId: number, body: string) =>
    api<Message>(`/messages/${messageId}`, { method: 'PATCH', json: { body } }),
  deleteMessage: (messageId: number) => api(`/messages/${messageId}`, { method: 'DELETE' }),
  directory: (q: string) => api<DirectoryUser[]>(`/users/directory${q ? `?q=${encodeURIComponent(q)}` : ''}`),
}

export type ChatApi = typeof chatApi
