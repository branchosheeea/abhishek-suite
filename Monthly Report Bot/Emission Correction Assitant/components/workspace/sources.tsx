"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { describeRole, type ColumnMap } from "@/lib/engine/schema"
import { SOURCE_KIND_LABEL, type ParseIssue, type SourceKind } from "@/lib/engine/types"
import { formatTime, get, send, upload } from "../api"
import { Banner, Button, Card, cn, Empty, inputClass, Mono, Pill } from "../ui"
import type { Artifact, Ctx, Focus } from "./types"

type View = {
  artifact: Artifact
  sheets?: string[]
  map: ColumnMap
  table: {
    kind: SourceKind
    headers: string[]
    headerLine: number
    meta: Record<string, unknown>
    issues: ParseIssue[]
    totalRows: number
    rows: { index: number; line: number; cells: string[]; blankLine?: boolean }[]
  }
}

const KINDS: SourceKind[] = ["LA", "BR", "OVDLA"]
const ACCEPT: Record<SourceKind, string> = { LA: ".csv", BR: ".csv", OVDLA: ".xlsx" }
const SHORT: Record<SourceKind, string> = { LA: "Log Abstract", BR: "Bunker Report", OVDLA: "OVDLA" }
const NOT_IMPORTED: Record<SourceKind, string> = {
  LA: "Not imported yet. This is the vessel's Log Abstract export.",
  BR: "Not imported yet. Recommended: without it, DNV \"ROB vs available fuel\" items stay Unresolved.",
  OVDLA: "Not imported yet. This is the OVDLA Excel downloaded from DNV.",
}

/** A visible button that opens the file picker (the native file input itself is visually hidden). */
function ImportButton({ label, accept, primary, disabled, onFile }: { label: string; accept: string; primary: boolean; disabled: boolean; onFile: (file: File) => void }) {
  return (
    <label
      className={cn(
        "inline-flex h-10 w-full cursor-pointer items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring",
        primary ? "bg-primary text-primary-foreground hover:opacity-90" : "border bg-card text-foreground hover:bg-muted",
        disabled && "pointer-events-none opacity-50",
      )}
    >
      <span aria-hidden>⤒</span>
      {label}
      <input
        type="file"
        accept={accept}
        disabled={disabled}
        className="sr-only"
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = "" // allow choosing the same file again later
          if (file) onFile(file)
        }}
      />
    </label>
  )
}

/** Accepts a file dropped onto the box. */
function DropZone({ disabled, onFile, children }: { disabled: boolean; onFile: (file: File) => void; children: React.ReactNode }) {
  const [over, setOver] = useState(false)
  return (
    <div
      className={cn("rounded-xl", over && "outline-2 outline-dashed outline-offset-2 outline-primary")}
      onDragOver={(e) => {
        e.preventDefault()
        if (!disabled) setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        const file = e.dataTransfer.files?.[0]
        if (file && !disabled) onFile(file)
      }}
    >
      {children}
    </div>
  )
}

