# NeraVeda — Digital Docking Module
## Master Product & Build Prompt — Version 2.0 (20 November 2026)

**Purpose:** Give this instruction to a coding agent working inside the existing NeraVeda Git repository. This is the governing product and engineering specification, **not** permission to implement all stages in one run. Build one approved stage at a time. Do not assume the referenced workbook, data dictionary or repository architecture has been verified until you inspect it.

---

## 0. Role, objectives and non-negotiable principles

You are a senior full-stack engineer with experience in reliable data ingestion, Excel/OOXML handling, auditable workflows and maintainable software. Work inside the existing NeraVeda application. Inspect its architecture before deciding how to implement anything.

**Primary objective:** Reduce repetitive clerical work for vessel staff and the attending Superintendent while improving the completeness, technical quality, traceability and usefulness of tanker dry-docking records. NeraVeda is initially a locally operated tool, not a new shipboard platform.

**Non-negotiable operational rule:** The daily vessel report is a **comprehensive work log**, not an exceptions-only update. It must record **ALL jobs and actual work carried out aboard that day**, in meaningful technical detail, including multiple activities against the same job where necessary. Staff populate and revise the working workbook **progressively throughout the day**, as work happens. They do not wait until the evening to reconstruct the day's work. End-of-day checks and submission are separate from ongoing entry.

- Preserve substantive technical information: the work done, observations/as-found condition, findings/defects, inspections, measurements and testing (as applicable), progress, outstanding actions and evidence. Do **not** shorten job descriptions into vague status updates.
- Reduce *duplicate administration*, not reporting completeness. Reuse existing vessel particulars, job numbers/titles, approved specifications, location, company/contractor references and historic information where available. Never overwrite actual observations with inferred values.
- One job may have many distinct activity rows on one day and across many days. Preserve the original chronological entries; also display a consolidated job timeline.
- Keep vessel workflow in Excel for V1. No onboard NeraVeda login or AI-generated free-text email import. The vessel sends an approved daily workbook through the existing email process. No additional parallel vessel report.
- Maintain the practical Deck/Engine distinction and distinguish ship staff, yard staff and service engineers. Do not remove staging, readings/tests, utilities, significant events, delays or attendance if needed for an accurate daily record.
- Keep photos associated with the **same activity/job row** in the workbook (up to four photo slots per row). More photographic evidence can be recorded on additional rows for the same job. Preserve originals and provenance. Do not require a separate onboard photo-folder workflow in V1. Do not assume either Excel insertion method works until proven on the actual vessel Excel version.
- Store records so that the final post-docking report can be produced largely from already captured, reviewed material—without asking ship staff to re-enter it.
- Evidence over assumptions. Do not invent engineering requirements, numerical limits, formulas, ship-management procedures, company account codes, survey criteria or vessel-specific facts.
- All submissions, corrections, reviews and final approvals must remain traceable. An original source file or originally entered activity is never silently rewritten.
- **Do not build for the sake of building.** Each stage must solve a demonstrable real workflow problem and pass an operational test.

## 1. Working rules for the coding agent

1. Start by inspecting the repository: technology stack, package versions, directory conventions, database and migrations, authentication/roles, storage, testing, master data and SIR (Superintendent Inspection Report) module. Reuse proven components, patterns, theme and report-generation capabilities **only if they actually exist**.
2. Do not introduce new frameworks or services without identifying why the current stack cannot satisfy the requirement and obtaining approval.
3. Work on a dedicated Git branch per stage, e.g. `feature/digital-docking-stage-1`. Make small, descriptive commits. Never alter unrelated modules without approval.
4. Before each stage: provide a concise implementation plan listing files to create/change, data model changes, external libraries, risks, test cases and dependencies. **STOP for approval**. At the end: provide a build summary, test evidence, limitations, unanswered decisions and **STOP**. Never move to the next stage automatically.
5. If the real repository, data dictionary, workbook or provided documents conflict, produce a **conflict register** with exact references and a proposed resolution. Do not choose silently. Ask only for material decisions.
6. Build robust error messages understandable by a Superintendent and referencing the exact sheet, row and field; no crashes or silent data loss.
7. Use configurable paths, limits, compression settings, file-size caps, picklists, account codes, PDF size targets and report definitions. No passwords or secrets in Git.
8. Keep all real docking workbooks, images, database files and other vessel-sensitive information outside the source repository. Only synthetic test data may be committed.
9. State clearly what you tested and what you could not test (including testing that requires desktop Excel and real vessel photos). Never claim that a workflow is verified without evidence.

