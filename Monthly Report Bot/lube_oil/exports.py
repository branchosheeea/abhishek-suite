"""Export the selected multi-vessel monthly analysis to PDF and Excel."""
from __future__ import annotations

from pathlib import Path
import re
import textwrap
import unicodedata

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter


def _source_cells(report, fields):
    evidence = report.get("data", {}).get("evidence", {})
    locations = []
    for field in fields:
        source = evidence.get(field)
        if source:
            locations.append(f"{source['sheet']}!{source['cell']}")
    return ", ".join(dict.fromkeys(locations))


def analysis_lines(analysis):
    lines = [
        f"Reporting month: {analysis['month']}",
        f"Reports for month: {analysis['report_count']}",
        f"Reports without a resolved workbook month: {analysis['unresolved_count']}",
        "Each vessel is compared only with its own calendar-month history.",
        "3M/6M/12M baselines use the preceding months, excluding the selected month.",
        "Only complete windows produce a percentage change; partial coverage is shown without a change claim.",
        "Confirmed baselines exclude pending reports. A separate preliminary reference may include unconfirmed reports and must be verified.",
        "",
    ]
    for vessel in analysis["vessels"]:
        lines.append(f"{vessel['vessel']} — {vessel['state'].upper()}")
        report = vessel["report"]
        if not report:
            if vessel["state"] == "ambiguous":
                lines.append(
                    f"Multiple active or pending source versions exist for {analysis['month']}; "
                    "resolve the version before comparing."
                )
            else:
                lines.append(f"No report is available for {analysis['month']}.")
            lines.append("")
            continue
        lines.append(
            f"Source: {report['filename']} · SHA-256 {report.get('sha256', 'unavailable')} "
            f"· validation {report['validation_status']}"
        )
        brief = vessel["brief"]
        if brief:
            lines.extend(
                [
                    f"Priority: {brief['headline']}",
                    f"Reason: {brief['rationale']}",
                    f"Action: {brief['action']}",
                    f"Boundary: {brief['boundary']}",
                ]
            )
            lines.extend(f"Evidence: {fact}" for fact in brief["facts"])
        for engine in vessel["engines"]:
            lines.append(
                f"{engine['engine']}: {engine['rate'] if engine['rate'] is not None else 'unavailable'} L/24h "
                f"({engine['hours'] if engine['hours'] is not None else 'unavailable'} h)"
            )
            for window in analysis["windows"]:
                comparison = engine["comparisons"][window]
                average = comparison["average_rate"]
                change = comparison["change_percent"]
                change_text = f"{change:+.1f}%" if change is not None else "not calculated"
                lines.append(
                    f"  Prior {window}M: {average:.2f} L/24h" if average is not None
                    else f"  Prior {window}M: no comparable baseline"
                )
                lines.append(
                    f"    coverage {comparison['coverage']}/{window} months; "
                    f"change {change_text}; grade {comparison['grade'] or 'unresolved'}"
                )
                if comparison["reference_provisional_months"]:
                    reference = comparison["reference_average_rate"]
                    reference_change = comparison["reference_change_percent"]
                    lines.append(
                        f"  Preliminary reference (includes pending): "
                        f"{reference:.2f} L/24h" if reference is not None
                        else "  Preliminary reference (includes pending): unavailable"
                    )
                    lines.append(
                        f"    coverage {comparison['reference_coverage']}/{window}; "
                        f"{comparison['reference_provisional_months']} pending month(s); "
                        f"change {f'{reference_change:+.1f}%' if reference_change is not None else 'not calculated'}"
                    )
        for engine in vessel["engines"]:
            cylinder_rate = engine.get("cylinder_rate")
            if cylinder_rate is None:
                continue
            grades = "; ".join(
                f"{family.title()}: {grade}"
                for family, grade in engine.get("cylinder_grade_basis", ())
            ) or "grade unresolved"
            lines.append(
                f"{engine['engine']} cylinder-oil rate: {cylinder_rate:.2f} L/24h "
                f"· grade basis {grades}"
            )
            for window in analysis["windows"]:
                comparison = engine["cylinder_comparisons"][window]
                average = comparison["average_rate"]
                change = comparison["change_percent"]
                change_text = f"{change:+.1f}%" if change is not None else "not calculated"
                lines.append(
                    f"  Prior {window}M cylinder oil: {average:.2f} L/24h"
                    if average is not None else
                    f"  Prior {window}M cylinder oil: no comparable confirmed baseline"
                )
                lines.append(
                    f"    coverage {comparison['coverage']}/{window}; "
                    f"change {change_text}"
                )
                if comparison["reference_provisional_months"]:
                    reference = comparison["reference_average_rate"]
                    reference_change = comparison["reference_change_percent"]
                    lines.append(
                        f"  Preliminary cylinder-oil reference (includes pending): "
                        f"{reference:.2f} L/24h" if reference is not None
                        else "  Preliminary cylinder-oil reference (includes pending): unavailable"
                    )
                    lines.append(
                        f"    coverage {comparison['reference_coverage']}/{window}; "
                        f"{comparison['reference_provisional_months']} pending month(s); "
                        f"change {f'{reference_change:+.1f}%' if reference_change is not None else 'not calculated'}"
                    )
        for oil in vessel["oils"]:
            lines.append(
                f"{oil['category']} ({oil['grade'] or 'grade unresolved'}): "
                f"operating {oil['operating'] if oil['operating'] is not None else 'unavailable'} L; "
                f"change/loss {oil['change_loss'] if oil['change_loss'] is not None else 'unavailable'} L; "
                f"all-in {oil['all_in'] if oil['all_in'] is not None else 'unavailable'} L"
            )
            for window in analysis["windows"]:
                comparison = oil["comparisons"][window]
                average = comparison["average_operating"]
                change = comparison["change_percent"]
                lines.append(
                    f"  Prior {window}M operating: {average:.1f} L" if average is not None
                    else f"  Prior {window}M operating: no comparable confirmed baseline"
                )
                lines.append(
                    f"    coverage {comparison['coverage']}/{window} months; "
                    f"change {f'{change:+.1f}%' if change is not None else 'not calculated'}"
                )
                if comparison["reference_provisional_months"]:
                    reference = comparison["reference_average_operating"]
                    reference_change = comparison["reference_change_percent"]
                    lines.append(
                        f"  Preliminary reference (includes pending): "
                        f"{reference:.1f} L" if reference is not None
                        else "  Preliminary reference (includes pending): unavailable"
                    )
                    lines.append(
                        f"    coverage {comparison['reference_coverage']}/{window}; "
                        f"{comparison['reference_provisional_months']} pending month(s); "
                        f"change {f'{reference_change:+.1f}%' if reference_change is not None else 'not calculated'}"
                    )
        for group in vessel.get("oil_groups", []):
            unit = group["unit"] or "(reported unit)"
            current = group["monthly_consumption"]
            lines.append(
                f"Group total · {group['group']} ({len(group['grades'])} heading(s)): "
                + (f"{current:.1f} {unit}" if current is not None else f"unavailable — {group['unavailable_reason']}")
            )
            for window in analysis["windows"]:
                comparison = group["comparisons"][window]
                average = comparison["average_consumption"]
                change = comparison["change_percent"]
                lines.append(
                    f"  Prior {window}M average: {average:.1f} {unit}" if average is not None
                    else f"  Prior {window}M average: no comparable confirmed baseline"
                )
                lines.append(
                    f"    coverage {comparison['coverage']}/{window} months; "
                    f"change {f'{change:+.1f}%' if change is not None else 'not calculated'}"
                )
        for oil in vessel.get("bulk_oils", []):
            lines.append(
                f"Grade consumption · {oil['group']} · {oil['category']} · {oil['grade']}: "
                f"{oil['consumption_basis']} "
                f"{oil['monthly_consumption'] if oil['monthly_consumption'] is not None else 'unavailable'} "
                f"{oil['unit']}"
            )
            for window in analysis["windows"]:
                comparison = oil["comparisons"][window]
                average = comparison["average_consumption"]
                change = comparison["change_percent"]
                lines.append(
                    f"  Prior {window}M average: {average:.1f} {oil['unit']}"
                    if average is not None
                    else f"  Prior {window}M average: no comparable confirmed baseline"
                )
                lines.append(
                    f"    coverage {comparison['coverage']}/{window} months; "
                    f"change {f'{change:+.1f}%' if change is not None else 'not calculated'}"
                )
                if comparison["reference_provisional_months"]:
                    reference = comparison["reference_average_consumption"]
                    reference_change = comparison["reference_change_percent"]
                    lines.append(
                        f"  Preliminary grade reference (includes pending): "
                        f"{reference:.1f} {oil['unit']}" if reference is not None
                        else "  Preliminary grade reference (includes pending): unavailable"
                    )
                    lines.append(
                        f"    coverage {comparison['reference_coverage']}/{window}; "
                        f"{comparison['reference_provisional_months']} pending month(s); "
                        f"change {f'{reference_change:+.1f}%' if reference_change is not None else 'not calculated'}"
                    )
        for issue in vessel["issues"]:
            fields = _source_cells(report, issue.get("fields", []))
            lines.append(
                f"Finding ({issue['severity']}): {issue['title']} — {issue['detail']}"
                + (f" · source {fields}" if fields else "")
            )
        lines.append("")
    return lines


