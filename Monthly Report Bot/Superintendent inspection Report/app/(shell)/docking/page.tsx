import type { Metadata } from "next"
import { DockingList } from "@/components/docking/docking-list"

export const metadata: Metadata = {
  title: "Digital Docking",
}

export default function DockingPage() {
  return <DockingList />
}