export function SourcesPanel({ ctx, focus }: { ctx: Ctx; focus: Focus }) {
  const { data } = ctx
  const [kind, setKind] = useState<SourceKind>(focus?.kind ?? (KINDS.find((k) => data.session.sources[k]) ?? "LA"))
  const [busy, setBusy] = useState<SourceKind | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    if (focus) setKind(focus.kind)
  }, [focus])

  async function onUpload(k: SourceKind, file: File | undefined) {
    if (!file) return
    const expected = ACCEPT[k]
    if (!file.name.toLowerCase().endsWith(expected)) {
      ctx.setError(`The ${SHORT[k]} must be a ${expected} file; "${file.name}" was not imported.`)
      return
    }
    setBusy(k)
    setNotice(null)
    ctx.setError(null)
    try {
      const r = await upload<{ artifact: Artifact; created: boolean }>(k, file)
      await send("PATCH", `/api/sessions/${data.session._id}`, { attach: { kind: k, sha256: r.artifact._id } })
      setNotice(r.created ? `${file.name} registered and attached as ${k}.` : `${file.name} was already registered (identical bytes); the existing record was attached. Nothing was overwritten.`)
      await ctx.reload()
      setKind(k)
    } catch (e) {
      ctx.setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  async function detach(k: SourceKind) {
    if (!confirm(`Detach the ${k} from this session? The registered file itself is kept unchanged.`)) return
    try {
      await send("PATCH", `/api/sessions/${data.session._id}`, { detach: k })
      await ctx.reload()
    } catch (e) {
      ctx.setError((e as Error).message)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-4 lg:grid-cols-3">
        {KINDS.map((k) => {
          const artifact = data.artifacts.find((a) => a._id === data.session.sources[k])
          return (
            <DropZone key={k} disabled={busy !== null} onFile={(f) => onUpload(k, f)}>
            <Card title={SOURCE_KIND_LABEL[k]} className="h-full">
              {artifact ? (
                <div className="flex flex-col gap-2 text-xs">
                  <p className="text-sm font-semibold">{artifact.filename}</p>
                  <p className="text-muted-foreground">{artifact.size.toLocaleString()} bytes · {artifact.format.toUpperCase()} · registered {formatTime(artifact.registeredAt)} by {artifact.registeredBy}</p>
                  <Mono>SHA-256 {artifact._id}</Mono>
                  <div className="mt-1 flex flex-wrap gap-2">
                    <Button variant="secondary" onClick={() => setKind(k)}>View</Button>
                    <a className="inline-flex h-9 items-center rounded-lg border px-3 text-sm font-semibold hover:bg-muted" href={`/api/sources/${artifact._id}/original`}>Download original</a>
                    <Button variant="ghost" onClick={() => detach(k)}>Detach</Button>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">{NOT_IMPORTED[k]}</p>
              )}
              <div className="mt-4 flex flex-col gap-1.5">
                <ImportButton
                  label={busy === k ? "Importing…" : artifact ? `Import a newer ${SHORT[k]}` : `Import ${SHORT[k]} (${ACCEPT[k]})`}
                  accept={ACCEPT[k]}
                  primary={!artifact}
                  disabled={busy !== null}
                  onFile={(f) => onUpload(k, f)}
                />
                <span className="text-xs text-muted-foreground">
                  {busy === k ? "Checking the file… unsafe or malformed files are rejected without being stored." : "…or drag the file onto this box."}
                </span>
              </div>
            </Card>
            </DropZone>
          )
        })}
      </div>
      {notice && <Banner tone="good" title="Source registered">{notice}</Banner>}
      <SourceViewer ctx={ctx} kind={kind} setKind={setKind} focus={focus?.kind === kind ? focus : null} />
    </div>
  )
}

function SourceViewer({ ctx, kind, setKind, focus }: { ctx: Ctx; kind: SourceKind; setKind: (k: SourceKind) => void; focus: Focus }) {
  const { data, result } = ctx
  const sha = data.session.sources[kind]
  const [view, setView] = useState<View | null>(null)
  const [query, setQuery] = useState("")
  const [onlyFindings, setOnlyFindings] = useState(false)
  const [loading, setLoading] = useState(false)
  const focusRow = useRef<HTMLTableRowElement | null>(null)

  useEffect(() => {
    if (!sha) {
      setView(null)
      return
    }
    setLoading(true)
    const sheet = kind === "OVDLA" && data.session.ovdlaSheet ? `?sheet=${encodeURIComponent(data.session.ovdlaSheet)}` : ""
    get<View>(`/api/sources/${sha}${sheet}`)
      .then(setView)
      .catch((e) => ctx.setError((e as Error).message))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sha, kind, data.session.ovdlaSheet])

  useEffect(() => {
    focusRow.current?.scrollIntoView({ block: "center" })
  }, [view, focus])

  const findingLines = useMemo(() => {
    const m = new Map<number, number>()
    for (const f of result?.findings ?? []) for (const r of f.refs) if (r.kind === kind) m.set(r.line, (m.get(r.line) ?? 0) + 1)
    return m
  }, [result, kind])

  const excluded = useMemo(() => new Map(data.session.exclusions.filter((e) => e.sha256 === sha).map((e) => [e.line, e.reason])), [data.session.exclusions, sha])
  const focusLines = new Set(focus?.lines ?? [])
  const focusColumns = new Set(focus?.columns ?? [])

  const rows = useMemo(() => {
    if (!view) return []
    const q = query.trim().toLowerCase()
    return view.table.rows.filter((r) => (!onlyFindings || findingLines.has(r.line) || focusLines.has(r.line)) && (!q || r.cells.some((c) => c.toLowerCase().includes(q)) || String(r.line) === q))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, query, onlyFindings, findingLines, focus])

  async function toggleExclusion(line: number) {
    try {
      if (excluded.has(line)) {
        await send("PATCH", `/api/sessions/${data.session._id}`, { include: { sha256: sha, line } })
      } else {
        const reason = prompt(`Reason for excluding ${kind} line ${line} from operational calculations (it stays visible and in the audit trail):`)
        if (!reason) return
        await send("PATCH", `/api/sessions/${data.session._id}`, { exclude: { sha256: sha, line, reason } })
      }
      await ctx.reload()
    } catch (e) {
      ctx.setError((e as Error).message)
    }
  }

  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          Read-only source viewer
          <span className="flex gap-1" role="group" aria-label="Source">
            {KINDS.map((k) => (
              <button key={k} onClick={() => setKind(k)} aria-pressed={k === kind} className={cn("rounded-md border px-2 py-0.5 text-xs", k === kind ? "border-primary bg-info-bg font-semibold text-primary" : "text-muted-foreground")}>{k}</button>
            ))}
          </span>
        </span>
      }
      actions={view && (
        <>
          <input className={cn(inputClass, "w-56")} placeholder="Search values or line number" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search source rows" />
          <label className="flex items-center gap-1.5 text-xs"><input type="checkbox" checked={onlyFindings} onChange={(e) => setOnlyFindings(e.target.checked)} /> Rows with findings</label>
        </>
      )}
    >
      {!sha ? (
        <Empty>No {kind} attached to this session.</Empty>
      ) : loading || !view ? (
        <p className="text-sm text-muted-foreground">Reading and verifying the registered file…</p>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            {view.table.totalRows.toLocaleString()} data rows · header on {kind === "OVDLA" ? "row" : "line"} {view.table.headerLine} ·{" "}
            {Object.entries(view.table.meta).filter(([, v]) => v !== undefined && !Array.isArray(v)).map(([k, v]) => `${k}: ${String(v)}`).join(" · ")}
            {view.map.unmapped.length > 0 && ` · ${view.map.unmapped.length} column(s) not used by any rule`}
          </p>
          {kind === "OVDLA" && view.sheets && view.sheets.length > 1 && (
            <label className="flex items-center gap-2 text-xs">
              Worksheet
              <select className={cn(inputClass, "w-auto")} value={data.session.ovdlaSheet ?? view.sheets[0]} onChange={async (e) => { await send("PATCH", `/api/sessions/${data.session._id}`, { ovdlaSheet: e.target.value }); await ctx.reload() }}>
                {view.sheets.map((s) => <option key={s}>{s}</option>)}
              </select>
            </label>
          )}
          {view.map.missingRequired.length > 0 && <Banner tone="critical" title="Required columns not found">{view.map.missingRequired.join("; ")}</Banner>}
          {view.table.issues.length > 0 && (
            <details className="text-xs">
              <summary className="cursor-pointer font-semibold text-primary">{view.table.issues.length} parse issue(s) reported (nothing was repaired)</summary>
              <ul className="mt-1 list-disc pl-5">{view.table.issues.slice(0, 50).map((i, n) => <li key={n}>{i.message}</li>)}</ul>
            </details>
          )}
          <div className="max-h-[65vh] overflow-auto rounded-lg border">
            <table className="text-xs">
              <thead className="sticky top-0 z-10 bg-muted">
                <tr>
                  <th className="sticky left-0 z-20 bg-muted px-2 py-1.5 text-left">{kind === "OVDLA" ? "Row" : "Line"}</th>
                  <th className="px-2 py-1.5 text-left">Status</th>
                  {view.table.headers.map((h, i) => {
                    const role = view.map.columns[i]?.role
                    return (
                      <th key={i} className={cn("whitespace-nowrap px-2 py-1.5 text-left font-semibold", focusColumns.has(h) && "bg-warning-bg")} title={role ? describeRole(role) : "Not used by any rule"}>
                        <span className="block">{h === "" ? <em className="text-muted-foreground">(blank header)</em> : h}</span>
                        <span className="block font-normal text-muted-foreground">{role ? describeRole(role) : "unmapped"}</span>
                      </th>
                    )
                  })}
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((r) => {
                  const isFocus = focusLines.has(r.line)
                  return (
                    <tr key={r.line} ref={isFocus && r.line === focus?.lines[0] ? focusRow : undefined} className={cn(isFocus && "bg-warning-bg", excluded.has(r.line) && "opacity-60")}>
                      <td className="sticky left-0 bg-card px-2 py-1 font-mono tabular-nums">{r.line}</td>
                      <td className="whitespace-nowrap px-2 py-1">
                        <span className="flex items-center gap-1">
                          {excluded.has(r.line) && <Pill tone="neutral">Excluded: {excluded.get(r.line)}</Pill>}
                          {findingLines.has(r.line) && <Pill tone="warning">{findingLines.get(r.line)} finding(s)</Pill>}
                          {r.blankLine && <Pill>Blank line</Pill>}
                          <button className="text-primary underline-offset-2 hover:underline" onClick={() => toggleExclusion(r.line)}>{excluded.has(r.line) ? "Re-include" : "Exclude…"}</button>
                        </span>
                      </td>
                      {view.table.headers.map((h, i) => (
                        <td key={i} className={cn("whitespace-pre px-2 py-1 font-mono", isFocus && focusColumns.has(h) && "font-bold outline outline-2 -outline-offset-2 outline-warning")}>
                          {r.cells[i] === "" ? <span className="text-muted-foreground">·</span> : r.cells[i]}
                        </td>
                      ))}
                      {r.cells.length > view.table.headers.length && (
                        <td className="px-2 py-1 font-mono text-critical">+ {r.cells.slice(view.table.headers.length).join(" | ")}</td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">Values are shown exactly as stored in the registered file. Blank cells are shown as “·” and are never read as zero. This viewer cannot change the file.</p>
        </div>
      )}
    </Card>
  )
}