def export_excel(analysis, target):
    target = Path(target)
    workbook = Workbook()
    summary = workbook.active
    summary.title = "Fleet Summary"
    summary.append(["Lub Oil Monthly Analysis", analysis["month"]])
    summary.append(["Reports for selected month", analysis["report_count"]])
    summary.append(["Unresolved workbook months", analysis["unresolved_count"]])
    summary.append([])
    summary.append([
        "Vessel", "State", "Source", "SHA-256", "Validation", "Priority",
        "Next action",
    ])
    for vessel in analysis["vessels"]:
        report = vessel["report"]
        brief = vessel["brief"] or {}
        summary.append([
            vessel["vessel"],
            vessel["state"],
            report["filename"] if report else "",
            report.get("sha256", "") if report else "",
            report["validation_status"] if report else "",
            brief.get("headline", "No report / resolve source versions"),
            brief.get("action", ""),
        ])

    trends = workbook.create_sheet("Consumption Comparisons")
    trends.append([
        "Reporting month", "Vessel", "Report state", "Measure", "Engine/system",
        "Oil grade", "Hours", "Current value", "Unit", "Baseline window",
        "Baseline average", "Change %", "Coverage", "Complete window",
        "Provisional reports excluded", "Preliminary reference average",
        "Preliminary reference change %", "Reference coverage",
        "Pending reference months", "Reference complete window",
    ])
    findings = workbook.create_sheet("Findings and Evidence")
    findings.append([
        "Reporting month", "Vessel", "Source file", "Validation", "Severity",
        "Finding", "Detail", "Source cells",
    ])
    for vessel in analysis["vessels"]:
        report = vessel["report"]
        if not report:
            continue
        for engine in vessel["engines"]:
            for window in analysis["windows"]:
                comparison = engine["comparisons"][window]
                trends.append([
                    analysis["month"], vessel["vessel"], vessel["state"], "Engine rate",
                    engine["engine"], comparison["grade"], engine["hours"], engine["rate"],
                    "L/24h", f"Prior {window}M", comparison["average_rate"],
                    comparison["change_percent"], f"{comparison['coverage']}/{window}",
                    comparison["complete"], comparison["provisional_months_available"],
                    comparison["reference_average_rate"],
                    comparison["reference_change_percent"],
                    f"{comparison['reference_coverage']}/{window}",
                    comparison["reference_provisional_months"],
                    comparison["reference_complete"],
                ])
            if engine.get("cylinder_rate") is not None:
                grade_basis = "; ".join(
                    f"{family.title()}: {grade}"
                    for family, grade in engine.get("cylinder_grade_basis", ())
                )
                for window in analysis["windows"]:
                    comparison = engine["cylinder_comparisons"][window]
                    trends.append([
                        analysis["month"], vessel["vessel"], vessel["state"],
                        "Cylinder oil rate", engine["engine"], grade_basis,
                        engine["hours"], engine["cylinder_rate"], "L/24h",
                        f"Prior {window}M", comparison["average_rate"],
                        comparison["change_percent"],
                        f"{comparison['coverage']}/{window}",
                        comparison["complete"], comparison["provisional_months_available"],
                        comparison["reference_average_rate"],
                        comparison["reference_change_percent"],
                        f"{comparison['reference_coverage']}/{window}",
                        comparison["reference_provisional_months"],
                        comparison["reference_complete"],
                    ])
        for oil in vessel["oils"]:
            for window in analysis["windows"]:
                comparison = oil["comparisons"][window]
                trends.append([
                    analysis["month"], vessel["vessel"], vessel["state"],
                    "Operating consumption", oil["category"], oil["grade"], "",
                    oil["operating"], oil["unit"], f"Prior {window}M",
                    comparison["average_operating"], comparison["change_percent"],
                    f"{comparison['coverage']}/{window}", comparison["complete"],
                    comparison["provisional_months_available"],
                    comparison["reference_average_operating"],
                    comparison["reference_change_percent"],
                    f"{comparison['reference_coverage']}/{window}",
                    comparison["reference_provisional_months"],
                    comparison["reference_complete"],
                ])
        for group in vessel.get("oil_groups", []):
            for window in analysis["windows"]:
                comparison = group["comparisons"][window]
                trends.append([
                    analysis["month"], vessel["vessel"], vessel["state"],
                    "Group total · reported withdrawal", group["group"],
                    "; ".join(group["grades"]), "",
                    group["monthly_consumption"], group["unit"] or "as reported", f"Prior {window}M",
                    comparison["average_consumption"],
                    comparison["change_percent"],
                    f"{comparison['coverage']}/{window}", comparison["complete"],
                    comparison["provisional_months_available"],
                    comparison["reference_average_consumption"],
                    comparison["reference_change_percent"],
                    f"{comparison['reference_coverage']}/{window}",
                    comparison["reference_provisional_months"],
                    comparison["reference_complete"],
                ])
        for oil in vessel.get("bulk_oils", []):
            for window in analysis["windows"]:
                comparison = oil["comparisons"][window]
                trends.append([
                    analysis["month"], vessel["vessel"], vessel["state"],
                    f"Grade consumption · {oil['consumption_basis']}",
                    f"{oil['group']} · {oil['category']}", oil["grade"], "",
                    oil["monthly_consumption"], oil["unit"], f"Prior {window}M",
                    comparison["average_consumption"],
                    comparison["change_percent"],
                    f"{comparison['coverage']}/{window}", comparison["complete"],
                    comparison["provisional_months_available"],
                    comparison["reference_average_consumption"],
                    comparison["reference_change_percent"],
                    f"{comparison['reference_coverage']}/{window}",
                    comparison["reference_provisional_months"],
                    comparison["reference_complete"],
                ])
        for issue in vessel["issues"]:
            findings.append([
                analysis["month"], vessel["vessel"], report["filename"],
                report["validation_status"], issue["severity"], issue["title"],
                issue["detail"], _source_cells(report, issue.get("fields", [])),
            ])
        brief = vessel["brief"] or {}
        for fact in brief.get("facts", []):
            findings.append([
                analysis["month"], vessel["vessel"], report["filename"],
                report["validation_status"], "REVIEW", brief["headline"], fact,
                _source_cells(report, list(report["data"].get("evidence", {}))),
            ])

    for sheet in workbook.worksheets:
        sheet.freeze_panes = "A5" if sheet.title == "Fleet Summary" else "A2"
        header_row = 5 if sheet.title == "Fleet Summary" else 1
        last_column = get_column_letter(sheet.max_column)
        sheet.auto_filter.ref = (
            f"A{header_row}:{last_column}{sheet.max_row}"
        )
        for cell in sheet[header_row]:
            cell.font = Font(bold=True, color="FFFFFF")
            cell.fill = PatternFill("solid", fgColor="17384A")
            cell.alignment = Alignment(wrap_text=True, vertical="top")
        for row in sheet.iter_rows(min_row=2):
            for cell in row:
                cell.alignment = Alignment(wrap_text=True, vertical="top")
        for column in sheet.columns:
            length = min(
                60,
                max((len(str(cell.value or "")) for cell in column), default=12) + 2,
            )
            sheet.column_dimensions[get_column_letter(column[0].column)].width = max(
                12, length
            )
    workbook.save(target)
    workbook.close()
    return target


