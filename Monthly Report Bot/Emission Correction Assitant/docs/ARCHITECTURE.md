# DNV Emissions Validation & Intelligence: Architecture

Status: built 18 Nov 2026. Schema verified against the supplied OVD 3.13 Interface Description; DHT COLT run
end to end on the Atlas database (§8). Outstanding: the DHT COLT Bunker Report and manual review (§7).

## 1. Repository assessment (Phase 1)

| Concern | Found | Decision |
|---|---|---|
| NeraVeda | Python 3.15 + CustomTkinter desktop launcher (`abhishek_automation_suite.py`). Each workspace runs as its own process. Shared SQLite database and SHA-256 archive in `suite_services/`. | Workspace 07 is a card on the launcher, like 06. |
| Web workspaces | `Superintendent inspection Report/` is a Next.js 16 app (React 19, `mongodb` driver, Atlas) on port 3000. It has no sign-in and listens on 127.0.0.1. | **Your decision:** a separate Next.js app in `Emission Correction Assitant/` on port 3001, with the same stack, look and launch pattern. Next 16 cannot compile code outside its own project root without widening the Turbopack root or using an experimental symlink feature. |
| "Express" | No Express server anywhere. The web app uses Next.js route handlers. | Route handlers act as the Express layer. Adding Express would be a duplicate server. |
| Storage | The web shell uses MongoDB Atlas. No local MongoDB is installed. | **Your decision:** Atlas, original files included (GridFS), in a separate `emissions` database. |
| Auth | None (Windows account; audit records `getpass.getuser()`). | Same at first; requests guarded (§4). **Since added:** NeraVeda sign-in (Microsoft work account, or NeraVeda ID and password) and per-person workspace rights. This app needs the session NeraVeda opens it with, and audit records the signed-in email (`docs/NERAVEDA_ACCESS.md` in `Monthly Report Bot`). |
| Reference data | Supplied later in `reference/` (git-ignored): the DHT COLT LA (CSV), the OVDLA (XLSX), the OVD 3.13 Interface Description and two DNV Emissions Connect screenshots. **No Bunker Report.** | Schema rebuilt from the Interface Description (§5); DHT COLT run (§8). |

## 2. Components

```
Browser (React UI) ──fetch──► Next.js route handlers (app/api) ──► lib/server/service.ts
                                                                    ├─ SourceStore (insert-only, GridFS)   ← originals
                                                                    ├─ DiagnosticStore (MongoDB)           ← sessions, runs, notes…
                                                                    └─ lib/engine (pure)  ◄── lib/parsers (frozen tables)
NeraVeda desktop ── suite_services/emissions_server.py ── starts/stops `next start` on 127.0.0.1:3001
                 └─ suite_services/home_intelligence.py ── caches /api/summary for the Home tile
```

- `lib/engine` is pure TypeScript: no React, MongoDB, clock or file system. The same inputs, rule set,
  schema and configuration always give the same result (tested). Successive-record rules follow the
  submitted row order. A separate timeline is used only for windows and display.
- `lib/parsers` turns bytes into deep-frozen tables (`Object.freeze`). Cells keep their raw text, and rows
  keep their original line numbers (CSV) or sheet row numbers (XLSX).

## 3. Data model (MongoDB database `emissions`)

| Collection | Owner | Write pattern |
|---|---|---|
| `source_artifacts`, `source_files.files/.chunks` (GridFS) | originals | **insert-only**: `_id` = SHA-256; read back and re-hashed before the record is inserted |
| `source_occurrences` | diagnostics | append: every upload, including duplicates |
| `sessions` | diagnostics | update: vessel, IMO, period, config, attached sources (by hash), exclusions (hash + line + reason) |
| `runs` | diagnostics | insert, then one update at the end: inputs, config + hash, exclusions, DNV ids, integrity before/after, summary, `resultJson` (verbatim) |
| `dnv_findings` | diagnostics | update (edit, confirm, withdraw); never deleted |
| `finding_status` / `finding_status_history` | diagnostics | update / **append-only** |
| `notes`, `finding_links`, `audit`, `reports` | diagnostics | **append-only** (the code refuses updates) |

Finding ids are deterministic (`<rule>-<fnv64>`), so an investigation status carries over to a re-run that
reproduces the same finding.

## 4. Source immutability and security controls

