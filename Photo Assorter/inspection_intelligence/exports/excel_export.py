import os
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Font
from openpyxl.utils import get_column_letter

from inspection_intelligence.models import ClassificationResult

HEADERS = (
    "Photo Name",
    "Vessel",
    "Inspection Date",
    "AI Level 1",
    "Confidence",
    "Abhishek Classification",
    "Final Classification",
    "Review Status",
    "Reason",
)


def export_results(results: list[ClassificationResult], output_path: Path) -> None:
    output = os.path.normcase(str(output_path.resolve()))
    original_paths = {
        os.path.normcase(str(Path(result.original_path).resolve())) for result in results
    }
    if output in original_paths:
        raise ValueError("The Excel export path cannot overwrite an original photograph.")

    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "Inspection Results"
    sheet.append(HEADERS)
    for cell in sheet[1]:
        cell.font = Font(bold=True)
    for result in results:
        sheet.append(
            (
                result.filename,
                result.vessel,
                result.inspection_date,
                result.ai_level1,
                result.ai_confidence,
                result.abhishek_level1,
                result.final_level1,
                result.review_status,
                result.ai_reason,
            )
        )
    for column in sheet.columns:
        width = min(max(max(len(str(cell.value or "")) for cell in column) + 2, 12), 60)
        sheet.column_dimensions[get_column_letter(column[0].column)].width = width
    sheet.freeze_panes = "A2"
    workbook.save(output_path)
