import { NextResponse } from "next/server"
import { CONDITION_SECTIONS, createEmptyReport, overallProgress, type Report } from "@/lib/form-schema"
import { getDb } from "@/lib/mongodb"
import { isFinal } from "@/lib/completeness"
import { keyFigures } from "@/lib/condition-overview"
import { route } from "@/lib/server/http"

// Lightweight, read-only summary for the NeraVeda desktop home page.
// Covers reports synced to the cloud database only; drafts that exist only in a browser are not visible here.
// Field names are kept for the desktop home page: "actionRequired" lists items rated Deficient (plus Action required on
// the earlier rating scale) and "monitorCount" counts Degraded items (plus earlier Monitor). Condition ratings are not
// risk ratings. Open findings and Immediate actions come from the report's findings register.

const CONDITION_ITEMS = CONDITION_SECTIONS.flatMap((section) =>
  section.items.map((item) => ({ key: item.key, label: item.label, source: section.source })),
)

export const dynamic = "force-dynamic"

// The desktop launcher reads it with a 60 s service ticket; a signed-in browser may read it too.
export const GET = route({ mutating: false, auth: "user-or-service" }, async () => {
  try {
    const db = await getDb()
    const [docs, photoCounts, reportCount] = await Promise.all([
      db.collection("reports").find({}, { projection: { _id: 0 } }).sort({ updatedAt: -1 }).limit(200).toArray(),
      db.collection("photos").aggregate<{ _id: string; n: number }>([{ $group: { _id: "$reportId", n: { $sum: 1 } } }]).toArray(),
      db.collection("reports").countDocuments(),
    ])
    const photos = new Map(photoCounts.map((row) => [row._id, row.n]))

    const reports = docs.map((doc) => {
      const report = { ...createEmptyReport(String(doc.id)), ...(doc as unknown as Partial<Report>) } as Report
      const ratings = CONDITION_ITEMS.map((item) => ({ label: item.label, rating: report[item.source]?.[item.key]?.rating ?? "" }))
      const figures = keyFigures(report)
      return {
        id: report.id,
        vessel: (report.details?.vessel || report.particulars?.shipName || "").trim(),
        reportNo: report.details?.reportNo ?? "",
        port: report.details?.port ?? "",
        dateFrom: report.details?.dateFrom ?? "",
        dateTo: report.details?.dateTo ?? "",
        updatedAt: report.updatedAt,
        progress: overallProgress(report, photos.get(report.id) ?? 0),
        // Signed off = every mandatory input complete and approved by the Fleet Manager.
        signedOff: isFinal(report, photos.get(report.id) ?? 0),
        actionRequired: ratings.filter((r) => r.rating === "deficient" || r.rating === "poor").map((r) => r.label),
        monitorCount: ratings.filter((r) => r.rating === "degraded" || r.rating === "fair").length,
        immediateCount: figures.immediate,
        openFindings: figures.openFindings,
        ratedCount: ratings.filter((r) => r.rating).length,
        itemCount: CONDITION_ITEMS.length,
      }
    })

    return NextResponse.json({
      app: "neraveda-web",
      scope: "cloud-synced reports",
      generatedAt: Date.now(),
      reportCount,
      reports,
    })
  } catch (error) {
    console.error("[inspections:summary]", error)
    return NextResponse.json({ error: "Summary unavailable" }, { status: 500 })
  }
})
