import type { Metadata } from "next"
import { ClaimWorkspace } from "@/components/gc/claim-workspace"

export const metadata: Metadata = {
  title: "Claim · Guarantee Claims",
}

export default function ClaimPage() {
  return <ClaimWorkspace />
}
