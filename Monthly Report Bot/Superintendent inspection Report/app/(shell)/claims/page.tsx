import type { Metadata } from "next"
import { CommandCentre } from "@/components/gc/command-centre"

export const metadata: Metadata = {
  title: "Command Centre · Guarantee Claims",
}

export default function CommandCentrePage() {
  return <CommandCentre />
}
