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
