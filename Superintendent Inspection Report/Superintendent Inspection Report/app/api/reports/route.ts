import { NextResponse } from "next/server"
import { getDb } from "@/lib/mongodb"

export async function GET() {
  try {
    const db = await getDb()
    const reports = await db
      .collection("reports")
      .find({}, { projection: { _id: 0, id: 1, updatedAt: 1, createdAt: 1, "details.vessel": 1, "details.reportNo": 1, "details.port": 1, "details.dateFrom": 1 } })
      .sort({ updatedAt: -1 })
      .limit(500)
      .toArray()
    return NextResponse.json({ reports })
  } catch (error) {
    console.error("[reports:list]", error)
    return NextResponse.json({ error: "Failed to load reports" }, { status: 500 })
  }
}
