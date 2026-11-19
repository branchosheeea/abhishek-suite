import { route } from "@/lib/server/http"
import { getServices } from "@/lib/server/runtime"
import { audit } from "@/lib/server/service"
import { BadRequest } from "@/lib/server/errors"
import { SHA256_PATTERN } from "@/lib/server/source-store"

type Ctx = { params: Promise<{ sha: string }> }

// Download the registered original exactly as received (hash-verified on read). GET only.
export const GET = route<Ctx>({ mutating: false }, async (_req, { params }) => {
  const { sha } = await params
  if (!SHA256_PATTERN.test(sha)) throw new BadRequest("Invalid source id.")
  const s = getServices()
  const { artifact, bytes } = await s.sources.read(sha)
  await audit(s, "source.downloaded", `${artifact.kind} ${artifact.filename}`, null, sha)
  const ascii = artifact.filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_")
  return new Response(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(artifact.filename)}`,
      "Cache-Control": "no-store",
      "X-Content-SHA256": sha,
    },
  })
})
