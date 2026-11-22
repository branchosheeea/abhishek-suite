import { photoFile } from "@/lib/docking/server/api"
import { dockingStore } from "@/lib/docking/server/instance"
import { DD_MODULE } from "@/lib/docking/server/route-kit"
import { route } from "@/lib/server/http"

type Ctx = { params: Promise<{ id: string; photoId: string }> }

/** A photo as the vessel sent it. Stored photos never change (they are named by their hash), so the browser may keep them. */
export const GET = route<Ctx>({ mutating: false, module: DD_MODULE }, async (_req, { params }) => {
  const { id, photoId } = await params
  const { data, type } = photoFile(await dockingStore(), id, photoId)
  return new Response(new Uint8Array(data), {
    headers: { "Content-Type": type, "Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" },
  })
})
