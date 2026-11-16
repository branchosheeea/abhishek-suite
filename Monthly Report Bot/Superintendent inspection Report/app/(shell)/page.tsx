import Link from "next/link"
import { ModuleBadge } from "@/components/shell/app-shell"
import { buttonVariants } from "@/components/ui/button"
import { WEB_MODULES } from "@/lib/modules"

export default function HomePage() {
  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-8 sm:px-9">
      <header className="flex flex-col gap-1.5 border-b pb-6">
        <h1 className="text-3xl font-bold tracking-tight text-balance">NeraVeda web workspaces</h1>
        <p className="max-w-2xl text-sm text-muted-foreground text-pretty">
          Workspaces that run in the browser. Fleet Intelligence and the desktop workspaces (Vessel Report Centre,
          Lub Oil Review, Voyage Summary, Guarantee Claims and Critical Jobs) are in the NeraVeda desktop app.
        </p>
      </header>

      <ul className="grid gap-5 md:grid-cols-2">
        {WEB_MODULES.map((m) => (
          <li key={m.id} className="flex flex-col rounded-2xl border bg-card p-5 pt-3">
            <span aria-hidden className="mb-4 h-1 rounded-full" style={{ backgroundColor: m.accent }} />
            <div className="flex items-center gap-3.5">
              <ModuleBadge module={m} large />
              <div className="flex min-w-0 flex-col">
                <span className="text-[10px] font-bold tracking-wide" style={{ color: m.accent }}>
                  {m.eyebrow}
                </span>
                <h2 className="text-lg font-bold">{m.title}</h2>
              </div>
            </div>
            <p className="mt-3 text-sm text-muted-foreground text-pretty">{m.description}</p>
            <div className="mt-5 border-t pt-4">
              <Link href={m.href} className={buttonVariants({ size: "lg" })}>
                {m.cta}
              </Link>
            </div>
          </li>
        ))}
      </ul>
    </main>
  )
}
