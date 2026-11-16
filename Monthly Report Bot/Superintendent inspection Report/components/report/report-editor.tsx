"use client"

import { ArrowLeft, ArrowRight, ChevronLeft, FileDown, Loader2 } from "lucide-react"
import Link from "next/link"
import { useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { OnlinePill, SavePill } from "@/components/status-pill"
import { Button, buttonVariants } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { useReportEditor } from "@/hooks/use-report-editor"
import { generateReportPdf } from "@/lib/pdf"
import {
  CONDITION_SECTIONS,
  DETAILS_GROUPS,
  FORM_CODE,
  MANAGEMENT_SECTION_GROUPS,
  PARTICULARS_GROUPS,
  SECTIONS,
  SUMMARY_FIELDS,
  overallProgress,
  sectionProgress,
  type ConditionEntry,
  type Report,
  type SectionId,
} from "@/lib/form-schema"
import { ConditionList } from "./condition-list"
import { CriticalEquipmentSection } from "./critical-equipment-section"
import { FieldGroups } from "./field-grid"
import { PhotosSection } from "./photos-section"
import { ScopeSection } from "./scope-section"
import { SectionNav } from "./section-nav"
import { SignoffSection } from "./signoff-section"

const DESCRIPTIONS: Partial<Record<SectionId, string>> = {
  details: "Who inspected which vessel, where and when.",
  particulars: "Key particulars of the vessel. Pre-fill once and reuse for future inspections.",
  summary: "High-level findings for owners and management.",
  scope: "Tick every area covered during this inspection.",
  hull: "Inspect hull structure, coating, markings, and record findings.",
  mainDeck: "Inspect the main deck and record findings.",
  cargoBallast: "Inspect cargo and water ballast tanks, and record findings.",
  deckMachinery: "Inspect deck machinery and cargo handling equipment.",
  accommodation: "Inspect accommodation spaces and record findings.",
  safety: "Inspect life saving and fire fighting appliances.",
  navigation: "Inspect navigation equipment and record findings.",
  engine: "Rate each machinery space and record findings.",
  critical: "Evaluate critical equipment and record test parameters.",
  system: "Evaluate planned maintenance system implementation.",
  survey: "Record class survey status.",
  budget: "Record budget observations.",
  crew: "Record crew complement and key officers, then assess performance and training needs.",
  photos: "Up to 50 photographs can be included in the owners' report.",
  signoff: "Confirm the work list and sign off the report.",
}

type StringKeys = "details" | "particulars" | "summary" | "management"

export function ReportEditor({ id }: { id: string }) {
  const { report, photos, isLoading, saveState, update, addPhoto, updatePhoto, removePhoto } = useReportEditor(id)
  const [active, setActive] = useState<SectionId>("details")
  const [exporting, setExporting] = useState(false)
  const topRef = useRef<HTMLDivElement>(null)

  const progress = useMemo(() => (report ? sectionProgress(report, photos.length) : null), [report, photos.length])
  const overall = report ? overallProgress(report, photos.length) : 0

  if (isLoading || !report || !progress) {
    return (
      <div className="flex min-h-dvh items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        Opening report…
      </div>
    )
  }

  const setString = (section: StringKeys) => (key: string, value: string) =>
    update((r) => ({ ...r, [section]: { ...r[section], [key]: value } }))

  const setCondition = (section: "deck" | "engine") => (key: string, entry: ConditionEntry) =>
    update((r) => ({ ...r, [section]: { ...r[section], [key]: entry } }))

  const index = SECTIONS.findIndex((s) => s.id === active)
  const current = SECTIONS[index]

  const go = (next: SectionId) => {
    setActive(next)
    topRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
  }

  const exportPdf = async () => {
    setExporting(true)
    try {
      await generateReportPdf(report, photos)
      toast.success("PDF downloaded")
    } catch (error) {
      console.error(error)
      toast.error("Could not generate the PDF")
    } finally {
      setExporting(false)
    }
  }

  const title = report.details.vessel || report.particulars.shipName || "Untitled inspection"

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-20 border-b bg-background/85 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3">
          <Link
            href="/inspections"
            aria-label="Back to inspection reports"
            className={buttonVariants({ variant: "ghost", size: "icon" })}
          >
            <ChevronLeft aria-hidden />
          </Link>
          <div className="flex min-w-0 flex-1 flex-col">
            <h1 className="truncate text-base font-semibold">{title}</h1>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
              <span className="font-mono text-xs text-muted-foreground">
                {report.details.reportNo ? `#${report.details.reportNo}` : `Form ${FORM_CODE}`}
              </span>
              <SavePill state={saveState} />
            </div>
          </div>
          <OnlinePill className="hidden sm:inline-flex" />
          <Button onClick={exportPdf} disabled={exporting}>
            {exporting ? <Loader2 className="animate-spin" aria-hidden /> : <FileDown aria-hidden />}
            <span className="hidden sm:inline">Export PDF</span>
            <span className="sm:hidden">PDF</span>
          </Button>
        </div>
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 pb-2">
          <Progress value={overall} className="h-1.5 flex-1" aria-label="Overall completion" />
          <span className="font-mono text-xs text-muted-foreground tabular-nums">{overall}%</span>
        </div>
      </header>

      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-6 lg:flex-row lg:gap-10">
        <aside className="lg:sticky lg:top-28 lg:w-56 lg:shrink-0 lg:self-start">
          <SectionNav active={active} progress={progress} onSelect={go} />
        </aside>

        <main className="min-w-0 flex-1 scroll-mt-32" ref={topRef}>
          <div className="mb-6 flex flex-col gap-1">
            <p className="font-mono text-xs text-muted-foreground">
              Section {index + 1} of {SECTIONS.length}
            </p>
            <h2 className="text-2xl font-semibold tracking-tight text-balance">{current.title}</h2>
            {DESCRIPTIONS[active] && <p className="text-sm text-muted-foreground text-pretty">{DESCRIPTIONS[active]}</p>}
          </div>

          <SectionBody
            active={active}
            report={report}
            photos={photos}
            setString={setString}
            setCondition={setCondition}
            update={update}
            addPhoto={addPhoto}
            updatePhoto={updatePhoto}
            removePhoto={removePhoto}
          />

          <div className="mt-10 flex items-center justify-between border-t pt-6">
            <Button variant="outline" disabled={index === 0} onClick={() => go(SECTIONS[index - 1].id)}>
              <ArrowLeft aria-hidden />
              {index > 0 ? SECTIONS[index - 1].short : "Previous"}
            </Button>
            {index < SECTIONS.length - 1 ? (
              <Button onClick={() => go(SECTIONS[index + 1].id)}>
                {SECTIONS[index + 1].short}
                <ArrowRight aria-hidden />
              </Button>
            ) : (
              <Button onClick={exportPdf} disabled={exporting}>
                <FileDown aria-hidden />
                Export PDF
              </Button>
            )}
          </div>
        </main>
      </div>
    </div>
  )
}

