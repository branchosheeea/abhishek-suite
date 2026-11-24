import { randomUUID } from "node:crypto"
import { NextResponse } from "next/server"
import { getDb, ID_PATTERN } from "@/lib/mongodb"
import { approvalOf, checkReopenReason, planReopen, readBaseUpdatedAt, withdrawnSignoff } from "@/lib/report-write"
import { route } from "@/lib/server/http"
import { actor, recordReportEvent, savedBy } from "@/lib/server/report-audit"

// Withdraw the Fleet Manager's approval of a report, so it can be corrected and approved again.
// Anyone with the Inspection Reports right may do it, with a reason. Before the approval is removed, the approved
// version and its photos are kept permanently in report_revisions / report_revision_photos, with who withdrew it,
// when and why; the withdrawal is also written to report_audit.

type Ctx = { params: Promise<{ id: string }> }

export const POST = route<Ctx>({ mutating: true, limit: ["write", 600] }, async (req, { params }) => {
  const { id } = await params
  if (!ID_PATTERN.test(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 })

  const raw = await req.text()
  if (raw.length > 20_000) return NextResponse.json({ error: "Payload too large" }, { status: 413 })
  let body: Record<string, unknown>
  try {
    body = JSON.parse(raw || "{}")
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }
  const checked = checkReopenReason(body.reason)
  if ("error" in checked) return NextResponse.json({ error: checked.error }, { status: 400 })

  const db = await getDb()
  const reports = db.collection("reports")
  const stored = await reports.findOne({ id }, { projection: { _id: 0 } })
  const plan = planReopen(stored, readBaseUpdatedAt(body.baseUpdatedAt))
  if (plan === "not-found") return NextResponse.json({ status: "not-found", error: "This report is not in the cloud." }, { status: 404 })
  if (plan === "not-approved") {
    return NextResponse.json({ status: "not-approved", error: "This report is not approved in the cloud.", serverUpdatedAt: Number(stored!.updatedAt) }, { status: 409 })
  }
  if (plan === "stale") return NextResponse.json({ status: "stale", serverUpdatedAt: Number(stored!.updatedAt) }, { status: 409 })

  const revisions = db.collection("report_revisions")
  const revisionPhotos = db.collection("report_revision_photos")
  const who = actor()
  const withdrawnAt = new Date().toISOString()
  const revisionId = randomUUID()
  const revision = (await revisions.countDocuments({ reportId: id })) + 1
  const photos = await db.collection("photos").find({ reportId: id }, { projection: { _id: 0 } }).toArray()

  // The approved version is kept before anything is changed.
  await revisions.insertOne({
    id: revisionId, reportId: id, revision, ...approvalOf(stored!), reason: checked.reason,
    withdrawnAt, withdrawnBy: who.sub, withdrawnByName: who.name, photoIds: photos.map((p) => p.id), report: stored,
  })
  for (const photo of photos) await revisionPhotos.insertOne({ revisionId, reportId: id, photo })

  const updatedAt = Math.max(Date.now(), Number(stored!.updatedAt) + 1)
  const result = await reports.updateOne(
    { id, updatedAt: stored!.updatedAt },
    { $set: { signoff: withdrawnSignoff(stored!.signoff), updatedAt, savedBy: savedBy() } },
  )
  if (result.matchedCount === 0) {
    // Saved again in the meantime: nothing was withdrawn, so the copy just made is not a record of anything.
    await revisions.deleteOne({ id: revisionId })
    await revisionPhotos.deleteMany({ revisionId })
    const now = await reports.findOne({ id }, { projection: { updatedAt: 1 } })
    return NextResponse.json({ status: "stale", serverUpdatedAt: Number(now?.updatedAt) }, { status: 409 })
  }
  await recordReportEvent(db, id, "withdraw-approval", { revision, revisionId, reason: checked.reason, ...approvalOf(stored!) })
  return NextResponse.json({ status: "ok", updatedAt, previousUpdatedAt: Number(stored!.updatedAt), revision })
})
