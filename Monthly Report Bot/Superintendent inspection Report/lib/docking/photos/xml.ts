// Digital Docking · Stage 1A: XML from inside an untrusted workbook.
// Office files never contain a DOCTYPE, so any DOCTYPE is refused outright: no entity definitions, no expansion attacks.
// Namespace prefixes are removed (Excel writes xdr:, a:, r:, but other writers may choose other prefixes).

import { XMLParser } from "fast-xml-parser"
import { WorkbookRejected } from "./package"

export type XmlNode = Record<string, unknown>

const ALWAYS_LIST = new Set([
  "sheet", "Relationship", "twoCellAnchor", "oneCellAnchor", "absoluteAnchor", "pic", "grpSp", "row", "c", "col",
  "bk", "rc", "rv", "v", "s", "k", "rel", "metadataType", "Override", "Default", "rvb", "ext",
])

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  removeNSPrefix: true,
  processEntities: false,
  htmlEntities: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name) => ALWAYS_LIST.has(name),
})

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }

/** The parser leaves entities alone (processEntities: false). With DOCTYPE refused, only XML's five predefined entities
 * and numeric character references can occur; they are decoded here, nothing else is. */
export function decodeEntities(value: string): string {
  if (!value.includes("&")) return value
  return value.replace(/&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos);/g, (match, name: string) => {
    if (name[0] !== "#") return NAMED[name]
    const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : match
  })
}

export function parseXml(data: Buffer | undefined, part: string): XmlNode {
  if (!data) throw new WorkbookRejected(`The workbook is missing ${part}.`)
  const text = data.toString("utf8")
  if (/<!DOCTYPE/i.test(text) || /<!ENTITY/i.test(text)) throw new WorkbookRejected(`The workbook part ${part} contains a document type declaration, which Excel never writes.`)
  try {
    return parser.parse(text) as XmlNode
  } catch (error) {
    throw new WorkbookRejected(`The workbook part ${part} is damaged: ${(error as Error).message}.`)
  }
}

/** Child element(s) as a list: absent → [], one → [it], many → them. */
export function list(node: unknown, name: string): XmlNode[] {
  if (!node || typeof node !== "object") return []
  const value = (node as XmlNode)[name]
  if (value === undefined || value === null || value === "") return []
  return (Array.isArray(value) ? value : [value]).filter((v) => typeof v === "object") as XmlNode[]
}

/** Text of each child element with this name (for elements such as <v>0</v> that hold only text). */
export function texts(node: unknown, name: string): string[] {
  if (!node || typeof node !== "object") return []
  const value = (node as XmlNode)[name]
  if (value === undefined || value === null) return []
  return (Array.isArray(value) ? value : [value]).map((v) => text(v))
}

export function child(node: unknown, name: string): XmlNode | undefined {
  return list(node, name)[0]
}

export function attr(node: unknown, name: string): string | undefined {
  if (!node || typeof node !== "object") return undefined
  const value = (node as XmlNode)[`@${name}`]
  return value === undefined ? undefined : decodeEntities(String(value))
}

export function text(node: unknown): string {
  if (node === undefined || node === null) return ""
  if (typeof node !== "object") return decodeEntities(String(node))
  const value = (node as XmlNode)["#text"]
  return value === undefined ? "" : decodeEntities(String(value))
}

/** Relationship id → target part path, resolved against the part that owns the .rels file. */
export function relationships(entries: Map<string, Buffer>, ownerPart: string): Map<string, { target: string; external: boolean; type: string }> {
  const slash = ownerPart.lastIndexOf("/")
  const dir = slash >= 0 ? ownerPart.slice(0, slash) : ""
  const relsPath = `${dir ? `${dir}/` : ""}_rels/${ownerPart.slice(slash + 1)}.rels`
  const out = new Map<string, { target: string; external: boolean; type: string }>()
  const data = entries.get(relsPath)
  if (!data) return out
  for (const rel of list(parseXml(data, relsPath).Relationships, "Relationship")) {
    const id = attr(rel, "Id")
    const target = attr(rel, "Target") ?? ""
    if (!id) continue
    const external = attr(rel, "TargetMode") === "External"
    out.set(id, { target: external ? target : resolvePart(dir, target), external, type: attr(rel, "Type") ?? "" })
  }
  return out
}

export function resolvePart(dir: string, target: string): string {
  const parts = (target.startsWith("/") ? target.slice(1) : `${dir ? `${dir}/` : ""}${target}`).split("/")
  const out: string[] = []
  for (const p of parts) {
    if (p === "..") out.pop()
    else if (p && p !== ".") out.push(p)
  }
  return out.join("/")
}
