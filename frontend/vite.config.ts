/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Khai báo ra biến trước để khóa `test` không bị kiểm tra thuộc tính thừa (vitest kèm bản vite riêng).
const config = {
  plugins: [react()],
  server: {
    // Khi chạy `npm run dev`, API đi qua Caddy của docker compose ở cổng 80.
    proxy: { '/api': { target: 'http://localhost:80', ws: true } },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    // Node 25 có localStorage thử nghiệm che mất bản của jsdom; tắt để dùng localStorage của jsdom.
    poolOptions: { forks: { execArgv: ['--no-experimental-webstorage'] } },
  },
}

export default defineConfig(config)
