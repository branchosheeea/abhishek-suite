import { revokeAll } from "@/lib/server/auth"
import { json, route } from "@/lib/server/http"

/** The launcher ends every browser session of this workspace (sign-out, rights withdrawn). */
export const POST = route({ mutating: true, auth: "service" }, async () => {
  revokeAll()
  return json({ revoked: true })
})
