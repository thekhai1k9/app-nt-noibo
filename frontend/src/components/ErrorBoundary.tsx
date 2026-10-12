import { Component, type ErrorInfo, type ReactNode } from 'react'
import { FullPageMessage } from './FullPageMessage'

interface State {
  failed: boolean
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false }

  static getDerivedStateFromError(): State {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack)
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <FullPageMessage role="alert">
        <p>Có lỗi khi tải trang.</p>
        <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
          Tải lại trang
        </button>
      </FullPageMessage>
    )
  }
}
