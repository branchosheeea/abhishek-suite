import type { ValidationConfig } from "@/lib/engine/config"
import type { DnvFinding } from "@/lib/engine/correlate"
import type { ValidationResult } from "@/lib/engine/run"
import type { SourceKind, SourceRef } from "@/lib/engine/types"

export type Artifact = { _id: string; kind: SourceKind; filename: string; size: number; format: string; registeredAt: string; registeredBy: string }

export type Session = {
  _id: string
  title: string
  vessel: string
  imo: string | null
  schemaId: string
  config: ValidationConfig
  sources: Partial<Record<SourceKind, string>>
  ovdlaSheet: string | null
  exclusions: { sha256: string; line: number; reason: string; by: string; at: string }[]
  createdAt: string
  createdBy: string
  updatedAt: string
}

export type IntegrityCheck = { kind: SourceKind; sha256: string; filename: string; ok: boolean; detail?: string }

export type RunSummary = {
  _id: string
  state: "running" | "completed" | "failed" | "integrity-failed"
  startedAt: string
  finishedAt: string | null
  actor: string
  engineVersion: string
  ruleSetVersion: string
  schemaId: string
  configHash: string
  config: ValidationConfig
  exclusions: { sha256: string; line: number; reason: string }[]
  inputs: { kind: SourceKind; sha256: string; filename: string }[]
  integrity: { before: IntegrityCheck[]; after: IntegrityCheck[] }
  summary: Record<string, number> | null
  error: string | null
  dnvIds: string[]
}

export type DnvEntry = DnvFinding & { _id: string; sessionId: string; createdAt: string; createdBy: string; updatedAt: string; withdrawn: boolean }

export type Investigation = {
  statuses: { findingId: string; status: string; updatedAt: string; updatedBy: string }[]
  history: { _id: string; findingId: string; from: string | null; to: string; at: string; by: string }[]
  notes: { _id: string; findingId: string | null; text: string; createdAt: string; createdBy: string }[]
  links: { _id: string; a: string; b: string; reason: string; createdAt: string; createdBy: string }[]
}

export type SessionData = { session: Session; artifacts: Artifact[]; dnv: DnvEntry[]; runs: RunSummary[]; investigation: Investigation }

export type Result = ValidationResult

/** What the source viewer should show and highlight. */
export type Focus = { kind: SourceKind; lines: number[]; columns?: readonly string[] } | null

export type Ctx = {
  data: SessionData
  result: Result | null
  run: RunSummary | null
  reload: () => Promise<void>
  focus: (refs: readonly SourceRef[], columns?: readonly string[]) => void
  openFinding: (id: string) => void
  setError: (message: string | null) => void
}

export const STATUS_OPTIONS = ["New", "Under Investigation", "Awaiting Vessel Clarification", "Reviewed", "Closed"] as const