| Spec requirement | Implementation |
|---|---|
| Never write to originals; no source edit, save or write-back | `SourceStore` has `register`, `get`, `list` and `read` only. No route under `/api/sources` exports PUT, PATCH or DELETE, and no route deletes anything. Tests scan the code for write verbs and file-system writes. |
| Byte-identical copy; unique ids that cannot be overwritten | Content-addressed (`_id` = SHA-256). A duplicate upload becomes an occurrence and never replaces. Bytes are read back and re-hashed before registration completes. |
| Verify integrity before and after validation | Every run re-reads and re-hashes each source before and after. A mismatch sets the run to `integrity-failed`, withholds results and is audited. Nothing is "repaired". |
| Read-only workers; write limited to ingestion | Three connection roles: source-write, source-read, diagnostics. `/api/integrity` reads each user's privileges and reports **database-enforced** or **application-only** protection. |
| Storage-level immutability where supported | Atlas has no WORM mode for collections. Least-privilege users are the strongest practical control; the limitation is documented and shown in the UI. |
| Safe parsing; malicious content; decompression bombs | Upload gate checks extension and magic bytes (rejects OLE .xls, .xlsm, PDF, renamed ZIP). ZIP sizes and ratio are checked before inflate, inflate output is capped, CRC-32 verified, and encrypted or ZIP64 archives rejected. XML refuses DOCTYPE/ENTITY. Macros, external links, ActiveX and embeddings are rejected. Files are parsed **before** registration. |
| Size and resource limits | 25 MB uploads (streamed byte count; Content-Length not trusted); 200k rows; 1,000 columns; 64 MB per XLSX part; 160 MB total. |
| Input validation, rate limiting, safe errors | Strict validators (config, ids, DNV entries); token-bucket limits on uploads, runs and writes; unknown errors become a generic 500 with details logged server-side only. |
| CSRF, session security | The server listens on 127.0.0.1. Host header must be localhost (defeats DNS rebinding). `Sec-Fetch-Site` and `Origin` are checked. Writes need `x-neraveda-request: 1`. Every API route except health needs the NeraVeda session: an HttpOnly, SameSite=Lax cookie (12 h), signed with a secret that NeraVeda rotates each time it starts the server. The secret is passed only in the environment. The Home summary accepts a 60 s service ticket instead. Without the secret, the API answers 503. |
| Safe downloads; formula injection | Reports are generated in memory and streamed; there is no file-system write path. The XLSX writer emits only inline strings (never `<f>`) and applies `quotePrefix` to text starting with `= + - @` TAB CR. Security headers include CSP (production), `nosniff`, `frame-ancestors 'none'` and no `X-Powered-By`. |
| TLS, encryption at rest | Atlas: TLS and encryption at rest by default. Browser ↔ local server is HTTP on the loopback interface only. |
| Dependency scanning | `npm audit`: 0 vulnerabilities after pinning Next 16.4.6. The 16.4.3 advisories (`'use cache'` leaks) did not affect this app. |
| No external AI | None used. |

## 5. Schema and rules

- **Schema `ovd-3.13-1` (verified, default).** Exact data-field names from the supplied Interface
  Description (SHA-256 `115f8d8f…6be6`), sheets "Log abstract" and "Bunker report". Matching ignores letter
  case, because DNV's own OVDLA re-cases headers; a case difference is reported (A09, information). Points
  that changed from the provisional mapping:
  - **Consumption** is ME/AE/Boiler/Inert_gas `_Consumption_{HFO|LFO|MGO|MDO|LPGP|LPGB|LNG|M|E|O}` plus
    `Incinerator_Consumption_O`. **ROB** is `{HFO|LFO|…}_ROB`, `Methanol_ROB`, `Ethanol_ROB`, `O_ROB`, mapped
    to one canonical fuel code.
  - **Allocation columns** are a "portion of total consumption" and are **never added**: cargo heating, DP and
    DPP cargo pumps. The provisional mapping double-counted cargo heating. D08 checks they don't exceed the
    total.
  - **BDN-scheme columns** are recognised so a mix of schemes is reported (A11).
  - **Bunker Report grades** (e.g. VLSFO, ULSMGO2020) map to Log Abstract categories through the documented
    "EU/UK fuel type name" column. Negative mass is de-bunkering.
  - **Event names**: only the documented exact spellings count for voyage logic (Arrival, Departure,
    ArrivalSTS, DepartureSTS, STS, BOSP/EOSP and alternatives). A near miss such as "Arrival STS" is A08.
