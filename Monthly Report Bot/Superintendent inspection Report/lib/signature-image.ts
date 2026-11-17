// Prepares an uploaded image of a signature (photo or scan): the paper becomes transparent and the ink is located, so
// the signature sits on the signature line like a drawn one. Pure pixel logic; the browser supplies the RGBA data.

export type InkBox = { x: number; y: number; width: number; height: number }

const luminance = (px: Uint8ClampedArray, i: number) => 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]

/**
 * Makes the paper transparent and the ink opaque in place (RGBA, row-major), and returns the box around the ink.
 * The paper brightness is the 90th percentile of the opaque pixels, so grey or unevenly lit paper also works; an
 * image with a transparent background is measured against white.
 * Returns null when there is no ink, e.g. a blank page.
 */
export function isolateInk(px: Uint8ClampedArray, width: number, height: number): InkBox | null {
  const histogram = new Array<number>(256).fill(0)
  let opaque = 0
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] < 128) continue
    histogram[Math.round(luminance(px, i))] += 1
    opaque += 1
  }
  if (!opaque) return null
  let paper = 255
  // A mostly transparent image (e.g. a signature exported as a transparent PNG) has no paper to measure: every
  // opaque pixel that is not near-white is ink.
  if (opaque > (px.length / 4) * 0.8) {
    let seen = 0
    for (let v = 0; v < 256; v++) {
      seen += histogram[v]
      if (seen >= opaque * 0.9) {
        paper = v
        break
      }
    }
  }
  const threshold = paper - 45

  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      if (px[i + 3] < 128 || luminance(px, i) > threshold) {
        px[i + 3] = 0
        continue
      }
      px[i + 3] = 255
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  }
  // A few stray dark pixels (dust, noise) are not a signature.
  if (maxX < 0 || (maxX - minX + 1) * (maxY - minY + 1) < 30) return null
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}
