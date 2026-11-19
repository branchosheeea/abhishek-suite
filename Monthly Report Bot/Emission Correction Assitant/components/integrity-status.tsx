"use client"

import { useEffect, useState } from "react"
import { get } from "./api"
import { Banner, Card, Pill } from "./ui"

type RoleCheck = { role: string; variable: string | null; user: string | null; canModifySources: boolean | null; canInsertSources: boolean | null; error?: string }
type Status = { configured: boolean; mode: string; summary: string; roles: RoleCheck[] }

const ROLE_LABEL: Record<string, string> = { sourceWrite: "Source registration", sourceRead: "Source reading (viewer, validation)", diagnostics: "Diagnostic records" }

export function IntegrityStatus() {
  const [status, setStatus] = useState<Status | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    get<Status>("/api/integrity").then(setStatus).catch((e) => setError((e as Error).message))
  }, [])
  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-8 sm:px-9">
      <header className="flex flex-col gap-1.5 border-b pb-6">
        <h1 className="text-3xl font-bold tracking-tight">Storage integrity</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">How the original vessel files are protected. Read from the database users&apos; own privileges each time this page opens.</p>
      </header>
      {error && <Banner tone="critical" title="Could not read the protection status">{error}</Banner>}
      {status && (
        <>
          <Banner tone={status.mode === "database-enforced" ? "good" : status.mode === "application-only" ? "warning" : "critical"} title={status.mode === "database-enforced" ? "Database-enforced protection" : status.mode === "application-only" ? "Application-only protection" : status.mode === "memory" ? "Test mode: temporary in-memory storage" : "Protection level unknown"}>
            {status.summary}
          </Banner>
          <Card title="Database users">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground"><tr><th className="py-1 pr-3">Role</th><th className="pr-3">Setting</th><th className="pr-3">Database user</th><th className="pr-3">Can change or delete originals</th><th>Can insert originals</th></tr></thead>
              <tbody className="divide-y">
                {status.roles.map((r) => (
                  <tr key={r.role}>
                    <td className="py-1.5 pr-3">{ROLE_LABEL[r.role] ?? r.role}</td>
                    <td className="pr-3 font-mono text-xs">{r.variable ?? "not set"}</td>
                    <td className="pr-3 text-xs">{r.user ?? (r.error ? `(${r.error})` : "no authentication")}</td>
                    <td className="pr-3">{r.canModifySources === null ? <Pill>Unknown</Pill> : r.canModifySources ? <Pill tone="warning">Yes</Pill> : <Pill tone="good">No</Pill>}</td>
                    <td>{r.canInsertSources === null ? <Pill>Unknown</Pill> : r.canInsertSources ? <Pill tone={r.role === "sourceWrite" ? "neutral" : "warning"}>Yes</Pill> : <Pill tone="good">No</Pill>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
      <Card title="Protection in place regardless of the database level">
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li>The application has no update, replace or delete operation for original files, and no API route for one. Automated tests enforce both.</li>
          <li>Each original is stored once under its SHA-256; an identical upload is recorded as an occurrence and never overwrites.</li>
          <li>Uploads are parsed before registration; unsafe or malformed files (macros, external links, decompression bombs, wrong format) are rejected without being stored.</li>
          <li>Each stored copy is read back and re-hashed at registration, re-hashed on every read, and verified before and after every validation run. A mismatch stops the run and is audited.</li>
          <li>Diagnostic reports are generated in memory and downloaded; they are never written to the original-file store.</li>
        </ul>
      </Card>
      <Card title="To enforce protection in the database (MongoDB Atlas)">
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          <li>In Atlas → Database Access, create a custom role <strong>emissions-source-ingest</strong> with <code>find</code> and <code>insert</code> only on <code>emissions.source_artifacts</code>, <code>emissions.source_files.files</code> and <code>emissions.source_files.chunks</code>.</li>
          <li>Create a custom role <strong>emissions-source-read</strong> with <code>find</code> only on the same three collections.</li>
          <li>Create a custom role <strong>emissions-diagnostics</strong> with <code>find</code>, <code>insert</code>, <code>update</code> and <code>createIndex</code> on the diagnostic collections only: <code>sessions</code>, <code>runs</code>, <code>dnv_findings</code>, <code>finding_status</code>, <code>finding_status_history</code>, <code>notes</code>, <code>finding_links</code>, <code>audit</code>, <code>reports</code>, <code>source_occurrences</code>. Do not give it a database-wide readWrite role, which would include the source collections.</li>
          <li>Create one database user per role.</li>
          <li>Put the connection strings in <code>.env.local</code> as <code>EMISSIONS_SOURCE_WRITE_URI</code>, <code>EMISSIONS_SOURCE_READ_URI</code> and <code>EMISSIONS_MONGODB_URI</code>, then restart. This page should then show database-enforced protection.</li>
        </ol>
        <p className="mt-2 text-xs text-muted-foreground">Atlas has no write-once (WORM) mode for collections; least-privilege users are the strongest practical storage-level control. Atlas encrypts data at rest and in transit (TLS) by default.</p>
      </Card>
    </main>
  )
}