## 2. Source-of-truth rules and prerequisites

These sources serve different purposes and must be reconciled **before** implementation:

- **Approved V1 Data Dictionary**: field IDs, meanings, data types, mandatory/conditional rules, input ownership, picklists and scope (V1 Core versus later phases).
- **Approved Vessel Daily Work Log Workbook Specification**: actual workbook tabs, physical cells, protection, data validations, photo slots and shipboard usability. The previously produced pilot workbook and any older ten-sheet proposed template are **draft/reference materials**, not simultaneously binding formats. Choose and freeze **one** workbook after review.
- **This Master Prompt**: business purpose, workflows, system behaviour, quality gates and phased scope.
- **Existing repository**: real framework and component conventions; do not assume that a feature mentioned in a prior document is implemented.
- **Company source documents** (when supplied): SMS, repair specifications, hull annexes, yard forms, acceptance limits and historical examples. These control their own technical content, subject to user confirmation.

In conflicts: **do not guess**. Present a decision table. After approval, publish a versioned mapping of field IDs to physical workbook cells and internal database attributes. Generate any runtime field schema/picklists from the approved dictionary or a versioned derivative, rather than scattering hand-written field lists through the code. Preserve old schema/picklist versions used by previously imported days.

**Required Stage 0 deliverable:** inspect and compare the existing sample report, candidate vessel workbook, V1 dictionary and repository. Identify discrepancies, missing information and usability problems. Request approval of the final workbook schema before production template generation. Never overwrite an attached reference workbook.

## 3. Roles and authority

- **Ship staff:** complete the working daily Excel workbook throughout the day, in technical detail. Responsible Deck and Engine officers review their sections; the Master confirms the submitted daily report. Vessel staff do not operate the local NeraVeda module in V1.
- **Attending Superintendent:** creates the docking, manages the job register and approved template, imports vessel daily files, reviews source records, annotates/queries entries, confirms corrections, manages technical close-out and compiles the final report. Does **not** edit the original vessel submission in place.
- **Fleet Manager:** reviews and approves the final report or returns it with item-specific comments. Use the title **Fleet Manager** consistently. Does not edit the Superintendent's content directly.
- Separate **file import acceptance**, **daily technical review**, **job verification**, and **final report approval**. These are different states/decisions.
- Since NeraVeda initially runs locally on one PC, do **not** assume the Fleet Manager has live remote access. Before building Stage 7, agree how their approval is captured and authenticated; do not invent remote-access infrastructure.

## 4. Daily shipboard reporting workflow (V1)

### 4.1 Before docking

The Superintendent creates a docking record and loads an approved job register (from docking specifications or a controlled CSV/Excel export). NeraVeda generates a vessel daily workbook populated with vessel/docking identity, jobs and controlled lists. The vessel uses **a fresh daily copy** of the same issued template for each reporting day; the master template is not overwritten by yesterday's data. Reissue a versioned template when the job register or approved layout/schema changes. Maintain known historical versions for audit and compatible imports.

### 4.2 During the reporting day

