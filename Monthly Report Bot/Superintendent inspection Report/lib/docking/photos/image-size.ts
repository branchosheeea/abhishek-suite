// Digital Docking · Stage 1A: pixel size of an embedded photo from its header only (JPEG, PNG, GIF, BMP, WebP).
// No image is decoded, so a hostile file cannot exhaust memory here; the caller applies the pixel limit.

export type ImageInfo = Readonly<{ format: string; width: number; height: number }>

export function imageInfo(data: Buffer): ImageInfo | null {
  if (data.length >= 24 && data.readUInt32BE(0) === 0x89504e47 && data.toString("latin1", 12, 16) === "IHDR") {
    return { format: "png", width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
  }
  if (data.length >= 10 && data.toString("latin1", 0, 3) === "GIF") {
    return { format: "gif", width: data.readUInt16LE(6), height: data.readUInt16LE(8) }
  }
  if (data.length >= 26 && data.toString("latin1", 0, 2) === "BM") {
    return { format: "bmp", width: Math.abs(data.readInt32LE(18)), height: Math.abs(data.readInt32LE(22)) }
  }
  if (data.length >= 30 && data.toString("latin1", 0, 4) === "RIFF" && data.toString("latin1", 8, 12) === "WEBP") {
    const kind = data.toString("latin1", 12, 16)
    if (kind === "VP8X") return { format: "webp", width: 1 + data.readUIntLE(24, 3), height: 1 + data.readUIntLE(27, 3) }
    if (kind === "VP8 ") return { format: "webp", width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff }
    if (kind === "VP8L") {
      const b = data.readUInt32LE(21)
      return { format: "webp", width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 }
    }
  }
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let i = 2
    while (i + 9 < data.length) {
      if (data[i] !== 0xff) return null
      const marker = data[i + 1]
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        i += 2
        continue
      }
      const length = data.readUInt16BE(i + 2)
      // SOF0–SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { format: "jpeg", width: data.readUInt16BE(i + 7), height: data.readUInt16BE(i + 5) }
      }
      i += 2 + length
    }
    return null
  }
  return null
}
