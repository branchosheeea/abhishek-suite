// Deterministic identifiers for findings and configurations. Not a security hash: integrity of source files
// uses SHA-256 in the server layer. This only has to be stable across runs and platforms.

const FNV_OFFSET = 0xcbf29ce484222325n
const FNV_PRIME = 0x100000001b3n
const MASK = 0xffffffffffffffffn

export function fnv1a64(text: string): string {
  let hash = FNV_OFFSET
  const bytes = new TextEncoder().encode(text)
  for (const byte of bytes) {
    hash ^= BigInt(byte)
    hash = (hash * FNV_PRIME) & MASK
  }
  return hash.toString(16).padStart(16, "0")
}

/** JSON with object keys sorted, so equal values always serialise identically. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key]
      if (item !== undefined) out[key] = sortKeys(item)
    }
    return out
  }
  if (typeof value === "bigint") return value.toString()
  return value
}

export function stableId(prefix: string, parts: unknown): string {
  return `${prefix}-${fnv1a64(canonicalJson(parts))}`
}

/** Deep-freeze plain data so a parsed source cannot be changed by any later step. */
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value as object)) deepFreeze((value as Record<string, unknown>)[key])
  }
  return value
}
