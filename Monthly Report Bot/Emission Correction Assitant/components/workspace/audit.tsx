"use client"

import { useEffect, useState } from "react"
import { formatTime, get } from "../api"
import { Card, Empty } from "../ui"

type Entry = { _id: string; at: string; actor: string; action: string; target: string | null; detail: string }

export function AuditPanel({ sessionId }: { sessionId: string }) {
  const [audit, setAudit] = useState<Entry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    get<{ audit: Entry[] }>(`/api/sessions/${sessionId}/audit`).then((r) => setAudit(r.audit)).catch((e) => setError((e as Error).message))
  }, [sessionId])
  return (
    <Card title="Audit history (append-only)">
      {error ? <p className="text-sm text-critical">{error}</p> : audit === null ? <p className="text-sm text-muted-foreground">Loading…</p> : audit.length === 0 ? <Empty>No entries.</Empty> : (
        <div className="max-h-[70vh] overflow-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-card text-left text-muted-foreground"><tr><th className="py-1 pr-3">When (UTC)</th><th className="pr-3">Who</th><th className="pr-3">Action</th><th>Detail</th></tr></thead>
            <tbody className="divide-y">
              {audit.map((a) => (
                <tr key={a._id}><td className="py-1 pr-3 whitespace-nowrap font-mono">{formatTime(a.at)}</td><td className="pr-3">{a.actor}</td><td className="pr-3 font-mono">{a.action}</td><td>{a.detail}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-2 text-xs text-muted-foreground">Source registrations and downloads (not tied to a session) are also recorded in the audit collection.</p>
    </Card>
  )
}