- Vessel officers enter work **as it happens** during the day, across their departmental sections, without waiting for end-of-day consolidation.
- **Every job/work activity actually executed that day must be recorded**, even if the underlying job started on an earlier day or is already familiar to the Superintendent. A job may appear on several rows that day for distinct activities, teams, stages, inspections or photo sets.
- Entries are factual and detailed: *what was performed; equipment/location; by whom; condition/findings; relevant measurements/tests; progress/status; pending work; photographs and source references.* Separate fields may be used when useful, but do not force repetitive text into multiple columns.
- A preloaded job number retrieves its approved title and other known details. This does **not** replace the daily work description.
- Unexpected/additional work can be recorded immediately, with an editable **New Job Title** and **Temporary Extra Job Reference**. It must be possible to refer to the same extra across subsequent rows/days until the Superintendent assigns its permanent job ID. Never use title similarity alone to merge extras.
- For a job involving more than four photographs, allow further activity/evidence rows referencing the same job. Every photograph must have an unambiguous row/slot association and may carry stage/context/caption information appropriate to the approved layout.
- Applicable Readings & Tests, Staging, Utilities, Events, delays, meetings/attendance and safety-critical observations must be recorded. These supporting sheets do not replace the comprehensive job-by-job account.
- Officers must be able to save, reopen and continue editing the same daily working file. Confirm safe use on the vessel's actual Excel version and hardware. If simultaneous Deck/Engine editing cannot be performed safely, document one controlled editing/ownership arrangement; do not assume Excel coauthoring or invent a second reporting channel.

### 4.3 At end of day

Deck and Engine responsible officers check that all work actually performed in their departments is represented and that descriptions, measurements and photos are properly linked. The Master confirms the daily submission. The working workbook is saved and emailed. Once received/imported, the submitted file is retained as an immutable source snapshot. Corrections are documented as revisions, not silent overwrites. A 'No report' day, if required, is explicitly declared by the Superintendent with a reason and must not be used to hide missing work.

### 4.4 Workbook functional design — subject to Stage 0 freeze

Preserve familiar categories in a practical layout, provisionally:

1. `Instructions` (short, practical examples; how to use a daily copy, insert/resize photos, save and submit)
2. `Day Summary` (docking/day/date, location/weather, key events, delays, attendance, department checks and Master confirmation)
3. `Deck Work` (multiple detailed activity rows)
4. `Engine Work` (multiple detailed activity rows)
5. `Readings & Tests` (actual readings and supporting test observations)
6. `Staging` (erection/removal and relevant details)
7. `Utilities` (relevant daily consumption/services, where available)
8. `Job Register` (read-only preloaded jobs)
9. `Lists` (hidden controlled dropdown data)
10. `_ID` (very hidden workbook version/identity data)

This tab list is a **proposal**, not authorization to modify an approved company form. Compare with actual Leopard report conventions and the approved candidate workbook. A simpler layout is preferred if it retains all required information and reduces editing burden.

**Logical activity-row fields** (map to actual columns only after template approval): internal unique activity/row reference; Job ID or `EXTRA`; temporary extra reference and editable title if `EXTRA`; department; performed by (Ship/Yard/Service Engineer/etc.); company/vendor if applicable; equipment/location if not preloaded; **detailed work actually carried out today**; **findings/observations**; test/reading reference where applicable; progress/status (percentage optional where meaningful); outstanding work/next action; witnessed/verified status if applicable; up to four row-linked photographs with unambiguous slot and useful stage/context/captions. Avoid making optional fields mandatory for every minor activity. A reported `Not witnessed` is not equivalent to a blank or unknown field.

Support a realistic number of rows per department and test overflow. Do not silently drop records at row 60 or require manual insertion that breaks protected IDs. Choose an approved, tested capacity-extension mechanism and version it if the workbook structure changes.

## 5. Core data architecture and identity

Create the minimum stable schema needed before importing any production report; expand it in later stages without losing history:

