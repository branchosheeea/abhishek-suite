import { json, route } from "@/lib/server/http"
import { protectionStatus } from "@/lib/server/runtime"

// Storage protection level of the original-file store, read from the database users' own privileges.
export const GET = route({ mutating: false }, async () => json(await protectionStatus()))
