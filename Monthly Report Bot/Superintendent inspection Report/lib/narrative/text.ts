// Language helpers shared by every controlled-narrative section.
// Pure functions only: no React, no browser APIs, so they run in Node tests and on the server.

/** Gap markers are private-use characters, so they can never collide with user text. */
const GAP_OPEN = ""
const GAP_CLOSE = ""
const GAP_PATTERN = /([^]*)/g

/** Marks missing required data. Shown in the preview, always removed from copied or saved text. */
export function gap(label: string) {
  return `${GAP_OPEN}${label}${GAP_CLOSE}`
}

export function hasGap(text: string) {
  return text.includes(GAP_OPEN)
}

export function removeGaps(text: string) {
  return tidy(text.replace(GAP_PATTERN, " "))
}

export type Segment = { text: string } | { gap: string }

export function toSegments(text: string): Segment[] {
  const segments: Segment[] = []
  let last = 0
  for (const match of text.matchAll(GAP_PATTERN)) {
    if (match.index > last) segments.push({ text: text.slice(last, match.index) })
    segments.push({ gap: match[1] })
    last = match.index + match[0].length
  }
  if (last < text.length) segments.push({ text: text.slice(last) })
  return segments
}

/** Collapses whitespace and repairs punctuation left behind when optional parts are omitted. */
export function tidy(text: string) {
  return text
    .replace(/[ \t]+/g, " ")
    .replace(/ +([,.;:])/g, "$1")
    .replace(/([,;:])(?:\s*[,;:])+/g, "$1")
    .replace(/[,;:]\s*\./g, ".")
    .replace(/\.(?:\s*\.)+/g, ".")
    .replace(/\(\s*\)/g, "")
    .replace(/ +/g, " ")
    .trim()
}

/** Turns a clause into a sentence: tidy spacing, capital first letter, single closing full stop. */
export function sentence(text: string) {
  const clean = tidy(text)
  if (!clean) return ""
  const body = /[.!?]$/.test(clean) ? clean : `${clean}.`
  return capitalise(body)
}

export function paragraph(sentences: string[]) {
  return tidy(sentences.filter(Boolean).join(" "))
}

export function capitalise(text: string) {
  const i = text.search(/[A-Za-z]/)
  if (i < 0) return text
  return text.slice(0, i) + text[i].toUpperCase() + text.slice(i + 1)
}

/** Lower-cases the first letter only when it starts an ordinary word ("The" → "the", "SIRE" stays). */
export function lowerFirst(text: string) {
  if (/^[A-Z][a-z]/.test(text)) return text[0].toLowerCase() + text.slice(1)
  return text
}

/** Cleans free text typed by the user for use inside a generated sentence. */
export function cleanFragment(text: string | undefined) {
  return (text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s.,;:]+$/, "")
}

/** Cleans a user-written note that is inserted as complete sentences. */
export function cleanSentences(text: string | undefined) {
  const clean = (text ?? "").replace(/\s+/g, " ").trim()
  return clean ? sentence(clean) : ""
}

/**
 * Joins items with commas and "and" (British style, no serial comma), adding the serial comma only
 * when an item already contains "and", so the final item cannot be misread.
 */
export function joinList(items: string[], conjunction = "and") {
  const list = items.filter(Boolean)
  if (list.length <= 1) return list[0] ?? ""
  if (list.length === 2) return `${list[0]} ${conjunction} ${list[1]}`
  const serial = list.some((item) => /\band\b|,/.test(item)) ? "," : ""
  return `${list.slice(0, -1).join(", ")}${serial} ${conjunction} ${list[list.length - 1]}`
}

/**
 * Joins noun phrases that take "the": one shared article for one or two items (as in
 * "the associated inspection worklist and Defect and Damage Report List"), and one article per item
 * for three or more, so items containing "and" stay unambiguous.
 */
export function joinWithArticle(nouns: string[]) {
  const list = nouns.filter(Boolean)
  if (!list.length) return ""
  if (list.length <= 2) return `the ${joinList(list)}`
  return joinList(list.map((noun) => `the ${noun}`))
}

/** Adds the closing comma required after a place name that contains a comma ("Galle, Sri Lanka,"). */
export function place(text: string) {
  return text.includes(",") ? `${text},` : text
}

const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"]

export function ordinal(n: number) {
  if (n >= 1 && n <= ORDINALS.length) return ORDINALS[n - 1]
  const tens = n % 100
  const suffix = tens >= 11 && tens <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"
  return `${n}${suffix}`
}

export function wordCount(text: string) {
  return text.split(/\s+/).filter(Boolean).length
}

/**
 * Final safety net for text that will be copied or saved. Returns the problems found; an empty list means
 * the text is clean. Square/curly brackets are treated as unresolved placeholders, as are leaked
 * programming values.
 */
export function placeholderProblems(text: string): string[] {
  const problems: string[] = []
  if (hasGap(text)) problems.push("Missing information marker left in the text")
  if (/[[\]{}]/.test(text)) problems.push("Unresolved placeholder in brackets")
  if (/<[^>]*>/.test(text)) problems.push("Unresolved placeholder in angle brackets")
  if (/\b(?:undefined|null|NaN|TODO|TBA|TBC|XXX)\b/.test(text)) problems.push("Unresolved placeholder value")
  if (/ {2,}/.test(text)) problems.push("Double space")
  if (/ [,.;:]|[,;:]\s*[,.;:]|\.\s*\./.test(text)) problems.push("Empty or doubled punctuation")
  return problems
}