- Vessel master (`VesselID`; IMO; particulars/equipment/tanks where available; shared with SIR if SIR truly uses a common source).
- Docking (`DockingID`; `VesselID`; yard; docking type; location/timezone; planned/actual dates; status).
- Versioned job register (`JobID` immutable internal key; displayed Job No.; job-register revision; original scope/spec ref; department/group/location; responsible party; critical flag; creation/change history).
- Extra-job provisional identity and controlled promotion to a permanent job number; previous activities retain their link.
- Daily reporting day (`DockingID`, day number, report date, day state, sign-off) distinct from the submitted **file revision**. Define Day 1 explicitly at docking setup; do not infer it from arbitrary event dates.
- Import submission revision (`SubmissionID`, source hash, source filename, template/picklist/register versions, imported user/time, validation outcome, source file path, supersedes/superseded-by, reason for correction).
- Activity record (`ActivityID` unique and immutable, docking/day/submission/sheet/row provenance, `JobID` or provisional extra, technical text, observations, progress, performer, contractor, witnessing, next actions). A workbook `DK001`/`EN001` row ID identifies a **row in one submission**, not a permanent job across days.
- Photo/evidence (`PhotoID`, source file/part, activity/job/day, slot, stage/caption, stored original or original workbook reference, processed derivative hash and path). No media filename-based job matching.
- Readings/events/attendance/staging/utilities as independently typed records with source references; later measurements map to confirmed equipment and limits.
- Append-only audit records for decisions and edits, including the actor/role, timestamp, source and previous version.

Model separate **raw submitted evidence** versus **reviewed interpretation/annotations**. Never silently replace ship staff wording with an AI summary or Superintendent's correction. Preserve actual source values and subsequent decisions.

## 6. Global validation, evidence and security rules

- Scope all records, uploads and lookups to the correct vessel/docking; never mix historical measurements or values from a sister vessel into the current vessel. Sister-class reference information may be shared with explicit provenance.
- Always distinguish **measured/entered data**, **controlled reference limits**, **calculated results** and **human verification**. Do not let a manually entered `Pass` override a known failed limit. If a validated limit/formula is unavailable, show `Not evaluated` and request the correct reference; do not invent one.
- Do not compare unlike engineering units (e.g. tank sounding in metres against tank volume in m³). Use approved calibration tables and correction rules where required.
- Preserve actual local date/time plus location/timezone or offset used for conversion to UTC; do not assume a fixed offset is correct in all circumstances. Validate conditional event dependencies, not a single rigid universal event sequence.
- A completion percentage is optional for work that cannot sensibly be quantified. A decrease may be genuine after additional findings; flag with explanation/review rather than permanently block it. Check consistency across affected later days if an earlier day is revised.
- Error versus warning must be explicit. Errors prevent acceptance when identity, structural integrity, mandatory critical input or photo-job association cannot be trusted; warnings are reviewable technical or operational anomalies. Never quietly skip a failed row or photo.
- Treat Excel as untrusted input: verify actual file format and OOXML package; reject `.xls`, `.xlsm`, `.xlsb`, encrypted/unexpected files and unsupported macros; set file-size, total uncompressed ZIP size, entry count, XML and decoded image pixel limits; protect against path traversal and unsafe external references. Use safe XML parsing.
- Validate every dropdown and conditional value server-side; Excel validation can be bypassed by paste. Handle 1900/1904 date systems, numeric/text differences, Unicode and formulas without trusting cached display values blindly.
- Preserve original imported files read-only and hash with SHA-256. Detect exact duplicate files separately from multiple revisions of a reporting day. Keep rejected-import audit records even if docking-data writes are rolled back.
- Use database transactions combined with temporary file staging and cleanup/recovery: filesystem writes are **not** automatically rolled back by a database transaction.
- Keep database, photos and originals outside Git; keep password/secrets in local config, use appropriate access controls, versioned migrations, consistent backups and a **tested restore procedure**. Worksheet protection prevents accidental edits; it is not an access-control security boundary.
- For approved reports or records, use a traceable amendment workflow, never destructive overwrite. Never silently suppress genuine work, defects or failed tests.

