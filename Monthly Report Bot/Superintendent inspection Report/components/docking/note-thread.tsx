"use client"

import { useState, type FormEvent } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { API, formatStamp, KIND_LABEL, type Note, send, usePeople, who } from "./client"

const KINDS: Note["kind"][] = ["comment", "query", "correction"]

/** Superintendent notes on one item. Notes are never edited or deleted: "Replace" adds a new note that supersedes it. */
export function NoteThread({ dockingId, entity, entityId, notes, onSaved }: {
  dockingId: string; entity: "day" | "job" | "activity"; entityId: string; notes: Note[]; onSaved: () => Promise<unknown>
}) {
  const [body, setBody] = useState("")
  const [kind, setKind] = useState<Note["kind"]>("comment")
  const [replacing, setReplacing] = useState<Note | null>(null)
  const [busy, setBusy] = useState(false)
  const people = usePeople()

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!body.trim()) return
    setBusy(true)
    try {
      await send(`${API}/${dockingId}/notes`, "POST", { entity, entityId, kind, body, supersedesId: replacing?.id })
      setBody("")
      setReplacing(null)
      await onSaved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The note could not be saved.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {notes.length > 0 && (
        <ul className="flex flex-col gap-2">
          {notes.map((n) => (
            <li key={n.id} className={cn("rounded-lg border bg-background p-3 text-sm", n.replaced && "opacity-60")}>
              <div className="mb-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                <span className={cn("font-semibold", n.kind === "query" && "text-amber-700 dark:text-amber-400", n.kind === "correction" && "text-primary")}>{KIND_LABEL[n.kind]}</span>
                <span>{who(people, n.author)}</span>
                <span>{formatStamp(n.created_at)}</span>
                {n.replaced && <span className="font-semibold">replaced by a later note</span>}
                {n.supersedes_id && <span>replaces an earlier note</span>}
                {!n.replaced && (
                  <button type="button" className="ml-auto text-primary underline-offset-2 hover:underline" onClick={() => { setReplacing(n); setKind(n.kind); setBody(n.body) }}>
                    Replace
                  </button>
                )}
              </div>
              <p className={cn("whitespace-pre-wrap", n.replaced && "line-through")}>{n.body}</p>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={save} className="flex flex-col gap-2">
        {replacing && (
          <p className="text-xs text-muted-foreground">
            Replacing the note of {formatStamp(replacing.created_at)}. The earlier note stays on record.{" "}
            <button type="button" className="text-primary underline-offset-2 hover:underline" onClick={() => { setReplacing(null); setBody("") }}>Cancel</button>
          </p>
        )}
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Note type">
          {KINDS.map((k) => (
            <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)}
              className={cn("rounded-full border px-2.5 py-0.5 text-xs", kind === k ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted")}>
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
        <Textarea value={body} onChange={(e) => setBody(e.target.value)} maxLength={4000} rows={2} placeholder="Add a note (the vessel's own records are not changed)" aria-label="Note" />
        <div>
          <Button type="submit" size="sm" disabled={busy || !body.trim()}>{busy ? "Saving…" : replacing ? "Save replacement" : "Add note"}</Button>
        </div>
      </form>
    </div>
  )
}
