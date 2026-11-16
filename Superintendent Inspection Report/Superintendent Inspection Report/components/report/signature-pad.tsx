"use client"

import { Eraser } from "lucide-react"
import { useEffect, useRef } from "react"
import { Button } from "@/components/ui/button"

type Props = {
  label: string
  value: string
  onChange: (dataUrl: string) => void
}

export function SignaturePad({ label, value, onChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drawing = useRef(false)
  const dirty = useRef(false)

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

  const clear = () => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext("2d")
    if (!canvas || !ctx) return
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.restore()
    dirty.current = false
    onChange("")
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{label}</span>
        <Button type="button" variant="ghost" size="sm" onClick={clear} disabled={!value}>
          <Eraser aria-hidden />
          Clear
        </Button>
      </div>
      <div className="relative overflow-hidden rounded-xl border-2 border-dashed bg-white">
        <canvas
          ref={canvasRef}
          aria-label={`${label} drawing area. Draw your signature with a finger, stylus or mouse.`}
          role="img"
          className="block h-40 w-full cursor-crosshair touch-none"
          onPointerDown={start}
          onPointerMove={move}
          onPointerUp={end}
          onPointerLeave={end}
        />
        {!value && (
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-neutral-400">
            Sign here
          </span>
        )}
        <span aria-hidden className="pointer-events-none absolute right-6 bottom-8 left-6 border-b border-neutral-300" />
      </div>
    </div>
  )
}
