"use client"

// Guarantee Claim Manager · forms that change a claim (Phase 4). Each one sends the change to /api/gc, where the Python
// claim rules decide (allowed status steps, required reasons and dates) and record history and audit under the
// signed-in person. Each form sends the claim's "last updated" time as it was loaded: if someone (or the desktop
// window) saved in between, nothing is overwritten and the form says so.

import { CircleAlert, CircleCheck, RotateCw } from "lucide-react"
import { type FormEvent, type ReactNode, useEffect, useState } from "react"
import useSWR from "swr"
import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { API, type ClaimDetail, formatDay, getJson, openStatuses, RequestFailed, send, type Vocabulary } from "./client"

export function useVocabulary() {
  return useSWR(`${API}/vocabulary`, (path: string) => getJson<Vocabulary>(path), { revalidateOnFocus: false }).data
}

export const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

export const inputStyle = "h-10 w-full rounded-lg border bg-background px-2.5 text-sm focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"

export function Field({ label, hint, children, wide }: { label: string; hint?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <label className={cn("flex flex-col gap-1 text-sm", wide && "sm:col-span-2")}>
      <span className="font-medium">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </label>
  )
}

/** Saving, saved, refused, or changed elsewhere (with a reload). */
export function useSave(onSaved: (detail: ClaimDetail) => void) {
  const [state, setState] = useState<{ busy: boolean; error: RequestFailed | null; saved: string | null }>({ busy: false, error: null, saved: null })
  const run = async (what: string, action: () => Promise<ClaimDetail>) => {
    setState({ busy: true, error: null, saved: null })
    try {
      const detail = await action()
      setState({ busy: false, error: null, saved: what })
      onSaved(detail)
    } catch (error) {
      setState({ busy: false, error: error instanceof RequestFailed ? error : new RequestFailed(-1, String(error)), saved: null })
    }
  }
  return { ...state, run, clear: () => setState({ busy: false, error: null, saved: null }) }
}

export function SaveMessage({ error, saved, onReload }: { error: RequestFailed | null; saved: string | null; onReload?: () => void }) {
  if (saved) return <p role="status" className="flex items-center gap-1.5 text-sm text-success"><CircleCheck className="size-4" aria-hidden /> {saved}</p>
  if (!error) return null
  return (
    <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm">
      <CircleAlert className="size-4 shrink-0 text-destructive" aria-hidden />
      <span className="flex-1">{error.status === 409 ? "Not saved. " : "Not saved: "}{error.message}</span>
      {error.status === 409 && onReload && (
        <button type="button" onClick={onReload} className={cn(buttonVariants({ variant: "outline", size: "sm" }), "h-9")}><RotateCw aria-hidden /> Reload the claim</button>
      )}
    </div>
  )
}

function Submit({ busy, children, variant }: { busy: boolean; children: ReactNode; variant?: "outline" | "destructive" }) {
  return (
    <button type="submit" disabled={busy} className={cn(buttonVariants({ size: "lg", variant }), "h-10 px-4")}>
      {busy ? "Saving…" : children}
    </button>
  )
}

const base = (detail: ClaimDetail) => `${API}/claims/${detail.claim.id}`

// ---- edit record ----------------------------------------------------------------------------------------------------

const TEXT_FIELDS: [string, string, boolean?][] = [
  ["title", "Title"], ["equipment_system", "Equipment / system"], ["responsible_party_name", "Responsible party (company or person)"],
  ["next_action", "Next required action", true], ["defect_description", "Defect", true], ["notes", "Notes", true],
]
const DATE_FIELDS: [string, string, string?][] = [
  ["action_since", "Pending since", "The date the action became pending with this owner. Changing the owner without a date starts it today."],
  ["next_follow_up_date", "Follow-up due date", "Overrides the default follow-up threshold."],
  ["promised_dispatch_date", "Promised dispatch"], ["expected_delivery_date", "Expected delivery"], ["service_attendance_date", "Service attendance"],
  ["rectification_date", "Rectification"], ["date_reported", "Reported"], ["date_submitted", "Submitted"],
]

