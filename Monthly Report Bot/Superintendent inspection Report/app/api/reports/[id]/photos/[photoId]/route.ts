import { NextResponse } from "next/server"
import { getDb, ID_PATTERN } from "@/lib/mongodb"
import { route } from "@/lib/server/http"

type Ctx = { params: Promise<{ id: string; photoId: string }> }

const MAX_PHOTO_BYTES = 3_500_000
const DATA_URL_PATTERN = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/

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
  await db.collection("photos").updateOne({ id: photoId, reportId: id }, { $set: doc }, { upsert: true })
  return NextResponse.json({ status: "ok" })
})

export const DELETE = route<Ctx>({ mutating: true, limit: ["write", 600] }, async (_req, { params }) => {
  const { id, photoId } = await params
  if (!ID_PATTERN.test(id) || !ID_PATTERN.test(photoId)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 })
  }
  const db = await getDb()
  await db.collection("photos").deleteOne({ id: photoId, reportId: id })
  return NextResponse.json({ status: "ok" })
})
