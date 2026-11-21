// Web workspaces served by the NeraVeda web shell.
// To add a module: add an entry here, then create its pages under app/(shell)/<href>/.
// Desktop workspaces (Vessel Report Centre, Lub Oil Review, ...) stay in the NeraVeda desktop app.

export type WebModule = {
  id: string
  /** The NeraVeda right needed to use it (suite_services/access/entitlements.py MODULES). */
  right: string
  href: string
  title: string
  navLabel: string
  badge: string
  eyebrow: string
  description: string
  cta: string
  accent: string
  tint: string
}

export const WEB_MODULES: WebModule[] = [
  {
    id: "inspections",
    right: "sir",
    href: "/inspections",
    title: "Superintendent Inspection Report",
    navLabel: "Inspection Reports",
    badge: "SIR",
    eyebrow: "VESSEL INSPECTION · WORKSPACE 06",
    description: "Write vessel inspection reports offline, attach photos, sync to the cloud and export the PDF.",
    cta: "Open Inspection Reports",
    accent: "#0E6E8C",
    tint: "#E2F2F7",
  },
  {
    id: "docking",
    right: "dd",
    href: "/docking",
    title: "Digital Docking",
    navLabel: "Digital Docking",
    badge: "DD",
    eyebrow: "DRY DOCKING · WORKSPACE 08",
    description: "Docking records, reporting days, jobs and Superintendent notes. Vessel files are never changed.",
    cta: "Open Digital Docking",
    accent: "#5B4A9E",
    tint: "#EEEBF8",
  },
]

/** The workspaces this person may use (all of them when the session is not known, e.g. offline). */
export function modulesFor(rights: readonly string[] | undefined): WebModule[] {
  return rights ? WEB_MODULES.filter((m) => rights.includes(m.right)) : WEB_MODULES
}

export function moduleForPath(pathname: string) {
  return WEB_MODULES.find((m) => pathname === m.href || pathname.startsWith(`${m.href}/`))
}
