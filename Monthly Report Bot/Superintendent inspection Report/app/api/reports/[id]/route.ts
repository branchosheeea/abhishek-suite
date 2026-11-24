import { NextResponse } from "next/server"
import { getDb, ID_PATTERN } from "@/lib/mongodb"
import { decideReportWrite, readBaseUpdatedAt } from "@/lib/report-write"
import { route } from "@/lib/server/http"

type Ctx = { params: Promise<{ id: string }> }

const ALLOWED_KEYS = [
  "details",
  "particulars",
  "summary",
  "scope",
  "worklist",
  "deck",
  "engine",
  "management",
  "signoff",
] as const

// Saved only when the request includes them. A browser tab still running an older version of the app does not
// send these, and must not wipe what a newer version saved.
const OPTIONAL_KEYS = ["narratives", "criticalResults"] as const

const MAX_BODY_BYTES = 2_000_000

export const GET = route<Ctx>({ mutating: false }, async (_req, { params }) => {
  const { id } = await params
  if (!ID_PATTERN.test(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 })
  const db = await getDb()
  const report = await db.collection("reports").findOne({ id }, { projection: { _id: 0 } })
  if (!report) return NextResponse.json({ error: "Not found" }, { status: 404 })
  const photos = await db
    .collection("photos")
    .find({ reportId: id }, { projection: { _id: 0 } })
    .sort({ createdAt: 1 })
    .toArray()
  return NextResponse.json({ report, photos })
})

export const PUT = route<Ctx>({ mutating: true, limit: ["write", 600] }, async (req, { params }) => {
  const { id } = await params
  if (!ID_PATTERN.test(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 })

  const raw = await req.text()
  if (raw.length > MAX_BODY_BYTES) return NextResponse.json({ error: "Payload too large" }, { status: 413 })

  let body: Record<string, unknown>
  try {
    body = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const updatedAt = Number(body.updatedAt)
  const createdAt = Number(body.createdAt)
  if (!Number.isFinite(updatedAt) || !Number.isFinite(createdAt)) {
    return NextResponse.json({ error: "Invalid timestamps" }, { status: 400 })
  }

  const doc: Record<string, unknown> = { id, updatedAt, createdAt }
  for (const key of ALLOWED_KEYS) {
    const value = body[key]
    doc[key] = value && typeof value === "object" && !Array.isArray(value) ? value : {}
  }
  for (const key of OPTIONAL_KEYS) {
    const value = body[key]
    if (value && typeof value === "object" && !Array.isArray(value)) doc[key] = value
  }

  const db = await getDb()
  const reports = db.collection("reports")
  const conflict = (serverUpdatedAt: unknown) =>
    NextResponse.json({ status: "stale", serverUpdatedAt: Number(serverUpdatedAt) }, { status: 409 })

  const existing = await reports.findOne({ id }, { projection: { updatedAt: 1 } })
  const decision = decideReportWrite({
    serverUpdatedAt: existing ? Number(existing.updatedAt) : null,
    updatedAt,
    baseUpdatedAt: readBaseUpdatedAt(body.baseUpdatedAt),
  })
  if (decision === "conflict") return conflict(existing!.updatedAt)
  if (decision === "unchanged") return NextResponse.json({ status: "ok", updatedAt })

  if (decision === "insert") {
    try {
      await reports.insertOne(doc)
    } catch (error) {
      // Another save created it a moment ago: report a conflict rather than overwrite it.
      if ((error as { code?: number }).code !== 11000) throw error
      const now = await reports.findOne({ id }, { projection: { updatedAt: 1 } })
      return conflict(now?.updatedAt)
    }
    return NextResponse.json({ status: "ok", updatedAt })
  }

  // Replace only the version that was checked above: a save that slipped in between is not overwritten.
  const result = await reports.updateOne({ id, updatedAt: existing!.updatedAt }, { $set: doc })
  if (result.matchedCount === 0) {
    const now = await reports.findOne({ id }, { projection: { updatedAt: 1 } })
    return conflict(now?.updatedAt)
  }
  return NextResponse.json({ status: "ok", updatedAt })
})

export const DELETE = route<Ctx>({ mutating: true, limit: ["write", 600] }, async (_req, { params }) => {
  const { id } = await params
  if (!ID_PATTERN.test(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 })
  const db = await getDb()
  await Promise.all([
    db.collection("reports").deleteOne({ id }),
    db.collection("photos").deleteMany({ reportId: id }),
  ])
  return NextResponse.json({ status: "ok" })
})