- **Superseded schema.** `ovd-3.13-provisional-1` is kept only so earlier runs stay reproducible.
- **Rules.** `lib/engine/rules/registry.ts` holds 48 rules in rule set `2026.11-3`. Where the Interface
  Description states a requirement, the rule cites the sheet and row and carries evidence class "official
  interface requirement": e.g. D01/D07 (ROB at start and end of period, Notes row 16), A07/B02 (one event per
  IMO + UTC minute, the highest row number is kept, Notes rows 6 and 20), G05 v2 (a distance in port needs
  Time_Elapsed_Maneuvering, Notes rows 29 and 34). The others are independent calculations or screening
  thresholds.
- **OVD Admin checks (rule set 2026.11-3).** Added so the check names OVD Admin shows have an independent
  counterpart:

  | OVD Admin check | Rules | Basis |
  |---|---|---|
  | Sea passage consistency | C09 (BOSP/EOSP vs Departure/Arrival; "COSP"/"SOSP" treated as a start and noted by A08 as info) | independent calculation |
  | Maneuvering in port | G05 v2 (distance in port with blank/zero maneuvering time) | official interface |
  | Consumption deviation (voyage / port stay) | D09 (mt/h vs median of the other segments of the same type × `consumptionDeviationFactor`, ≥ 3 segments of ≥ 6 h) | screening threshold |
  | CII: FC boiler (consumption) | D10 (cargo heating > boiler consumption of the same fuel), D08 | independent calculation |
  | Distance deviation (per voyage) | G06 (Σ distance vs track through reported positions; short = error, > `voyageDistanceDeviationPct` = warning), G01, G02 | screening threshold |

  DNV's own logic for these checks is not documented; the rules say so in their qualifications.
- **OVD Admin screenshots.** `POST /api/sessions/:id/dnv/screenshot` (PNG body ≤ 15 MB, ≤ 16 MP)
  reads a screenshot and returns draft items. It stores nothing except an audit entry with the image's
  SHA-256.
  - **Image checks** (`lib/ocr/image.ts`): the PNG size is read from IHDR before any decompression. The
    OCR copy is a grayscale image enlarged 2–3×; a dark theme is inverted.
  - **OCR** (`lib/server/ocr.ts`): Tesseract LSTM (tesseract.js 6.0.1, WebAssembly) in a worker thread.
    The model is loaded from `node_modules/@tesseract.js-data/eng`, with no download and no disk cache.
    One screenshot is read at a time, with a 3-minute timeout and an idle shutdown.
  - **Layout** (`lib/ocr/ovd-admin.ts`, pure):
    - Words are grouped into rows and cells by geometry.
    - UnderWay/InPort rows give the segments.
    - An item starts where a red (issue) or amber (warning) icon sits left of the check column. The OCR'd
      icon glyph and known check names are fallbacks.
    - Wrapped check names and messages continue in their column.
    - The event cell is the date, time and event at the right.
    - The badge totals let the UI say when part of the list is missing.
  - **Entries:** reviewed drafts are added with `POST /dnv {items}` (all validated before any is stored) as
    `entryMethod: "screenshot"` with `evidence {sha256, name, reader}`.
  - **Rule fix:** C09 findings carry the time of the inconsistent record (the record OVD Admin lists), so
    the ±24 h event-time match works for long passages.
- **Findings export** (`GET /api/sessions/:id/runs/:runId/findings-export?format=pdf|xlsx&scope=…`): only
  for completed runs.
  - **Selection:** `lib/export/findings-filter.ts`, shared with the Findings tab, so "current filter" matches
    the screen.
  - **PDF** (`lib/export/findings-pdf.ts`):
    - Built with pdf-lib 1.17.1 and DejaVu fonts embedded as subsets and read from `node_modules`.
    - Content is laid out as blocks that are placed on pages, then drawn. Boxes split cleanly across pages, a
      card that continues gets a "(continued)" strip, and index rows link to the cards.
    - AcroForm fields per finding: `status__<id>` (choice field with the 5 investigation statuses, preset to
      the current one) and `remarks__<id>` (multi-line text).
    - Text width comes from cached per-character advances, because pdf-lib re-shapes the whole string for
      each width check.
  - **Excel** (`lib/export/findings-xlsx.ts`): the XLSX writer gained data-validation lists, frozen panes,
    AutoFilter (with `_xlnm._FilterDatabase`), wrapped and coloured styles, and estimated row heights. Style
    indexes 0–4 and the formula protection are unchanged.
  - **Recording:** each file is recorded (`reports`, with format `findings-pdf`/`findings-xlsx` and SHA-256)
    and audited. `lib/server/reporting.ts` holds the loading and recording code shared with the diagnostic
    report route.