def _pdf_text(value):
    text = unicodedata.normalize("NFKD", str(value))
    text = text.encode("ascii", "ignore").decode("ascii")
    return re.sub(r"\s+", " ", text).strip()


def _pdf_string(value):
    return _pdf_text(value).replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def export_pdf(analysis, target):
    """Write a small, dependency-free, standards-compliant text PDF."""
    target = Path(target)
    lines = analysis_lines(analysis)
    wrapped = []
    for line in lines:
        if not line:
            wrapped.append("")
        else:
            wrapped.extend(textwrap.wrap(_pdf_text(line), width=96) or [""])
    pages = [wrapped[index:index + 48] for index in range(0, len(wrapped), 48)] or [[]]

    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        None,
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    ]
    page_ids = []
    for page_lines in pages:
        page_id = len(objects) + 1
        stream_id = page_id + 1
        page_ids.append(page_id)
        commands = ["BT", "/F1 9 Tf", "48 748 Td", "12 TL"]
        for line in page_lines:
            commands.append(f"({_pdf_string(line)}) Tj")
            commands.append("T*")
        commands.append("ET")
        stream = "\n".join(commands).encode("ascii")
        objects.append(
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            f"/Resources << /Font << /F1 3 0 R >> >> /Contents {stream_id} 0 R >>".encode("ascii")
        )
        objects.append(
            f"<< /Length {len(stream)} >>\nstream\n".encode("ascii")
            + stream
            + b"\nendstream"
        )
    kids = " ".join(f"{page_id} 0 R" for page_id in page_ids)
    objects[1] = f"<< /Type /Pages /Kids [{kids}] /Count {len(page_ids)} >>".encode("ascii")

    output = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for index, obj in enumerate(objects, start=1):
        offsets.append(len(output))
        output.extend(f"{index} 0 obj\n".encode("ascii"))
        output.extend(obj)
        output.extend(b"\nendobj\n")
    xref_offset = len(output)
    output.extend(f"xref\n0 {len(objects) + 1}\n".encode("ascii"))
    output.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        output.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
    output.extend(
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
        f"startxref\n{xref_offset}\n%%EOF\n".encode("ascii")
    )
    target.write_bytes(output)
    return target
