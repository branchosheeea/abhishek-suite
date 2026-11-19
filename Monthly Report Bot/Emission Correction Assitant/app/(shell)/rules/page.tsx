import { CONFIG_HELP } from "@/lib/engine/config"
import { RULE_SET_VERSION, RULES } from "@/lib/engine/rules/registry"
import { DEFAULT_SCHEMA } from "@/lib/engine/schema"
import { EVIDENCE_LABEL, RULE_GROUP_LABEL, type RuleGroup } from "@/lib/engine/types"

export const metadata = { title: "Rule catalogue" }

export default function RulesPage() {
  const groups = Object.keys(RULE_GROUP_LABEL) as RuleGroup[]
  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8 sm:px-9">
      <header className="flex flex-col gap-1.5 border-b pb-6">
        <h1 className="text-3xl font-bold tracking-tight">Rule catalogue</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Rule set {RULE_SET_VERSION}. Every rule states its logic, evidence basis and version. Rules without a specification reference are independent
          engineering checks or screening thresholds, not DNV requirements. Schema in use: {DEFAULT_SCHEMA.label} — {DEFAULT_SCHEMA.source}.
        </p>
      </header>
      {groups.map((g) => (
        <section key={g} className="rounded-xl border bg-card">
          <h2 className="border-b px-4 py-3 text-sm font-bold">{g} · {RULE_GROUP_LABEL[g]}</h2>
          <ul className="divide-y">
            {RULES.filter((r) => r.group === g).map((r) => (
              <li key={r.id} className="grid gap-1 px-4 py-3 text-sm md:grid-cols-[110px_minmax(0,1fr)]">
                <div className="font-mono text-xs">
                  {r.id} v{r.version}
                  <br />
                  <span className="text-muted-foreground">{r.severity}</span>
                </div>
                <div>
                  <p className="font-semibold">{r.name}</p>
                  <p>{r.description}</p>
                  <p className="mt-1 text-xs"><strong>Logic:</strong> {r.logic}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Evidence: {EVIDENCE_LABEL[r.evidence]} · Inputs: {r.requires.join(", ")} · Reference: {r.specReference ?? "none (independent check)"}
                    {r.tolerance ? ` · Threshold: ${r.tolerance} — ${CONFIG_HELP[r.tolerance] ?? ""}` : ""} · OVD {r.ovdVersions.join(", ")}
                  </p>
                  <p className="mt-1 text-xs"><strong>Recommended check:</strong> {r.recommendation}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  )
}