- **DNV item anchoring.** A DNV item can carry the OVD Admin row's date/time (`eventUtc`). Record-level
  categories match findings within ±24 h of it; voyage/port-stay categories (ROB vs available fuel,
  consumption deviation, distance per voyage) match a finding whose window contains it and spans ≤ 60 days.
  Without an event time the from/to window rules apply as before.
- **Tolerances.** All tolerances in `config.ts` are labelled screening thresholds. The configuration
  (including the record order) is hashed into every run.

### Record order (`sequenceBasis`)

- **Timeline (default).** Voyage, fuel, cargo, duration and distance rules read records inside the reporting
  period in UTC order. Of several rows with the same IMO and minute, only the highest row is kept. This is how
  OVD keys and processes event reports, and it is what lets the module reproduce DNV's view of the data.
- **Skipped records.** A record dated outside the period (e.g. a mistyped year) is reported by B03 and is not
  placed in the sequence. Findings whose two records have such a record between them in the file name it as a
  hypothesis; nothing is moved or corrected.
- **Submitted.** Available in Settings. B01 always checks the file's own row order.

## 6. Fuel reconciliation

`Expected = ROB(i−1) + Σ BR deliveries of the fuel in (t(i−1), t(i)] − Σ consumption(i)`;
`Residual = ROB(i) − Expected`. All arithmetic is exact BigInt decimal.

- A blank or invalid ROB makes the step **not computable** (D03).
- Blank consumption fields are left out of the sum and the step is **qualified**, saying blank is not zero.
- Missing de-bunkering, transfers and corrections are always stated as a qualification.
- Each residual is summed over reconstructed voyages and port stays (D04) and over the whole log.
- Deliveries dated just outside a step are offered as **hypotheses** (D05) and never moved.

## 7. Acceptance criteria (spec §14)

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Original bytes unchanged | Met | `server.test.ts` (bytes compared before and after runs); API e2e: downloads byte-identical to uploads |
| 2 | SHA-256 matches before and after | Met | run `integrity.before/after`; test "a run verifies every source…" |
| 3 | No source-edit or write-back API | Met | static route scan; HTTP 405 for PUT/PATCH/DELETE |
| 4 | No export can overwrite a source | Met | reports streamed; no file-system write calls (static test); no export code touches source collections |
| 5 | Values and row refs traceable | Met | every finding carries `refs` (hash + line); calculation inputs carry column + ref; viewer highlights |
| 6 | Duplicates handled | Met | A07 (exact / conflicting), B02, reconciliation ambiguity |
| 7 | Ambiguous matches not silently resolved | Met | `reconcile.test.ts` duplicate-key test |
| 8 | Missing values not treated as zero | Met | rules tests: blank ROB → not computable; blank consumption → qualified |
| 9 | Precise decimal arithmetic | Met | `decimal.test.ts`; exact residuals in rules tests |
| 10 | Incomplete transactions qualified | Met | no BR / blank fields / unavailable deductions all listed as qualifications |
| 11 | Chronology keeps source order | Met | rules test "B01 … row order unchanged" |
| 12 | Reconciliation identifies differences | Met | value vs format-only vs missing / cut-off classes |
| 13 | DNV errors not auto-confirmed | Met | correlation outcomes kept separate; screenshot entries unconfirmed |
| 14 | Unauthorized users can't see another vessel | **Partly** | sign-in and workspace rights: a person without this workspace cannot open it (`tests/auth.test.ts`; `webcheck evi` 9/9). Vessel-level scopes are in the access model but not used in v1, so everyone with the workspace sees every vessel |
| 15 | Malicious uploads rejected | Met | parser tests (macro, external link, embeddings, XXE, bomb, CRC, renamed types) |
| 16 | Existing modules still work | Met | suite regression: 255 passed, 7 skipped (baseline 246 + 9 new); one pre-existing timing-sensitive probe test failed once under load and passed on re-runs |
| 17 | Reproducible results | Met | determinism tests (engine and service level) |
| 18 | Reports separate from official forms | Met | banner on every sheet and in JSON; `NERAVEDA-DIAGNOSTIC_…` names; no OVD format |
| 19 | Failed run can't alter sources | Met | integrity-failed test; runs only read |
| 20 | Clear evidence when a rule can't run | Met | coverage list (executed / partial / not executable + reason) on the dashboard and in reports |

The MongoDB storage path (GridFS registration, read-back verification, runs) was also tested against the
Atlas cluster, in a temporary database that was dropped afterwards (`npm run test:mongo`, 2 passed). The
DHT COLT case was then loaded through the app's own API: both originals came back byte-identical (§8).

