"""Evidence-first parser for the inspected 12.04.07.021 workbook family.

Coordinates are discovered from labels; returned values always retain source cells.
No Excel formulas or macros are executed. Unknowns stay None.
"""
from __future__ import annotations
import calendar
from datetime import date, datetime
import math
import re
from zipfile import ZipFile, BadZipFile
from openpyxl import load_workbook

VERSION = "1.3.0"


def norm(value):
    return re.sub(r"[^A-Z0-9]+", " ", str(value or "").upper()).strip()


def numeric(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and math.isfinite(value):
        return float(value)
    if isinstance(value, str) and re.fullmatch(r"-?\d[\d,]*(?:\.\d+)?", value.strip()):
        return float(value.replace(",", ""))
    return None


def parse_date(value):
    if isinstance(value, (date, datetime)):
        return value.strftime("%Y-%m-%d")
    text = str(value or "").strip()
    try:
        return datetime.fromisoformat(text).date().isoformat()
    except ValueError:
        try:
            return date.fromisoformat(text).isoformat()
        except ValueError:
            pass
    text = re.sub(r"\b(\d{1,2})(?:st|nd|rd|th)\b", r"\1", text, flags=re.IGNORECASE)
    match = re.search(r"\b(\d{1,2})[-./ ]([A-Za-z]+|\d{1,2})[-./ ](\d{2}|\d{4})\b", text)
    if not match:
        return None
    day, month, year = match.groups()
    try:
        month = int(month) if month.isdigit() else list(calendar.month_abbr).index(month[:3].title())
        year = int(year)
        if year < 100:
            year += 2000 if year < 70 else 1900
        return date(year, month, int(day)).isoformat()
    except ValueError:
        return None


def parse_reporting_month(value, search=False):
    """Resolve a year-month where the source may provide no exact report day."""
    text = str(value or "").strip().upper()
    month_names = "|".join(
        sorted(
            {name.upper() for name in calendar.month_abbr[1:] + calendar.month_name[1:]},
            key=len,
            reverse=True,
        )
    )
    pattern = rf"(?:{month_names})\s*[,./ -]?\s*['’]?\s*(\d{{4}}|\d{{2}})\b"
    match = re.search(pattern, text) if search else re.fullmatch(pattern, text)
    if not match:
        return None
    month_text = re.match(month_names, text[match.start():], re.IGNORECASE)
    if not month_text:
        return None
    month = list(calendar.month_abbr).index(month_text.group(0)[:3].title())
    year = int(match.group(1))
    if year < 100:
        year += 2000 if year < 70 else 1900
    return f"{year:04d}-{month:02d}"


def parse_workbook(path, source_name=None, tolerance=0.02):
    if path.suffix.lower() != ".xlsx":
        raise ValueError("This pilot supports .xlsx only; legacy or macro-enabled files require a validated reader.")
    try:
        with ZipFile(path) as archive:
            if sum(info.file_size for info in archive.infolist()) > 100 * 1024 * 1024:
                raise ValueError("Workbook expanded size exceeds the 100 MB safety limit.")
    except BadZipFile as error:
        raise ValueError("Not a readable Excel OOXML workbook.") from error
    values = load_workbook(path, data_only=True, keep_links=False)
    formulas = load_workbook(path, data_only=False, keep_links=False)
    try:
        candidates = [s for s in values if any(
            norm(c.value).startswith(("LUB OIL STOCK AND CONSUMPTION", "LUB OIL SOCK AND CONSUMPTION"))
            for row in s for c in row)]
        if len(candidates) != 1:
            raise ValueError("Unsupported or ambiguous report: expected one Lub Oil Stock and Consumption sheet.")
        s = candidates[0]
        f = formulas[s.title]
        result = dict(parser_version=VERSION, sheet=s.title, vessel=None, month=None, reporting_date=None,
                      form_number=s.title if re.search(r"12\W*04\W*07\W*021", s.title) else None,
                      received_date=None, period_basis="calendar_month", remarks="", evidence={},
                      inventory=[], engines=[], events=[], issues=[])
        issues = result["issues"]

        def issue(code, title, detail, keys=(), severity="WARNING"):
            issues.append(dict(code=code, title=title, detail=detail, fields=list(keys), severity=severity))

        def cell_value(cell, key, number=False):
            raw = cell.value
            formula = f[cell.coordinate].value if f[cell.coordinate].data_type == "f" else None
            raw_value = raw.isoformat() if isinstance(raw, (date, datetime)) else raw
            value = numeric(raw) if number else raw_value
            result["evidence"][key] = dict(sheet=s.title, cell=cell.coordinate, raw=raw_value,
                                            formula=formula, value=value)
            if number and value is None:
                reason = "Blank or blank formula result" if raw is None else "Invalid numeric value"
                issue("missing:" + key, reason, f"{key} is unavailable; it has not been replaced with zero.", [key])
            if number and value is not None and value < 0:
                issue("negative:" + key, "Negative quantity", f"Review the reported value for {key}.", [key])
            return value

        def row_for(prefix, required=True):
            matches = [c.row for row in s for c in row if norm(c.value).startswith(prefix)]
            if len(matches) == 1:
                return matches[0]
            if required:
                issue("anchor:" + prefix, "Missing or ambiguous report label", prefix, severity="FAIL")
            return None

        def right_of(label, key):
            matches = [c for row in s for c in row if norm(c.value) == label]
            if len(matches) != 1:
                issue("metadata:" + key, "Missing or ambiguous metadata", label, severity="FAIL")
                return None
            anchor = matches[0]
            for col in range(anchor.column + 1, s.max_column + 1):
                c = s.cell(anchor.row, col)
                if c.value is not None:
                    if norm(c.value) in ("VESSEL", "MONTH"):
                        break
                    return cell_value(c, key)
            return None

        result["vessel"] = " ".join(str(right_of("VESSEL", "vessel") or "").upper().split()) or None
        raw_date = right_of("MONTH", "reporting_date")
        result["reporting_date"] = parse_date(raw_date)
        result["month"] = (
            (result["reporting_date"] or "")[:7]
            or parse_reporting_month(raw_date)
        )
        if not result["vessel"] or not result["month"]:
            issue("identity", "Report identity needs review", "Vessel or reporting date could not be resolved.", ["vessel", "reporting_date"], "FAIL")
        filename_month = parse_reporting_month(source_name, search=True)
        if filename_month and result["month"] and filename_month != result["month"]:
            issue(
                "filename_period_mismatch",
                "Filename and workbook reporting months differ",
                f"Filename suggests {filename_month}; workbook states {result['month']}. "
                "The workbook period is retained and requires verification.",
                ["reporting_date"],
            )
        summary = row_for("SUMMARY")
        grade_row = row_for("GRADE OF OIL")
        rows = {}
        # Inventory, systems and fuel repeat labels. Bound all searches by section.
        summary = summary or s.max_row + 1
        grade_row = grade_row or 0
        stock_labels = {"opening": "STOCK END OF LAST MONTH", "receipts": "RECEIVED DURING THE MONTH",
                        "withdrawal": "CONSUMED DURING THIS MONTH", "closing": "STOCK END OF THE MONTH"}
        system_labels = {"system_opening": "STOCK END OF LAST MONTH A", "replenishment": "REPLENISHED TO SYSTEM FROM STORAGE TK B",
                         "system_closing": "STOCK END OF THIS MONTH C", "operating": "CONSUMPTION THIS MONTH A B C D",
                         "change_loss": "SYSTEM CHANGE LOSS OF OIL E", "all_in": "TOTAL CONSUMPTION THIS MONTH D E F"}
        first_system = row_for("STOCK END OF LAST MONTH A") or summary
        for key, label in stock_labels.items():
            matches = [c.row for row in s for c in row if grade_row < c.row < first_system and norm(c.value) == label]
            rows[key] = matches[0] if len(matches) == 1 else None
            if rows[key] is None:
                issue("anchor:" + key, "Inventory row needs review", label, severity="FAIL")
        for key, label in system_labels.items():
            rows[key] = row_for(label)
        # Grade columns are identified by observed category headers, not column letters.
        columns = []
        header_rows = [c.row for row in s for c in row if c.row < grade_row and norm(c.value) == "SYSTEM OIL M E"]
        header_row = header_rows[0] if len(header_rows) == 1 else None
        if header_row is None:
            issue("category_header", "Missing or ambiguous oil-category header", "Cannot map inventory columns safely.", severity="FAIL")
        if grade_row:
            for col in range(1, s.max_column + 1):
                grade = s.cell(grade_row, col)
                header = s.cell(header_row, col) if header_row else None
                if header is None:
                    continue
                if col > 1 and (grade.value is not None or header.value is not None):
                    if norm(grade.value) == "GRADE OF OIL" or header.value is None:
                        continue
                    columns.append(col)
        for index, col in enumerate(columns):
            key = f"oil.{index}"
            grade = cell_value(s.cell(grade_row, col), key + ".grade")
            category = str(s.cell(header_row, col).value or "").strip()
            oil = dict(id=str(index), grade=grade, category=category, unit="L" if not "GREASE" in norm(category) else None,
                       actual_rob=None, reported_shortage=None, actual_evidence=None)
            if not grade:
                issue("grade:" + key, "Missing oil grade", category, [key + ".grade"])
            for field, row in rows.items():
                # System breakdown applies to ME and AE oil only.
                if field in system_labels and norm(category) not in ("SYSTEM OIL M E", "SYSTEM OIL A E"):
                    oil[field] = None
                    continue
                oil[field] = cell_value(s.cell(row, col), key + "." + field, True) if row else None
            if oil["unit"] is None:
                issue("unit:" + key, "Confirm grease units", "Do not combine grease quantities with litres.", [key + ".grade"])
            if all(oil[k] is not None for k in ("opening", "receipts", "withdrawal", "closing")):
                residual = oil["opening"] + oil["receipts"] - oil["withdrawal"] - oil["closing"]
                if abs(residual) > 0.1:
                    issue("balance:" + key, "Storage balance does not reconcile", f"Residual {residual:,.1f} {oil['unit'] or 'units'}.", [key + "." + k for k in stock_labels])
            if all(oil.get(k) is not None for k in ("withdrawal", "operating", "change_loss", "system_opening", "system_closing")):
                residual = oil["withdrawal"] - oil["operating"] - oil["change_loss"] - (oil["system_closing"] - oil["system_opening"])
                if abs(residual) > 0.1:
                    issue("system_balance:" + key, "Storage and system movement need reconciliation", f"{category}: residual {residual:,.1f} L after system quantity movement and reported change/loss; not a proven physical loss.", [key + "." + k for k in ("withdrawal", "operating", "change_loss", "system_opening", "system_closing")])
            result["inventory"].append(oil)

        metric_rows = {key: row_for(label) for key, label in {
            "hours": "HOURS RUN DURING THIS MONTH", "rate": "SYSTEM OIL CONSUMPTION PER 24 HOURS",
            "cylinder_rate": "CYLINDER OIL CONSUMPTION PER 24 HOURS", "last_change": "SYSTEM OIL IN SERVICE LAST CHANGE DATE"}.items()}
        heads = [c for row in s for c in row if c.row > summary and (norm(c.value) == "MAIN ENGINE" or re.fullmatch(r"AUX ENG [1-4]", norm(c.value)))]
        for head in heads:
            engine = "ME" if norm(head.value) == "MAIN ENGINE" else "AE" + norm(head.value)[-1]
            if engine == "AE4" and all(s.cell(r, head.column).value is None for r in metric_rows.values() if r):
                continue
            data = {"engine": engine}
            for key, row in metric_rows.items():
                if key == "cylinder_rate" and engine != "ME":
                    continue
                data[key] = cell_value(s.cell(row, head.column), engine + "." + key, key != "last_change") if row else None
            data["last_change_raw"] = data["last_change"]
            data["last_change"] = parse_date(data["last_change"])
            if data["last_change_raw"] and not data["last_change"]:
                issue("date:" + engine, "Invalid last-change date", str(data["last_change_raw"]), [engine + ".last_change"])
            hours, rate = data["hours"], data["rate"]
            data["implied_litres"] = hours * rate / 24 if hours is not None and rate is not None and hours >= 0 and rate >= 0 else None
            if result["month"] and hours is not None:
                year, month = map(int, result["month"].split("-"))
                if hours > calendar.monthrange(year, month)[1] * 24:
                    issue("hours:" + engine, "Running hours exceed calendar month", f"{engine}: {hours:g} h exceeds {calendar.monthrange(year, month)[1] * 24} h. Confirm period or reading.", [engine + ".hours"])
            if hours == 0 and rate not in (None, 0):
                issue("zero_hours:" + engine, "Nonzero rate with zero running hours", engine, [engine + ".hours", engine + ".rate"])
            if data["last_change"] and result["reporting_date"] and data["last_change"] > result["reporting_date"]:
                issue("future_change:" + engine, "Oil-change date follows report date", engine, [engine + ".last_change", "reporting_date"])
            result["engines"].append(data)

        remarks_row = row_for("REMARKS", False)
        if remarks_row:
            texts = []
            for row in s.iter_rows(min_row=remarks_row, max_row=s.max_row):
                for c in row:
                    # Only the remarks label column: excludes signature blocks.
                    if c.column == 1 and c.value is not None and norm(c.value) != "REMARKS":
                        texts.append(str(cell_value(c, "remarks." + c.coordinate)))
            result["remarks"] = "\n".join(texts)
        remarks = result["remarks"]
        actual_pattern = r"ACTUAL\s+ROB\s*:?\s*([\d,]+(?:\.\d+)?)\s*(?:LTRS?|LITRES?)\s*\(\s*SHORT\s+BY\s*([\d,]+(?:\.\d+)?)"
        for match in re.finditer(actual_pattern, remarks, re.I):
            prefix = remarks[max(0, match.start() - 180):match.start()].upper()
            markers = [(prefix.rfind(text), category) for text, category in (
                ("TARO 30 DP40", "SYSTEM OIL A E"), ("TARO ULTRA 100", "HIGH TBN"), ("TARO ULTRA 40", "LOW TBN"))]
            position, category = max(markers)
            candidates_oil = [o for o in result["inventory"] if position >= 0 and category in norm(o["category"])]
            if len(candidates_oil) != 1:
                issue("actual_ambiguous:" + str(match.start()), "Actual ROB could not be assigned uniquely", match.group(), list(k for k in result["evidence"] if k.startswith("remarks.")))
                continue
            oil = candidates_oil[0]
            oil["actual_rob"], oil["reported_shortage"] = (numeric(v) for v in match.groups())
            oil["actual_evidence"] = match.group()
            delta = oil["closing"] - oil["actual_rob"] if oil["closing"] is not None else None
            if delta is None:
                issue("actual_uncompared:" + oil["id"], "Actual ROB could not be compared with book stock",
                      f"{oil['grade']}: vessel-stated actual is {oil['actual_rob']:,.1f} L; book closing stock is unavailable.",
                      [f"oil.{oil['id']}.closing", *[k for k in result["evidence"] if k.startswith("remarks.")]])
            elif abs(delta) > 0.1:
                issue("actual:" + oil["id"], "Book and vessel-stated actual ROB differ",
                      f"{oil['grade']}: book {oil['closing']:,.1f} L; stated actual {oil['actual_rob']:,.1f} L. Review before purchasing.",
                      [f"oil.{oil['id']}.closing", *[k for k in result["evidence"] if k.startswith("remarks.")]])
            if delta is not None and abs(delta - oil["reported_shortage"]) > 0.1:
                issue("shortage_arithmetic:" + oil["id"], "Stated shortage arithmetic differs", f"Calculated difference {delta:,.1f} L; stated shortage {oil['reported_shortage']:,.1f} L.", [f"oil.{oil['id']}.closing"])

        ae = next((o for o in result["inventory"] if norm(o["category"]) == "SYSTEM OIL A E"), None)
        me = next((o for o in result["inventory"] if norm(o["category"]) == "SYSTEM OIL M E"), None)
        main = next((e for e in result["engines"] if e["engine"] == "ME"), None)
        if main and me and main["hours"] is not None and main["hours"] > 0 and me["operating"] is not None and main["rate"] is not None:
            calculated = me["operating"] / main["hours"] * 24
            if abs(calculated - main["rate"]) > max(0.1, abs(calculated) * tolerance):
                issue("me_rate", "ME rate differs from system consumption", f"Calculated {calculated:,.2f} L/24h; reported {main['rate']:,.2f} L/24h.", ["ME.hours", "ME.rate", f"oil.{me['id']}.operating"])
        if main and me and main["hours"] == 0 and me["operating"] not in (None, 0):
            issue("zero_hours:ME", "Consumption with zero ME running hours", "Review hours and consumption.", ["ME.hours", f"oil.{me['id']}.operating"])
        engines = [e for e in result["engines"] if e["engine"].startswith("AE")]
        if ae and engines and all(e["implied_litres"] is not None for e in engines) and ae["operating"] is not None:
            implied = sum(e["implied_litres"] for e in engines)
            if abs(implied - ae["operating"]) > max(1.0, abs(ae["operating"]) * tolerance):
                issue("ae_reconciliation", "Individual AE rates do not reconcile with pooled consumption", f"Hours × rates imply {implied:,.1f} L; pooled operating consumption is {ae['operating']:,.1f} L. Implied litres are derived, not independently reported.", [f"{e['engine']}.{k}" for e in engines for k in ("hours", "rate")] + [f"oil.{ae['id']}.operating"])
        for e in result["engines"]:
            if not e["engine"].startswith("AE"):
                continue
            explicit = re.search(r"AE\s*#?\s*" + e["engine"][-1] + r"\s+SUMP\s+(?:OIL\s+)?RENEWED", remarks, re.I)
            current_change = e["last_change"] and e["last_change"][:7] == result["month"]
            if explicit or current_change:
                confirmed = bool(explicit and current_change)
                result["events"].append(dict(engine=e["engine"], date=e["last_change"], quantity=None,
                    event_type="CONFIRMED_RENEWAL" if confirmed else "PROBABLE_RENEWAL",
                    evidence="Matching renewal remark and current-month change date" if confirmed else "Last-change date and/or remark require review",
                    confidence="corroborated" if confirmed else "review_required"))
                if not confirmed:
                    issue("renewal:" + e["engine"], "Reconcile sump renewal evidence", f"{e['engine']}: change date {e['last_change'] or 'unknown'}; explicit renewal remark {'present' if explicit else 'absent'}. No quantity allocated from pooled loss.", [e["engine"] + ".last_change", *[k for k in result["evidence"] if k.startswith("remarks.")]])
        result["source_status"] = "corrected" if "CORRECT" in norm(source_name) else "revised" if "REVIS" in norm(source_name) else "unknown"
        result["validation_status"] = "FAIL" if any(i["severity"] == "FAIL" for i in issues) else "WARNING" if issues else "PASS"
        return result
    finally:
        values.close()
        formulas.close()
