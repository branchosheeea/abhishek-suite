"use client"

import { Cloud, CloudOff, HardDrive, Loader2, TriangleAlert, Wifi, WifiOff } from "lucide-react"
import type { SaveState } from "@/hooks/use-report-editor"
import { useOnline } from "@/hooks/use-online"
import { cn } from "@/lib/utils"

export function OnlinePill({ className }: { className?: string }) {
  const online = useOnline()
  return (
    <span
      role="status"
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium",
        online ? "border-success/40 text-success" : "border-warning/50 bg-warning/15 text-warning-foreground dark:text-warning",
        className,
      )}
    >
      {online ? <Wifi className="size-3.5" aria-hidden /> : <WifiOff className="size-3.5" aria-hidden />}
      {online ? "Online" : "Offline"}
    </span>
  )
}

export function SavePill({ state }: { state: SaveState }) {
  const online = useOnline()
  const view = (() => {
    if (state === "saving") return { icon: <Loader2 className="size-3.5 animate-spin" aria-hidden />, text: "Saving…" }
    if (state === "locked") return { icon: <TriangleAlert className="size-3.5" aria-hidden />, text: "Not synced: report is approved" }
    if (state === "conflict") return { icon: <TriangleAlert className="size-3.5" aria-hidden />, text: "Not synced: changed elsewhere" }
    if (state === "sync-error") return { icon: <TriangleAlert className="size-3.5" aria-hidden />, text: "Saved locally, sync failed" }
    if (state === "synced") return { icon: <Cloud className="size-3.5" aria-hidden />, text: "Synced to cloud" }
    if (state === "saved" && !online) return { icon: <CloudOff className="size-3.5" aria-hidden />, text: "Saved on device" }
    if (state === "saved") return { icon: <HardDrive className="size-3.5" aria-hidden />, text: "Saved on device" }
    return { icon: <HardDrive className="size-3.5" aria-hidden />, text: "All changes saved" }
  })()
  return (
    <span aria-live="polite" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      {view.icon}
      {view.text}
    </span>
  )
}
