// Local OCR for OVD Admin screenshots. Tesseract (WebAssembly) runs inside this server process; the English
// model is read from node_modules/@tesseract.js-data/eng. No image or text leaves this computer, no external
// AI service is used, nothing is downloaded at run time and nothing is cached to disk.

import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { PNG } from "pngjs"
import { createWorker, OEM, type Worker } from "tesseract.js"
import { decodePng, iconSampler, ocrScale, prepareForOcr } from "../ocr/image"
import { type OcrWord, type OvdAdminParse, parseOvdAdmin } from "../ocr/ovd-admin"
import { AppError } from "./errors"

export const OCR_ENGINE = "Tesseract 5 LSTM (tesseract.js 6.0.1, eng 4.0.0_best_int), local"

const IDLE_MS = 5 * 60_000
const TIMEOUT_MS = 180_000

type State = { worker: Promise<Worker> | null; queue: Promise<unknown>; idle: ReturnType<typeof setTimeout> | null }
const g = globalThis as unknown as { __eviOcr?: State }
const state: State = (g.__eviOcr ??= { worker: null, queue: Promise.resolve(), idle: null })

export function languagePath(root = process.cwd()): string {
  return join(root, "node_modules", "@tesseract.js-data", "eng", "4.0.0_best_int")
}

function worker(): Promise<Worker> {
  if (!state.worker) {
    const langPath = languagePath()
    if (!existsSync(join(langPath, "eng.traineddata.gz"))) throw new AppError(503, "The OCR language data is not installed. Run npm install in the Emission Correction Assitant folder.")
    state.worker = createWorker("eng", OEM.LSTM_ONLY, { langPath, gzip: true, cacheMethod: "none", logger: () => {}, errorHandler: () => {} }).then(async (w) => {
      await w.setParameters({ tessedit_pageseg_mode: "11" as never, preserve_interword_spaces: "1", user_defined_dpi: "300" })
      return w
    })
    state.worker.catch(() => { state.worker = null })
  }
  return state.worker
}

function scheduleIdleStop() {
  if (state.idle) clearTimeout(state.idle)
  state.idle = setTimeout(() => {
    const w = state.worker
    state.worker = null
    void w?.then((x) => x.terminate()).catch(() => {})
  }, IDLE_MS)
  state.idle.unref?.()
}

/** Words with boxes in ORIGINAL image pixels. One screenshot at a time (the engine is single-threaded). */
async function recognise(png: Buffer, scale: number): Promise<OcrWord[]> {
  const w = await worker()
  const { data } = await w.recognize(png, {}, { blocks: true, text: false })
  const words: OcrWord[] = []
  for (const b of data.blocks ?? []) {
    for (const p of b.paragraphs) {
      for (const l of p.lines) {
        for (const x of l.words) {
          words.push({ text: x.text, conf: x.confidence, x0: x.bbox.x0 / scale, y0: x.bbox.y0 / scale, x1: x.bbox.x1 / scale, y1: x.bbox.y1 / scale })
        }
      }
    }
  }
  return words
}

/** Health check: language data present and the engine reads a blank test image. Touches no session. */
export function ocrStatus(): Promise<{ ready: boolean; engine: string; ms: number; error?: string }> {
  const job = state.queue.then(async () => {
    const started = Date.now()
    try {
      const blank = decodePng(new Uint8Array(PNG.sync.write(Object.assign(new PNG({ width: 64, height: 32 }), { data: Buffer.alloc(64 * 32 * 4, 255) }))))
      await recognise(prepareForOcr(blank, 1), 1)
      return { ready: true, engine: OCR_ENGINE, ms: Date.now() - started }
    } catch (error) {
      return { ready: false, engine: OCR_ENGINE, ms: Date.now() - started, error: (error as Error).message }
    } finally {
      scheduleIdleStop()
    }
  })
  state.queue = job.catch(() => {})
  return job
}

export type ScreenshotReading = Readonly<{
  sha256: string
  width: number
  height: number
  engine: string
  ms: number
  words: number
  parse: OvdAdminParse
}>

export function readScreenshot(bytes: Uint8Array): Promise<ScreenshotReading> {
  const job = state.queue.then(async () => {
    const started = Date.now()
    const img = decodePng(bytes)
    const scale = ocrScale(img.width, img.height)
    const prepared = prepareForOcr(img, scale)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const words = await Promise.race([
        recognise(prepared, scale),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new AppError(504, "Reading the screenshot took too long. Try a smaller screenshot.")), TIMEOUT_MS) }),
      ])
      return {
        sha256: createHash("sha256").update(bytes).digest("hex"),
        width: img.width,
        height: img.height,
        engine: OCR_ENGINE,
        ms: Date.now() - started,
        words: words.length,
        parse: parseOvdAdmin(words, iconSampler(img)),
      }
    } catch (error) {
      // a stuck or failed engine is replaced on the next request
      const w = state.worker
      state.worker = null
      void w?.then((x) => x.terminate()).catch(() => {})
      throw error
    } finally {
      if (timer) clearTimeout(timer)
      scheduleIdleStop()
    }
  })
  state.queue = job.catch(() => {})
  return job
}
