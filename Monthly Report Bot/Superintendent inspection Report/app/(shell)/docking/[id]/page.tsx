import type { Metadata } from "next"
import { DockingOverview } from "@/components/docking/docking-overview"

export const metadata: Metadata = {
  title: "Docking · Digital Docking",
}

export default function DockingOverviewPage() {
  return <DockingOverview />
}
