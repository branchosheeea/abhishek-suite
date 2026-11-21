import { currentUser, sessionInfo, ANY_MODULE } from "@/lib/server/auth"
import { json, route } from "@/lib/server/http"

/** Who is signed in (browser) or whether the launcher's secret is accepted (service ticket). */
export const GET = route({ mutating: false, auth: "user-or-service", module: ANY_MODULE }, async () => json(sessionInfo(currentUser())))
