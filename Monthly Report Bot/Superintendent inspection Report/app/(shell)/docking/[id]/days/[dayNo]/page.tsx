import type { Metadata } from "next"
import { DayReview } from "@/components/docking/day-review"

export const metadata: Metadata = {
  title: "Day · Digital Docking",
}

export default function DockingDayPage() {
  return <DayReview />
}
