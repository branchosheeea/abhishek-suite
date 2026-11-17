// Executive Summary – Projects and Upgrades.
// Past reports list upcoming dry-dockings / Special Surveys, regulatory retrofits (BWTS, EGCS, EPL), energy or fuel
// initiatives and piping or equipment renewals. Each entry here states what, its status, when, why, and whether it is
// Class-approved and managed under Management of Change (TMSA element 7).

import { compareIsoDates, formatDate } from "../dates"
import { capitalise, cleanFragment, gap, joinClauses, sentence } from "../text"
import { para, type ItemValue, type SectionSpec } from "../section"
import { items, str } from "./common"

const STATUS = [
  { id: "NONE", label: "No projects or upgrades" },
  { id: "LISTED", label: "Projects or upgrades listed" },
] as const

const CATEGORY = [
  { id: "DRY_DOCK", label: "Dry-docking / Special Survey" },
  { id: "REGULATORY", label: "Regulatory retrofit (BWTS, EGCS, EEXI…)" },
  { id: "ENERGY", label: "Energy efficiency / CII" },
  { id: "FUEL", label: "Alternative fuel" },
  { id: "COATING", label: "Hull or deck coating programme" },
  { id: "RENEWAL", label: "Piping or equipment renewal" },
  { id: "NAV_COMMS", label: "Navigation / communication upgrade" },
  { id: "CYBER", label: "Cyber security" },
  { id: "SAFETY", label: "Safety equipment" },
  { id: "WELFARE", label: "Habitability and crew welfare" },
  { id: "OTHER", label: "Other" },
] as const

const PROJECT_STATUS = [
  { id: "EVALUATION", label: "Under evaluation", phrase: "is under evaluation" },
  { id: "PLANNED", label: "Planned", phrase: "is planned" },
  { id: "DUE", label: "Due", phrase: "is due" },
  { id: "IN_PROGRESS", label: "In progress", phrase: "is in progress" },
  { id: "COMPLETED", label: "Completed", phrase: "was completed" },
] as const

const TIMING = [
  { id: "DATE", label: "By / on a date" },
  { id: "NEXT_DRY_DOCK", label: "At the next dry-docking", phrase: "at the next dry-docking" },
  { id: "NEXT_ANNUAL", label: "With the next annual Class survey", phrase: "with the forthcoming annual Class survey" },
  { id: "VOYAGE", label: "During the current voyage", phrase: "during the current voyage" },
  { id: "NEAR_FUTURE", label: "In the near future", phrase: "in the near future" },
] as const

const DRIVER = [
  { id: "OWNERS", label: "Owners’ request", phrase: "at the Owners’ request" },
  { id: "CHARTERERS", label: "Charterers’ requirement", phrase: "in line with the charterers’ requirements" },
  { id: "REGULATORY", label: "Regulatory requirement", phrase: "to meet regulatory requirements" },
  { id: "COMPANY", label: "Company initiative", phrase: "as a Company initiative" },
  { id: "CLASS", label: "Class requirement", phrase: "as required by the Classification Society" },
] as const

const APPROVALS = [
  { id: "CLASS_APPROVED", label: "Approved by Class", phrase: "the work was approved by the Classification Society" },
  { id: "CERT_REISSUED", label: "Certificate reissued", phrase: "the relevant statutory certificate was reissued" },
  { id: "MOC", label: "Managed under Management of Change", phrase: "the change is managed under the Company’s Management of Change procedure" },
] as const

function projectSentences(item: ItemValue) {
  const description = capitalise(cleanFragment(item.description as string))
  if (!description) return gap("project description")
  const status = PROJECT_STATUS.find((o) => o.id === item.status)
  const timing = TIMING.find((o) => o.id === item.timing)
  const date = formatDate(item.date as string)
  let when = ""
  if (timing?.id === "DATE") when = date ? `${item.status === "COMPLETED" ? "on" : "by"} ${date}` : gap("date")
  else if (timing && "phrase" in timing) when = timing.phrase
  const driver = DRIVER.find((o) => o.id === item.driver)?.phrase
  const main = sentence(`${description} ${status?.phrase ?? gap("status")}${when ? ` ${when}` : ""}${driver ? `, ${driver}` : ""}`)
  const approvals = APPROVALS.filter((a) => Array.isArray(item.approvals) && (item.approvals as string[]).includes(a.id)).map((a) => a.phrase)
  return [main, approvals.length ? sentence(joinClauses(approvals)) : ""].filter(Boolean).join(" ")
}

