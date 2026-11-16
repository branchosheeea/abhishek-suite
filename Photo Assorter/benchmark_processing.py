"""Benchmark local inference without changing inspection records or source photos."""
import argparse
import base64
import json
import sqlite3
import time
from pathlib import Path
from urllib.request import Request, urlopen

from openpyxl import load_workbook

from benchmark_fast_local import load_reference_photos
from inspection_intelligence.configuration import load_configuration, get_data_directory
from inspection_intelligence.services.storage.local_storage import discover_photos, prepare_image
from inspection_intelligence.taxonomy import Taxonomy


def load_excel_references(
    workbook_path: Path,
    photo_folder: Path,
    taxonomy: Taxonomy,
) -> tuple[list[tuple[Path, str]], int]:
    if not workbook_path.is_file():
        raise FileNotFoundError(f"Reference workbook does not exist: {workbook_path}")

    photos_by_name: dict[str, list[Path]] = {}
    for photo in discover_photos(photo_folder):
        photos_by_name.setdefault(photo.name.casefold(), []).append(photo)

    workbook = load_workbook(workbook_path, read_only=True, data_only=True)
    try:
        worksheet = (
            workbook["Inspection Results"]
            if "Inspection Results" in workbook.sheetnames
            else workbook.active
        )
        rows = worksheet.iter_rows(values_only=True)
        headers = next(rows, None)
        if headers is None:
            raise ValueError("Reference workbook is empty.")
        header_indexes = {
            value: index for index, value in enumerate(headers) if isinstance(value, str)
        }
        required_headers = ("Photo Name", "Abhishek Classification")
        if any(header not in header_indexes for header in required_headers):
            raise ValueError(
                "Reference workbook must contain Photo Name and "
                "Abhishek Classification columns."
            )

        labels_by_name: dict[str, str] = {}
        for row in rows:
            filename = row[header_indexes["Photo Name"]]
            label = row[header_indexes["Abhishek Classification"]]
            if not isinstance(filename, str) or not filename.strip() or label in (None, ""):
                continue
            if not isinstance(label, str):
                raise ValueError(f"Invalid Abhishek Classification for {filename!r}: {label!r}")
            try:
                taxonomy.validate(label)
            except ValueError as error:
                raise ValueError(
                    f"Invalid Abhishek Classification for {filename!r}: {label}"
                ) from error
            photo_key = filename.strip().casefold()
            previous_label = labels_by_name.get(photo_key)
            if previous_label is not None and previous_label != label:
                raise ValueError(
                    f"Conflicting Abhishek Classifications for {filename!r} in the workbook."
                )
            labels_by_name[photo_key] = label

        references: list[tuple[Path, str]] = []
        missing_photos = 0
        for photo_key, label in labels_by_name.items():
            matches = photos_by_name.get(photo_key, [])
            if not matches:
                missing_photos += 1
                continue
            if len(matches) > 1:
                raise ValueError(
                    f"More than one photo named {matches[0].name!r} exists in {photo_folder}. "
                    "Use a folder with unique photo names for an unambiguous benchmark."
                )
            references.append((matches[0], label))
        return references, missing_photos
    finally:
        workbook.close()


def extract_level1(
    response: object,
    taxonomy: Taxonomy,
    done_reason: object = None,
) -> str | None:
    if not isinstance(response, str) or done_reason == 'length':
        return None
    try:
        result = json.loads(response)
    except json.JSONDecodeError:
        return None
    if not isinstance(result, dict):
        return None
    level1 = result.get('level1')
    confidence = result.get('confidence')
    reason = result.get('reason')
    if not isinstance(level1, str) or level1 not in taxonomy.values:
        return None
    if isinstance(confidence, bool) or not isinstance(confidence, (int, float)):
        return None
    if not 0 <= confidence <= 1 or not isinstance(reason, str) or not reason.strip():
        return None
    return level1


