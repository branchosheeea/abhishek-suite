"use client"

// Approved reports are read-only (lib/report-write.ts). These banners say so and offer the only way to change one:
// withdrawing the approval with a reason. The cloud keeps the approved version permanently, with who withdrew it,
// when and why, and the Fleet Manager must approve the report again.

import { BadgeCheck, Loader2, Lock } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { useOnline } from "@/hooks/use-online"
import { formatDate } from "@/lib/narrative/dates"
import type { ConflictChoice, ResolveOutcome, SyncLock, WithdrawOutcome } from "@/lib/sync"

type Withdraw = (reason: string) => Promise<WithdrawOutcome>

function announce(outcome: WithdrawOutcome) {
  if (outcome.result === "conflict") toast.warning("This report was changed elsewhere in the meantime. Choose which version to keep first.")
  else if (outcome.withdrawn === "device") toast.success("Approval withdrawn. It had not reached the cloud yet, so it was withdrawn on this device.")
  else toast.success("Approval withdrawn. The approved version is kept in the cloud; the Fleet Manager must approve the report again.")
}

/** The reason form, shared by both banners. */
function WithdrawForm({ action, onCancel, onWithdraw }: { action: string; onCancel: () => void; onWithdraw: Withdraw }) {
  const online = useOnline()
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)
  const ready = reason.trim().length >= 5

  const submit = async () => {
    setBusy(true)
    try {
      announce(await onWithdraw(reason.trim()))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The approval could not be withdrawn.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-background p-3">
      <label htmlFor="withdraw-reason" className="text-sm font-medium">
        Reason for withdrawing the approval
        <span aria-hidden className="text-destructive"> *</span>
      </label>
      <Textarea
        id="withdraw-reason"
        value={reason}
        maxLength={1000}
        rows={3}
        placeholder="e.g. Main engine running hours were entered for the wrong month."
        onChange={(e) => setReason(e.target.value)}
      />
      <p className="text-xs text-muted-foreground">
        The approved version is kept permanently in the cloud, with your name, the date and this reason. The Fleet Manager must then approve the report
        again.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={!ready || !online || busy} onClick={submit}>
          {busy && <Loader2 className="animate-spin" aria-hidden />}
          {action}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {!online && <p className="text-xs text-muted-foreground">Connect to the internet to withdraw the approval.</p>}
    </div>
  )
}

/** Shown on an approved report: it is read-only, and the approval can be withdrawn with a reason. */
export function ApprovedBanner({ approvedBy, approvedOn, onWithdraw }: { approvedBy: string; approvedOn: string; onWithdraw: Withdraw }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="mb-6 flex flex-col gap-3 rounded-lg border border-success/40 bg-success/10 p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-start gap-2 font-medium">
          <BadgeCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
          Approved by {approvedBy || "the Fleet Manager"}
          {approvedOn ? ` on ${formatDate(approvedOn)}` : ""}. This report is read-only.
        </p>
        {!open && (
          <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
            Withdraw approval…
          </Button>
        )}
      </div>
      {open && <WithdrawForm action="Withdraw approval" onCancel={() => setOpen(false)} onWithdraw={onWithdraw} />}
    </div>
  )
}

/** Shown when the cloud refused this device's changes because the report has been approved there. */
export function LockedBanner({
  lock,
  onWithdraw,
  onResolve,
}: {
  lock: SyncLock
  onWithdraw: Withdraw
  onResolve: (choice: ConflictChoice) => Promise<ResolveOutcome>
}) {
  const online = useOnline()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<ConflictChoice | null>(null)

  const choose = async (choice: "both" | "cloud") => {
    if (choice === "cloud" && !window.confirm("Discard the changes made on this device and keep the approved version?")) return
    setBusy(choice)
    try {
      await onResolve(choice)
      toast.success(
        choice === "both"
          ? "Kept both. This device's changes are now a separate draft report in the list; this report shows the approved version."
          : "This report now shows the approved version.",
      )
    } catch {
      toast.error("Could not reach the cloud copy. Nothing was overwritten; try again when the connection is back.")
    } finally {
      setBusy(null)
    }
  }

  return (
    <div role="alert" className="mb-6 flex flex-col gap-3 rounded-lg border border-amber-500/50 bg-amber-500/10 p-4 text-sm">
      <p className="flex items-start gap-2 font-medium">
        <Lock className="mt-0.5 size-4 shrink-0" aria-hidden />
        This report has been approved{lock.approvedBy ? ` by ${lock.approvedBy}` : ""}
        {lock.approvedOn ? ` on ${formatDate(lock.approvedOn)}` : ""}, so the changes on this device were not saved
      </p>
      <p className="text-pretty">
        An approved report cannot be changed. The changes are kept on this device and are not sent until you choose what to do with them.
      </p>
      {open ? (
        <WithdrawForm action="Withdraw approval and save my changes" onCancel={() => setOpen(false)} onWithdraw={onWithdraw} />
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" disabled={!online || busy !== null} onClick={() => setOpen(true)}>
            Withdraw approval and save my changes…
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={!online || busy !== null} onClick={() => choose("both")}>
            {busy === "both" && <Loader2 className="animate-spin" aria-hidden />}
            Keep both
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={!online || busy !== null} onClick={() => choose("cloud")}>
            {busy === "cloud" && <Loader2 className="animate-spin" aria-hidden />}
            Discard my changes
          </Button>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        {online ? "Keep both saves this device's changes, with its photos, as a separate draft report." : "Connect to the internet to choose."}
      </p>
    </div>
  )
}
