import { ENGINE_VERSION } from "@/lib/engine/run"

// Lets the NeraVeda desktop launcher recognise this server on its port.
export function GET() {
  return Response.json({ app: "neraveda-emissions", module: "emissions", engine: ENGINE_VERSION }, { headers: { "Cache-Control": "no-store" } })
}
