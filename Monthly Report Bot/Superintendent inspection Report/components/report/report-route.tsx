"use client"

import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { buttonVariants } from "@/components/ui/button"
import { ReportEditor } from "./report-editor"

export function ReportRoute() {
  const id = useSearchParams().get("id")
  if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-4 p-6 text-center">
        <h1 className="text-lg font-semibold">Report not found</h1>
        <Link href="/inspections" className={buttonVariants()}>
          Back to reports
        </Link>
      </main>
    )
  }
  return <ReportEditor key={id} id={id} />
}
