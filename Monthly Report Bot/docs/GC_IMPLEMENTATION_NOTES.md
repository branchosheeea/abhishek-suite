# Guarantee Claim Manager implementation notes

## Existing Suite architecture

- The application is a Windows desktop Suite built with Python and CustomTkinter. `abhishek_automation_suite.py` is the dashboard entry point; it launches each focused module as a separate process.
- The existing `lube_oil` package is the closest module pattern: a Python package, repository boundary, shared SQLite data directory, and CustomTkinter UI.
- `suite_services.database` owns the shared `suite.sqlite3` connection and schema. `suite_services.storage.runtime_root()` selects `%LOCALAPPDATA%\AbhishekAutomationSuite` or `ABHISHEK_SUITE_DATA`.
- The shared database already has canonical `vessels` and `vessel_aliases` tables. GC uses canonical vessel IDs and does not infer vessel identity from claim records.
- Tests use `unittest`; there is no frontend build, web framework, ORM, lint, or type-check setup. Startup is `python abhishek_automation_suite.py`; the module entry point is `python -m gc_manager`.

## Implementation decisions

- Keep the existing desktop architecture and add a GC dashboard card and separately launched `gc_manager` package. Do not introduce FastAPI, React, or another database.
- Put GC tables in a namespaced `gc_*` schema and use a dedicated GC schema version table. Initialize the existing Suite database first, then add only GC tables; never reset Suite tables.
- Before extending an existing database, create a timestamped backup under the runtime data root's `backups` directory. New/temporary databases do not need backups.
- Implement deterministic subject parsing, vessel-only matching against the canonical vessel register, compound `(vessel_id, gc_number)` claim lookup, idempotent email import, review resolution, status/audit history, and attention calculations behind a repository/service boundary.
- The JSON fixture importer, local `.msg` archive importer, and Graph adapter feed the same subject parser and repository import path. Local `.msg` reading uses classic Outlook `OpenSharedItem`; V1 performs no Outlook writes. Graph remains disabled without configuration; the UI must say so plainly. Explicit NEW_GC registration may offer an audited group link for other independently matched messages with the same canonical vessel + GC key.
- Keep identity configurable with `GC_LOCAL_USER_NAME`; services read configuration rather than embedding a person into business rules. The default follows the supplied V1 environment example.
- Keep an inert `NoOpClaimIntelligenceProvider`; no claim decision depends on AI.

## Future migration path

The repository/service API isolates SQL and identity decisions from UI code. A later shared FastAPI service can replace repository persistence with PostgreSQL and Entra identity while keeping the claim rules and UI contract. V1 does not add those services or multi-user behavior.