## 7. Staged delivery plan (build only when preceding gate is approved)

### STAGE 0 — Repository audit, source reconciliation and operational design **[STOP]**

1. Report the actual existing stack, database, repository structure, SIR integration and PDF/narrative capabilities, tests and available vessel master data.
2. Inspect the actual DHT Leopard daily workbooks and sample NeraVeda pilot, the intended V1 data dictionary and the candidate final workbook. Compare full daily technical coverage, photo positions, repetition, formulas, extra-job handling and actual shipboard workflow.
3. Produce a field-by-field source-of-truth conflict report, mapping draft business fields to proposed workbook positions and database attributes; explicitly identify fields required for V1 versus later stages.
4. Confirm vessel Excel versions, physical editing/sharing arrangement, email attachment limits, representative image sizes and onboard hardware limitations. Identify how much of this can be tested and what requires vessel/user testing.
5. Propose the **smallest viable, complete** daily logging layout. Confirm every job/activity can be entered progressively, photos are linked, and ship staff are not asked to duplicate prior information.
6. Freeze the approved workbook specification and dictionary revisions **only after user sign-off**. Supply a short usability checklist and test scenarios.

**Gate:** User approves a single physical workbook layout, dictionary mapping, day numbering, extra-job identity method and test plan. No production module implementation before this gate. Do not mistake a previous pilot for the approved template.

### STAGE 1 — Photo proof, minimum docking foundation, daily template and importer **[multiple STOP gates]**

**1A — Photo feasibility FIRST.** Generate a three-row test workbook with four photo slots/row and proposed protection. Have the user make real desktop-Excel test files using both `Place in Cell` and `Place over Cells` (when available), mixed placements, four pictures on a row, pictures on non-adjacent rows, overlapping/ambiguous anchors, photos with protection enabled, large-file stress, Excel compression and open/re-save in the oldest onboard version. Parse genuine OOXML relationships/drawing/rich-value parts; do **not** rely solely on openpyxl for images. Demonstrate exact sheet/row/slot association for supported methods; explicitly reject or flag ambiguous/unlinked images rather than mislink them. Report file size, opening/saving performance, compatibility and safest insertion method. **STOP** for approval of one supported shipboard method, or a revised approach if the hard requirement proves impractical.

**1B — Minimal foundation.** Create docking record, minimal vessel identity, versioned job register upload (CSV/XLSX), persistent job IDs, provisional `EXTRA` identity, day and submission revisions, activities, photos and auditing. Match existing repository patterns. Configure file storage, size guards and backups. **STOP** after schema/tests.

**1C — Production vessel template.** Generate the **approved** Excel layout, populated with docking ID, actual job register, safe hidden identity/version markers, controlled picklists, formulas and protection. Separate prefilled read-only data from editable daily entries. Allow detailed multi-row entries per job, necessary extra-job title/ref, photo evidence and all supporting daily records. No macros. Workbook and file revisions must be distinguishable. Provide explicit instructions including continuous entry, saving, safe daily copies and photo handling. Test on actual desktop Excel. **STOP** after hands-on user validation.

**1D — Controlled import and daily read-only view.** Select docking and upload single or multiple approved daily `.xlsx` files; structurally verify all expected sheets, identity and field mapping. A hidden `_ID` is metadata, **not** a tamper-proof credential; use an authenticity mechanism if required. Accept historical known register/template versions only if data can be interpreted correctly against the corresponding version; do not automatically reject every older register. Validate fields, activity rows, photos, event/report date, sign-offs, readings and allowed values. Preview complete activities and thumbnails, display errors/warnings, then require Superintendent confirmation before persisting. Store immutable submission and source evidence. Distinguish initial day import, exact duplicate file, revised unapproved day and amendment to an approved day. Record and validate downstream consequences of historic corrections. Build read-only day view plus job-by-job chronology with photos and actual text. **STOP** after tests.

