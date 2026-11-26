"use client"

// Guarantee Claim Manager · Outlook sync in the page header (Phase 5). Only what the records and the helper know:
// the last completed sync, a sync running now, the last error, or that a Microsoft sign-in is needed. "Sync now" and
// "Sign in" exist because the helper really can do them. The sign-in code is shown here and nowhere else.

import { CloudOff, Copy, ExternalLink, LogIn, Mail, RefreshCw, TriangleAlert } from "lucide-react"
import { useRef, useState } from "react"
import useSWR from "swr"
import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { API, formatStamp, getJson, RequestFailed, send, type SyncState } from "./client"

export function OutlookSync({ onSynced }: { onSynced?: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const lastRunning = useRef(false) // so the claims refresh once, when a running sync finishes
  const { data, mutate } = useSWR(`${API}/sync`, (path: string) => getJson<SyncState>(path), {
    // Follow closely while something is happening; otherwise once a minute.
    refreshInterval: (s) => (s && (s.running || s.sign_in?.state === "WAITING") ? 3000 : 60000),
    onSuccess: (s) => { if (!s.running && lastRunning.current && onSynced) onSynced(); lastRunning.current = s.running },
  })
  const act = async (path: string) => {
    setBusy(true)
    setError(null)
    try {
      const result = await send<{ started?: boolean; reason?: string }>(path, "POST")
      if (result && result.started === false && result.reason) setError(result.reason)
      await mutate()
    } catch (e) {
      setError(e instanceof RequestFailed ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  if (!data) return null

  if (!data.enabled || !data.configured) {
    return <p className="flex items-center gap-2 text-sm text-muted-foreground"><CloudOff className="size-4" aria-hidden /> Outlook is not connected on this PC</p>
  }

  const signIn = data.sign_in
  if (signIn?.state === "WAITING" && signIn.user_code) {
    return (
      <div role="status" className="flex max-w-md flex-col gap-1.5 rounded-xl border border-primary/40 bg-primary/5 p-3 text-sm">
        <p className="font-semibold">Microsoft sign-in for Outlook</p>
        <p>
          Open <a href={signIn.verification_uri} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-primary underline underline-offset-4">
            {signIn.verification_uri.replace(/^https?:\/\//, "")} <ExternalLink className="size-3.5" aria-hidden /></a> and enter this code:
        </p>
        <p className="flex items-center gap-2">
          <code className="rounded-md border bg-background px-2 py-1 font-mono text-lg font-semibold tracking-widest">{signIn.user_code}</code>
          <button type="button" onClick={async () => { try { await navigator.clipboard.writeText(signIn.user_code ?? ""); setCopied(true) } catch { setCopied(false) } }}
            className={cn(buttonVariants({ variant: "outline", size: "sm" }), "h-9")}><Copy aria-hidden /> {copied ? "Copied" : "Copy"}</button>
        </p>
        <p className="text-xs text-muted-foreground">Use your work account. The code expires in {Math.ceil(signIn.expires_in / 60)} minutes. Outlook access stays read-only.</p>
      </div>
    )
  }

  const lastOk = data.last_success_at ? `Last synced ${formatStamp(data.last_success_at)}` : "No completed sync recorded yet"
  const button = (label: string, path: string, Icon: typeof RefreshCw) => (
    <button type="button" onClick={() => act(path)} disabled={busy || data.running} className={cn(buttonVariants({ variant: "outline", size: "sm" }), "h-9")}>
      <Icon className={cn(data.running && Icon === RefreshCw && "animate-spin")} aria-hidden /> {data.running ? "Syncing…" : label}
    </button>
  )

  if (data.sign_in_needed || signIn?.state === "FAILED" || signIn?.state === "EXPIRED") {
    return (
      <div className="flex max-w-md flex-col items-end gap-1.5 text-right text-sm">
        <p className="flex items-center gap-1.5 font-semibold"><TriangleAlert className="size-4 text-warning" aria-hidden /> Outlook sign-in needed</p>
        <p className="text-xs text-muted-foreground">
          {signIn?.state === "FAILED" ? `The last sign-in did not complete${signIn.error ? `: ${signIn.error}` : ""}. ` : signIn?.state === "EXPIRED" ? "The sign-in code expired. " : ""}
          {lastOk}. Newer emails are not shown until you sign in.
        </p>
        {button("Sign in to Microsoft", `${API}/sync/sign-in`, LogIn)}
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      </div>
    )
  }

  if (data.last_error && !data.running) {
    return (
      <div className="flex max-w-md flex-col items-end gap-1.5 text-right text-sm">
        <p className="flex items-center gap-1.5 font-semibold"><TriangleAlert className="size-4 text-warning" aria-hidden /> Outlook sync failed</p>
        <p className="line-clamp-2 text-xs text-muted-foreground" title={data.last_error}>{data.last_error}</p>
        <p className="text-xs text-muted-foreground">{lastOk}. Newer emails may not be shown yet.</p>
        {button("Try again", `${API}/sync`, RefreshCw)}
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      </div>
    )
  }

  return (
    <div className="flex flex-col items-end gap-1 text-right text-xs text-muted-foreground">
      <span className="flex items-center gap-1.5 text-sm text-foreground"><Mail className="size-4" aria-hidden /> Outlook (read-only)</span>
      <span>{data.running ? "Syncing now…" : lastOk}{!data.running && data.last_added !== null ? ` · ${data.last_added} new` : ""}</span>
      {data.automatic && !data.running && <span>Syncs every {data.interval_minutes} minutes while NeraVeda runs</span>}
      {button("Sync now", `${API}/sync`, RefreshCw)}
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </div>
  )
}
