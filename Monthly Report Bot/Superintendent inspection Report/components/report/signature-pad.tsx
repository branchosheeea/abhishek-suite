"use client"

import { Eraser, Upload } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { isolateInk } from "@/lib/signature-image"

const UPLOAD_TYPES = ["image/png", "image/jpeg", "image/webp"]
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

function loadImage(file: File) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error("unreadable"))
    }
    img.src = url
  })
}

/** Reads an uploaded signature image (scaled to at most 1200 px) and isolates the ink; null when none is found. */
function extractSignature(img: HTMLImageElement) {
  const scale = Math.min(1, 1200 / Math.max(img.naturalWidth, img.naturalHeight))
  const w = Math.max(1, Math.round(img.naturalWidth * scale))
  const h = Math.max(1, Math.round(img.naturalHeight * scale))
  const work = document.createElement("canvas")
  work.width = w
  work.height = h
  const ctx = work.getContext("2d", { willReadFrequently: true })
  if (!ctx) return null
  ctx.drawImage(img, 0, 0, w, h)
  const data = ctx.getImageData(0, 0, w, h)
  const ink = isolateInk(data.data, w, h)
  if (!ink) return null
  ctx.putImageData(data, 0, 0)
  return { canvas: work, ...ink }
}

type Props = {
  label: string
  value: string
  onChange: (dataUrl: string) => void
  /** Shows the mandatory * marker. */
  required?: boolean
  /** Locks the pad (signature shown, cannot be drawn or cleared); the reason is shown under it. */
  disabledReason?: string
}

export function SignaturePad({ label, value, onChange, required, disabledReason }: Props) {
  const disabled = Boolean(disabledReason)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drawing = useRef(false)
  const dirty = useRef(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploadError, setUploadError] = useState("")

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ratio = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    canvas.width = rect.width * ratio
    canvas.height = rect.height * ratio
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    ctx.scale(ratio, ratio)
    ctx.lineWidth = 2.2
    ctx.lineCap = "round"
    ctx.lineJoin = "round"
    ctx.strokeStyle = "#0f2747"
    if (value) {
      const img = new Image()
      img.onload = () => ctx.drawImage(img, 0, 0, rect.width, rect.height)
      img.src = value
    }
    // Only paint the stored signature on mount; strokes afterwards are drawn directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  const start = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (disabled) return
    const ctx = e.currentTarget.getContext("2d")
    if (!ctx) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drawing.current = true
    const { x, y } = point(e)
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(x + 0.1, y + 0.1)
    ctx.stroke()
  }

  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return
    const ctx = e.currentTarget.getContext("2d")
    if (!ctx) return
    const { x, y } = point(e)
    ctx.lineTo(x, y)
    ctx.stroke()
    dirty.current = true
  }

  const end = () => {
    if (!drawing.current) return
    drawing.current = false
    if (canvasRef.current) onChange(canvasRef.current.toDataURL("image/png"))
  }

  const wipe = () => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext("2d")
    if (!canvas || !ctx) return null
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.restore()
    return { canvas, ctx }
  }

  const clear = () => {
    if (!wipe()) return
    dirty.current = false
    setUploadError("")
    onChange("")
  }

  // Upload: an image of the signature is placed on the pad and saved exactly like a drawn one.
  const upload = async (file: File | undefined) => {
    if (!file || disabled) return
    setUploadError("")
    if (!UPLOAD_TYPES.includes(file.type)) return setUploadError("Upload a PNG, JPG or WebP image of the signature.")
    if (file.size > MAX_UPLOAD_BYTES) return setUploadError("The image is larger than 10 MB. Upload a smaller image.")
    let img: HTMLImageElement
    try {
      img = await loadImage(file)
    } catch {
      return setUploadError("The image could not be read. Try another file.")
    }
    const signature = extractSignature(img)
    if (!signature) return setUploadError("No signature found in the image. Use a clear image of the signature on plain paper.")
    const target = wipe()
    if (!target) return
    // Fit the signature inside the pad above the signature line, keeping its proportions.
    const rect = target.canvas.getBoundingClientRect()
    const boxW = rect.width - 32
    const boxH = rect.height - 40
    const fit = Math.min(boxW / signature.width, boxH / signature.height, 1.5)
    const drawW = signature.width * fit
    const drawH = signature.height * fit
    const x = (rect.width - drawW) / 2
    const y = rect.height - 30 - drawH
    target.ctx.drawImage(signature.canvas, signature.x, signature.y, signature.width, signature.height, x, Math.max(8, y), drawW, drawH)
    dirty.current = true
    onChange(target.canvas.toDataURL("image/png"))
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">
          {label}
          {required && (
            <>
              {" "}
              <span aria-hidden className="text-destructive">*</span>
              <span className="sr-only">(mandatory)</span>
            </>
          )}
        </span>
        <div className="flex items-center gap-1">
          <Button type="button" variant="ghost" size="sm" onClick={() => fileRef.current?.click()} disabled={disabled}>
            <Upload aria-hidden />
            Upload
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={clear} disabled={!value || disabled}>
            <Eraser aria-hidden />
            Clear
          </Button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept={UPLOAD_TYPES.join(",")}
          className="sr-only"
          tabIndex={-1}
          aria-label={`Upload an image of the ${label.toLowerCase()}`}
          onChange={(e) => {
            void upload(e.target.files?.[0])
            e.target.value = ""
          }}
        />
      </div>
      <div className={`relative overflow-hidden rounded-xl border-2 border-dashed bg-white ${disabled ? "opacity-60" : ""}`}>
        <canvas
          ref={canvasRef}
          aria-label={`${label} drawing area. Draw your signature with a finger, stylus or mouse, or use Upload to add an image of it.`}
          role="img"
          className={`block h-40 w-full touch-none ${disabled ? "cursor-not-allowed" : "cursor-crosshair"}`}
          aria-disabled={disabled || undefined}
          onPointerDown={start}
          onPointerMove={move}
          onPointerUp={end}
          onPointerLeave={end}
        />
        {!value && (
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-neutral-400">
            Sign here, or upload an image
          </span>
        )}
        <span aria-hidden className="pointer-events-none absolute right-6 bottom-8 left-6 border-b border-neutral-300" />
      </div>
      {uploadError && (
        <p role="alert" className="text-xs font-medium text-destructive">
          {uploadError}
        </p>
      )}
      {disabledReason && <p className="text-xs text-muted-foreground">{disabledReason}</p>}
    </div>
  )
}
