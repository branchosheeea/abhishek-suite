"use client"

// Guarantee Claim Manager · Review Queue (read-only for now): emails NeraVeda could not link to a claim by itself.
// Each one is resolved by a person in GC Manager; nothing is linked or registered from here yet.

import { ArrowDownLeft, ArrowUpRight, Info } from "lucide-react"
import useSWR from "swr"
import { API, formatStamp, getJson, query, REVIEW_LABEL, type ReviewItem, type Vessel } from "./client"
import { useFrame } from "./gc-frame"
import { ErrorPanel, Loading, Skeleton } from "./states"

export function ReviewQueue() {
  const { vesselParam } = useFrame()
  const { data, error, isLoading } = useSWR(`${API}/reviews${query({ vessel: vesselParam })}`, (path: string) => getJson<{ vessel: Vessel | null; items: ReviewItem[] }>(path))
  const groups = new Map<string, ReviewItem[]>()
  for (const item of data?.items ?? []) {
    groups.set(item.type, [...(groups.get(item.type) ?? []), item]) // the same groups and counts as the Command Centre
  }

  return (
    <section aria-labelledby="reviews" className="flex flex-col gap-4">
      <div>
        <h2 id="reviews" className="text-lg font-semibold">Review Queue</h2>
        <p className="text-sm text-muted-foreground">Emails that need a person to decide which claim they belong to.</p>
      </div>
      <p className="flex items-start gap-2 rounded-xl border bg-muted/40 p-3 text-sm">
        <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        Read-only here. Link, register or dismiss these in GC Manager (desktop), Review Queue tab.
      </p>
      {error && <ErrorPanel error={error} what="the Review Queue" />}
      {!error && (isLoading || !data) && (
        <Loading label="Loading the Review Queue">
          <div className="flex flex-col gap-2">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-16" />)}</div>
        </Loading>
      )}
      {data && data.items.length === 0 && <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">No email waits for review.</p>}
      {[...groups.entries()].map(([type, items]) => (
        <section key={type} aria-label={REVIEW_LABEL[type] ?? type} className="rounded-2xl border bg-card p-5">
          <h3 className="flex items-baseline justify-between gap-3 text-base font-semibold">
            {REVIEW_LABEL[type] ?? type}
            <span className="text-sm font-normal text-muted-foreground tabular-nums">{items.length}</span>
          </h3>
          <ol className="mt-3 flex flex-col divide-y">
            {items.map((item) => {
              const Arrow = item.direction === "OUTGOING" ? ArrowUpRight : ArrowDownLeft
              return (
                <li key={item.id} className="flex gap-3 py-3 first:pt-0 last:pb-0">
                  <Arrow className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label={item.direction === "OUTGOING" ? "Sent" : "Received"} />
                  <div className="min-w-0 flex-1 text-sm">
                    <p className="flex flex-wrap items-baseline justify-between gap-x-3">
                      <span className="font-medium">{item.subject}</span>
                      <span className="text-xs whitespace-nowrap text-muted-foreground">{item.message_datetime ? formatStamp(item.message_datetime) : "No date"}</span>
                    </p>
                    <p className="text-muted-foreground">{item.reason}</p>
                  </div>
                </li>
              )
            })}
          </ol>
        </section>
      ))}
    </section>
  )
}
