import type { Metadata } from "next"
import { Suspense } from "react"
import { GcFrame } from "@/components/gc/gc-frame"

export const metadata: Metadata = {
  title: "Guarantee Claims",
}

// The frame (header, vessel context, sync state, sections) stays in place while moving between the sections.
// Suspense: the frame reads the vessel from the address.
export default function ClaimsLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense>
      <GcFrame>{children}</GcFrame>
    </Suspense>
  )
}
