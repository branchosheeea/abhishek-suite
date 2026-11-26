import type { Metadata } from "next"
import { Correspondence } from "@/components/gc/correspondence"

export const metadata: Metadata = {
  title: "Correspondence · Guarantee Claims",
}

export default function CorrespondencePage() {
  return <Correspondence />
}
