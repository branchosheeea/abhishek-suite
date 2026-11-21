// Digital Docking API routes: every route needs the Digital Docking right ("dd") and runs as the signed-in person.
import { currentUser } from "../../server/auth"

export const DD_MODULE = "dd"
export const WRITE_LIMIT: [string, number] = ["docking-write", 240]

/** The signed-in person (routes are "user" routes, so there is always one). */
export function actor(): string {
  return currentUser()?.sub ?? ""
}
