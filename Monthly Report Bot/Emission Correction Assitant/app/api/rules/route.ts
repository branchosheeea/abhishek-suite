import { CONFIG_HELP, DEFAULT_CONFIG } from "@/lib/engine/config"
import { DNV_CATEGORIES } from "@/lib/engine/correlate"
import { RULE_SET_VERSION, RULES } from "@/lib/engine/rules/registry"
import { SCHEMAS } from "@/lib/engine/schema"
import { FINDING_STATUSES } from "@/lib/server/diagnostics"
import { json, route } from "@/lib/server/http"

export const GET = route({ mutating: false }, async () =>
  json({
    ruleSetVersion: RULE_SET_VERSION,
    rules: RULES,
    defaults: DEFAULT_CONFIG,
    help: CONFIG_HELP,
    schemas: SCHEMAS.map((s) => ({ id: s.id, ovdVersion: s.ovdVersion, label: s.label, verified: s.verified, note: s.note })),
    dnvCategories: Object.entries(DNV_CATEGORIES).map(([id, c]) => ({ id, label: c.label, rules: c.rules })),
    statuses: FINDING_STATUSES,
  }),
)
