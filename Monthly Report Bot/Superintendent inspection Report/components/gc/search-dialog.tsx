"use client"

// Guarantee Claim Manager · global search (Ctrl+K). Searches only what NeraVeda holds: claims (GC number in any written
// form, title, equipment) and stored correspondence (subject, sender, kept email text; the text itself is never sent
// to the page). A real modal (native <dialog>): the page behind is inert, Esc closes, focus returns to where it was.

import { ArrowDownLeft, ArrowUpRight, Search, Wrench } from "lucide-react"
import Link from "next/link"
import { type ReactNode, useEffect, useRef, useState } from "react"
import useSWR from "swr"
import { ClassBadge } from "./assessment"
import { API, formatStamp, getJson, query, type SearchData } from "./client"
import { ErrorPanel } from "./states"

export function SearchDialog({ vesselParam, onClose, onPick }: { vesselParam: string | null; onClose: () => void; onPick: (claimId: number) => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [typed, setTyped] = useState("")
  const [text, setText] = useState("")
  useEffect(() => {
    const element = dialog.current
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null
    element?.showModal()
    return () => {
      element?.close()
      before?.focus()
    }
  }, [])
  useEffect(() => {
    const timer = setTimeout(() => setText(typed.trim()), 250)
    return () => clearTimeout(timer)
  }, [typed])
  const { data, error, isLoading } = useSWR(text ? `${API}/search${query({ vessel: vesselParam, q: text })}` : null, (path: string) => getJson<SearchData>(path))
  const nothing = data && data.claims.length === 0 && data.emails.length === 0 && data.equipment.length === 0

  return (
    <dialog
      ref={dialog}
      aria-label="Search claims and correspondence"
      onCancel={(e) => { e.preventDefault(); onClose() }}
      onClick={(e) => { if (e.target === dialog.current) onClose() }}
      className="m-auto mt-[12vh] w-[min(680px,calc(100vw-2rem))] rounded-2xl border bg-background p-0 text-foreground shadow-2xl backdrop:bg-black/40"
    >
      <div className="flex items-center gap-2 border-b px-4">
        <Search className="size-5 text-muted-foreground" aria-hidden />
        <input
          autoFocus
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          maxLength={200}
          placeholder="GC001, GC-001, title, equipment, sender or words in an email"
          aria-label="Search text"
          className="h-14 flex-1 bg-transparent text-[15px] outline-none"
        />
        <kbd className="rounded border bg-muted px-1.5 text-[11px]">Esc</kbd>
      </div>
      <div className="max-h-[60vh] overflow-y-auto p-2" aria-live="polite">
        {!text && <p className="p-4 text-sm text-muted-foreground">Type to search this vessel’s claims and stored emails. GC001, GC-001 and GC 001 find the same claim.</p>}
        {error && <div className="p-2"><ErrorPanel error={error} what="the search" /></div>}
        {text && isLoading && <p className="p-4 text-sm text-muted-foreground">Searching…</p>}
        {nothing && <p className="p-4 text-sm text-muted-foreground">Nothing found for “{text}”.</p>}
        {data && data.claims.length > 0 && (
          <Group title="Claims">
            {data.claims.map((c) => (
              <li key={c.id}>
                <button type="button" onClick={() => onPick(c.id)} className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
                  <span className="w-16 font-semibold tabular-nums">{c.gc_number}</span>
                  <span className="min-w-0 flex-1 truncate">{c.title ?? c.equipment_system ?? <span className="text-muted-foreground italic">Title not recorded</span>}</span>
                  {c.assessment && <ClassBadge assessment={c.assessment} compact />}
                  <span className="text-xs text-muted-foreground">{c.status_label}</span>
                </button>
              </li>
            ))}
          </Group>
        )}
        {data && data.equipment.length > 0 && (
          <Group title="Equipment">
            {data.equipment.map((name) => (
              <li key={name}>
                <Link href={`/claims/register${query({ vessel: vesselParam, search: name })}`} onClick={onClose} className="flex min-h-11 items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
                  <Wrench className="size-4 text-muted-foreground" aria-hidden /> {name}
                </Link>
              </li>
            ))}
          </Group>
        )}
        {data && data.emails.length > 0 && (
          <Group title={`Correspondence${data.email_total > data.emails.length ? ` (${data.emails.length} of ${data.email_total})` : ""}`}>
            {data.emails.map((e) => {
              const Arrow = e.direction === "OUTGOING" ? ArrowUpRight : ArrowDownLeft
              const body = (
                <>
                  <Arrow className="size-4 shrink-0 text-muted-foreground" aria-label={e.direction === "OUTGOING" ? "Sent" : "Received"} />
                  <span className="min-w-0 flex-1"><span className="block truncate">{e.subject}</span>
                    <span className="block text-xs text-muted-foreground">{e.claim ? `${e.claim.gc_number} · ` : "Not linked to a claim · "}{e.message_datetime ? formatStamp(e.message_datetime, true) : "No date"}</span></span>
                </>
              )
              const style = "flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              return <li key={e.id}>{e.claim ? <button type="button" onClick={() => onPick(e.claim!.id)} className={style}>{body}</button> : <div className={style}>{body}</div>}</li>
            })}
          </Group>
        )}
      </div>
    </dialog>
  )
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="py-1">
      <h3 className="px-3 py-1.5 text-[11px] font-bold tracking-wider text-muted-foreground uppercase">{title}</h3>
      <ul>{children}</ul>
    </section>
  )
}
