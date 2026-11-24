"use client"

// Vessel Master in the report editor (lib/particulars.ts holds the rules):
//   useVesselList        the picker's vessels (network first, the copy saved on this device when offline)
//   useVesselActions     choose a master vessel or another vessel (confirmation when the report already has content)
//   usePendingSnapshot   a vessel chosen offline without a saved copy: completed as soon as the master can be reached
//   useAutoFlags         a mandatory value the Superintendent had to enter is reported to the office once (when online)

import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { useNeraVedaUser } from "@/components/shell/session-gate"
import { postFlag } from "@/components/vessels/flag-form"
import type { Report } from "@/lib/form-schema"
import { fromMaster, hasReportContent, markFlagSent, pendingFlags, selectOtherVessel, selectVessel, type Capture } from "@/lib/particulars"
import { fetchVesselList, fetchVesselView, type Cached } from "@/lib/vessel-cache"
import { FIELD } from "@/lib/vessel-master/fields"
import type { PickerEntry } from "@/lib/vessel-master/view"

type Update = (mutator: (draft: Report) => Report) => void

/** Name recorded with confirmations and entered values: the NeraVeda user, else the Superintendent named in the report. */
export function useRecordedBy(report: Report | null): string {
  const user = useNeraVedaUser()
  return user?.name || user?.sub || report?.details.inspectedBy || "Superintendent"
}

export function useVesselList() {
  const [list, setList] = useState<Cached<PickerEntry[]> | null | undefined>(undefined)
  const reload = useCallback(() => void fetchVesselList().then(setList), [])
  useEffect(reload, [reload])
  return { list, reload }
}

/** Capture a vessel: its master view when reachable (or saved on this device), else a pending snapshot. */
export async function captureFor(entry: Pick<PickerEntry, "vesselId" | "name" | "imo">): Promise<Capture> {
  const result = await fetchVesselView(entry.vesselId)
  if (result) {
    return { kind: "view", view: result.data, source: result.source === "network" ? "master" : "offline-cache", fetchedAt: result.fetchedAt, legacyKey: result.data.legacyKeys[0] }
  }
  return { kind: "pending", vesselId: entry.vesselId, name: entry.name, imo: entry.imo }
}

export function useVesselActions(report: Report, update: Update) {
  const by = useRecordedBy(report)
  const [busy, setBusy] = useState(false)

  const confirmChange = (to: string) => {
    const s = report.vesselSnapshot
    if (!s || s.source === "none" || !hasReportContent(report)) return true
    return window.confirm(
      `Change the vessel to ${to}?\n\nPrincipal Particulars are replaced by ${to}'s and values you entered there are cleared. ` +
        "The rest of the report (summary, ratings, findings, photos) is kept.",
    )
  }

  const choose = async (entry: PickerEntry) => {
    if (report.vesselSnapshot?.vesselId === entry.vesselId || !confirmChange(entry.name)) return
    setBusy(true)
    try {
      const capture = await captureFor(entry)
      update((r) => selectVessel(r, capture, by, new Date().toISOString()))
      if (capture.kind === "pending") toast.warning(`${entry.name}: particulars will be filled in when the Vessel Master can be reached.`)
      else if (capture.source === "offline-cache") toast.info(`${entry.name}: particulars from the copy saved on this device.`)
    } finally {
      setBusy(false)
    }
  }

  const chooseOther = () => {
    if (report.vesselSnapshot?.source === "not-in-master" || !confirmChange("a vessel not in the Vessel Master")) return
    update((r) => selectOtherVessel(r, fromMaster(r.vesselSnapshot) ? "" : (r.details.vessel ?? ""), by, new Date().toISOString()))
  }

  return { choose, chooseOther, busy }
}

export function usePendingSnapshot(report: Report | null, update: Update) {
  const by = useRecordedBy(report)
  const pending = report?.vesselSnapshot?.source === "pending" ? report.vesselSnapshot : null
  const trying = useRef(false)
  const vesselId = pending?.vesselId ?? null
  const name = pending?.name ?? ""
  const imo = pending?.imo ?? null

  useEffect(() => {
    if (!vesselId) return
    const attempt = async () => {
      if (trying.current || !navigator.onLine) return
      trying.current = true
      try {
        const capture = await captureFor({ vesselId, name, imo })
        if (capture.kind === "view") {
          update((r) => (r.vesselSnapshot?.source === "pending" && r.vesselSnapshot.vesselId === vesselId ? selectVessel(r, capture, by, new Date().toISOString(), true) : r))
          toast.success(`${name}: particulars filled in from the Vessel Master.`)
        }
      } finally {
        trying.current = false
      }
    }
    void attempt()
    window.addEventListener("online", attempt)
    return () => window.removeEventListener("online", attempt)
  }, [vesselId, name, imo, by, update])
}

export function useAutoFlags(report: Report | null, update: Update) {
  const keys = report ? pendingFlags(report) : []
  const signature = keys.map((k) => `${k}=${report?.particulars[k]}`).join("|")
  const latest = useRef(report)
  latest.current = report

  useEffect(() => {
    if (!signature) return
    // Sent a little after typing stops, so the office gets the finished value.
    const timer = window.setTimeout(async () => {
      const r = latest.current
      const s = r?.vesselSnapshot
      if (!r || !s?.vesselId || !navigator.onLine) return
      for (const key of pendingFlags(r)) {
        const master = s.fields[key]
        const value = r.particulars[key]
        const reason = `Entered in inspection report${r.details.reportNo ? ` ${r.details.reportNo}` : ""} because the Vessel Master ` +
          (master?.value ? `value "${master.value}" (${master.status}) was not used.` : `has no released value for this mandatory field (${FIELD[key]?.label ?? key}).`)
        try {
          const flag = await postFlag(s.vesselId, { field: key, proposedValue: value, reason, reportId: r.id })
          update((d) => markFlagSent(d, key, flag.flagId))
        } catch {
          return // offline or refused: tried again on the next change or visit
        }
      }
    }, 8000)
    return () => window.clearTimeout(timer)
  }, [signature, update])
}
