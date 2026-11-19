// Strict, minimal XML reader for the parts of an XLSX package. It refuses DOCTYPE and ENTITY declarations
// (no external entities, no entity expansion), decodes only the five predefined entities and numeric character
// references, and never fetches anything. Namespace prefixes are dropped from element and attribute names.

export type XmlElement = {
  name: string
  attrs: Record<string, string>
  children: XmlNode[]
}
export type XmlNode = XmlElement | string

export class XmlError extends Error {}

const MAX_DEPTH = 64

const PREDEFINED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" }

function decodeEntities(text: string): string {
  if (!text.includes("&")) return text
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]+);|&/g, (whole, body: string | undefined) => {
    if (body === undefined) throw new XmlError("Unescaped '&' in XML text.")
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      if (!Number.isFinite(code) || code > 0x10ffff) throw new XmlError(`Invalid character reference ${whole}.`)
      return String.fromCodePoint(code)
    }
    const value = PREDEFINED[body]
    if (value === undefined) throw new XmlError(`Unknown XML entity ${whole}.`)
    return value
  })
}

function localName(name: string): string {
  const colon = name.indexOf(":")
  return colon >= 0 ? name.slice(colon + 1) : name
}

const ATTR = /([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g

export function parseXml(source: string): XmlElement {
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new XmlError("XML DOCTYPE or ENTITY declarations are not accepted.")
  const root: XmlElement = { name: "#document", attrs: {}, children: [] }
  const stack: XmlElement[] = [root]
  let i = 0
  while (i < source.length) {
    const lt = source.indexOf("<", i)
    if (lt < 0) {
      appendText(stack, source.slice(i))
      break
    }
    if (lt > i) appendText(stack, source.slice(i, lt))
    if (source.startsWith("<?", lt)) {
      const end = source.indexOf("?>", lt + 2)
      if (end < 0) throw new XmlError("Unterminated processing instruction.")
      i = end + 2
      continue
    }
    if (source.startsWith("<!--", lt)) {
      const end = source.indexOf("-->", lt + 4)
      if (end < 0) throw new XmlError("Unterminated comment.")
      i = end + 3
      continue
    }
    if (source.startsWith("<![CDATA[", lt)) {
      const end = source.indexOf("]]>", lt + 9)
      if (end < 0) throw new XmlError("Unterminated CDATA section.")
      stack[stack.length - 1].children.push(source.slice(lt + 9, end))
      i = end + 3
      continue
    }
    if (source[lt + 1] === "!") throw new XmlError("Unsupported XML markup declaration.")
    const gt = findTagEnd(source, lt + 1)
    const inner = source.slice(lt + 1, gt)
    i = gt + 1
    if (inner.startsWith("/")) {
      const name = localName(inner.slice(1).trim())
      const open = stack.pop()
      if (!open || open === root || open.name !== name) throw new XmlError(`Mismatched closing tag </${name}>.`)
      continue
    }
    const selfClosing = inner.endsWith("/")
    const body = selfClosing ? inner.slice(0, -1) : inner
    const nameMatch = /^([A-Za-z_][\w.:-]*)/.exec(body)
    if (!nameMatch) throw new XmlError("Malformed XML tag.")
    const element: XmlElement = { name: localName(nameMatch[1]), attrs: {}, children: [] }
    const attrText = body.slice(nameMatch[1].length)
    ATTR.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = ATTR.exec(attrText))) {
      element.attrs[localName(m[1])] = decodeEntities(m[3] ?? m[4] ?? "")
    }
    stack[stack.length - 1].children.push(element)
    if (!selfClosing) {
      stack.push(element)
      if (stack.length > MAX_DEPTH) throw new XmlError("XML nesting is too deep.")
    }
  }
  if (stack.length !== 1) throw new XmlError(`Unclosed XML element <${stack[stack.length - 1].name}>.`)
  const top = root.children.find((c): c is XmlElement => typeof c !== "string")
  if (!top) throw new XmlError("Empty XML document.")
  return top
}

function findTagEnd(source: string, from: number): number {
  let quote: string | null = null
  for (let j = from; j < source.length; j += 1) {
    const ch = source[j]
    if (quote) {
      if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === ">") {
      return j
    }
  }
  throw new XmlError("Unterminated XML tag.")
}

function appendText(stack: XmlElement[], raw: string) {
  stack[stack.length - 1].children.push(decodeEntities(raw))
}

export function elements(node: XmlElement, name: string): XmlElement[] {
  return node.children.filter((c): c is XmlElement => typeof c !== "string" && c.name === name)
}

export function child(node: XmlElement, name: string): XmlElement | undefined {
  return node.children.find((c): c is XmlElement => typeof c !== "string" && c.name === name)
}

/** Concatenated text of a node and its descendants. */
export function textOf(node: XmlElement): string {
  let out = ""
  for (const c of node.children) out += typeof c === "string" ? c : textOf(c)
  return out
}
