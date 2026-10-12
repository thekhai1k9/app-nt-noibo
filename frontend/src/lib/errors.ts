import { ApiError } from './api'

const MESSAGES: Record<string, string> = {
  invalid_credentials: 'Sai tên đăng nhập hoặc mật khẩu.',
  too_many_attempts: 'Bạn nhập sai quá nhiều lần. Vui lòng thử lại sau vài phút.',
  invalid_refresh: 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.',
  not_authenticated: 'Bạn cần đăng nhập để tiếp tục.',
  password_change_required: 'Bạn cần đổi mật khẩu trước khi tiếp tục.',
  forbidden: 'Bạn không có quyền thực hiện thao tác này.',
  wrong_current_password: 'Mật khẩu hiện tại không đúng.',
  password_unchanged: 'Mật khẩu mới phải khác mật khẩu hiện tại.',
  username_taken: 'Tên đăng nhập đã tồn tại.',
  user_not_found: 'Không tìm thấy người dùng.',
  branch_not_found: 'Không tìm thấy chi nhánh.',
  branch_exists: 'Tên hoặc mã chi nhánh đã tồn tại.',
  branch_has_users: 'Chi nhánh còn người dùng. Hãy chuyển họ sang chi nhánh khác trước khi xoá.',
  cannot_modify_self: 'Bạn không thể tự hạ quyền hoặc tự khoá tài khoản của mình.',
  validation_error: 'Dữ liệu chưa hợp lệ. Hãy kiểm tra lại các trường.',
  service_unavailable: 'Máy chủ tạm thời không khả dụng. Vui lòng thử lại sau.',
  network_error: 'Không kết nối được máy chủ.',
  unknown_error: 'Có lỗi xảy ra. Vui lòng thử lại.',
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return MESSAGES[error.code] ?? MESSAGES.unknown_error
  return MESSAGES.unknown_error
}
