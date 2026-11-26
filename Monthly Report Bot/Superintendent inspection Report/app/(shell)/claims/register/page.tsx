import type { Metadata } from "next"
import { ClaimRegister } from "@/components/gc/claim-register"

export const metadata: Metadata = {
  title: "Claim Register · Guarantee Claims",
}

export default function ClaimRegisterPage() {
  return <ClaimRegister />
}