def summarize_reference_results(results: list[dict]) -> dict:
    total = len(results)
    successfully_processed = sum(result.get('category') is not None for result in results)
    exact_matches = sum(result.get('exact_match') is True for result in results)
    return {
        'reference_photos': total,
        'successfully_processed': successfully_processed,
        'failed': total - successfully_processed,
        'exact_matches': exact_matches,
        'mismatches': total - exact_matches,
        'accuracy': exact_matches / total if total else None,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--folder', type=Path)
    parser.add_argument('--count', type=int, default=3)
    parser.add_argument('--size', type=int)
    parser.add_argument('--tokens', type=int, default=96)
    parser.add_argument('--model')
    parser.add_argument('--baseline', action='store_true')
    parser.add_argument(
        '--against-abhishek',
        action='store_true',
        help='Evaluate only photos with an Abhishek Classification.',
    )
    parser.add_argument(
        '--reference-excel',
        type=Path,
        help='Read Abhishek Classification labels from an Excel export; requires --folder.',
    )
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    config = load_configuration()
    if args.count < 1:
        parser.error('--count must be a positive integer.')
    if args.size is not None and args.size < 1:
        parser.error('--size must be a positive integer.')
    if args.reference_excel and not args.against_abhishek:
        parser.error('--reference-excel requires --against-abhishek.')
    if args.reference_excel and not args.folder:
        parser.error('--reference-excel requires --folder containing the workbook photos.')
    if args.against_abhishek and args.folder and not args.reference_excel:
        parser.error(
            'When using --folder with --against-abhishek, provide --reference-excel for the labels.'
        )
    references = []
    missing_photos = 0
    conflicting_references = 0
    if args.reference_excel:
        references, missing_photos = load_excel_references(
            args.reference_excel,
            args.folder,
            config.taxonomy,
        )
        references = references[:args.count]
        photos = [reference[0] for reference in references]
    elif args.against_abhishek:
        references, missing_photos, conflicting_references = load_reference_photos(
            get_data_directory() / 'inspection_intelligence.sqlite3'
        )
        references = references[:args.count]
        photos = [reference[0] for reference in references]
    elif args.folder:
        photos = discover_photos(args.folder)[:args.count]
    else:
        database = get_data_directory() / 'inspection_intelligence.sqlite3'
        if not database.is_file():
            raise SystemExit('Inspection database not found. Supply --folder.')
        with sqlite3.connect(f'{database.as_uri()}?mode=ro', uri=True) as connection:
            rows = connection.execute('SELECT original_path FROM classification_results '
                                      'GROUP BY original_path ORDER BY MAX(id) DESC').fetchall()
        photos = [Path(row[0]) for row in rows if Path(row[0]).is_file()][:args.count]
    if not photos:
        if args.against_abhishek:
            raise SystemExit(
                'No accessible, consistently Abhishek-classified photos found in the selected reference source.'
            )
        raise SystemExit('No readable photographs. Supply --folder.')
    image_dimension = (
        config.max_image_dimension if args.baseline or (args.against_abhishek and args.size is None)
        else args.size if args.size is not None else 768
    )
    schema = {'type': 'object', 'properties': {
        'level1': {'type': 'string', 'enum': list(config.taxonomy.values)},
        'confidence': {'type': 'number'}, 'reason': {'type': 'string'}},
        'required': ['level1', 'confidence', 'reason'], 'additionalProperties': False}
    results = []
    benchmark_started = time.perf_counter()
    for index, photo in enumerate(photos, 1):
        print(f'Benchmark {index}/{len(photos)}: {photo.name}', flush=True)
        start = time.perf_counter()
        prep = None
        try:
            image, _ = prepare_image(photo, image_dimension)
            prep = time.perf_counter() - start
            prompt = config.prompt.replace('{taxonomy}', ', '.join(config.taxonomy.values))
            if not args.baseline:
                prompt += '\nUse at most 12 words for reason. Return compact JSON without whitespace.'
            payload = {'model': args.model or config.model_name, 'prompt': prompt,
                       'images': [base64.b64encode(image).decode('ascii')],
                       'format': 'json' if args.baseline else schema, 'stream': False,
                       'options': {'temperature': 0}}
            if not args.baseline:
                payload['options'].update(num_predict=args.tokens, num_ctx=2048)
                payload['keep_alive'] = '30m'
            request = Request(f'{config.ollama_url}/api/generate',
                              data=json.dumps(payload).encode(),
                              headers={'Content-Type': 'application/json'})
            with urlopen(request, timeout=config.request_timeout_seconds) as response:
                answer = json.load(response)
            response_text = answer.get('response')
            done_reason = answer.get('done_reason')
            category = extract_level1(response_text, config.taxonomy, done_reason)
            row = {'photo': photo.name, 'original_path': str(photo.resolve()), 'category': category,
                   'wall_seconds': round(time.perf_counter() - start, 3),
                   'prepare_seconds': round(prep, 3), 'response': response_text,
                   'done_reason': done_reason}
            if category is None:
                row['classification_error'] = 'Missing, malformed, or unapproved Level 1 response.'
            for key in ('total_duration', 'load_duration', 'prompt_eval_duration', 'eval_duration'):
                row[key.replace('_duration', '_seconds')] = round(answer.get(key, 0) / 1e9, 3)
            row.update({key: answer.get(key) for key in ('eval_count', 'prompt_eval_count')})
        except Exception as error:
            row = {'photo': photo.name, 'original_path': str(photo.resolve()), 'error': str(error),
                   'prepare_seconds': round(prep, 3) if prep is not None else None,
                   'wall_seconds': round(time.perf_counter() - start, 3)}
        if args.against_abhishek:
            reference = references[index - 1][1]
            row['abhishek_classification'] = reference
            row['exact_match'] = row.get('category') == reference
        results.append(row)
        print(json.dumps(row), flush=True)
    report = {
        'baseline': args.baseline,
        'image_dimension': image_dimension,
        'model': args.model or config.model_name,
        'reference_source': str(args.reference_excel.resolve()) if args.reference_excel else (
            'local database' if args.against_abhishek else None
        ),
        'photos': len(results),
        'total_seconds': round(time.perf_counter() - benchmark_started, 3),
        'average_photo_seconds': round(
            sum(result['wall_seconds'] for result in results) / len(results), 3
        ),
        'missing_source_photos': missing_photos,
        'conflicting_reference_labels': conflicting_references,
        'results': results,
    }
    if args.against_abhishek:
        report.update(summarize_reference_results(results))
    output = args.output or Path(
        'data/benchmark-gemma-accuracy.json' if args.against_abhishek else 'data/benchmark.json'
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps({key: value for key, value in report.items() if key != 'results'}), flush=True)


if __name__ == '__main__':
    main()