export const PROJECTS_SECTION: SectionSpec = {
  id: "projectsUpgrades",
  summaryKey: "projects",
  title: "Projects and Upgrades",
  tab: "Projects & upgrades",
  description: "Planned or completed projects, retrofits and upcoming dry-dockings.",
  groups: [
    {
      title: "Projects and upgrades",
      fields: [
        { kind: "select", key: "status", label: "Status", required: true, options: STATUS, placeholder: "Select…" },
        {
          kind: "items",
          key: "projects",
          label: "Projects",
          itemLabel: "Project",
          addLabel: "Add project",
          max: 8,
          required: true,
          showIf: (s) => str(s, "status") === "LISTED",
          fields: [
            { kind: "select", key: "category", label: "Category", options: CATEGORY, placeholder: "Select…" },
            {
              kind: "text",
              key: "description",
              label: "Project",
              required: true,
              placeholder: "e.g. the second Special Survey and dry-docking",
              hint: "A singular noun phrase: “the upgrade of the BWTS to the non-filter type”, “the use of biofuel”.",
              wide: true,
            },
            { kind: "select", key: "status", label: "Status", required: true, options: PROJECT_STATUS, placeholder: "Select…" },
            { kind: "select", key: "timing", label: "Timing", options: TIMING, placeholder: "Not stated" },
            { kind: "date", key: "date", label: "Date", required: true, showIf: (s) => s.timing === "DATE" },
            { kind: "select", key: "driver", label: "Reason", options: DRIVER, placeholder: "Not stated" },
            { kind: "multi", key: "approvals", label: "Approvals and change control", options: APPROVALS },
          ],
        },
        { kind: "note", key: "note", label: "Additional factual note (optional)", placeholder: "Only for a fact the selections cannot express." },
      ],
    },
  ],

  paragraphs(i) {
    const status = str(i, "status")
    if (status === "NONE") return [para("summary", "Projects and upgrades", [sentence("No projects or upgrades are currently planned"), sentence(str(i, "note"))])]
    if (status === "LISTED") {
      const projects = items(i, "projects")
      return [
        ...projects.map((item, index) => para(`project-${index + 1}`, `Project ${index + 1}`, [projectSentences(item)])),
        para("note", "Note", [sentence(str(i, "note"))]),
      ]
    }
    return [para("summary", "Projects and upgrades", [gap("status")])]
  },

  validate(i, ctx, { warn }) {
    const reference = ctx.endDate || ctx.startDate
    items(i, "projects").forEach((item, index) => {
      const id = (key: string) => `narr-projectsUpgrades-projects-${index}-${key}`
      const order = compareIsoDates(item.date as string, reference)
      if (item.timing === "DATE" && order !== null) {
        if (item.status === "COMPLETED" && order > 0) warn(id("date"), "A completed project has a date after the attendance.")
        if ((item.status === "PLANNED" || item.status === "DUE") && order < 0) warn(id("date"), "This planned date has already passed.")
      }
      if (item.status === "COMPLETED" && item.timing === "NEXT_DRY_DOCK") warn(id("timing"), "“Completed” conflicts with “at the next dry-docking”.")
      const regulatory = item.category === "REGULATORY" || item.category === "FUEL" || item.category === "ENERGY"
      const approvals = Array.isArray(item.approvals) ? (item.approvals as string[]) : []
      if (regulatory && item.status !== "EVALUATION" && !approvals.includes("MOC")) {
        warn(id("approvals"), "Modifications of this kind are normally managed under the Company’s Management of Change procedure (TMSA element 7).")
      }
    })
  },
}
