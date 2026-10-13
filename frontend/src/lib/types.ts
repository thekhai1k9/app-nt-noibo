export type Role = 'admin' | 'member'

export interface User {
  id: number
  username: string
  full_name: string
  branch_id: number
  role: Role
  is_active: boolean
  must_change_password: boolean
  last_login_at: string | null
}

export interface Branch {
  id: number
  name: string
  code: string
  address: string
  user_count: number
}

export interface TokenOut {
  access_token: string
  token_type: 'bearer'
  must_change_password: boolean
}

export interface UserCreated extends User {
  temp_password: string
}

export interface ResetPasswordOut {
  temp_password: string
}

export interface Reply {
  id: number
  sender_id: number
  sender_name: string
  /** Rỗng khi tin gốc đã xoá (deleted=true) hoặc chỉ gồm ký tự vô hình (deleted=false). */
  snippet: string
  deleted: boolean
}

export interface Mention {
  user_id: number
  full_name: string
}

export interface Message {
  id: number
  room_id: number
  sender_id: number
  sender_name: string
  body: string
  kind: string
  client_id: string | null
  created_at: string
  edited_at: string | null
  deleted: boolean
  reply_to: Reply | null
  mentions: Mention[]
  mention_all: boolean
}

export interface Room {
  id: number
  type: 'direct' | 'group'
  name: string | null
  branch_id: number | null
  member_count: number
  peer_id: number | null
  last_message: Message | null
  unread_count: number
  unread_mentions: number
  last_activity: string
  my_role: 'owner' | 'member' | null
}

export interface RoomMember {
  user_id: number
  full_name: string
  last_read_message_id: number | null
  role: 'owner' | 'member'
}

export interface MessagePage {
  items: Message[]
  has_more_before: boolean
  has_more_after: boolean
}

export interface DirectoryUser {
  id: number
  username: string
  full_name: string
  branch_id: number
  branch_name: string
}

export interface AdminRoom {
  id: number
  name: string
  branch_id: number | null
  member_count: number
  created_at: string
  archived_at: string | null
  purge_at: string | null
}

export interface AdminRoomMember {
  user_id: number
  full_name: string
  username: string
  branch_id: number
}

export interface AdminRoomDetail extends AdminRoom {
  members: AdminRoomMember[]
}

export type ServerEvent =
  | { type: 'ready'; user_id: number }
  | { type: 'message' | 'message_updated'; message: Message }
  | { type: 'message_deleted'; room_id: number; message_id: number }
  | { type: 'rooms_changed' }
  | { type: 'resync' }
  | { type: 'pong' }
  | { type: 'typing'; room_id: number; user_id: number; user_name: string }
  | { type: 'read'; room_id: number; user_id: number; message_id: number }
  | { type: 'presence'; user_id: number; online: boolean }
  | { type: 'error'; code: string; client_id: string | null }