type Values = Record<string, string>

function recordValues(detail: ClaimDetail): Values {
  const c = detail.claim as unknown as Record<string, string | null>
  const values: Values = {}
  for (const [key] of [...TEXT_FIELDS, ...DATE_FIELDS]) values[key] = c[key === "responsible_party_name" ? "responsible_party" : key] ?? ""
  values.waiting_on = detail.claim.waiting_on
  values.priority = detail.claim.priority
  return values
}

export function EditRecordForm({ detail, onSaved, onReload }: { detail: ClaimDetail; onSaved: (d: ClaimDetail) => void; onReload: () => void }) {
  const vocab = useVocabulary()
  const initial = recordValues(detail)
  const [values, setValues] = useState<Values>(initial)
  // After a save (or a reload) the form shows the record as it now is.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the saved record changes, not on every refetch
  useEffect(() => setValues(recordValues(detail)), [detail.claim.updated_at])
  const [reason, setReason] = useState("")
  const save = useSave(onSaved)
  const set = (key: string) => (e: { target: { value: string } }) => setValues({ ...values, [key]: e.target.value })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const fields: Record<string, string | null> = {}
    for (const key of Object.keys(values)) if (values[key] !== initial[key]) fields[key] = values[key] === "" ? null : values[key]
    if (Object.keys(fields).length === 0) return save.clear()
    // A new owner without a changed pending-since date: the claim rule starts the action period today.
    save.run("Saved. History and audit recorded.", () =>
      send<ClaimDetail>(base(detail), "PATCH", { fields, reason, expected_updated_at: detail.claim.updated_at }))
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Action owner (verified)" hint="Who must act now.">
          <select value={values.waiting_on} onChange={set("waiting_on")} className={inputStyle}>
            {(vocab?.waiting_on ?? [detail.claim.waiting_on]).map((w) => <option key={w} value={w}>{vocab?.owner_labels[w] ?? w}</option>)}
          </select>
        </Field>
        <Field label="Priority">
          <select value={values.priority} onChange={set("priority")} className={inputStyle}>
            {["LOW", "NORMAL", "HIGH", "URGENT"].map((p) => <option key={p} value={p}>{p[0] + p.slice(1).toLowerCase()}</option>)}
          </select>
        </Field>
        {TEXT_FIELDS.map(([key, label, long]) => (
          <Field key={key} label={label} wide={long}>
            {long ? <textarea value={values[key]} onChange={set(key)} rows={3} maxLength={2000} className={cn(inputStyle, "h-auto py-2")} />
              : <input value={values[key]} onChange={set(key)} maxLength={2000} className={inputStyle} />}
          </Field>
        ))}
        {DATE_FIELDS.map(([key, label, hint]) => (
          <Field key={key} label={label} hint={hint}>
            <input type="date" value={values[key]} onChange={set(key)} className={inputStyle} />
          </Field>
        ))}
        <Field label="Reason for the change (optional)" wide><input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} className={inputStyle} /></Field>
      </div>
      <SaveMessage error={save.error} saved={save.saved} onReload={onReload} />
      <div><Submit busy={save.busy}>Save record</Submit></div>
    </form>
  )
}

// ---- status, close, reopen, snooze ----------------------------------------------------------------------------------

