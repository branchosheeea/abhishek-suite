# Guarantee Claim Manager

The GC Manager is a local desktop workspace in Abhishek Automation Suite for vessel guarantee claims, correspondence evidence, review, status history, and daily attention. It runs with Graph disabled and without AI. The local SQLite database is the authoritative claim record; Outlook messages remain read-only evidence.

## Architecture and data

- Existing CustomTkinter launcher: `python abhishek_automation_suite.py`
- GC workspace: `python -m gc_manager`
- Repository/business rules: `gc_manager/repository.py`, `gc_manager/rules.py`, `gc_manager/attention.py`
- Graph and mock message boundary: `gc_manager/outlook.py`
- Persistence: shared `%LOCALAPPDATA%\AbhishekAutomationSuite\suite.sqlite3`, or the directory selected by `ABHISHEK_SUITE_DATA`.
- New tables use a separate `gc_schema_migrations` version marker and `gc_` prefix. Each new GC schema migration takes a timestamped copy of an existing database into its `backups` folder first. Existing Suite rows are not reset.
- Canonical vessels are drawn from the Suite vessel register. Add vessel identity in the Vessels tab; GC metadata is stored separately.

## Run and install

Use the same Python environment as the Suite:

```powershell
python -m pip install -r requirements.txt
python abhishek_automation_suite.py
```

Open **Guarantee Claim Manager** from the dashboard. To launch it directly, run `python -m gc_manager`. Set `ABHISHEK_SUITE_DATA` to a local data folder for an isolated environment or tests. Never point it at a folder that contains a database you intend to replace.

## Claim identity and review

The permanent key is `(canonical vessel ID, normalized GC number)`, protected by a database unique constraint. GC numbers are extracted only from the subject and normalized to `GC-` plus at least three digits. The vessel matcher independently uses only the subject and registered canonical vessels. It checks exact and normalized matches before safe fuzzy matching. Fuzzy matching uses configurable thresholds (`GC_VESSEL_AUTO_MATCH_THRESHOLD=90`, `GC_VESSEL_REVIEW_THRESHOLD=80`, `GC_VESSEL_MATCH_MARGIN=8`); uncertain results go to review.

An email only links automatically after both subject-derived components independently pass. The repository query always includes both vessel ID and GC number. A valid new pair creates a `NEW_GC` review, not a claim. Multiple GC numbers, ambiguous vessel names, and unmatched vessels go to review. Review corrections are explicit and audited. Changed subject wording remains attached through stable message identifiers, not subject equality.

## Statuses and attention

The lifecycle values are `DRAFT`, `SUBMITTED`, `INFO_REQUIRED`, `UNDER_REVIEW`, `ACCEPTED`, `DISPUTED`, `REMEDY_AGREED`, `AWAITING_SUPPLY`, `IN_TRANSIT`, `AWAITING_ATTENDANCE`, `RECTIFICATION_IN_PROGRESS`, `AWAITING_VERIFICATION`, `MONITORING`, `CLOSURE_PROPOSED`, `CLOSED`, and `CANCELLED`. Waiting On remains a separate field. Normal transitions are validated and every change is retained in status and timeline history. Closure needs a date and reason; reopening needs a reason. The safe undo action checks that the latest status state still matches before recording a compensating history entry.

Attention conditions can coexist: overdue or due follow-up, no response after an outgoing message, unreviewed email, delivery overdue, closure pending, and guarantee expiry risk. Closed and cancelled claims do not receive ordinary alerts. Defaults are stored in `gc_settings` and can be changed in Settings.

## Outlook and mock mode

Microsoft Graph access is delegated and read-only. The Graph adapter requests `User.Read`, `Mail.Read`, `offline_access`, `openid`, and `profile`; it never requests `Mail.ReadWrite` or `Mail.Send`. Inbox and Sent Items use independent delta links and immutable message IDs. Authentication stays in the backend process; on Windows its MSAL cache is encrypted with the current Windows user's DPAPI key under the local runtime `credentials` directory. Disconnect removes only that local cache.

With Graph disabled, use **Import mock JSON** for synthetic fixtures or **Import .msg archive** for user-exported mail. The archive importer reads `.msg` files recursively through classic Outlook's local `OpenSharedItem` interface. It compares the message sender with the signed-in Outlook user's SMTP address to classify Inbox versus Sent Items, and uses the Internet Message ID when available for deduplication. If Outlook cannot provide the signed-in address, it keeps the direction as unknown. It only reads the exported files and does not change Outlook. All imported mail passes through the same subject parser, vessel matcher, deduplication, review, link, and timeline path as Graph. No sample data is inserted automatically. Email HTML is reduced to text before storing or displaying.

The `.msg` archive importer uses the existing Windows `pywin32` dependency and requires classic Outlook. Choose the folder containing the exported files; nested folders are included. Failed files are reported individually and can be retried. The source mail remains unchanged.

When an operator registers a NEW_GC item, the review screen offers to link other open NEW_GC messages whose subjects independently match the same canonical vessel and GC number. This is optional, requires confirmation, and writes an audit event for each linked message. Ambiguous-vessel and multiple-GC items are never included in this group action.

## V1 and future path

V1 is local, Windows-based, single-user, and SQLite. Audit and assignment columns are nullable; identity comes from `GC_LOCAL_USER_NAME`, not a person-specific business rule. The repository boundary provides a future path to a shared FastAPI service, PostgreSQL, Entra authentication, and multi-user assignment without moving identity rules into the UI. No team service is included now. `NoOpClaimIntelligenceProvider` reserves an inert future advisory extension; no V1 function calls AI.

## Validation

Run backend tests with:

```powershell
python -m unittest discover -s tests -v
```

There is no web frontend, frontend test runner, build, lint, or type-check command in this Tkinter Suite. A manual smoke checklist is in `GC_GRAPH_SETUP.md`.

## Troubleshooting

- **Outlook Not Configured:** expected with Graph disabled or missing client/tenant IDs; fixture import and local claim work remain available.
- **Graph sign-in fails:** confirm the Entra tenant, public client setting, delegated `Mail.Read` consent, and the backend network connection. No Outlook write scope is required.
- **Vessel goes to review:** compare the subject with the canonical vessel register; do not rely on claim existence or body wording to correct identity.
- **Duplicate claim error:** the same vessel and normalized GC number already exists; open that claim or resolve the email to it.
- **Database migration issue:** preserve the original database and inspect the timestamped backup before retrying. GC tables are additive and namespaced.