**Stage 1 acceptance:** A real, representative set of consecutive Leopard-style days (including a same-job multi-activity day, `EXTRA`, corrected day, photographic evidence, and busy reporting day) imports with no lost activity or mislinked photo. `100%` of supported pictures linked correctly **or safely rejected with an actionable location**. Test malformed/unsafe files, versioning, atomic recovery and backups. Measure total time for vessel entry and Superintendent import/review versus the old workflow; do not claim savings without measured evidence.

### STAGE 2 — Shared vessel master and full docking setup **[STOP]**

Extend existing shared SIR vessel data rather than duplicate it: particulars, class-level reference context, tank lists/capacities, equipment register, maker/model/serial, criticality, known open findings and historical measurements—all explicitly scoped and sourced. Import job register from docking specification format confirmed by the user. Add docking type, yard, dates, personnel, budget account configuration, planned scope, source/change history and carry-forward **proposals** requiring Superintendent accept/reject. Job register changes create a new revision without breaking historical activity links. Test cross-vessel isolation and reissued template compatibility.

### STAGE 3 — Events, daily conditions, SOF, drafts, soundings, bunkers and off-hire **[STOP]**

Consolidate submitted daily events with Superintendent-recorded events; retain source timestamps and provenance. Validate conditional event order, planned versus actual milestones, arrival/departure, gas-free and relevant certificates, drafts, tank sounding measurements and correctly calculated volumes using approved tank tables, bunkers ROB and consumptions where source inputs support them. Build yard/dock-day, delay and off-hire calculations only from user-approved event definitions; explain the selected start/end events. Produce an editable-before-approval Statement of Facts derived from evidence, not guessed entries. Test against real past SOF and independently checked calculations.

### STAGE 4 — As-found survey, hull condition and measurement engine **[STOP]**

Record as-found hull condition and anomalies by area/frame/side using supplied Hull Inspection Annex terminology and photographic evidence. Mark the point at which hull washing commenced; protect the original as-found snapshot while allowing auditable subsequent findings/corrections. Build versioned measurement definitions, units, positions, reference limits and **user-supplied** formulas: rudder, stern tube, propeller, sea chest, chain and other equipment. Initial/final measurements with timestamps and supporting reports; prior-docking values read-only and explicitly vessel-scoped. Never automatically treat an unsupported calculation as a pass. Reconcile imported readings to measurement sets with Superintendent confirmation.

### STAGE 5 — Full job lifecycle and Superintendent technical review **[STOP]**

Maintain one permanent job record and its many daily activity records. Distinguish job execution state (planned/in progress/completed/deferred/cancelled), findings, verification state and final disposition rather than forcing every job through the same sequence. Provide review queue; Superintendent may accept, query or annotate activity records but cannot edit vessel originals. Convert provisional extras into controlled permanent jobs without breaking existing links. Manage defects, inspections, tests, supporting Class/maker/vendor evidence, critical-equipment applicability and actual PTW references **only where procedures require them**; return-to-service/witnessing must reflect reality. A failed test triggers an unresolved verification requirement, not a silent closure. Show daily changes, critical items, new extras and open work; allow full technical report review beyond exception summaries.

### STAGE 6 — Cost, yard performance and technical close-out **[STOP]**

Budget and actual costs by **user-supplied** accounts, yard invoice, extras/owner approvals, variance with unambiguous sign and reconciled totals. Yard performance against the company form when supplied. Capture real lessons learnt with duplicate-text warnings (never auto-delete). Require every genuine outstanding finding/job to have a disposition and source-linked carry-forward; do not force meaningless `N/A` statements on optional sections. Record Class status at departure and carry-forward proposals, which become active fleet open items only at the approved release point. Preserve outstanding safety-critical requirements even before optional automation exists.

### STAGE 7 — Final post-docking report and Fleet Manager approval **[STOP]**

