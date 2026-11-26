import type { Metadata } from "next"
import { ReviewQueue } from "@/components/gc/review-queue"

export const metadata: Metadata = {
  title: "Review Queue · Guarantee Claims",
}

export default function ReviewQueuePage() {
  return <ReviewQueue />
}
