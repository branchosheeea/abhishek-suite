"""Durable historical imports, activation, provenance and Lube Oil Intelligence master data."""
from __future__ import annotations
from datetime import date, datetime, timezone
import getpass
import json
from pathlib import Path
import shutil
import sqlite3
from suite_services.database import connection, initialize
from suite_services.storage import archive_file, runtime_root
from .budget import BUDGET_CATEGORIES
from .parser import VERSION, parse_workbook


def now():
    return datetime.now(timezone.utc).isoformat()


# Module-owned additive schema, versioned separately from the Suite core (same pattern as GC Manager).
LUBE_SCHEMA_VERSION = 2
LUBE_SCHEMA = """
CREATE TABLE IF NOT EXISTS oil_tanks(
 id INTEGER PRIMARY KEY, vessel_id INTEGER NOT NULL REFERENCES vessels(id), tank_identifier TEXT NOT NULL,
 tank_name TEXT NOT NULL, oil_category TEXT NOT NULL, assigned_grade TEXT, physical_capacity REAL NOT NULL,
 usable_capacity REAL NOT NULL, minimum_rob REAL, safety_stock REAL, unit TEXT NOT NULL DEFAULT 'L',
 effective_from TEXT NOT NULL, effective_to TEXT, source_reference TEXT NOT NULL, remarks TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS vessel_lube_parameters(
 id INTEGER PRIMARY KEY, vessel_id INTEGER NOT NULL REFERENCES vessels(id), parameter TEXT NOT NULL,
 value REAL NOT NULL, unit TEXT NOT NULL, effective_from TEXT NOT NULL, effective_to TEXT,
 source_reference TEXT NOT NULL, remarks TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS lube_schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS vessel_budget_consumption_basis(
 id INTEGER PRIMARY KEY, vessel_id INTEGER NOT NULL REFERENCES vessels(id), budget_year INTEGER NOT NULL,
 oil_category TEXT NOT NULL, daily_budget_rate REAL NOT NULL, rate_unit TEXT NOT NULL DEFAULT 'L/day',
 applicable_days_per_year REAL NOT NULL, annual_budget_quantity REAL NOT NULL, quantity_unit TEXT NOT NULL DEFAULT 'L',
 effective_from TEXT, effective_to TEXT, source_reference TEXT NOT NULL, remarks TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(vessel_id, budget_year, oil_category));
CREATE TABLE IF NOT EXISTS oil_consumption_reference_price(
 id INTEGER PRIMARY KEY, vessel_id INTEGER REFERENCES vessels(id), budget_year INTEGER NOT NULL,
 oil_category TEXT NOT NULL, oil_grade TEXT, reference_price_per_litre REAL NOT NULL,
 currency TEXT NOT NULL DEFAULT 'USD', price_basis TEXT NOT NULL DEFAULT 'Singapore', reference_location TEXT,
 effective_from TEXT, effective_to TEXT, source_reference TEXT NOT NULL, comments TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cost_variance_comments(
 id INTEGER PRIMARY KEY, vessel_id INTEGER NOT NULL REFERENCES vessels(id), period TEXT NOT NULL,
 oil_category TEXT, oil_grade TEXT, report_id INTEGER REFERENCES monthly_reports(id), event_id TEXT,
 variance_type TEXT NOT NULL, comment TEXT NOT NULL, created_by TEXT NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS master_data_audit(
 id INTEGER PRIMARY KEY, table_name TEXT NOT NULL, record_key TEXT NOT NULL, old_value TEXT,
 new_value TEXT NOT NULL, reason TEXT, actor TEXT NOT NULL, created_at TEXT NOT NULL)
"""
BASIS_SOURCE = "Approved DHT Colt 2026 budget basis, confirmed in the Lube Oil Intelligence specification (2026-11-15)"
PRICE_SOURCE = ("DHT Vessels - LO Expense analysis.xlsx, sheet 'F3 RH Analysis', DHT Colt row 6: "
                "CLO cost = litres x 1.59, MECC cost = litres x 1.18 (Singapore reference)")
# Seeded once as editable master data; the services never read these constants.
SEED_BASIS = (("DHT COLT", 2026, "ME_CYLINDER_OIL", 425, 240), ("DHT COLT", 2026, "ME_SYSTEM_OIL", 75, 240),
              ("DHT COLT", 2026, "AE_SYSTEM_OIL", 15, 365))
