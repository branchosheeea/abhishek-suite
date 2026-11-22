import type { Metadata } from "next"
import { ReportEditor } from "@/components/docking/report-editor"

export const metadata: Metadata = {
  title: "Daily report · Digital Docking",
}

export default function DockingDayReportPage() {
  return <ReportEditor />
}
