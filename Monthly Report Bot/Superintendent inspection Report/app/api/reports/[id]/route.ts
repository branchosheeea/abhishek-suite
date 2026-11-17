import { NextResponse } from "next/server"
import { getDb, ID_PATTERN } from "@/lib/mongodb"

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

export async function GET(_req: Request, { params }: Ctx) {
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
}

export async function PUT(req: Request, { params }: Ctx) {
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
  const existing = await db.collection("reports").findOne({ id }, { projection: { updatedAt: 1 } })
  if (existing && Number(existing.updatedAt) > updatedAt) {
    return NextResponse.json({ status: "stale", serverUpdatedAt: existing.updatedAt }, { status: 409 })
  }

  await db.collection("reports").updateOne({ id }, { $set: doc }, { upsert: true })
  return NextResponse.json({ status: "ok", updatedAt })
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params
  if (!ID_PATTERN.test(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 })
  const db = await getDb()
  await Promise.all([
    db.collection("reports").deleteOne({ id }),
    db.collection("photos").deleteMany({ reportId: id }),
  ])
  return NextResponse.json({ status: "ok" })
}
