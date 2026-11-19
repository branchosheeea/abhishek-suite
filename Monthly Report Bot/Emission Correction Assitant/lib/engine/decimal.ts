// Exact decimal arithmetic for reporting quantities (ROB, consumption, bunkers, cargo, distance).
// A value is m × 10^-s with an integer mantissa (BigInt) and a non-negative scale. Addition, subtraction and
// multiplication are exact; rounding happens only where a caller asks for it (display), using half-even.
// Floating point is never used for a reconciliation result.

export type Dec = Readonly<{ m: bigint; s: number }>

const MAX_DIGITS = 40 // more significant digits than any reporting value carries
const MAX_EXPONENT = 30
const DECIMAL = /^([+-])?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d{1,3}))?$/

export const ZERO: Dec = Object.freeze({ m: 0n, s: 0 })

function make(m: bigint, s: number): Dec {
  // Normalise: strip trailing zeros so equal values have equal representations.
  while (s > 0 && m % 10n === 0n) {
    m /= 10n
    s -= 1
  }
  if (m === 0n) s = 0
  return Object.freeze({ m, s })
}

/**
 * Strict parse of a plain decimal literal ("12", "-0.5", ".25", "1.2E-3"). No thousands separators, no
 * decimal commas, no units, no surrounding whitespace: anything else returns null so the caller can report it.
 */
export function parseDec(text: string): Dec | null {
  const match = DECIMAL.exec(text)
  if (!match) return null
  const [, sign, intPart = "", fracPart = "", expPart] = match
  if (intPart.length === 0 && fracPart.length === 0) return null
  if (intPart.length + fracPart.length > MAX_DIGITS) return null
  const exponent = expPart === undefined ? 0 : Number(expPart)
  if (!Number.isInteger(exponent) || Math.abs(exponent) > MAX_EXPONENT) return null
  let m = BigInt((intPart + fracPart).replace(/^0+(?=\d)/, "") || "0")
  let s = fracPart.length - exponent
  if (s < 0) {
    m *= 10n ** BigInt(-s)
    s = 0
  }
  return make(sign === "-" ? -m : m, s)
}

export function fromInt(value: number | bigint): Dec {
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw new RangeError("Not a safe integer")
  return make(BigInt(value), 0)
}

function align(a: Dec, b: Dec): [bigint, bigint, number] {
  if (a.s === b.s) return [a.m, b.m, a.s]
  if (a.s > b.s) return [a.m, b.m * 10n ** BigInt(a.s - b.s), a.s]
  return [a.m * 10n ** BigInt(b.s - a.s), b.m, b.s]
}

export function add(a: Dec, b: Dec): Dec {
  const [x, y, s] = align(a, b)
  return make(x + y, s)
}

export function sub(a: Dec, b: Dec): Dec {
  const [x, y, s] = align(a, b)
  return make(x - y, s)
}

export function mul(a: Dec, b: Dec): Dec {
  return make(a.m * b.m, a.s + b.s)
}

export function neg(a: Dec): Dec {
  return make(-a.m, a.s)
}

export function abs(a: Dec): Dec {
  return a.m < 0n ? neg(a) : a
}

export function cmp(a: Dec, b: Dec): -1 | 0 | 1 {
  const [x, y] = align(a, b)
  return x === y ? 0 : x < y ? -1 : 1
}

export function eq(a: Dec, b: Dec): boolean {
  return a.m === b.m && a.s === b.s
}

export function isZero(a: Dec): boolean {
  return a.m === 0n
}

export function isNegative(a: Dec): boolean {
  return a.m < 0n
}

export function sum(values: readonly Dec[]): Dec {
  return values.reduce<Dec>((total, value) => add(total, value), ZERO)
}

/** Round to `scale` decimal places, half to even. */
export function round(a: Dec, scale: number): Dec {
  if (a.s <= scale) return a
  const divisor = 10n ** BigInt(a.s - scale)
  let q = a.m / divisor
  const r = a.m % divisor
  const twice = (r < 0n ? -r : r) * 2n
  if (twice > divisor || (twice === divisor && q % 2n !== 0n)) q += a.m < 0n ? -1n : 1n
  return make(q, scale)
}

/** a ÷ b rounded half-even to `scale` places. Used only for rates and percentages, never for balances. */
export function divide(a: Dec, b: Dec, scale: number): Dec {
  if (b.m === 0n) throw new RangeError("Division by zero")
  // a / b × 10^scale = a.m × 10^(b.s + scale) / (b.m × 10^a.s); round the quotient using the exact remainder.
  const numerator = a.m * 10n ** BigInt(b.s + scale)
  const denominator = b.m * 10n ** BigInt(a.s)
  let q = numerator / denominator
  const r = numerator % denominator
  const twice = 2n * (r < 0n ? -r : r)
  const d = denominator < 0n ? -denominator : denominator
  if (twice > d || (twice === d && q % 2n !== 0n)) q += (numerator < 0n) !== (denominator < 0n) ? -1n : 1n
  return make(q, scale)
}

/** Exact decimal text, no exponent ("-12.305"). */
export function toString(a: Dec): string {
  const negative = a.m < 0n
  const digits = (negative ? -a.m : a.m).toString()
  if (a.s === 0) return (negative ? "-" : "") + digits
  const padded = digits.padStart(a.s + 1, "0")
  const text = `${padded.slice(0, padded.length - a.s)}.${padded.slice(padded.length - a.s)}`
  return (negative ? "-" : "") + text
}

/** Exactly `scale` decimal places, rounded half-even ("12.300"). */
export function toFixed(a: Dec, scale: number): string {
  const rounded = round(a, scale)
  const text = toString(rounded)
  if (scale === 0) return text
  const [whole, fraction = ""] = text.split(".")
  return `${whole}.${fraction.padEnd(scale, "0")}`
}

/** For charts only. Never feed this back into a calculation. */
export function toNumber(a: Dec): number {
  return Number(toString(a))
}

export function max(a: Dec, b: Dec): Dec {
  return cmp(a, b) >= 0 ? a : b
}