SEED_PRICES = (("DHT COLT", 2026, "ME_CYLINDER_OIL", 1.59), ("DHT COLT", 2026, "ME_SYSTEM_OIL", 1.18))
# Bulk tanks hold one reporting group each; one group may have several tanks.
TANK_CATEGORIES = {
    "ME_SYSTEM_OIL": "System oil · ME",
    "ME_CYLINDER_OIL_HIGH_BN": "Cylinder oil · High TBN",
    "ME_CYLINDER_OIL_LOW_BN": "Cylinder oil · Low TBN",
    "AE_SYSTEM_OIL": "System oil · AE",
}
# Vessel parameters used by stock-cover rules. Values are versioned by effective date.
PARAMETERS = {
    "ME_SYSTEM_OIL_FULL_CHARGE": ("ME system oil · one full charge", "L"),
}


class Repository:
    def __init__(self, root=None):
        self.root = Path(root) if root else runtime_root()
        initialize(self.root)
        self._migrate()

    def _migrate(self):
        database = self.root / "suite.sqlite3"
        reader = sqlite3.connect(f"file:{database.as_posix()}?mode=ro", uri=True)
        try:
            has = reader.execute("SELECT 1 FROM sqlite_master WHERE name='lube_schema_migrations'").fetchone()
            version = reader.execute("SELECT COALESCE(MAX(version),0) FROM lube_schema_migrations").fetchone()[0] if has else 0
        finally:
            reader.close()
        if version > LUBE_SCHEMA_VERSION:
            raise RuntimeError("This Lube Oil database requires a newer application version.")
        if version == LUBE_SCHEMA_VERSION:
            return
        has_reports = False
        with connection(self.root) as db:
            has_reports = db.execute("SELECT COUNT(*) FROM monthly_reports").fetchone()[0] > 0
        if has_reports:
            backups = self.root / "backups"
            backups.mkdir(parents=True, exist_ok=True)
            shutil.copy2(database, backups / f"suite-before-lube-v{LUBE_SCHEMA_VERSION}-{datetime.now():%Y%m%d-%H%M%S}.sqlite3.bak")
        with connection(self.root) as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                for statement in LUBE_SCHEMA.split(";"):
                    if statement.strip():
                        db.execute(statement)
                if version < 1:
                    stamp = now()
                    for vessel, year, category, rate, days in SEED_BASIS:
                        db.execute("""INSERT OR IGNORE INTO vessel_budget_consumption_basis(vessel_id,budget_year,oil_category,
                            daily_budget_rate,applicable_days_per_year,annual_budget_quantity,effective_from,effective_to,
                            source_reference,created_at,updated_at)
                            SELECT id,?,?,?,?,?,?,?,?,?,? FROM vessels WHERE name=?""",
                                   (year, category, rate, days, rate * days, f"{year}-01-01", f"{year}-12-31",
                                    BASIS_SOURCE, stamp, stamp, vessel))
                    for vessel, year, category, price in SEED_PRICES:
                        db.execute("""INSERT INTO oil_consumption_reference_price(vessel_id,budget_year,oil_category,
                            reference_price_per_litre,currency,price_basis,reference_location,effective_from,
                            source_reference,created_at,updated_at)
                            SELECT id,?,?,?,'USD','Singapore','Singapore',?,?,?,? FROM vessels WHERE name=?""",
                                   (year, category, price, f"{year}-01-01", PRICE_SOURCE, stamp, stamp, vessel))
                db.execute("INSERT OR IGNORE INTO lube_schema_migrations VALUES(?,?)", (LUBE_SCHEMA_VERSION, now()))
                db.commit()
            except Exception:
                db.rollback()
                raise

    def import_file(self, path):
        path = Path(path)
        sha, archived = archive_file(path, self.root)
        # A write transaction reserves the hash and report version across processes.
        with connection(self.root) as db:
            db.execute("BEGIN IMMEDIATE")
            existing = db.execute("SELECT id FROM report_files WHERE sha256=?", (sha,)).fetchone()
            if existing:
                db.execute("INSERT INTO source_occurrences(file_id,source_path,seen_at,outcome) VALUES(?,?,?,?)",
                           (existing[0], str(path), now(), "duplicate"))
                db.commit()
                return dict(filename=path.name, status="Duplicate", detail="Original already archived; no duplicate report created.")
            file_id = db.execute("INSERT INTO report_files(sha256,filename,archive_path,imported_at) VALUES(?,?,?,?)",
                                 (sha, path.name, str(archived.relative_to(self.root)), now())).lastrowid
            try:
                payload = parse_workbook(archived, path.name)
                vessel = db.execute("SELECT vessel_id FROM vessel_aliases WHERE alias=?", (payload["vessel"],)).fetchone()
                vessel_id = vessel[0] if vessel else None
                if vessel_id is None:
                    payload["issues"].append(dict(code="vessel_unknown", title="Vessel identity requires mapping", detail="No reviewed Suite vessel alias matches this workbook.", fields=["vessel"], severity="FAIL"))
                    payload["validation_status"] = "FAIL"
                version = db.execute("SELECT COALESCE(MAX(report_version),0)+1 FROM monthly_reports WHERE vessel_id IS ? AND month IS ? AND report_type=?",
                                     (vessel_id, payload["month"], "lub_oil_stock_consumption")).fetchone()[0]
                if version > 1:
                    payload["issues"].append(dict(code="revision", title="Another version exists for this month", detail="Import order does not establish chronology. Compare versions before confirming this report.", fields=[], severity="WARNING"))
                    if payload["validation_status"] != "FAIL":
                        payload["validation_status"] = "WARNING"
                report_id = db.execute("""INSERT INTO monthly_reports(file_id,vessel_id,report_type,month,reporting_date,report_version,
                    source_status,validation_status,payload) VALUES(?,?,?,?,?,?,?,?,?)""",
                    (file_id, vessel_id, "lub_oil_stock_consumption", payload["month"], payload["reporting_date"], version,
                     payload["source_status"], payload["validation_status"], json.dumps(payload, ensure_ascii=False))).lastrowid
                self._audit(db, report_id, "imported", "Official vessel submission imported.")
                detail = f"{payload['vessel']} · {payload['month']} · {payload['validation_status']}"
                if self._usable(vessel_id, payload["month"], payload["validation_status"]):
                    self._activate(db, report_id, vessel_id, payload["month"])
                    status = "Imported"
                else:
                    status = "Not usable"
                    detail += " · vessel or reporting month could not be identified"
            except Exception as error:
                status, detail = "Failed", f"{type(error).__name__}: {error}"
            db.execute("INSERT INTO processing_runs(file_id,parser_version,state,error,processed_at) VALUES(?,?,?,?,?)",
                       (file_id, VERSION, status, detail if status == "Failed" else None, now()))
            db.execute("INSERT INTO source_occurrences(file_id,source_path,seen_at,outcome) VALUES(?,?,?,?)", (file_id, str(path), now(), status))
            db.commit()
            return dict(filename=path.name, status=status, detail=detail)

    def import_paths(self, paths, emit=lambda result: None, stop=None):
        results = []
        for path in sorted(set(map(Path, paths))):
            if stop and stop.is_set():
                break
            try:
                result = self.import_file(path)
            except Exception as error:
                result = dict(filename=path.name, status="Failed", detail=str(error))
            results.append(result)
            emit(result)
        return results

    def reprocess_stale_reports(self):
        """Refresh stored parses after a parser upgrade without activating reports."""
        with connection(self.root) as db:
            stale_rows = db.execute(
                """SELECT r.id, r.vessel_id, r.report_type, r.month, r.is_active,
                          f.filename, f.archive_path, f.imported_at, r.payload
                   FROM monthly_reports r
                   JOIN report_files f ON f.id=r.file_id"""
            ).fetchall()
            aliases = {
                row["alias"]: row["vessel_id"]
                for row in db.execute("SELECT alias, vessel_id FROM vessel_aliases")
            }

        updates = []
        for row in stale_rows:
            payload = json.loads(row["payload"])
            if payload.get("parser_version") == VERSION:
                continue
            archived = self.root / row["archive_path"]
            payload = parse_workbook(archived, row["filename"])
            vessel_id = aliases.get(payload["vessel"])
            if vessel_id is None:
                payload["issues"].append(dict(
                    code="vessel_unknown",
                    title="Vessel identity requires mapping",
                    detail="No reviewed Suite vessel alias matches this workbook.",
                    fields=["vessel"],
                    severity="FAIL",
                ))
                payload["validation_status"] = "FAIL"
            updates.append((row, payload, vessel_id))

        if not updates:
            return 0

        active_groups = {}
        for row in stale_rows:
            proposed = next((entry for entry in updates if entry[0]["id"] == row["id"]), None)
            vessel_id = proposed[2] if proposed else row["vessel_id"]
            month = proposed[1]["month"] if proposed else row["month"]
            key = (vessel_id, row["report_type"], month)
            if row["is_active"] and vessel_id is not None and month:
                active_groups[key] = active_groups.get(key, 0) + 1
        if any(count > 1 for count in active_groups.values()):
            raise RuntimeError(
                "Parser refresh would create multiple active reports for a vessel/month. "
                "Resolve the existing report versions before refreshing."
            )

        with connection(self.root) as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("UPDATE monthly_reports SET report_version = -id")
            updated_ids = []
            for row, payload, vessel_id in updates:
                db.execute(
                    """UPDATE monthly_reports
                       SET vessel_id=?, month=?, reporting_date=?, validation_status=?, payload=?
                       WHERE id=?""",
                    (
                        vessel_id,
                        payload["month"],
                        payload["reporting_date"],
                        payload["validation_status"],
                        json.dumps(payload, ensure_ascii=False),
                        row["id"],
                    ),
                )
                db.execute(
                    "UPDATE processing_runs SET parser_version=? WHERE file_id=(SELECT file_id FROM monthly_reports WHERE id=?)",
                    (VERSION, row["id"]),
                )
                self._audit(
                    db,
                    row["id"],
                    "parser_refreshed",
                    f"Reparsed archived source using parser {VERSION}; report remains in its existing review state.",
                )
                updated_ids.append(row["id"])

            grouped = {}
            for row in db.execute(
                """SELECT r.id, r.vessel_id, r.report_type, r.month, f.imported_at
                   FROM monthly_reports r JOIN report_files f ON f.id=r.file_id
                   ORDER BY f.imported_at, r.id"""
            ):
                grouped.setdefault(
                    (row["vessel_id"], row["report_type"], row["month"]), []
                ).append(row["id"])
            for ids in grouped.values():
                for version, report_id in enumerate(ids, start=1):
                    db.execute(
                        "UPDATE monthly_reports SET report_version=? WHERE id=?",
                        (version, report_id),
                    )
            db.commit()
        return len(updated_ids)

    @staticmethod
    def _usable(vessel_id, month, validation_status):
        return vessel_id is not None and bool(month) and validation_status != "FAIL"

    def _activate(self, db, report_id, vessel_id, month):
        """Vessel sheets are official: the latest import for a vessel/month is the one in use."""
        previous = db.execute(
            "SELECT id FROM monthly_reports WHERE vessel_id=? AND month=? AND report_type=? AND is_active=1",
            (vessel_id, month, "lub_oil_stock_consumption"),
        ).fetchone()
        if previous:
            db.execute("UPDATE monthly_reports SET is_active=0 WHERE id=?", (previous[0],))
            self._audit(db, previous[0], "superseded", f"Replaced by newer import {report_id}.")
        db.execute("UPDATE monthly_reports SET is_active=1,confirmed_at=?,supersedes_report_id=? WHERE id=?",
                   (now(), previous[0] if previous else None, report_id))
        self._audit(db, report_id, "activated", "Official vessel submission; in use for analysis.")

    def activate_imported(self):
        """Put earlier imports into use: the latest usable import per vessel/month becomes active."""
        with connection(self.root) as db:
            db.execute("BEGIN IMMEDIATE")
            latest = {}
            for row in db.execute(
                """SELECT r.id, r.vessel_id, r.month, r.is_active, r.confirmed_at, r.validation_status
                   FROM monthly_reports r JOIN report_files f ON f.id=r.file_id
                   WHERE r.report_type='lub_oil_stock_consumption'
                   ORDER BY f.imported_at, r.id"""
            ):
                if not self._usable(row["vessel_id"], row["month"], row["validation_status"]):
                    continue
                # An already superseded version stays superseded.
                if row["is_active"] or row["confirmed_at"] is None:
                    latest[(row["vessel_id"], row["month"])] = row
            activated = 0
            for (vessel_id, month), row in latest.items():
                if not row["is_active"]:
                    self._activate(db, row["id"], vessel_id, month)
                    activated += 1
            db.commit()
        return activated

    @staticmethod
    def _audit(db, report_id, action, note):
        db.execute("INSERT INTO audit_events(report_id,action,note,actor,created_at) VALUES(?,?,?,?,?)",
                   (report_id, action, note, getpass.getuser(), now()))

    def reports(self, active_only=False):
        with connection(self.root) as db:
            rows = db.execute("""SELECT r.*, f.filename, f.sha256, f.archive_path, f.imported_at, v.name AS vessel
                FROM monthly_reports r JOIN report_files f ON f.id=r.file_id
                LEFT JOIN vessels v ON v.id=r.vessel_id """ + (" WHERE r.is_active=1" if active_only else "") +
                " ORDER BY r.month DESC,r.report_version DESC,r.id DESC").fetchall()
        return [dict(row) | {"data": json.loads(row["payload"])} for row in rows]

    def add_note(self, report_id, issue_code, note):
        if not note.strip():
            raise ValueError("A review note cannot be empty.")
        with connection(self.root) as db, db:
            db.execute("INSERT INTO review_notes(report_id,issue_code,note,created_at) VALUES(?,?,?,?)", (report_id, issue_code, note.strip(), now()))
            self._audit(db, report_id, "issue_reviewed", f"{issue_code}: {note.strip()}")

    def notes(self, report_id):
        with connection(self.root) as db:
            return [dict(row) for row in db.execute("SELECT * FROM review_notes WHERE report_id=? ORDER BY id", (report_id,))]

    def audit(self, report_id):
        with connection(self.root) as db:
            return [dict(row) for row in db.execute("SELECT * FROM audit_events WHERE report_id=? ORDER BY id", (report_id,))]

    def failures(self):
        with connection(self.root) as db:
            return [dict(row) for row in db.execute("SELECT f.filename,p.error,p.processed_at FROM processing_runs p JOIN report_files f ON f.id=p.file_id WHERE p.state='Failed' ORDER BY p.id DESC")]

    # ---- Budget basis, reference prices and superintendent comments (master data) ----
    @staticmethod
    def _vessel_id(db, vessel):
        row = db.execute("SELECT vessel_id FROM vessel_aliases WHERE alias=?", (vessel,)).fetchone()
        if row is None:
            raise ValueError(f"{vessel} is not in the Suite vessel master.")
        return row[0]

    @staticmethod
    def _master_audit(db, table, key, old, new, reason):
        db.execute("INSERT INTO master_data_audit(table_name,record_key,old_value,new_value,reason,actor,created_at) VALUES(?,?,?,?,?,?,?)",
                   (table, key, json.dumps(old) if old is not None else None, json.dumps(new), reason, getpass.getuser(), now()))

    def budget_basis(self, vessel, year):
        with connection(self.root) as db:
            return [dict(row) for row in db.execute(
                """SELECT b.* FROM vessel_budget_consumption_basis b JOIN vessel_aliases a ON a.vessel_id=b.vessel_id
                   WHERE a.alias=? AND b.budget_year=? ORDER BY b.oil_category""", (vessel, int(year)))]

    def budget_years(self, vessel):
        with connection(self.root) as db:
            return sorted({row[0] for row in db.execute(
                """SELECT b.budget_year FROM vessel_budget_consumption_basis b JOIN vessel_aliases a ON a.vessel_id=b.vessel_id
                   WHERE a.alias=?""", (vessel,))})

    def set_budget_basis(self, vessel, year, category, daily_rate, applicable_days, source_reference, remarks=None):
        if category not in BUDGET_CATEGORIES:
            raise ValueError("Budget basis applies only to ME system oil, ME cylinder oil and AE system oil.")
        if not source_reference or not source_reference.strip():
            raise ValueError("Record where this budget basis was approved.")
        daily_rate, applicable_days = float(daily_rate), float(applicable_days)
        if daily_rate < 0 or not 0 < applicable_days <= 366:
            raise ValueError("Use a non-negative daily rate and 1-366 applicable days.")
        with connection(self.root) as db, db:
            vessel_id = self._vessel_id(db, vessel)
            old = db.execute("SELECT daily_budget_rate,applicable_days_per_year,source_reference FROM vessel_budget_consumption_basis "
                             "WHERE vessel_id=? AND budget_year=? AND oil_category=?", (vessel_id, int(year), category)).fetchone()
            stamp = now()
            db.execute("""INSERT INTO vessel_budget_consumption_basis(vessel_id,budget_year,oil_category,daily_budget_rate,
                    applicable_days_per_year,annual_budget_quantity,effective_from,effective_to,source_reference,remarks,created_at,updated_at)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
                    ON CONFLICT(vessel_id,budget_year,oil_category) DO UPDATE SET daily_budget_rate=excluded.daily_budget_rate,
                    applicable_days_per_year=excluded.applicable_days_per_year,annual_budget_quantity=excluded.annual_budget_quantity,
                    source_reference=excluded.source_reference,remarks=excluded.remarks,updated_at=excluded.updated_at""",
                       (vessel_id, int(year), category, daily_rate, applicable_days, daily_rate * applicable_days,
                        f"{int(year)}-01-01", f"{int(year)}-12-31", source_reference.strip(), remarks, stamp, stamp))
            self._master_audit(db, "vessel_budget_consumption_basis", f"{vessel}|{int(year)}|{category}",
                               dict(old) if old else None,
                               dict(daily_budget_rate=daily_rate, applicable_days_per_year=applicable_days,
                                    source_reference=source_reference.strip()), remarks)

    def reference_prices(self, vessel, year):
        """Current (open-ended) prices for a year; a vessel-specific price wins over a fleet-wide one."""
        with connection(self.root) as db:
            vessel_id = self._vessel_id(db, vessel)
            rows = [dict(row) for row in db.execute(
                """SELECT * FROM oil_consumption_reference_price WHERE budget_year=? AND effective_to IS NULL
                   AND (vessel_id=? OR vessel_id IS NULL) ORDER BY vessel_id IS NOT NULL, id""", (int(year), vessel_id))]
        latest = {}
        for row in rows:  # fleet rows first, then vessel rows override
            latest[(row["oil_category"], row.get("oil_grade"))] = row
        return list(latest.values())

    def set_reference_price(self, vessel, year, category, price, source_reference, grade=None, currency="USD",
                            price_basis="Singapore", comments=None):
        """Versioned: the previous price is closed, never overwritten."""
        if category not in BUDGET_CATEGORIES:
            raise ValueError("Reference prices apply only to the three primary consumption categories.")
        if not source_reference or not source_reference.strip():
            raise ValueError("Record the source of this reference price.")
        price = float(price)
        if price < 0:
            raise ValueError("A reference price cannot be negative.")
        today = date.today().isoformat()
        with connection(self.root) as db, db:
            vessel_id = self._vessel_id(db, vessel)
            old = db.execute("""SELECT id,reference_price_per_litre FROM oil_consumption_reference_price WHERE vessel_id=?
                AND budget_year=? AND oil_category=? AND oil_grade IS ? AND effective_to IS NULL""",
                             (vessel_id, int(year), category, grade)).fetchone()
            if old:
                db.execute("UPDATE oil_consumption_reference_price SET effective_to=?,updated_at=? WHERE id=?", (today, now(), old["id"]))
            stamp = now()
            db.execute("""INSERT INTO oil_consumption_reference_price(vessel_id,budget_year,oil_category,oil_grade,
                reference_price_per_litre,currency,price_basis,reference_location,effective_from,source_reference,comments,
                created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                       (vessel_id, int(year), category, grade, price, currency, price_basis, price_basis, today,
                        source_reference.strip(), comments, stamp, stamp))
            self._master_audit(db, "oil_consumption_reference_price", f"{vessel}|{int(year)}|{category}|{grade or ''}",
                               dict(reference_price_per_litre=old["reference_price_per_litre"]) if old else None,
                               dict(reference_price_per_litre=price, currency=currency, price_basis=price_basis,
                                    source_reference=source_reference.strip()), comments)

    # ---- Master data register: vessels, tanks, parameters, change history ----
    def vessels(self):
        """Every vessel in the Suite vessel master, whether or not it has reports yet."""
        with connection(self.root) as db:
            return [row[0] for row in db.execute("SELECT name FROM vessels ORDER BY name")]

    def register(self, year):
        """One row per vessel: budget basis and current reference prices for the year (blank when not configured)."""
        rows = []
        for vessel in self.vessels():
            rows.append(dict(vessel=vessel,
                             basis={b["oil_category"]: b for b in self.budget_basis(vessel, year)},
                             prices={p["oil_category"]: p for p in self.reference_prices(vessel, year) if not p.get("oil_grade")},
                             charge=self.parameter(vessel, "ME_SYSTEM_OIL_FULL_CHARGE")))
        return rows

    def tanks(self, vessel=None, current_only=True):
        query = """SELECT t.*, v.name AS vessel FROM oil_tanks t JOIN vessels v ON v.id=t.vessel_id"""
        clauses, args = [], []
        if vessel:
            clauses.append("v.name=?")
            args.append(vessel)
        if current_only:
            clauses.append("(t.effective_to IS NULL OR t.effective_to>=?)")
            args.append(date.today().isoformat())
        if clauses:
            query += " WHERE " + " AND ".join(clauses)
        with connection(self.root) as db:
            return [dict(row) for row in db.execute(query + " ORDER BY v.name, t.oil_category, t.tank_identifier", args)]

    def save_tank(self, vessel, tank_identifier, tank_name, oil_category, physical_capacity, usable_capacity,
                  source_reference, assigned_grade=None, minimum_rob=None, safety_stock=None, unit="L",
                  effective_from=None, remarks=None, tank_id=None):
        """Add a tank, or edit one (tank_id). The previous values go to the master-data audit."""
        if oil_category not in TANK_CATEGORIES:
            raise ValueError("Choose the bulk oil the tank holds.")
        if not str(tank_identifier).strip() or not str(tank_name).strip():
            raise ValueError("Tank identifier and name are required.")
        if not source_reference or not source_reference.strip():
            raise ValueError("Record the source of the tank capacity (e.g. capacity plan, tank table).")

        def number(value, label, required=True):
            if value in (None, ""):
                if required:
                    raise ValueError(f"{label} is required.")
                return None
            value = float(value)
            if value < 0:
                raise ValueError(f"{label} cannot be negative.")
            return value
        physical = number(physical_capacity, "Physical capacity")
        usable = number(usable_capacity, "Usable capacity")
        minimum, safety = number(minimum_rob, "Minimum ROB", False), number(safety_stock, "Safety stock", False)
        if usable > physical:
            raise ValueError("Usable capacity cannot exceed physical capacity.")
        stamp, start = now(), effective_from or date.today().isoformat()
        values = dict(tank_identifier=str(tank_identifier).strip(), tank_name=str(tank_name).strip(), oil_category=oil_category,
                      assigned_grade=assigned_grade or None, physical_capacity=physical, usable_capacity=usable,
                      minimum_rob=minimum, safety_stock=safety, unit=unit, source_reference=source_reference.strip(),
                      remarks=remarks or None)
        with connection(self.root) as db, db:
            vessel_id = self._vessel_id(db, vessel)
            if tank_id:
                old = db.execute("SELECT * FROM oil_tanks WHERE id=? AND vessel_id=?", (tank_id, vessel_id)).fetchone()
                if old is None:
                    raise ValueError("Tank not found for this vessel.")
                db.execute("UPDATE oil_tanks SET " + ",".join(f"{k}=?" for k in values) + ",updated_at=? WHERE id=?",
                           (*values.values(), stamp, tank_id))
                self._master_audit(db, "oil_tanks", f"{vessel}|{values['tank_identifier']}",
                                   {k: old[k] for k in values}, values, remarks)
                return tank_id
            new_id = db.execute("INSERT INTO oil_tanks(vessel_id," + ",".join(values) + ",effective_from,created_at,updated_at) "
                                "VALUES(" + ",".join("?" * (len(values) + 4)) + ")",
                                (vessel_id, *values.values(), start, stamp, stamp)).lastrowid
            self._master_audit(db, "oil_tanks", f"{vessel}|{values['tank_identifier']}", None, values, remarks)
            return new_id

    def retire_tank(self, vessel, tank_id, reason):
        """A tank is never deleted: it stops being current from today and stays in the history."""
        if not reason or not reason.strip():
            raise ValueError("Give a reason for retiring the tank.")
        with connection(self.root) as db, db:
            vessel_id = self._vessel_id(db, vessel)
            row = db.execute("SELECT tank_identifier FROM oil_tanks WHERE id=? AND vessel_id=?", (tank_id, vessel_id)).fetchone()
            if row is None:
                raise ValueError("Tank not found for this vessel.")
            yesterday = date.fromordinal(date.today().toordinal() - 1).isoformat()
            db.execute("UPDATE oil_tanks SET effective_to=?,updated_at=? WHERE id=?", (yesterday, now(), tank_id))
            self._master_audit(db, "oil_tanks", f"{vessel}|{row[0]}", None, dict(effective_to=yesterday), reason.strip())

    def parameter(self, vessel, key):
        with connection(self.root) as db:
            row = db.execute("""SELECT p.* FROM vessel_lube_parameters p JOIN vessels v ON v.id=p.vessel_id
                WHERE v.name=? AND p.parameter=? AND p.effective_to IS NULL ORDER BY p.id DESC LIMIT 1""", (vessel, key)).fetchone()
        return dict(row) if row else None

    def set_parameter(self, vessel, key, value, source_reference, remarks=None):
        """Versioned like reference prices: the previous value is closed, never overwritten."""
        if key not in PARAMETERS:
            raise ValueError("Unknown vessel parameter.")
        if not source_reference or not source_reference.strip():
            raise ValueError("Record the source of this value (e.g. engine manual, chief engineer confirmation).")
        value = float(value)
        if value <= 0:
            raise ValueError("The value must be greater than zero.")
        today = date.today().isoformat()
        with connection(self.root) as db, db:
            vessel_id = self._vessel_id(db, vessel)
            old = db.execute("SELECT id,value FROM vessel_lube_parameters WHERE vessel_id=? AND parameter=? AND effective_to IS NULL",
                             (vessel_id, key)).fetchone()
            if old:
                db.execute("UPDATE vessel_lube_parameters SET effective_to=?,updated_at=? WHERE id=?", (today, now(), old["id"]))
            stamp = now()
            db.execute("""INSERT INTO vessel_lube_parameters(vessel_id,parameter,value,unit,effective_from,source_reference,
                remarks,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)""",
                       (vessel_id, key, value, PARAMETERS[key][1], today, source_reference.strip(), remarks, stamp, stamp))
            self._master_audit(db, "vessel_lube_parameters", f"{vessel}|{key}",
                               dict(value=old["value"]) if old else None, dict(value=value, source_reference=source_reference.strip()),
                               remarks)

    def master_history(self, limit=30):
        with connection(self.root) as db:
            return [dict(row) for row in db.execute("SELECT * FROM master_data_audit ORDER BY id DESC LIMIT ?", (limit,))]

    def add_comment(self, vessel, period, comment, variance_type="GENERAL", category=None, grade=None,
                    report_id=None, event_id=None):
        """Superintendent explanation. Recorded with the Windows user and a timestamp; never generated."""
        if not comment or not comment.strip():
            raise ValueError("A comment cannot be empty.")
        stamp = now()
        with connection(self.root) as db, db:
            vessel_id = self._vessel_id(db, vessel)
            return db.execute("""INSERT INTO cost_variance_comments(vessel_id,period,oil_category,oil_grade,report_id,event_id,
                variance_type,comment,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
                              (vessel_id, period, category, grade, report_id, event_id, variance_type, comment.strip(),
                               getpass.getuser(), stamp, stamp)).lastrowid

    def comments(self, vessel, period=None):
        with connection(self.root) as db:
            vessel_id = self._vessel_id(db, vessel)
            query = "SELECT * FROM cost_variance_comments WHERE vessel_id=?" + (" AND period=?" if period else "") + " ORDER BY id DESC"
            return [dict(row) for row in db.execute(query, (vessel_id, period) if period else (vessel_id,))]
