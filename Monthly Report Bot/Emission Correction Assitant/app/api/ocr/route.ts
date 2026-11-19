import { json, route } from "@/lib/server/http"
import { ocrStatus } from "@/lib/server/ocr"

export const runtime = "nodejs"

/** Whether the local screenshot reader works (reads a blank test image; no session is touched). */
export const GET = route({ mutating: false, limit: ["ocr-status", 10] }, async () => json(await ocrStatus()))
