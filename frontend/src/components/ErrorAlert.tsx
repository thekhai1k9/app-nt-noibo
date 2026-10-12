import { errorMessage } from '../lib/errors'

export function ErrorAlert({ error, message }: { error?: unknown; message?: string }) {
  const text = message ?? (error ? errorMessage(error) : '')
  if (!text) return null
  return (
    <div role="alert" className="alert-error">
      {text}
    </div>
  )
}