export function StatusForm({ detail, onSaved, onReload }: { detail: ClaimDetail; onSaved: (d: ClaimDetail) => void; onReload: () => void }) {
  const vocab = useVocabulary()
  const current = detail.claim.status
  const allowed = vocab?.transitions[current]?.filter((s) => s !== "CLOSED") ?? []
  const [status, setStatus] = useState("")
  const [override, setOverride] = useState(false)
  const [reason, setReason] = useState("")
  const save = useSave((d) => { setStatus(""); setReason(""); setOverride(false); onSaved(d) })
  const choices = override ? (vocab ? openStatuses(vocab) : []).filter((s) => s !== current) : allowed
  return (
    <form className="flex flex-col gap-3" onSubmit={(e) => {
      e.preventDefault()
      save.run("Status changed. History and audit recorded.", () =>
        send<ClaimDetail>(`${base(detail)}/status`, "POST", { status, reason, override, expected_updated_at: detail.claim.updated_at }))
    }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="New status" hint={`Now: ${detail.claim.status_label}. A new stage starts a new action period (pending since today).`}>
          <select required value={status} onChange={(e) => setStatus(e.target.value)} className={inputStyle}>
            <option value="">Choose…</option>
            {choices.map((s) => <option key={s} value={s}>{vocab?.labels[s] ?? s}</option>)}
          </select>
        </Field>
        <Field label={override ? "Reason (required for a step outside the normal order)" : "Reason"}>
          <input value={reason} onChange={(e) => setReason(e.target.value)} required={override} maxLength={2000} className={inputStyle} />
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={override} onChange={(e) => { setOverride(e.target.checked); setStatus("") }} className="size-4" />
        Allow a step outside the normal order (recorded as a manual override)
      </label>
      <SaveMessage error={save.error} saved={save.saved} onReload={onReload} />
      <div><Submit busy={save.busy}>Change status</Submit></div>
    </form>
  )
}

export function CloseForm({ detail, onSaved, onReload, initialDate, initialReason }: {
  detail: ClaimDetail | { claim: { id: number; updated_at: string } }; onSaved: (d: ClaimDetail) => void; onReload: () => void; initialDate?: string; initialReason?: string
}) {
  const [date, setDate] = useState(initialDate ?? today())
  const [reason, setReason] = useState(initialReason ?? "")
  const save = useSave(onSaved)
  return (
    <form className="flex flex-col gap-3" onSubmit={(e) => {
      e.preventDefault()
      save.run("Claim closed. History and audit recorded.", () =>
        send<ClaimDetail>(`${API}/claims/${detail.claim.id}/close`, "POST", { closure_date: date, reason, expected_updated_at: detail.claim.updated_at }))
    }}>
      <div className="grid gap-3 sm:grid-cols-[12rem_minmax(0,1fr)]">
        <Field label="Closure date"><input type="date" required value={date} max={today()} onChange={(e) => setDate(e.target.value)} className={inputStyle} /></Field>
        <Field label="Closure reason (what verified it)"><input required value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} className={inputStyle} /></Field>
      </div>
      <SaveMessage error={save.error} saved={save.saved} onReload={onReload} />
      <div><Submit busy={save.busy} variant="destructive">Close claim</Submit></div>
    </form>
  )
}

export function ReopenForm({ detail, onSaved, onReload }: { detail: ClaimDetail; onSaved: (d: ClaimDetail) => void; onReload: () => void }) {
  const vocab = useVocabulary()
  const [status, setStatus] = useState("RECTIFICATION_IN_PROGRESS")
  const [reason, setReason] = useState("")
  const save = useSave(onSaved)
  return (
    <form className="flex flex-col gap-3" onSubmit={(e) => {
      e.preventDefault()
      save.run("Claim reopened. History and audit recorded.", () =>
        send<ClaimDetail>(`${base(detail)}/reopen`, "POST", { status, reason, expected_updated_at: detail.claim.updated_at }))
    }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Reopen into">
          <select value={status} onChange={(e) => setStatus(e.target.value)} className={inputStyle}>
            {(vocab ? openStatuses(vocab).filter((s) => s !== "CANCELLED") : [status]).map((s) => <option key={s} value={s}>{vocab?.labels[s] ?? s}</option>)}
          </select>
        </Field>
        <Field label="Reason for reopening"><input required value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} className={inputStyle} /></Field>
      </div>
      <SaveMessage error={save.error} saved={save.saved} onReload={onReload} />
      <div><Submit busy={save.busy}>Reopen claim</Submit></div>
    </form>
  )
}

