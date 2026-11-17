import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { isolateInk } from "../lib/signature-image"

/** RGBA image filled with one grey level, with optional dark strokes. */
function image(width: number, height: number, paper: number, strokes: [x: number, y: number, w: number, h: number, ink: number][] = []) {
  const px = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < px.length; i += 4) px.set([paper, paper, paper, 255], i)
  for (const [sx, sy, sw, sh, ink] of strokes) {
    for (let y = sy; y < sy + sh; y++) for (let x = sx; x < sx + sw; x++) px.set([ink, ink, ink + 20, 255], (y * width + x) * 4)
  }
  return px
}

const alphaAt = (px: Uint8ClampedArray, width: number, x: number, y: number) => px[(y * width + x) * 4 + 3]

describe("uploaded signature", () => {
  test("white paper becomes transparent and the box fits the ink", () => {
    const px = image(100, 60, 250, [[20, 25, 50, 4, 20], [30, 15, 3, 25, 30]])
    assert.deepEqual(isolateInk(px, 100, 60), { x: 20, y: 15, width: 50, height: 25 })
    assert.equal(alphaAt(px, 100, 5, 5), 0, "paper is transparent")
    assert.equal(alphaAt(px, 100, 40, 26), 255, "ink is opaque")
  })

  test("grey, photographed paper is treated as paper too", () => {
    const px = image(80, 40, 175, [[10, 18, 40, 3, 40]])
    assert.deepEqual(isolateInk(px, 80, 40), { x: 10, y: 18, width: 40, height: 3 })
    assert.equal(alphaAt(px, 80, 70, 5), 0)
  })

  test("a blank page or a few specks of dust is not a signature", () => {
    assert.equal(isolateInk(image(60, 40, 245), 60, 40), null)
    assert.equal(isolateInk(image(60, 40, 245, [[10, 10, 2, 2, 20]]), 60, 40), null)
  })

  test("a transparent PNG keeps only its ink", () => {
    const px = image(50, 30, 0, [[5, 10, 30, 4, 10]])
    for (let i = 3; i < px.length; i += 4) px[i] = 0
    for (let y = 10; y < 14; y++) for (let x = 5; x < 35; x++) px[(y * 50 + x) * 4 + 3] = 255
    assert.deepEqual(isolateInk(px, 50, 30), { x: 5, y: 10, width: 30, height: 4 })
  })
})
