"use client"

import { Loader2, TriangleAlert } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { useOnline } from "@/hooks/use-online"
import type { ConflictChoice, ResolveOutcome, SyncConflict } from "@/lib/sync"

const DONE: Record<ConflictChoice, string> = {
  both: "Kept both. This device's version is now a separate report in the list; this report shows the cloud version.",
  local: "This device's version is now the cloud copy.",
  cloud: "This report now shows the cloud version.",
}

const CONFIRM: Partial<Record<ConflictChoice, string>> = {
  local: "Replace the cloud copy with this device's version? The changes saved from the other device or tab will be lost.",
  cloud: "Discard the changes made on this device and use the cloud version? Photos added on this device are kept.",
}

/** Shown while a report is in sync conflict (lib/sync.ts): nothing is sent or fetched until the person chooses. */
export function SyncConflictBanner({ conflict, onResolve }: { conflict: SyncConflict; onResolve: (choice: ConflictChoice) => Promise<ResolveOutcome> }) {
  const online = useOnline()
  const [busy, setBusy] = useState<ConflictChoice | null>(null)
  const savedElsewhere = conflict.serverUpdatedAt
    ? new Date(conflict.serverUpdatedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })
    : null

  const choose = async (choice: ConflictChoice) => {
    const question = CONFIRM[choice]
    if (question && !window.confirm(question)) return
    setBusy(choice)
    try {
      const outcome = await onResolve(choice)
      if (outcome.result === "conflict") toast.warning("The cloud copy changed again while sending. Nothing was overwritten; choose again.")
      else toast.success(DONE[choice])
    } catch {
      toast.error("Could not reach the cloud copy. Nothing was overwritten; try again when the connection is back.")
    } finally {
      setBusy(null)
    }
  }

  const option = (choice: ConflictChoice, label: string, variant: "default" | "outline") => (
    <Button type="button" variant={variant} size="sm" disabled={!online || busy !== null} onClick={() => choose(choice)}>
      {busy === choice && <Loader2 className="animate-spin" aria-hidden />}
      {label}
    </Button>
  )

  return (
    <div role="alert" className="mb-6 flex flex-col gap-3 rounded-lg border border-amber-500/50 bg-amber-500/10 p-4 text-sm">
      <p className="flex items-start gap-2 font-medium">
        <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
        This report was also changed on another device or browser tab
      </p>
      <p className="text-pretty">
        A different version was saved to the cloud{savedElsewhere ? ` (${savedElsewhere})` : ""}. The changes on this device have not been sent, and
        nothing has been overwritten. You can keep working; this report is not synced until you choose what to keep.
      </p>
      <div className="flex flex-wrap gap-2">
        {option("both", "Keep both", "default")}
        {option("local", "Use this device's version", "outline")}
        {option("cloud", "Use the cloud version", "outline")}
      </div>
      <p className="text-xs text-muted-foreground">
        {online
          ? "Keep both saves this device's version, with its photos, as a separate report and shows the cloud version here."
          : "Connect to the internet to choose."}
      </p>
    </div>
  )
}
