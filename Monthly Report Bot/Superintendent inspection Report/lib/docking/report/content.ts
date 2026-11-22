// Digital Docking · the Daily Report to owners: what it holds and how it reads as email text. Shared by the browser
// (live preview, "Copy email text") and the server (checks, PDF, issued versions), so both always produce the same text.
// Layout follows the Superintendent's own daily emails (DHT Leopard 2025): greeting, a short summary, the header lines
// (date and day, berth, dock entry and departure, ETD, weather…), timed events, then the jobs by department and by
// who did them, Class attendance and the service engineers.

export const REPORT_FORMAT = 1

export const SECTIONS = [
  { key: "deck_ship", group: "DECK", title: "Jobs carried out by Ship's Staff", department: "deck", performer: "Ship staff" },
  { key: "deck_yard", group: "DECK", title: "Jobs carried out by Yard Staff", department: "deck", performer: "Yard staff" },
  { key: "engine_ship", group: "ENGINE", title: "Jobs carried out by Ship's Staff", department: "engine", performer: "Ship staff" },
  { key: "engine_yard", group: "ENGINE", title: "Jobs carried out by Yard Staff", department: "engine", performer: "Yard staff" },
  { key: "class", group: "", title: "Class Surveyor attendance", department: null, performer: "Class surveyor" },
  { key: "service", group: "", title: "Job Done By Service Engineers", department: null, performer: "Service engineer" },
] as const

export type SectionKey = (typeof SECTIONS)[number]["key"]
export const SECTION_KEYS = SECTIONS.map((s) => s.key) as SectionKey[]

/** One numbered line of the report. `sources` are the vessel entries it was written from (their text stays on record). */
export type ReportItem = { id: string; text: string; company: string; photos: string[]; sources: string[] }
export type HeaderLine = { label: string; value: string }
/** A block of timed events, e.g. "17th Oct 2025:" with "2018 LT : Pilot onboard" lines. `carry` = copy to the next day's report. */
export type EventBlock = { id: string; title: string; text: string; carry: boolean }
export type ReportContent = {
  format: typeof REPORT_FORMAT
  greeting: string
  summary: string
  header: HeaderLine[]
  events: EventBlock[]
  sections: Record<SectionKey, ReportItem[]>
}
export type ReportContext = { dayNo: number; reportDate: string }

export const LIMITS = {
  greeting: 500, summary: 8000, headerLines: 20, label: 60, value: 300, events: 20, eventTitle: 120, eventText: 4000,
  items: 200, itemText: 2000, company: 80, photosPerItem: 60, photos: 800, sources: 40,
} as const

/** Owners' mail limit for one email (decided 2026-11-21); the PDF must fit within it. */
export const MAX_PDF_BYTES = 10 * 1024 * 1024

export const DEFAULT_GREETING = "Dear Sir\nGood day"
export const DEFAULT_SUMMARY = "Below is the work progress update at shipyard."
export const DEFAULT_HEADER_LABELS = ["Berth", "Vessel arrival shipyard", "Dry Dock entry", "Dry Dock Departure", "ETD", "Loss of time due to bad weather", "Weather"]

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]

