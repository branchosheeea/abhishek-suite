import { ModuleCards } from "@/components/shell/module-cards"

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

      <ModuleCards />
    </main>
  )
}