**Outstanding:** the DHT COLT Bunker Report, so the five fuel items can be reproduced or ruled out (cases
5–8); confirmation of the 11 transcribed DNV items in the UI; and manual technical review of the findings.
The module should not be treated as production-ready until that review is done.

## 8. DHT COLT results (reference files, 18 Nov 2026)

Session "DHT COLT 2026 — DNV Emissions Connect review" in the `emissions` database. Settings: period
2026-01-01 to 2026-12-31, IMO 9813450, timeline basis. LA lines 2–5 (the four 2013 "Example Voyage" DNV
template rows) are excluded with a reason. No Bunker Report was supplied.

**Reconciliation (cases 9–10)**
- Of 398 LA rows, **361 matched** all 361 OVDLA records with **zero value differences**. `Date_UTC` differs
  only in format: Excel date in the OVDLA, text in the LA.
- 37 LA-only rows:
  - 4 excluded templates;
  - **8 dated outside 2026** (lines 98–100, 212, 266, 325, 329, 347: years 2024, 2029, 2019, 2012);
  - **25 after the OVDLA's last record** (2026-11-01 04:00; `Last_Updated` 2026-11-02 04:10, a processing
    cut-off).
- No OVDLA-only records.
- The spec's "391 submitted / 30 submitted-only" is **not** reproduced by these files (398 rows; 33
  non-template LA-only). The earlier analysis probably used another LA version.

**DNV Emissions Connect items** (transcribed from the screenshots, unconfirmed)

| DNV | Outcome | Independent evidence |
|---|---|---|
| BOY ROB missing: LFO | Independently Reproduced | D01: LFO ROB blank on the first 2026 record (line 6) |
| Port code, UnderWay TWSHL→SGSIN (Mar) | Independently Reproduced | C01: departure from TWKHH (line 101), previous port TWSHL. Hypothesis: lines 98–100 (Arrival TWKHH, 2 Noons) are dated 2024 |
| Cargo 142,741 → 0 at Departure 21 Mar | Independently Reproduced | E01: lines 97→101, same cause |
| Arrival/departure inconsistent 21 Mar | Independently Reproduced | C03: two departures (lines 94, 101), same cause |
| Cargo 268,402.15 → 2,684,021.15 (28 May) | Independently Reproduced | E01: lines 181→182 (a digit inserted) |
| Port code, UnderWay PHBTN→OMMFH (Oct–Nov) | Independently Reproduced | C01/C07: Departure at line 364 gives Voyage_From PHBTN after the Arrival at SGSIN |
| ROB vs available fuel (period) HFO; LFO | Unresolved | Period residuals are dominated by three Singapore bunkerings; Bunker Report needed |
| ROB vs available fuel HFO, SGSIN 26–27 Mar | Unresolved | HFO +4,394.9 mt over the port stay (lines 109–111), a bunkering; delivery timing needs the BR (case 8) |
| ROB vs available fuel LFO, TWKHH 22–23 Jul | Unresolved | LFO −48.7 mt over the port stay (lines 242–245) |
| ROB vs available fuel LFO, PHBTN 16–18 Oct | Unresolved | LFO −145.1 mt over the port stay (lines 352–355) |
| ROB vs available fuel LFO, 1 Nov | Unresolved | No LFO residual in the independent steps; DNV's figure likely involves a BR transaction |

**Also found** (not in the DNV list):
- "Arrival STS" / "Departure STS" are written with a space (A08). The cargo changes around them in May are
  flagged as warnings that name the STS events as the likely cause.
- Cargo-heating LFO exceeds total LFO consumption on 6 records (D08), and LFO boiler consumption on the
  same 6 records (D10).
- A distance in port without maneuvering time on 1 record, a Departure with 18 nm (G05 v2; v1, which
  ignored maneuvering time, counted 3 records).
- Rule set 2026.11-3 also reports: two EOSP without a sea passage start (C09); two port stays burning
  1.56× and 7.27× the median port-stay rate (D09); two voyages whose Σ distance is 4–5% shorter than the
  track through their positions, and two short voyages 11–20% longer (G06). "COSP" is used for the
  passage start on 17 LA records (A08, info).
- Several duration and timestamp mismatches (F01, B01).
- Distances shorter than the geodesic (G01), some explained by skipped records.

The expectations behind these results are in the git-ignored `tests/private/dhtcolt.json`, and
`tests/dhtcolt.regression.test.ts` re-checks them whenever the files are present. They are not in any
rule.
