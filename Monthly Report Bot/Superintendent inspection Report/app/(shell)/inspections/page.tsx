import type { Metadata } from "next"
import { ReportList } from "@/components/dashboard/report-list"

export const metadata: Metadata = {
  title: "Inspection Reports",
}

export default function InspectionsPage() {
  return <ReportList />
}
