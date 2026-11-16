// Web workspaces served by the NeraVeda web shell.
// To add a module: add an entry here, then create its pages under app/(shell)/<href>/.
// Desktop workspaces (Vessel Report Centre, Lub Oil Review, ...) stay in the NeraVeda desktop app.

export type WebModule = {
  id: string
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
]

export function moduleForPath(pathname: string) {
  return WEB_MODULES.find((m) => pathname === m.href || pathname.startsWith(`${m.href}/`))
}
