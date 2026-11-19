// Real OVD Admin screenshots through the local OCR (runs only when the git-ignored reference screenshots and
// tests/private/ovdadmin-screenshots.json are present). Expected values live in the private file, not here.
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { after, describe, test } from "node:test"
import { fileURLToPath } from "node:url"
import { readScreenshot } from "../lib/server/ocr"

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..")
const specPath = join(ROOT, "tests", "private", "ovdadmin-screenshots.json")
type Expected = { file: string; vessel: { name: string; imo: string }; period: { from: string; to: string } | null; totals: { issues: number | null; warnings: number | null }; items: { category: string; severity: string; eventUtc: string | null; eventName: string | null; fuel?: string | null }[] }
const spec: Expected[] | null = existsSync(specPath) ? JSON.parse(readFileSync(specPath, "utf8")) : null
const present = !!spec && spec.every((s) => existsSync(join(ROOT, "reference", s.file)))

describe("OVD Admin screenshots (reference files)", { skip: present ? false : "reference screenshots or tests/private/ovdadmin-screenshots.json not present" }, () => {
  after(() => setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref?.())
  for (const s of spec ?? []) {
    test(`${s.file}: every item, its severity, check, event time and event are read`, async () => {
      const r = await readScreenshot(new Uint8Array(readFileSync(join(ROOT, "reference", s.file))))
      assert.deepEqual(r.parse.vessel, s.vessel)
      assert.deepEqual(r.parse.period, s.period)
      assert.deepEqual(r.parse.totals, s.totals)
      assert.deepEqual(
        r.parse.items.map((i) => ({ category: i.category, severity: i.severity, eventUtc: i.eventUtc, eventName: i.eventName, ...(i.fuel ? { fuel: i.fuel } : {}) })),
        s.items.map((i) => ({ category: i.category, severity: i.severity, eventUtc: i.eventUtc, eventName: i.eventName, ...(i.fuel ? { fuel: i.fuel } : {}) })),
      )
      assert.ok(r.parse.items.every((i) => i.severitySource === "icon"))
    })
  }
})
