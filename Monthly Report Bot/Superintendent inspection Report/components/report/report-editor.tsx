"use client"

import { ArrowLeft, ArrowRight, ChevronLeft, FileDown, Loader2 } from "lucide-react"
import Link from "next/link"
import { useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { OnlinePill, SavePill } from "@/components/status-pill"
import { Button, buttonVariants } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { useReportEditor } from "@/hooks/use-report-editor"
import { useAutoFlags, usePendingSnapshot } from "@/hooks/use-vessel-master"
import { isV2 } from "@/lib/particulars"
import { generateReportPdf } from "@/lib/pdf"
import {
  CONDITION_SECTIONS,
  DETAILS_GROUPS,
  FORM_CODE,
  MANAGEMENT_SECTION_GROUPS,
  PARTICULARS_GROUPS,
  SECTIONS,
  overallProgress,
  sectionProgress,
  type ConditionEntry,
  type Report,
  type SectionId,
} from "@/lib/form-schema"
import { ConditionList } from "./condition-list"
import { CriticalEquipmentSection } from "./critical-equipment-section"
import { FieldGroups } from "./field-grid"
import { ParticularsV2 } from "./particulars-v2"
import { VesselPicker } from "./vessel-picker"
import { PhotosSection } from "./photos-section"
import { ScopeSection } from "./scope-section"
import { SectionNav } from "./section-nav"
import { SignoffSection } from "./signoff-section"
import { SummarySection } from "./summary-section"
import { SyncConflictBanner } from "./sync-conflict-banner"
import { ApprovedBanner, LockedBanner } from "./approval-banner"
import { SectionBuilder } from "./narrative/section-builder"
import { CONDITION_ITEM_SECTIONS } from "@/lib/narrative/sections"
import { applyLinkedChange, vesselNameMismatch } from "@/lib/linked-fields"
import { outstandingBySection, outstandingForReview, reportStage } from "@/lib/completeness"
import { AlertCircle, BadgeCheck, ShieldCheck } from "lucide-react"

const DESCRIPTIONS: Partial<Record<SectionId, string>> = {
  details: "Who inspected which vessel, where and when.",
  particulars: "Key particulars of the vessel. Pre-fill once and reuse for future inspections.",
  summary: "Each part is built from structured selections and checked against the rest of this report.",
  scope: "Tick every area covered during this inspection.",
  hull: "Rate the hull, then build the remarks from what was seen and how: plating, markings, coating, underwater inspection and performance.",
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
  signoff: "The Superintendent signs; the Fleet Manager reviews and approves before submission.",
}

type StringKeys = "details" | "particulars" | "summary" | "management"

export function ReportEditor({ id }: { id: string }) {
  const { report, photos, isLoading, saveState, approved, conflict, locked, resolveConflict, withdraw, update, saveNow, addPhoto, updatePhoto, removePhoto } =
    useReportEditor(id)
  const [active, setActive] = useState<SectionId>("details")
  const [exporting, setExporting] = useState(false)
  const topRef = useRef<HTMLDivElement>(null)

  const progress = useMemo(() => (report ? sectionProgress(report, photos.length) : null), [report, photos.length])
  const overall = report ? overallProgress(report, photos.length) : 0
  const outstanding = useMemo(() => (report ? outstandingForReview(report, photos.length) : []), [report, photos.length])
  const outstandingMap = useMemo(() => outstandingBySection(outstanding), [outstanding])
  // Vessel Master: complete particulars chosen offline, and report mandatory values the master could not supply.
  usePendingSnapshot(report, update)
  useAutoFlags(report, update)

  if (isLoading || !report || !progress) {
    return (
      <div className="flex min-h-dvh items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        Opening report…
      </div>
    )
  }

  const setString = (section: StringKeys) => (key: string, value: string) =>
    update((r) =>
      // Details and Particulars share some facts (vessel name, port → place, inspection end → date): keep them in step.
      section === "details" || section === "particulars"
        ? applyLinkedChange(r, section, key, value)
        : { ...r, [section]: { ...r[section], [key]: value } },
    )

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
              <SavePill state={conflict ? "conflict" : locked ? "locked" : saveState} />
              <StagePill stage={reportStage(report, photos.length)} outstanding={outstanding.length} onClick={() => go("signoff")} />
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
          <SectionNav active={active} progress={progress} outstanding={outstandingMap} onSelect={go} />
        </aside>

        <main className="min-w-0 flex-1 scroll-mt-32" ref={topRef}>
          {conflict ? (
            <SyncConflictBanner conflict={conflict} onResolve={resolveConflict} />
          ) : locked ? (
            <LockedBanner lock={locked} onWithdraw={withdraw} onResolve={resolveConflict} />
          ) : approved ? (
            <ApprovedBanner approvedBy={report.signoff.fleetManagerName ?? ""} approvedOn={report.signoff.fleetManagerDate ?? ""} onWithdraw={withdraw} />
          ) : null}
          <div className="mb-6 flex flex-col gap-1">
            <p className="font-mono text-xs text-muted-foreground">
              Section {index + 1} of {SECTIONS.length}
            </p>
            <h2 className="text-2xl font-semibold tracking-tight text-balance">{current.title}</h2>
            {DESCRIPTIONS[active] && (
              <p className="text-sm text-muted-foreground text-pretty">
                {active === "particulars" && isV2(report) ? "Key particulars of the vessel, from the Vessel Master." : DESCRIPTIONS[active]}
              </p>
            )}
            {active !== "signoff" && outstandingMap.get(active)?.length ? (
              <p className="mt-1 flex items-start gap-1.5 text-xs text-destructive">
                <AlertCircle className="mt-px size-3.5 shrink-0" aria-hidden />
                <span>
                  Mandatory, still outstanding: {outstandingMap.get(active)!.map((item) => item.label).join("; ")}. Fields marked * must be completed before the
                  report can be approved.
                </span>
              </p>
            ) : null}
          </div>

          {/* An approved report is read-only: every control inside is disabled (the editor also ignores changes). */}
          <fieldset disabled={approved} className="contents">
          <SectionBody
            active={active}
            report={report}
            photos={photos}
            setString={setString}
            setCondition={setCondition}
            update={update}
            saveNow={saveNow}
            addPhoto={addPhoto}
            updatePhoto={updatePhoto}
            removePhoto={removePhoto}
            go={go}
          />
          </fieldset>

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
  saveNow: ReturnType<typeof useReportEditor>["saveNow"]
  addPhoto: ReturnType<typeof useReportEditor>["addPhoto"]
  updatePhoto: ReturnType<typeof useReportEditor>["updatePhoto"]
  removePhoto: ReturnType<typeof useReportEditor>["removePhoto"]
  go: (section: SectionId) => void
}

function StagePill({ stage, outstanding, onClick }: { stage: ReturnType<typeof reportStage>; outstanding: number; onClick: () => void }) {
  const styles = {
    draft: "border-destructive/40 text-destructive",
    "awaiting-approval": "border-primary/40 text-primary",
    approved: "border-success/40 text-success",
  }[stage]
  const Icon = stage === "draft" ? AlertCircle : stage === "approved" ? BadgeCheck : ShieldCheck
  const text =
    stage === "draft" ? `DRAFT · ${outstanding} mandatory outstanding` : stage === "approved" ? "Approved by Fleet Manager" : "Awaiting Fleet Manager approval"
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50 ${styles}`}
      title="Open Sign-off"
    >
      <Icon className="size-3" aria-hidden />
      {text}
    </button>
  )
}

function SectionBody({ active, report, photos, setString, setCondition, update, saveNow, addPhoto, updatePhoto, removePhoto, go }: BodyProps) {
  switch (active) {
    case "details":
      return (
        <FieldGroups
          groups={DETAILS_GROUPS}
          values={report.details}
          idPrefix="details"
          onChange={setString("details")}
          // New reports choose the vessel from the Vessel Master (or "Other vessel"); earlier reports keep the typed name.
          renderField={isV2(report) ? (field, fieldId) => (field.key === "vessel" ? <VesselPicker report={report} update={update} id={fieldId} /> : undefined) : undefined}
        />
      )
    case "particulars": {
      if (isV2(report)) return <ParticularsV2 report={report} update={update} go={go} />
      const mismatch = vesselNameMismatch(report)
      return (
        <div className="flex flex-col gap-6">
          {mismatch && (
            <div className="flex flex-col gap-2 rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
              <p>
                The vessel is “{mismatch.vessel}” in Inspection Details but “{mismatch.ship}” here. They are now linked: choose the spelling to use in
                both.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => setString("details")("vessel", mismatch.vessel)}>
                  Use “{mismatch.vessel}”
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => setString("details")("vessel", mismatch.ship)}>
                  Use “{mismatch.ship}”
                </Button>
              </div>
            </div>
          )}
          <FieldGroups groups={PARTICULARS_GROUPS} values={report.particulars} idPrefix="particulars" onChange={setString("particulars")} />
        </div>
      )
    }
    case "summary":
      return <SummarySection report={report} update={update} saveNow={saveNow} />
    case "scope":
      return <ScopeSection values={report.scope} onChange={(scope) => update((r) => ({ ...r, scope }))} />
    case "hull": case "mainDeck": case "cargoBallast": case "deckMachinery": case "accommodation": case "safety": case "navigation": case "engine": {
      const section = CONDITION_SECTIONS.find((entry) => entry.id === active)!
      // Items whose remarks are written by a structured builder (e.g. Hull), as on the Executive Summary page.
      const builders = section.items.flatMap((item) => {
        const spec = CONDITION_ITEM_SECTIONS[item.key]
        return spec ? [{ key: item.key, spec }] : []
      })
      return (
        <div className="flex flex-col gap-6">
          <ConditionList
            items={section.items}
            values={section.source === "deck" ? report.deck : report.engine}
            idPrefix={active}
            onChange={setCondition(section.source)}
            builtRemarks={Object.fromEntries(builders.map((b) => [b.key, `${b.spec.title} remarks builder`]))}
          />
          {builders.map((b) => (
            <SectionBuilder key={b.spec.id} spec={b.spec} report={report} update={update} saveNow={saveNow} />
          ))}
        </div>
      )
    }
    case "critical":
      return (
        <CriticalEquipmentSection
          values={report.management}
          results={report.criticalResults ?? {}}
          onChange={setString("management")}
          onResult={(key, result) => update((r) => ({ ...r, criticalResults: { ...(r.criticalResults ?? {}), [key]: result } }))}
        />
      )
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
          photoCount={photos.length}
          onWorklist={(key, value) => update((r) => ({ ...r, worklist: { ...r.worklist, [key]: value } }))}
          onSignoff={(patch) => update((r) => ({ ...r, signoff: { ...r.signoff, ...patch } }))}
          onDetails={(patch) => update((r) => ({ ...r, details: { ...r.details, ...patch } }))}
          onGoTo={go}
        />
      )
  }
}
