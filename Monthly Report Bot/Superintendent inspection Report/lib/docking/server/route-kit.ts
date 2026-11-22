// Digital Docking API routes: every route needs the Digital Docking right ("dd") and runs as the signed-in person.
import { currentUser } from "../../server/auth"

export const DD_MODULE = "dd"
export const WRITE_LIMIT: [string, number] = ["docking-write", 240]

/** The signed-in person (routes are "user" routes, so there is always one). */
export function actor(): string {
  return currentUser()?.sub ?? ""
}

/** The signed-in person's name, as NeraVeda knows it (shown on issued reports). */
export function actorName(): string {
  return currentUser()?.name ?? ""
}

/** Building a PDF reads every photo of the report: kept to a sensible rate. */
export const PDF_LIMIT: [string, number] = ["docking-pdf", 30]

/** Reading a vessel workbook (up to 50 MB) is the heaviest request: checks and imports together. */
export const IMPORT_LIMIT: [string, number] = ["docking-import", 40]
