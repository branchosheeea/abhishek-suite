import { NextResponse } from "next/server"
import { CONDITION_SECTIONS, createEmptyReport, overallProgress, type Report } from "@/lib/form-schema"
import { getDb } from "@/lib/mongodb"

// Lightweight, read-only summary for the NeraVeda desktop home page.
// Covers reports synced to the cloud database only; drafts that exist only in a browser are not visible here.
// Ratings use the form's own scale: "poor" is shown to users as "Action required", "fair" as "Monitor".
// The form has no finding-closure field, so closure status is not reported.

const CONDITION_ITEMS = CONDITION_SECTIONS.flatMap((section) =>
  section.items.map((item) => ({ key: item.key, label: item.label, source: section.source })),
)

export const dynamic = "force-dynamic"

export async function GET() {
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
      const signoff = report.signoff ?? {}
      return {
        id: report.id,
        vessel: (report.details?.vessel || report.particulars?.shipName || "").trim(),
        reportNo: report.details?.reportNo ?? "",
        port: report.details?.port ?? "",
        dateFrom: report.details?.dateFrom ?? "",
        dateTo: report.details?.dateTo ?? "",
        updatedAt: report.updatedAt,
        progress: overallProgress(report, photos.get(report.id) ?? 0),
        signedOff: Boolean(signoff.superintendentName?.trim() && signoff.superintendentSignature),
        actionRequired: ratings.filter((r) => r.rating === "poor").map((r) => r.label),
        monitorCount: ratings.filter((r) => r.rating === "fair").length,
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
}
