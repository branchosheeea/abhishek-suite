import { randomUUID } from "node:crypto"
import { NextResponse } from "next/server"
import { getDb, ID_PATTERN } from "@/lib/mongodb"
import { OPTIONAL_SECTIONS, REPORT_SECTIONS, approvalOf, planReportDelete, planReportSave, readBaseUpdatedAt } from "@/lib/report-write"
import { route } from "@/lib/server/http"
import { actor, recordReportEvent, savedBy } from "@/lib/server/report-audit"

// One inspection report. The rules for saving and deleting (conflicts, approved reports) are in lib/report-write.ts.

type Ctx = { params: Promise<{ id: string }> }

const MAX_BODY_BYTES = 2_000_000

const conflict = (serverUpdatedAt: unknown) =>
  NextResponse.json({ status: "stale", serverUpdatedAt: Number(serverUpdatedAt) }, { status: 409 })

const locked = (approval: { approvedBy: string; approvedOn: string }, serverUpdatedAt: unknown, error: string) =>
  NextResponse.json({ status: "locked", error, ...approval, serverUpdatedAt: Number(serverUpdatedAt) }, { status: 423 })

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

  const doc: Record<string, unknown> & { updatedAt: number } = { id, updatedAt, createdAt }
  for (const key of REPORT_SECTIONS) {
    const value = body[key]
    doc[key] = value && typeof value === "object" && !Array.isArray(value) ? value : {}
  }
  for (const key of OPTIONAL_SECTIONS) {
    const value = body[key]
    if (value && typeof value === "object" && !Array.isArray(value)) doc[key] = value
  }

  const db = await getDb()
  const reports = db.collection("reports")
  const stored = await reports.findOne({ id }, { projection: { _id: 0 } })
  const plan = planReportSave({ stored, incoming: doc, baseUpdatedAt: readBaseUpdatedAt(body.baseUpdatedAt) })

  switch (plan.action) {
    case "conflict":
      return conflict(plan.serverUpdatedAt)
    case "locked":
      await recordReportEvent(db, id, "change-refused", { what: "save" })
      return locked(plan, plan.serverUpdatedAt, "This report has been approved by the Fleet Manager and cannot be changed. Withdraw the approval first.")
    case "unchanged":
      return NextResponse.json({ status: "ok", updatedAt })
    case "insert":
      try {
        await reports.insertOne({ ...doc, savedBy: savedBy() })
      } catch (error) {
        // Another save created it a moment ago: report a conflict rather than overwrite it.
        if ((error as { code?: number }).code !== 11000) throw error
        const now = await reports.findOne({ id }, { projection: { updatedAt: 1 } })
        return conflict(now?.updatedAt)
      }
      break
    case "write":
    case "touch": {
      // Replace only the version that was checked: a save that slipped in between is not overwritten.
      const change = plan.action === "touch" ? { updatedAt, savedBy: savedBy() } : { ...doc, savedBy: savedBy() }
      const result = await reports.updateOne({ id, updatedAt: stored!.updatedAt }, { $set: change })
      if (result.matchedCount === 0) {
        const now = await reports.findOne({ id }, { projection: { updatedAt: 1 } })
        return conflict(now?.updatedAt)
      }
      break
    }
  }
  if (plan.approves) await recordReportEvent(db, id, "approve", approvalOf(doc))
  return NextResponse.json({ status: "ok", updatedAt })
})

// Deleting: an approved report cannot be deleted. A draft is moved, with its photos, to reports_deleted / photos_deleted
// (with who deleted it and when), so it can be recovered.
export const DELETE = route<Ctx>({ mutating: true, limit: ["write", 600] }, async (_req, { params }) => {
  const { id } = await params
  if (!ID_PATTERN.test(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 })
  const db = await getDb()
  const reports = db.collection("reports")
  const stored = await reports.findOne({ id }, { projection: { _id: 0 } })
  const plan = planReportDelete(stored)
  if (plan === "absent") return NextResponse.json({ status: "ok" })
  if (plan === "locked") {
    await recordReportEvent(db, id, "change-refused", { what: "delete" })
    return locked(approvalOf(stored!), stored!.updatedAt, "This report has been approved by the Fleet Manager and cannot be deleted. Withdraw the approval first.")
  }

  const who = actor()
  const deletion = { deletionId: randomUUID(), deletedAt: new Date().toISOString(), deletedBy: who.sub, deletedByName: who.name }
  const photos = await db.collection("photos").find({ reportId: id }, { projection: { _id: 0 } }).toArray()
  // Copies first: if anything stops half-way, the report exists twice rather than not at all.
  await db.collection("reports_deleted").insertOne({ ...stored, ...deletion })
  if (photos.length) await db.collection("photos_deleted").insertMany(photos.map((photo) => ({ ...photo, ...deletion })))
  const removed = await reports.deleteOne({ id, updatedAt: stored!.updatedAt })
  if (removed.deletedCount === 0) {
    // Saved again in the meantime: keep it, and drop the copies just made.
    await db.collection("reports_deleted").deleteOne({ deletionId: deletion.deletionId })
    await db.collection("photos_deleted").deleteMany({ deletionId: deletion.deletionId })
    const now = await reports.findOne({ id }, { projection: { updatedAt: 1 } })
    return conflict(now?.updatedAt)
  }
  await db.collection("photos").deleteMany({ reportId: id })
  await recordReportEvent(db, id, "delete", { deletionId: deletion.deletionId, photos: photos.length })
  return NextResponse.json({ status: "ok" })
})
