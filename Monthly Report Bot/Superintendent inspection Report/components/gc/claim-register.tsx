"use client"

// Guarantee Claim Manager · Claim Register: every claim of the vessel with its recorded facts and the same rule results
// as the Command Centre (priority class, reasons, due, age; gc_manager/command.py). Search finds GC numbers in any
// written form (GC001, GC-001, GC 001) and words in title or equipment; the stored numbers are never changed.
// Clicking a row opens the Claim Inspector beside the list.

import { Search } from "lucide-react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { useEffect, useState } from "react"
import useSWR from "swr"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { Chips, ClaimTitle, Note } from "./assessment"
import { API, type ClaimRow, days, formatDay, getJson, query, type Vessel } from "./client"
import { useFrame } from "./gc-frame"
import { ErrorPanel, Loading, Skeleton, Value } from "./states"

const FOCUS: [string, string][] = [
  ["", "All"], ["your_turn", "Your turn"], ["waiting", "Waiting on others"], ["ready_to_close", "Ready to close"],
  ["not_set_up", "Not set up"], ["overdue", "Overdue"],
]

export function ClaimRegister() {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const { vesselParam, overview, inspect, inspecting } = useFrame()
  const search = params.get("search") ?? ""
  const status = params.get("status") ?? ""
  const focus = params.get("focus") ?? ""
  const owner = params.get("owner") ?? ""
  const sort = params.get("sort") ?? ""
  const go = (values: Record<string, string>) => router.replace(`${pathname}${query({ vessel: vesselParam, search, status, focus, owner, sort, ...values })}`)
  const [typed, setTyped] = useState(search)
  useEffect(() => setTyped(search), [search])
  useEffect(() => {
    if (typed === search) return
    const timer = setTimeout(() => router.replace(`${pathname}${query({ vessel: vesselParam, search: typed.trim(), status, focus, owner, sort })}`), 300)
    return () => clearTimeout(timer)
  }, [typed, search, status, focus, owner, sort, vesselParam, pathname, router])

  const key = `${API}/claims${query({ vessel: vesselParam, search, status, focus, owner, sort })}`
  const { data, error, isLoading } = useSWR(key, (path: string) => getJson<{ vessel: Vessel | null; claims: ClaimRow[] }>(path))
  const statuses = overview?.claims?.by_status ?? []

  return (
    <section aria-labelledby="register" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="register" className="text-lg font-semibold">Claim Register</h2>
          <p className="text-sm text-muted-foreground">Recorded facts and the shared claim rules. Where a fact is not in the claim record it says so.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative">
            <span className="sr-only">Search claims</span>
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="GC number, title or equipment" maxLength={200} className="h-10 w-72 pl-8" />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Status</span>
            <select
              value={status}
              onChange={(e) => go({ status: e.target.value })}
              className="h-10 rounded-lg border bg-background px-2 text-sm"
            >
              <option value="">All</option>
              {statuses.map((s) => <option key={s.status} value={s.status}>{s.label}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Order</span>
            <select value={sort || "gc"} onChange={(e) => go({ sort: e.target.value === "gc" ? "" : e.target.value })} className="h-10 rounded-lg border bg-background px-2 text-sm">
              <option value="gc">GC number</option>
              <option value="priority">Priority</option>
            </select>
          </label>
        </div>
      </div>

      <div role="group" aria-label="Show" className="flex flex-wrap gap-2">
        {FOCUS.map(([value, label]) => (
          <button key={value || "all"} type="button" aria-pressed={focus === value} onClick={() => go({ focus: value })}
            className={cn("inline-flex h-10 items-center rounded-lg border px-3.5 text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50", focus === value && "bg-secondary font-semibold")}>
            {label}
          </button>
        ))}
        {owner && (
          <button type="button" onClick={() => go({ owner: "" })} className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-dashed px-3.5 text-sm hover:bg-muted">
            Owner: {owner} <span aria-hidden>×</span><span className="sr-only">(remove this filter)</span>
          </button>
        )}
      </div>

      {error && <ErrorPanel error={error} what="the claims" />}
      {!error && (isLoading || !data) && (
        <Loading label="Loading claims">
          <div className="flex flex-col gap-2">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-12" />)}</div>
        </Loading>
      )}
      {data && data.claims.length === 0 && (
        <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
          {search || status || focus || owner ? "No claim matches this view." : "No claims are registered for this vessel."}
        </p>
      )}
      {data && data.claims.length > 0 && (
        <div className="overflow-x-auto rounded-2xl border bg-card">
          <table className="w-full min-w-[1040px] text-sm">
            <caption className="sr-only">Guarantee claims of {data.vessel?.name}</caption>
            <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="px-4 py-2.5 font-medium">GC</th>
                <th scope="col" className="px-3 py-2.5 font-medium">Claim</th>
                <th scope="col" className="px-3 py-2.5 font-medium">Status</th>
                <th scope="col" className="px-3 py-2.5 font-medium">Stage</th>
                <th scope="col" className="px-3 py-2.5 font-medium">With</th>
                <th scope="col" className="px-3 py-2.5 font-medium">Since</th>
                <th scope="col" className="px-3 py-2.5 font-medium">Due</th>
                <th scope="col" className="px-4 py-2.5 text-right font-medium">Emails</th>
              </tr>
            </thead>
            <tbody>
              {data.claims.map((c) => {
                const a = c.assessment
                const open = (row: HTMLElement) => inspect(c.id, row)
                return (
                  <tr
                    key={c.id}
                    tabIndex={0}
                    onClick={(e) => open(e.currentTarget)}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(e.currentTarget) } }}
                    aria-label={`${c.gc_number}${c.title ? `, ${c.title}` : ""}: open in the Claim Inspector`}
                    aria-current={inspecting === c.id ? "true" : undefined}
                    className={cn("cursor-pointer border-b last:border-0 hover:bg-muted/50 focus-visible:bg-muted/60 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset", inspecting === c.id && "bg-muted/60")}
                  >
                    <td className="px-4 py-3 font-semibold whitespace-nowrap tabular-nums">{c.gc_number}</td>
                    <td className="px-3 py-3">
                      <span className="block font-medium"><ClaimTitle title={c.title} assessment={a} /></span>
                      {c.equipment_system && <span className="block text-xs text-muted-foreground">{c.equipment_system}</span>}
                    </td>
                    <td className="max-w-72 px-3 py-3">
                      {a && (
                        <span className="flex flex-col gap-1">
                          <span className="text-xs font-semibold">{a.group === "NOT_SET_UP" ? "Not set up" : a.group === "YOUR_TURN" ? "Your turn" : a.group === "READY_TO_CLOSE" ? "Ready to close" : a.group === "WAITING" ? "Waiting on others" : "Closed"}</span>
                          <Chips chips={a.chips} />
                          <Note text={a.note} />
                        </span>
                      )}
                    </td>
                    <td className={cn("px-3 py-3", !c.open && "text-muted-foreground")}>{c.status_label}</td>
                    <td className="px-3 py-3">
                      {c.owner ? <span className="font-medium">{c.owner}</span> : <span className="text-muted-foreground italic">Not set{a?.suggested.owner && <span className="block text-xs not-italic">email suggests: {a.suggested.owner}</span>}</span>}
                      {c.responsible_party && <span className="block text-xs text-muted-foreground">{c.responsible_party}</span>}
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap">{a?.pending_since ? <>{formatDay(a.pending_since)}<span className="block text-xs text-muted-foreground">{days(a.age_days)}</span></> : <span className="text-muted-foreground italic">Not set</span>}</td>
                    <td className="px-3 py-3 whitespace-nowrap">
                      {a?.due ? (
                        <>
                          {formatDay(a.due.date)}
                          {a.due_state === "OVERDUE" && <span className="block text-xs font-semibold text-destructive">Overdue {days(a.overdue_days)}</span>}
                          {a.due_state === "DUE_TODAY" && <span className="block text-xs font-semibold">Due today</span>}
                        </>
                      ) : <Value value={null} />}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{c.emails}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {data && data.claims.length > 0 && (
        <p className="text-xs text-muted-foreground">{data.claims.length} {data.claims.length === 1 ? "claim" : "claims"}. Pending age counts from the confirmed pending-since date, never from email dates.</p>
      )}
    </section>
  )
}
