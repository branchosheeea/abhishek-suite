"use client"

import { Bold, Italic, List, Underline } from "lucide-react"

type EditableField = HTMLInputElement | HTMLTextAreaElement

export function FormatToolbar({
  value,
  onChange,
  inputRef,
}: {
  value: string
  onChange: (value: string) => void
  inputRef: { current: EditableField | null }
}) {
  const format = (before: string, after = before) => {
    const input = inputRef.current
    if (!input) return
    const start = input.selectionStart ?? 0
    const end = input.selectionEnd ?? start
    const selected = value.slice(start, end) || "text"
    const next = `${value.slice(0, start)}${before}${selected}${after}${value.slice(end)}`
    onChange(next)
    requestAnimationFrame(() => {
      input.focus()
      input.setSelectionRange(start + before.length, start + before.length + selected.length)
    })
  }

  const tools = [
    { label: "Bold", icon: Bold, run: () => format("**") },
    { label: "Italic", icon: Italic, run: () => format("*") },
    { label: "Underline", icon: Underline, run: () => format("__") },
    { label: "Bulleted list", icon: List, run: () => format("\n- ", "") },
  ]

  return (
    <div role="toolbar" aria-label="Text formatting" className="flex w-fit items-center gap-1 rounded-t-lg border border-b-0 bg-muted/50 p-1">
      {tools.map(({ label, icon: Icon, run }) => (
        <button
          key={label}
          type="button"
          title={label}
          aria-label={label}
          onMouseDown={(event) => event.preventDefault()}
          onClick={run}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Icon className="size-4" />
        </button>
      ))}
    </div>
  )
}
