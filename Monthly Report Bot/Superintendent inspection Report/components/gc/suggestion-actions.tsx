"use client"

// Guarantee Claim Manager · one email suggestion with what can be done with it on its own: link the email, note a
// possible typing error, close the claim (with a date and reason you check), or dismiss it. Values such as owner,
// since and next step are confirmed in the set-up table or the claim's Edit record form instead.

import { Check, Link2, X } from "lucide-react"
import { useState } from "react"
import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { SuggestionCard } from "./assessment"
import { CloseForm, SaveMessage, today, useSave } from "./claim-forms"
import { API, type ClaimDetail, formatDay, send, type Suggestion } from "./client"

export function SuggestionActions({ claimId, updatedAt, suggestion: s, onChanged, compact }: {
  claimId: number; updatedAt: string; suggestion: Suggestion; onChanged: () => void; compact?: boolean
}) {
  const [closing, setClosing] = useState(false)
  const save = useSave(() => onChanged())
  const decide = (decision: "ACCEPTED" | "REJECTED", done: string) => save.run(done, () =>
    send<ClaimDetail>(`${API}/claims/${claimId}/suggestions`, "POST", { key: s.key, decision }))
  const small = cn(buttonVariants({ variant: "outline", size: "sm" }), "h-9")
  return (
    <div className="flex flex-col gap-2">
      <SuggestionCard suggestion={s} compact={compact} />
      <div className="flex flex-wrap items-center gap-2 pl-1">
        {s.kind === "LINK" && <button type="button" disabled={save.busy} onClick={() => decide("ACCEPTED", "Email linked to this claim.")} className={small}><Link2 aria-hidden /> Link email</button>}
        {s.kind === "CONFLICT" && <button type="button" disabled={save.busy} onClick={() => decide("ACCEPTED", "Noted.")} className={small}><Check aria-hidden /> Noted, I will check</button>}
        {s.kind === "CLOSURE" && <button type="button" aria-expanded={closing} onClick={() => setClosing(!closing)} className={small}>Close claim…</button>}
        <button type="button" disabled={save.busy} onClick={() => decide("REJECTED", "Dismissed.")} className={cn(small, "text-muted-foreground")}><X aria-hidden /> Dismiss</button>
        <SaveMessage error={save.error} saved={save.saved} />
      </div>
      {closing && (
        <div className="rounded-xl border p-3">
          <CloseForm detail={{ claim: { id: claimId, updated_at: updatedAt } }} onSaved={() => onChanged()} onReload={onChanged}
            initialDate={s.evidence_date ?? today()}
            initialReason={`Closure confirmed by the email of ${s.evidence_date ? formatDay(s.evidence_date) : "unknown date"}: “${s.quote}”`.slice(0, 2000)} />
        </div>
      )}
    </div>
  )
}
