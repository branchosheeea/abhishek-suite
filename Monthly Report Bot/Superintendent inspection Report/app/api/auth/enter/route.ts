import { handleEnter } from "@/lib/server/auth"
import { route } from "@/lib/server/http"

/** Entry from the NeraVeda launcher: a short-lived signed ticket becomes this workspace's session cookie. */
export const GET = route({ mutating: false, limit: ["enter", 30], auth: "none" }, async (req) => handleEnter(req))
