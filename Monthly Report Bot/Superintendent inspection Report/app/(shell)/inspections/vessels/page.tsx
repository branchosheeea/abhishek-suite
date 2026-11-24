import type { Metadata } from "next"
import { VesselMasterReview } from "@/components/vessels/vessel-master-review"

export const metadata: Metadata = {
  title: "Vessel Master",
}

export default function VesselMasterPage() {
  return <VesselMasterReview />
}
