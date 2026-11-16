"use client"

import { Camera, ImagePlus, Trash2 } from "lucide-react"
import { useId, useRef, useState } from "react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { MAX_OWNER_PHOTOS, PHOTO_CATEGORIES, type Photo } from "@/lib/form-schema"
import { compressImage } from "@/lib/image"
import { cn } from "@/lib/utils"

type Props = {
  photos: Photo[]
  onAdd: (input: { category: string; dataUrl: string }) => Promise<void>
  onUpdate: (id: string, patch: Partial<Pick<Photo, "caption" | "category" | "includeInOwnerReport">>) => void
  onRemove: (id: string) => void
}

export function PhotosSection({ photos, onAdd, onUpdate, onRemove }: Props) {
  const [category, setCategory] = useState(PHOTO_CATEGORIES[0])
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const cameraRef = useRef<HTMLInputElement>(null)
  const selectId = useId()
  const ownerCount = photos.filter((p) => p.includeInOwnerReport).length
  const overLimit = ownerCount > MAX_OWNER_PHOTOS
  const covered = new Set(photos.map((p) => p.category))

  const handleFiles = async (files: FileList | null) => {
    if (!files?.length) return
    setBusy(true)
    try {
      for (const file of Array.from(files)) {
        if (!file.type.startsWith("image/")) continue
        await onAdd({ category, dataUrl: await compressImage(file) })
      }
      toast.success(`${files.length} photo${files.length > 1 ? "s" : ""} added to ${category}`)
    } catch {
      toast.error("Could not process that image")
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ""
      if (cameraRef.current) cameraRef.current.value = ""
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 rounded-xl border bg-card p-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-end">
          <div className="flex flex-1 flex-col gap-2">
            <label htmlFor={selectId} className="text-sm font-medium">
              Photo location
            </label>
            <select
              id={selectId}
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
            >
              {PHOTO_CATEGORIES.map((c, i) => (
                <option key={c} value={c}>
                  {i + 1}. {c}
                  {covered.has(c) ? " ✓" : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="flex gap-2">
            <Button type="button" onClick={() => cameraRef.current?.click()} disabled={busy} className="h-10">
              <Camera aria-hidden />
              Take photo
            </Button>
            <Button type="button" variant="outline" onClick={() => fileRef.current?.click()} disabled={busy} className="h-10">
              <ImagePlus aria-hidden />
              Upload
            </Button>
          </div>
          <input
            ref={cameraRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            onChange={(e) => handleFiles(e.target.files)}
          />
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            onChange={(e) => handleFiles(e.target.files)}
          />
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>
            Locations covered:{" "}
            <span className="font-mono font-semibold text-foreground">
              {covered.size}/{PHOTO_CATEGORIES.length}
            </span>
          </span>
          <span className={cn(overLimit && "font-semibold text-destructive")}>
            In owners&apos; PDF:{" "}
            <span className="font-mono font-semibold">
              {ownerCount}/{MAX_OWNER_PHOTOS}
            </span>
          </span>
          <span>Photos are compressed and stored on this device until synced.</span>
        </div>
        {overLimit && (
          <p role="alert" className="text-sm text-destructive">
            Photos to owners must be restricted to {MAX_OWNER_PHOTOS}. Untick extras to keep them for internal use only.
          </p>
        )}
      </div>

      {photos.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed p-10 text-center">
          <ImagePlus className="size-8 text-muted-foreground" aria-hidden />
          <p className="text-sm font-medium">No photos yet</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            Choose a location above, then take or upload photos. They work offline and are added to the PDF.
          </p>
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {photos.map((photo, i) => (
            <li key={photo.id} className="flex flex-col overflow-hidden rounded-xl border bg-card">
              <div className="relative aspect-[4/3] bg-muted">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={photo.dataUrl}
                  alt={photo.caption || photo.category}
                  className="size-full object-cover"
                />
                <Badge className="absolute top-2 left-2 font-mono" variant="secondary">
                  {i + 1}
                </Badge>
                {!photo.syncedAt && (
                  <Badge className="absolute top-2 right-2" variant="outline">
                    <span className="sr-only">Status: </span>Local
                  </Badge>
                )}
              </div>
              <div className="flex flex-col gap-3 p-3">
                <select
                  aria-label="Photo location"
                  value={photo.category}
                  onChange={(e) => onUpdate(photo.id, { category: e.target.value })}
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm font-medium outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
                >
                  {PHOTO_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
                <Input
                  aria-label="Photo caption"
                  value={photo.caption}
                  onChange={(e) => onUpdate(photo.id, { caption: e.target.value })}
                  placeholder="Caption (optional)"
                />
                <div className="flex items-center justify-between gap-2">
                  <label className="flex cursor-pointer items-center gap-2 text-sm">
                    <Checkbox
                      checked={photo.includeInOwnerReport}
                      onCheckedChange={(v) => onUpdate(photo.id, { includeInOwnerReport: Boolean(v) })}
                    />
                    Include in owners&apos; PDF
                  </label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => onRemove(photo.id)}
                    aria-label={`Delete photo ${i + 1}`}
                  >
                    <Trash2 aria-hidden />
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
