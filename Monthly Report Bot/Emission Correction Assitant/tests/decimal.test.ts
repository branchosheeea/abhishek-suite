import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { add, cmp, divide, eq, mul, parseDec, round, sub, sum, toFixed, toString } from "../lib/engine/decimal"

const d = (s: string) => parseDec(s)!

describe("exact decimal arithmetic", () => {
  test("0.1 + 0.2 is exactly 0.3 (no binary floating point)", () => {
    assert.equal(toString(add(d("0.1"), d("0.2"))), "0.3")
    assert.ok(eq(add(d("0.1"), d("0.2")), d("0.3")))
  })

  test("fuel-style balance keeps every digit", () => {
    const expected = sub(add(d("477.250"), d("0")), sum([d("21"), d("2.25")]))
    assert.equal(toString(expected), "454")
    assert.equal(toString(sub(d("454.0"), expected)), "0")
    assert.equal(toString(sub(d("1234.567"), d("1234.5669"))), "0.0001")
  })

  test("strict parsing rejects units, separators, commas and blanks", () => {
    for (const bad of ["", " ", "1,234.5", "12,5", "12.5 mt", "abc", "--1", "1.2.3", "∞", "NaN"]) {
      assert.equal(parseDec(bad), null, bad)
    }
    assert.equal(toString(d("-0.50")), "-0.5")
    assert.equal(toString(d(".25")), "0.25")
    assert.equal(toString(d("1.2E-3")), "0.0012")
    assert.equal(toString(d("4.5e2")), "450")
    assert.equal(toString(d("-0")), "0")
  })

  test("numerically equal values compare equal regardless of trailing zeros", () => {
    assert.ok(eq(d("1.50"), d("1.5")))
    assert.equal(cmp(d("2"), d("10")), -1)
    assert.equal(cmp(d("-2"), d("-10")), 1)
  })

  test("half-even rounding and division", () => {
    assert.equal(toString(round(d("2.345"), 2)), "2.34")
    assert.equal(toString(round(d("2.355"), 2)), "2.36")
    assert.equal(toString(round(d("-2.345"), 2)), "-2.34")
    assert.equal(toFixed(d("12.3"), 3), "12.300")
    assert.equal(toString(divide(d("1"), d("3"), 4)), "0.3333")
    assert.equal(toString(divide(d("0.65"), d("2"), 2)), "0.32") // 0.325 → tie → even
    assert.equal(toString(divide(d("0.650001"), d("2"), 2)), "0.33") // just above the tie
    assert.equal(toString(mul(d("1.5"), d("-2.25"))), "-3.375")
  })
})
