import type { Metadata } from "next"
import { RegisterSetup } from "@/components/gc/register-setup"

export const metadata: Metadata = {
  title: "Guided set-up · Guarantee Claims",
}

export default function RegisterSetupPage() {
  return <RegisterSetup />
}
