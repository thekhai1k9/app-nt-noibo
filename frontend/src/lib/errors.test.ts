import { ApiError } from './api'
import { errorMessage } from './errors'

it('maps known codes to Vietnamese', () => {
  expect(errorMessage(new ApiError(401, 'invalid_credentials'))).toBe('Sai tên đăng nhập hoặc mật khẩu.')
  expect(errorMessage(new ApiError(409, 'branch_has_users'))).toContain('Chi nhánh còn người dùng')
})

it('falls back for unknown codes and non-ApiError values', () => {
  expect(errorMessage(new ApiError(500, 'something_new'))).toBe('Có lỗi xảy ra. Vui lòng thử lại.')
  expect(errorMessage(new Error('boom'))).toBe('Có lỗi xảy ra. Vui lòng thử lại.')
  expect(errorMessage(null)).toBe('Có lỗi xảy ra. Vui lòng thử lại.')
})

it('has a message for a network failure', () => {
  expect(errorMessage(new ApiError(0, 'network_error'))).toBe('Không kết nối được máy chủ.')
})
