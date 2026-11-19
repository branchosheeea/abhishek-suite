// Screenshot handling for the local OCR: strict PNG checks before decoding (no decompression bombs), a
// grayscale, upscaled copy for the OCR engine, and an icon-colour sampler on the original pixels.
// Only PNG is accepted; the browser converts other image types to PNG before upload.

import { PNG } from "pngjs"
import type { IconColor, IconSampler } from "./ovd-admin"

export const IMAGE_LIMITS = Object.freeze({
  maxBytes: 15 * 1024 * 1024,
  maxSide: 10_000,
  maxPixels: 16_000_000,
  /** Pixels handed to the OCR engine after upscaling. */
  maxScaledPixels: 36_000_000,
})

export class ImageRejected extends Error {}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** Width and height from the IHDR chunk, read before anything is decompressed. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length < 33 || SIGNATURE.some((b, i) => bytes[i] !== b)) throw new ImageRejected("The screenshot must be a PNG image (paste it, or save it from the Snipping Tool as PNG).")
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const type = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15])
  if (view.getUint32(8) !== 13 || type !== "IHDR") throw new ImageRejected("The PNG image is malformed.")
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

export type Rgba = Readonly<{ width: number; height: number; data: Uint8Array }>

export function decodePng(bytes: Uint8Array): Rgba {
  if (bytes.length > IMAGE_LIMITS.maxBytes) throw new ImageRejected("The screenshot is larger than 15 MB.")
  const { width, height } = pngSize(bytes)
  if (!width || !height || width > IMAGE_LIMITS.maxSide || height > IMAGE_LIMITS.maxSide || width * height > IMAGE_LIMITS.maxPixels) {
    throw new ImageRejected(`The screenshot is ${width} × ${height} pixels; the limit is 16 megapixels. Take a smaller screenshot of the list.`)
  }
  try {
    const png = PNG.sync.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
    if (png.width !== width || png.height !== height) throw new Error("size mismatch")
    return { width, height, data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength) }
  } catch {
    throw new ImageRejected("The PNG image could not be read.")
  }
}

/** Scale used for OCR: small UI text reads far better enlarged; bounded by the pixel budget. */
export function ocrScale(width: number, height: number): number {
  for (const s of [3, 2]) if (width * height * s * s <= IMAGE_LIMITS.maxScaledPixels) return s
  return 1
}

/**
 * Grayscale (dark text on light background: a dark-theme screenshot is inverted), enlarged by `scale` with
 * bilinear interpolation, as an 8-bit grayscale PNG for the OCR engine.
 */
export function prepareForOcr(img: Rgba, scale: number): Buffer {
  const { width: w0, height: h0, data } = img
  const lum = new Float32Array(w0 * h0)
  let total = 0
  for (let i = 0; i < lum.length; i += 1) {
    const a = data[i * 4 + 3] / 255
    // transparent pixels count as white
    const v = (0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]) * a + 255 * (1 - a)
    lum[i] = v
    total += v
  }
  const invert = total / lum.length < 110
  const w = w0 * scale
  const h = h0 * scale
  const gray = Buffer.alloc(w * h)
  for (let y = 0; y < h; y += 1) {
    const sy = Math.min(h0 - 1, Math.max(0, (y + 0.5) / scale - 0.5))
    const y0 = Math.floor(sy)
    const y1 = Math.min(h0 - 1, y0 + 1)
    const fy = sy - y0
    for (let x = 0; x < w; x += 1) {
      const sx = Math.min(w0 - 1, Math.max(0, (x + 0.5) / scale - 0.5))
      const x0 = Math.floor(sx)
      const x1 = Math.min(w0 - 1, x0 + 1)
      const fx = sx - x0
      const top = lum[y0 * w0 + x0] * (1 - fx) + lum[y0 * w0 + x1] * fx
      const bottom = lum[y1 * w0 + x0] * (1 - fx) + lum[y1 * w0 + x1] * fx
      const v = Math.round(top * (1 - fy) + bottom * fy)
      gray[y * w + x] = invert ? 255 - v : v
    }
  }
  const png = new PNG({ width: w, height: h, colorType: 0, inputColorType: 0, bitDepth: 8 })
  png.data = gray
  return PNG.sync.write(png, { colorType: 0, inputColorType: 0 })
}

/** Classify one pixel as an error-red or warning-amber icon pixel. */
export function iconPixel(r: number, g: number, b: number): IconColor | null {
  const hi = Math.max(r, g, b)
  const lo = Math.min(r, g, b)
  if (hi - lo < 90 || r < 150 || b > 0.6 * r) return null
  if (g < 0.5 * r) return "red"
  if (g >= 0.55 * r && g <= 0.95 * r) return "amber"
  return null
}

/** Sampler over the ORIGINAL image: the colour with at least 6 icon pixels in the rectangle, if any. */
export function iconSampler(img: Rgba): IconSampler {
  return (x0, y0, x1, y1) => {
    const ax = Math.max(0, Math.floor(x0))
    const bx = Math.min(img.width - 1, Math.ceil(x1))
    const ay = Math.max(0, Math.floor(y0))
    const by = Math.min(img.height - 1, Math.ceil(y1))
    let red = 0
    let amber = 0
    for (let y = ay; y <= by; y += 1) {
      for (let x = ax; x <= bx; x += 1) {
        const i = (y * img.width + x) * 4
        const c = iconPixel(img.data[i], img.data[i + 1], img.data[i + 2])
        if (c === "red") red += 1
        else if (c === "amber") amber += 1
      }
    }
    if (Math.max(red, amber) < 6) return null
    return red >= amber ? "red" : "amber"
  }
}
