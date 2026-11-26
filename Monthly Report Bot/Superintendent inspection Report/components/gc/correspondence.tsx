"use client"

// Guarantee Claim Manager · Correspondence: the stored claim emails of the vessel, newest first. The search also looks
// in the stored email text on this PC; only the subject and first lines are ever sent to the page.

import { Search } from "lucide-react"
import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { useEffect, useState } from "react"
import useSWRInfinite from "swr/infinite"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { API, type Email, getJson, query, type Vessel } from "./client"
import { EmailItem } from "./claim-workspace"
import { useFrame, useHref } from "./gc-frame"
import { ErrorPanel, Loading, Skeleton } from "./states"

type Page = { vessel: Vessel | null; emails: Email[]; total: number; offset: number; page: number }

const DIRECTIONS = [
  { value: "", label: "All" },
  { value: "INCOMING", label: "Received" },
  { value: "OUTGOING", label: "Sent" },
]

export function Correspondence() {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const href = useHref()
  const { vesselParam } = useFrame()
  const search = params.get("search") ?? ""
  const direction = params.get("direction") ?? ""
  const [typed, setTyped] = useState(search)
  useEffect(() => setTyped(search), [search])
  useEffect(() => {
    if (typed === search) return
    const timer = setTimeout(() => router.replace(`${pathname}${query({ vessel: vesselParam, search: typed.trim(), direction })}`), 350)
    return () => clearTimeout(timer)
  }, [typed, search, direction, vesselParam, pathname, router])

  const { data, error, isLoading, size, setSize, isValidating } = useSWRInfinite(
    (index: number, previous: Page | null) => {
      if (previous && previous.offset + previous.page >= previous.total) return null
      return `${API}/correspondence${query({ vessel: vesselParam, search, direction, offset: index ? index * (previous?.page ?? 50) : null })}`
    },
    (path: string) => getJson<Page>(path),
    { revalidateFirstPage: false },
  )
  const emails = data?.flatMap((p) => p.emails) ?? []
  const total = data?.[0]?.total ?? 0
  const more = data && emails.length < total

  return (
    <section aria-labelledby="correspondence" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="correspondence" className="text-lg font-semibold">Correspondence</h2>
          <p className="text-sm text-muted-foreground">Emails with a GC number in the subject, stored on this PC. Attachments are not stored.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative">
            <span className="sr-only">Search the emails</span>
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Words, sender or GC number" maxLength={200} className="h-10 w-72 pl-8" />
          </label>
          <div role="group" aria-label="Direction" className="flex rounded-lg border p-0.5">
            {DIRECTIONS.map((d) => (
              <button
                key={d.value}
                type="button"
                aria-pressed={direction === d.value}
                onClick={() => router.replace(`${pathname}${query({ vessel: vesselParam, search, direction: d.value })}`)}
                className={cn("h-9 rounded-md px-3 text-sm", direction === d.value ? "bg-secondary font-medium" : "text-muted-foreground hover:text-foreground")}
              >
                {d.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error && <ErrorPanel error={error} what="the emails" />}
      {!error && isLoading && (
        <Loading label="Loading emails">
          <div className="flex flex-col gap-2">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-16" />)}</div>
        </Loading>
      )}
      {data && (
        <>
          <p className="text-sm text-muted-foreground tabular-nums">
            {total === 0 ? (search ? "No stored email matches this search." : "No email is stored for this vessel.") : `${total} ${total === 1 ? "email" : "emails"}${search ? " match" : ""}, newest first`}
          </p>
          {emails.length > 0 && (
            <ol className="flex flex-col divide-y rounded-2xl border bg-card px-5 py-4">
              {emails.map((e) => (
                <EmailItem
                  key={e.id}
                  email={e}
                  claimLink={e.claim ? (
                    <Link href={href(`/claims/${e.claim.id}`)} className="text-xs font-semibold text-primary underline-offset-4 hover:underline">{e.claim.gc_number}</Link>
                  ) : (
                    <span className="text-xs text-muted-foreground">Not linked to a claim{e.gc_numbers.length ? ` (subject: ${e.gc_numbers.join(", ")})` : ""}</span>
                  )}
                />
              ))}
            </ol>
          )}
          {more && (
            <Button variant="outline" className="h-10 w-fit px-4" disabled={isValidating} onClick={() => setSize(size + 1)}>
              {isValidating ? "Loading…" : `Show more (${total - emails.length} left)`}
            </Button>
          )}
        </>
      )}
    </section>
  )
}