type BodyProps = {
  active: SectionId
  report: Report
  photos: ReturnType<typeof useReportEditor>["photos"]
  setString: (s: StringKeys) => (key: string, value: string) => void
  setCondition: (s: "deck" | "engine") => (key: string, entry: ConditionEntry) => void
  update: ReturnType<typeof useReportEditor>["update"]
  addPhoto: ReturnType<typeof useReportEditor>["addPhoto"]
  updatePhoto: ReturnType<typeof useReportEditor>["updatePhoto"]
  removePhoto: ReturnType<typeof useReportEditor>["removePhoto"]
}

function SectionBody({ active, report, photos, setString, setCondition, update, addPhoto, updatePhoto, removePhoto }: BodyProps) {
  switch (active) {
    case "details":
      return <FieldGroups groups={DETAILS_GROUPS} values={report.details} idPrefix="details" onChange={setString("details")} />
    case "particulars":
      return (
        <FieldGroups groups={PARTICULARS_GROUPS} values={report.particulars} idPrefix="particulars" onChange={setString("particulars")} />
      )
    case "summary":
      return <FieldGroups groups={[{ fields: SUMMARY_FIELDS }]} values={report.summary} idPrefix="summary" onChange={setString("summary")} />
    case "scope":
      return <ScopeSection values={report.scope} onChange={(scope) => update((r) => ({ ...r, scope }))} />
    case "hull": case "mainDeck": case "cargoBallast": case "deckMachinery": case "accommodation": case "safety": case "navigation": case "engine": {
      const section = CONDITION_SECTIONS.find((entry) => entry.id === active)!
      return <ConditionList items={section.items} values={section.source === "deck" ? report.deck : report.engine} idPrefix={active} onChange={setCondition(section.source)} />
    }
    case "critical":
      return <CriticalEquipmentSection values={report.management} onChange={setString("management")} />
    case "system": case "survey": case "budget": case "crew":
      return (
        <FieldGroups groups={MANAGEMENT_SECTION_GROUPS[active]} values={report.management} idPrefix={active} onChange={setString("management")} />
      )
    case "photos":
      return <PhotosSection photos={photos} onAdd={addPhoto} onUpdate={updatePhoto} onRemove={removePhoto} />
    case "signoff":
      return (
        <SignoffSection
          report={report}
          onWorklist={(key, value) => update((r) => ({ ...r, worklist: { ...r.worklist, [key]: value } }))}
          onSignoff={(patch) => update((r) => ({ ...r, signoff: { ...r.signoff, ...patch } }))}
        />
      )
  }
}