Generate the existing company report section order using supplied company examples and confirmed NeraVeda/SIR components. Derive narratives from source-linked structured records; display original factual data alongside editable proposed narrative. AI-assisted text may be used for **drafting only**, must never invent facts or silently update source records; final technical review is manual. Job-linked photo appendix with readable originals/derivatives; configurable PDF target; retain approved snapshot, model/version where relevant, output hash and prior revisions. Implement a feasible Fleet Manager approve/return-with-comments process appropriate to the actual local deployment; the Fleet Manager does not edit content. Lock published versions; corrections create new auditable versions, not overwrites. Test exact source traceability and output correctness.

### STAGE 8 — Phase 2: SMS requirements, recommissioning rules and stakeholder outputs **[STOP]**

Only with supplied approved SMS/form rules, introduce configurable/versioned applicability rules based on vessel type, equipment, age and interval. Distinguish procedural safety-critical checks that must continue in existing processes from new software gating. Build recommissioning checklists and evidence requirements triggered by actual work; flag unresolved critical work but do not claim a regulatory requirement without verified source. Produce stakeholder-specific summaries (owner, vetting, lender, commercial) from reviewed evidence after their content is approved.

### STAGE 9 — Phase 3: Closed-loop SIR, fleet analytics and legacy extraction **[STOP]**

Connect approved carry-forwards to the vessel's open-item register, SIR and future docking planning without duplicates. Compare yards, time/cost variance, recurring defects and actual measurement trends with vessel/class context. Import legacy Word/PDF reports only to **review staging** with confidence, source page and specific anomaly flags; no automatic promotion to live facts and no unsupported claims of detecting copied material.

## 8. Acceptance criteria that govern every stage

**Technical integrity:** No silently omitted actual activity; no photo linked to the wrong activity; no cross-docking/cross-vessel values; no invented formulas, limits or technical results; immutable original submissions; reproducible audit and rollback/recovery; explicit treatment of unknowns and unsupported formats.

**Operational practicality:** Test with actual daily reports, not only synthetic data. Vessel officers can update throughout the day, with legible descriptions and workable photo handling. Each day captures all work actually performed, including small jobs, recurring tasks, multiple entries on the same job and unexpected additional work. Existing source particulars are prefilled; unnecessary repetition is eliminated. A brief end-of-day completeness declaration remains, because software cannot know which jobs were omitted.

**Performance / benefit:** Establish baseline minutes for current vessel daily reporting (including photos, revisions and mailing) and Superintendent review/consolidation. Compare after pilot over multiple representative days. Suggested *evaluation targets*, not promises: at least 25% lower clerical preparation time onboard and at least 40% lower Superintendent processing time, **without any reduction in technical coverage or record quality**. If they are not met, explain why and propose a simpler workflow before expanding scope.

**Testing:** At each stage deliver automated unit/integration tests, actual Excel compatibility results when applicable, pass/fail evidence for every specified rule, data migration checks, restore test, negative cases, security limits, and documented exceptions. Include baseline and final counts of reported job activities/photos when comparing source daily reports against the NeraVeda import.

## 9. What to do immediately on receiving this master prompt

**Do not build all nine stages. Do not immediately rewrite the existing vessel workbook.**

Perform **STAGE 0 ONLY**, then submit:

1. Actual repository/SIR architecture findings.
2. Current Excel/dictionary/source documents inspected and any unavailable references.
3. Conflict matrix (including any old pilot versus new proposed workbook discrepancy).
4. Proposed final **vessel daily workbook schema** showing all work fields, multiple entries per job, extras, photos and support sheets, marking prefilled versus ship-entered fields.
5. Clear plan for testing progressive entry throughout the day, older Excel, protected photo insertion, workbook size and simultaneous editing constraints.
6. Minimal Stage 1 database model and photo proof-of-concept plan, including tests and acceptance gate.
7. A list of **only the material decisions** requiring approval.

**STOP. Wait for the user's explicit approval before implementing Stage 1.**

---

**End of master prompt — version 2.0**
