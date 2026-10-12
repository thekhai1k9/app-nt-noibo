import { lazy, Suspense } from 'react'
import { Navigate, Outlet, Route, Routes } from 'react-router-dom'
import { ErrorBoundary } from './components/ErrorBoundary'
import { FullPageMessage } from './components/FullPageMessage'
import { RequireAdmin, RequireAuth } from './components/guards'
import { ChangePasswordPage } from './pages/ChangePasswordPage'
import { ConversationPane } from './components/chat/ConversationPane'
import { ChatHome } from './pages/ChatHome'
import { ChatLayout } from './pages/ChatLayout'
import { ChatProvider } from './lib/ChatProvider'
import { LoginPage } from './pages/LoginPage'

const AdminLayout = lazy(() => import('./pages/admin/AdminLayout').then((m) => ({ default: m.AdminLayout })))
const BranchesPage = lazy(() => import('./pages/admin/BranchesPage').then((m) => ({ default: m.BranchesPage })))
const RoomsPage = lazy(() => import('./pages/admin/RoomsPage').then((m) => ({ default: m.RoomsPage })))
const UsersPage = lazy(() => import('./pages/admin/UsersPage').then((m) => ({ default: m.UsersPage })))

export function AppRoutes() {
  return (
    <ErrorBoundary>
      <Suspense fallback={<FullPageMessage>Đang tải…</FullPageMessage>}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            element={
              <RequireAuth allowPasswordChange>
                <ChatProvider>
                  <Outlet />
                </ChatProvider>
              </RequireAuth>
            }
          >
            <Route path="/change-password" element={<ChangePasswordPage />} />
            <Route
              element={
                <RequireAuth>
                  <ChatLayout />
                </RequireAuth>
              }
            >
              <Route path="/" element={<ChatHome />} />
              <Route path="/chat/:roomId" element={<ConversationPane />} />
            </Route>
            <Route
              path="/admin"
              element={
                <RequireAuth>
                  <RequireAdmin>
                    <AdminLayout />
                  </RequireAdmin>
                </RequireAuth>
              }
            >
              <Route index element={<Navigate to="users" replace />} />
              <Route path="users" element={<UsersPage />} />
              <Route path="branches" element={<BranchesPage />} />
              <Route path="rooms" element={<RoomsPage />} />
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </ErrorBoundary>
  )
}