function ordinal(n: number): string {
  const tens = n % 100
  if (tens >= 11 && tens <= 13) return `${n}th`
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`
}

/** "2025-10-21" → "21st October 2025", as the Superintendent writes it. */
export function longDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return iso
  return `${ordinal(Number(m[3]))} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`
}

export function dateLine(ctx: ReportContext): string {
  return `${longDate(ctx.reportDate)} / Day ${ctx.dayNo}`
}

export function emptySections(): Record<SectionKey, ReportItem[]> {
  return Object.fromEntries(SECTION_KEYS.map((k) => [k, []])) as unknown as Record<SectionKey, ReportItem[]>
}

export function itemLine(item: ReportItem): string {
  const text = item.text.trim().replace(/\s*\n\s*/g, " ")
  return item.company.trim() ? `${item.company.trim()} – ${text}` : text
}

/** The sections that have items, with their group heading ("DECK", "ENGINE") shown before the first of each group. */
export function filledSections(content: ReportContent) {
  let lastGroup = ""
  return SECTIONS.filter((s) => content.sections[s.key].length > 0).map((s) => {
    const showGroup = Boolean(s.group) && s.group !== lastGroup
    if (s.group) lastGroup = s.group
    return { ...s, showGroup, items: content.sections[s.key] }
  })
}

function paragraphs(text: string): string[] {
  return text.split(/\n/).map((l) => l.trimEnd()).filter((l) => l.trim())
}

/** The report as plain email text, ready to paste into Outlook (NeraVeda never sends it). */
export function emailText(content: ReportContent, ctx: ReportContext): string {
  const blocks: string[][] = []
  const opening = [...paragraphs(content.greeting), ...paragraphs(content.summary)]
  if (opening.length) blocks.push(opening)
  blocks.push([`Date – ${dateLine(ctx)}`, ...content.header.filter((h) => h.label.trim() && h.value.trim()).map((h) => `${h.label.trim()} – ${h.value.trim()}`)])
  for (const e of content.events) {
    const lines = paragraphs(e.text)
    if (!e.title.trim() && !lines.length) continue
    blocks.push([...(e.title.trim() ? [e.title.trim()] : []), ...lines])
  }
  for (const s of filledSections(content)) {
    blocks.push([...(s.showGroup ? [`${s.group}:`] : []), `${s.title}:`, ...s.items.map((item, i) => `${i + 1}.\t${itemLine(item)}`)])
  }
  return blocks.map((b) => b.join("\n")).join("\n\n") + "\n"
}

export type ContentProblem = { where: string; message: string }

/** What must be fixed before the report can be issued (a draft may be saved with these). */
export function issueProblems(content: ReportContent): ContentProblem[] {
  const problems: ContentProblem[] = []
  let items = 0
  for (const s of SECTIONS) {
    content.sections[s.key].forEach((item, i) => {
      items++
      if (!item.text.trim()) problems.push({ where: `${s.group ? `${s.group[0]}${s.group.slice(1).toLowerCase()} · ` : ""}${s.title}, item ${i + 1}`, message: "has no text. Describe the work or delete the item." })
    })
  }
  if (!items && !content.summary.trim()) problems.push({ where: "Report", message: "is empty: add a summary or at least one item." })
  return problems
}

/** Every photo id used by the report, each once, in report order. */
export function reportPhotos(content: ReportContent): string[] {
  return [...new Set(SECTION_KEYS.flatMap((k) => content.sections[k].flatMap((i) => i.photos)))]
}

const ID = /^[A-Za-z0-9_-]{1,40}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * Check untrusted report content (from the browser) and return a clean copy. Throws an Error with a message the
 * Superintendent can act on. Photo and entry ids are checked for shape here; that they belong to the docking is
 * checked by the server against the store.
 */
export function parseContent(value: unknown): ReportContent {
  const fail = (message: string): never => {
    throw new Error(message)
  }
  const obj = (v: unknown, what: string) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : fail(`${what} could not be read.`))
  const list = (v: unknown, what: string, max: number) => {
    if (!Array.isArray(v)) return fail(`${what} could not be read.`)
    if (v.length > max) fail(`${what}: at most ${max}.`)
    return v as unknown[]
  }
  const str = (v: unknown, what: string, max: number) => {
    if (v === undefined || v === null) return ""
    if (typeof v !== "string") return fail(`${what} must be text.`)
    if (v.length > max) fail(`${what} is longer than ${max} characters.`)
    return v
  }
  const ids = (v: unknown, what: string, max: number) => {
    const out = list(v ?? [], what, max).map((x) => (typeof x === "string" && UUID.test(x) ? x : fail(`${what} could not be read.`)))
    return [...new Set(out)]
  }
  const root = obj(value, "The report")
  if (root.format !== REPORT_FORMAT) fail("The report was written by another version of NeraVeda. Reload the page.")
  const header = list(root.header ?? [], "Header lines", LIMITS.headerLines).map((h, i) => {
    const line = obj(h, `Header line ${i + 1}`)
    return { label: str(line.label, `Header line ${i + 1} label`, LIMITS.label), value: str(line.value, `Header line ${i + 1}`, LIMITS.value) }
  })
  const seen = new Set<string>()
  const uniqueId = (v: unknown, what: string) => {
    const id = typeof v === "string" && ID.test(v) ? v : fail(`${what} could not be read.`)
    if (seen.has(id)) fail(`${what} appears twice.`)
    seen.add(id)
    return id
  }
  const events = list(root.events ?? [], "Timed events", LIMITS.events).map((e, i) => {
    const block = obj(e, `Event block ${i + 1}`)
    return {
      id: uniqueId(block.id, `Event block ${i + 1}`), title: str(block.title, `Event block ${i + 1} title`, LIMITS.eventTitle),
      text: str(block.text, `Event block ${i + 1}`, LIMITS.eventText), carry: block.carry === true,
    }
  })
  const rawSections = obj(root.sections ?? {}, "The report sections")
  for (const key of Object.keys(rawSections)) if (!(SECTION_KEYS as string[]).includes(key)) fail(`Unknown report section "${key.slice(0, 40)}".`)
  let photos = 0
  const sections = emptySections()
  for (const s of SECTIONS) {
    sections[s.key] = list(rawSections[s.key] ?? [], s.title, LIMITS.items).map((it, i) => {
      const item = obj(it, `${s.title}, item ${i + 1}`)
      const where = `${s.title}, item ${i + 1}`
      const parsed: ReportItem = {
        id: uniqueId(item.id, where), text: str(item.text, where, LIMITS.itemText), company: str(item.company, `${where} company`, LIMITS.company),
        photos: ids(item.photos, `${where} photos`, LIMITS.photosPerItem), sources: ids(item.sources, `${where} sources`, LIMITS.sources),
      }
      photos += parsed.photos.length
      return parsed
    })
  }
  if (photos > LIMITS.photos) fail(`The report has ${photos} photos; at most ${LIMITS.photos}.`)
  return {
    format: REPORT_FORMAT, greeting: str(root.greeting, "The greeting", LIMITS.greeting), summary: str(root.summary, "The summary", LIMITS.summary),
    header, events, sections,
  }
}
