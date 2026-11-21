// Server-side gate for every page of the web shell (Next.js 16 "proxy", formerly middleware; Node.js runtime).
// A page is sent only with a valid NeraVeda session cookie (lib/server/auth.ts pageGate); otherwise the server answers
// with an "Open from NeraVeda" page, so there is no app in the browser whose lock screen could be removed.
// Not gated here: /api/* (every route checks the session itself, and /api/auth/enter is what creates the cookie),
// Next.js build assets under /_next/, and public files with an extension (icons, logo, sw.js, manifest). They hold no
// report data. KEEP IN SYNC with "Emission Correction Assitant/proxy.ts".
import { NextResponse, type NextRequest } from "next/server"
import { pageGate } from "./lib/server/auth"

export function proxy(request: NextRequest) {
  return pageGate(request) ?? NextResponse.next()
}

export const config = {
  matcher: ["/((?!api/|_next/|.*\\.[A-Za-z0-9]+$).*)"],
}
