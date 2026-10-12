import type { InputHTMLAttributes } from 'react'

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string
  id: string
}

export function Field({ label, id, className, ...input }: FieldProps) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} className={`input${className ? ` ${className}` : ''}`} {...input} />
    </div>
  )
}
