import { NextResponse } from "next/server"
import type { Photo } from "@/lib/form-schema"
import { getDb, ID_PATTERN } from "@/lib/mongodb"
import { approvalOf, planPhotoDelete, planPhotoSave } from "@/lib/report-write"
import { route } from "@/lib/server/http"
import { recordReportEvent } from "@/lib/server/report-audit"

type Ctx = { params: Promise<{ id: string; photoId: string }> }

const MAX_PHOTO_BYTES = 3_500_000
const DATA_URL_PATTERN = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/

// The photos of an approved report are part of what was approved: they cannot be added, changed or removed.
const locked = (report: Record<string, unknown>) =>
  NextResponse.json(
    {
      status: "locked",
      error: "This report has been approved by the Fleet Manager; its photos cannot be changed. Withdraw the approval first.",
      ...approvalOf(report),
      serverUpdatedAt: Number(report.updatedAt),
    },
    { status: 423 },
  )

const reportFor = (db: Awaited<ReturnType<typeof getDb>>, id: string) =>
  db.collection("reports").findOne({ id }, { projection: { _id: 0, signoff: 1, updatedAt: 1 } })

export const PUT = route<Ctx>({ mutating: true, limit: ["write", 600] }, async (req, { params }) => {
  const { id, photoId } = await params
  if (!ID_PATTERN.test(id) || !ID_PATTERN.test(photoId)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 })
  }

  const raw = await req.text()
  if (raw.length > MAX_PHOTO_BYTES) return NextResponse.json({ error: "Photo too large" }, { status: 413 })

  let body: Record<string, unknown>
  try {
    body = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const dataUrl = String(body.dataUrl ?? "")
  if (!DATA_URL_PATTERN.test(dataUrl)) return NextResponse.json({ error: "Invalid image" }, { status: 400 })

  const doc = {
    id: photoId,
    reportId: id,
    category: String(body.category ?? "").slice(0, 120),
    caption: String(body.caption ?? "").slice(0, 500),
    includeInOwnerReport: Boolean(body.includeInOwnerReport),
    dataUrl,
    createdAt: Number(body.createdAt) || Date.now(),
    updatedAt: Number(body.updatedAt) || Date.now(),
  }

  const db = await getDb()
  const report = await reportFor(db, id)
  const existing = report ? await db.collection<Photo>("photos").findOne({ id: photoId, reportId: id }, { projection: { _id: 0 } }) : null
  const plan = planPhotoSave(report, existing, doc)
  if (plan === "locked") {
    await recordReportEvent(db, id, "change-refused", { what: "photo", photoId })
    return locked(report!)
  }
  if (plan === "write") await db.collection("photos").updateOne({ id: photoId, reportId: id }, { $set: doc }, { upsert: true })
  return NextResponse.json({ status: "ok" })
})

export const DELETE = route<Ctx>({ mutating: true, limit: ["write", 600] }, async (_req, { params }) => {
  const { id, photoId } = await params
  if (!ID_PATTERN.test(id) || !ID_PATTERN.test(photoId)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 })
  }
  const db = await getDb()
  const report = await reportFor(db, id)
  if (planPhotoDelete(report) === "locked") {
    await recordReportEvent(db, id, "change-refused", { what: "photo-delete", photoId })
    return locked(report!)
  }
  await db.collection("photos").deleteOne({ id: photoId, reportId: id })
  return NextResponse.json({ status: "ok" })
})