export function SnoozeForm({ detail, onSaved }: { detail: ClaimDetail; onSaved: (d: ClaimDetail) => void }) {
  const snoozed = detail.claim.assessment?.snoozed_until
  const [until, setUntil] = useState("")
  const [reason, setReason] = useState("")
  const save = useSave(onSaved)
  if (snoozed) {
    return (
      <div className="flex flex-col gap-3 text-sm">
        <p>Snoozed until <b>{formatDay(snoozed)}</b>. It still counts as overdue where it is overdue, and stays in every total.</p>
        <SaveMessage error={save.error} saved={save.saved} />
        <div>
          <button type="button" disabled={save.busy} onClick={() => save.run("Snooze ended.", () => send<ClaimDetail>(`${base(detail)}/snooze`, "DELETE"))}
            className={cn(buttonVariants({ variant: "outline", size: "lg" }), "h-10 px-4")}>{save.busy ? "Saving…" : "End snooze now"}</button>
        </div>
      </div>
    )
  }
  return (
    <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); save.run("Snoozed.", () => send<ClaimDetail>(`${base(detail)}/snooze`, "POST", { until, reason })) }}>
      <p className="text-sm text-muted-foreground">Snooze only keeps the claim out of the Next Best Action until the date. Due dates, age, overdue days and totals do not change.</p>
      <div className="grid gap-3 sm:grid-cols-[12rem_minmax(0,1fr)]">
        <Field label="Snooze until"><input type="date" required value={until} min={today()} onChange={(e) => setUntil(e.target.value)} className={inputStyle} /></Field>
        <Field label="Reason"><input required value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} className={inputStyle} /></Field>
      </div>
      <SaveMessage error={save.error} saved={save.saved} />
      <div><Submit busy={save.busy} variant="outline">Snooze</Submit></div>
    </form>
  )
}

/** The claim page's change panel: one form open at a time. */
export function ClaimActions({ detail, onSaved, onReload }: { detail: ClaimDetail; onSaved: (d: ClaimDetail) => void; onReload: () => void }) {
  const closed = !detail.claim.open
  const tabs = closed ? (["Reopen"] as const) : (["Edit record", "Change status", "Snooze", "Close"] as const)
  const [open, setOpen] = useState<string | null>(null)
  return (
    <section className="rounded-2xl border bg-card p-5">
      <p className="text-[11px] font-bold tracking-wider text-muted-foreground">CHANGE THIS CLAIM</p>
      <p className="mt-1 text-sm text-muted-foreground">Saved through the claim rules, with history and audit under your name.</p>
      <div role="group" aria-label="Change this claim" className="mt-3 flex flex-wrap gap-2">
        {tabs.map((t) => (
          <button key={t} type="button" aria-expanded={open === t} onClick={() => setOpen(open === t ? null : t)}
            className={cn(buttonVariants({ variant: open === t ? "default" : "outline", size: "lg" }), "h-10 px-4")}>{t}</button>
        ))}
      </div>
      {open && (
        <div className="mt-4 border-t pt-4">
          {open === "Edit record" && <EditRecordForm detail={detail} onSaved={onSaved} onReload={onReload} />}
          {open === "Change status" && <StatusForm detail={detail} onSaved={onSaved} onReload={onReload} />}
          {open === "Snooze" && <SnoozeForm key={detail.claim.assessment?.snoozed_until ?? "none"} detail={detail} onSaved={onSaved} />}
          {open === "Close" && <CloseForm detail={detail} onSaved={onSaved} onReload={onReload} />}
          {open === "Reopen" && <ReopenForm detail={detail} onSaved={onSaved} onReload={onReload} />}
        </div>
      )}
    </section>
  )
}
