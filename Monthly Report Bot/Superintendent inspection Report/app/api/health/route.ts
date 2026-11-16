import { NextResponse } from "next/server"
import { WEB_MODULES } from "@/lib/modules"

// Lets the NeraVeda desktop launcher recognise this server on its port.
export function GET() {
  return NextResponse.json({ app: "neraveda-web", modules: WEB_MODULES.map((m) => m.id) })
}
