import type { Metadata } from "next"
import { Suspense } from "react"
import { ReportRoute } from "@/components/report/report-route"

export const metadata: Metadata = {
  title: "Edit report | Superintendent Inspection Report",
}

export default function ReportPage() {
  return (
    <Suspense fallback={null}>
      <ReportRoute />
    </Suspense>
  )
}
