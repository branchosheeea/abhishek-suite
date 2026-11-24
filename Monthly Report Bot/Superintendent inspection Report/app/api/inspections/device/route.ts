import { readBody } from "@/lib/docking/server/api"
import { AppError } from "@/lib/server/errors"
import { readDeviceStatus, rememberDeviceStatus } from "@/lib/server/device-status"
import { json, route } from "@/lib/server/http"

// The report list tells the server how many of this browser's reports are not in the cloud yet (lib/server/device-status.ts).
export const POST = route({ mutating: true, limit: ["device-status", 120] }, async (req) => {
  const status = readDeviceStatus(await readBody(req, 1024))
  if (!status) throw new AppError(400, "The report counts could not be read.")
  rememberDeviceStatus(status)
  return json({ status: "ok" })
})
