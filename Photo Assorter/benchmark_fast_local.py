"""Measure uncached local sorting; never changes inspection records."""
import argparse
from contextlib import closing
import json
import sqlite3
from pathlib import Path
from time import monotonic

from inspection_intelligence.configuration import load_configuration, get_data_directory, get_config_directory
from inspection_intelligence.services.ai.fast_local_provider import FastLocalProvider
from inspection_intelligence.services.storage.local_storage import discover_photos


def load_reference_photos(database: Path) -> tuple[list[tuple[Path, str]], int, int]:
    if not database.is_file():
        raise FileNotFoundError(f"Inspection database does not exist: {database}")
    with closing(sqlite3.connect(f"{database.as_uri()}?mode=ro", uri=True)) as connection:
        rows = connection.execute(
            """
            SELECT original_path, MIN(abhishek_level1), COUNT(DISTINCT abhishek_level1)
            FROM classification_results
            WHERE abhishek_level1 IS NOT NULL
            GROUP BY original_path
            ORDER BY MAX(id) DESC
            """
        ).fetchall()

    references: list[tuple[Path, str]] = []
    missing_photos = 0
    conflicting_references = 0
    for original_path, label, label_count in rows:
        if label_count != 1:
            conflicting_references += 1
            continue
        photo = Path(original_path)
        if not photo.is_file():
            missing_photos += 1
            continue
        references.append((photo, label))
    return references, missing_photos, conflicting_references


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--folder', type=Path)
    parser.add_argument('--count', type=int)
    parser.add_argument(
        '--against-abhishek',
        action='store_true',
        help='Evaluate only unique, locally stored photos with an Abhishek Classification.',
    )
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    if args.count is not None and args.count < 1:
        parser.error('--count must be a positive integer.')
    if args.against_abhishek and args.folder:
        parser.error('--against-abhishek reads labeled photo paths from the local database; omit --folder.')

    config = load_configuration()
    missing_photos = 0
    conflicting_references = 0
    references: list[tuple[Path, str]] = []
    if args.against_abhishek:
        references, missing_photos, conflicting_references = load_reference_photos(
            get_data_directory() / 'inspection_intelligence.sqlite3'
        )
        if args.count is not None:
            references = references[:args.count]
        photos = [photo for photo, _label in references]
    elif args.folder:
        photos = discover_photos(args.folder)
        photos = photos[:args.count] if args.count is not None else photos[:5]
    else:
        database = get_data_directory() / 'inspection_intelligence.sqlite3'
        if not database.is_file():
            raise SystemExit('Inspection database not found. Supply --folder.')
        with closing(sqlite3.connect(f'{database.as_uri()}?mode=ro', uri=True)) as connection:
            rows = connection.execute('SELECT original_path FROM classification_results '
                                      'GROUP BY original_path ORDER BY MAX(id) DESC').fetchall()
        photos = [Path(row[0]) for row in rows if Path(row[0]).is_file()]
        photos = photos[:args.count] if args.count is not None else photos[:5]
    if not photos:
        if args.against_abhishek:
            raise SystemExit(
                'No accessible, consistently Abhishek-classified photos found in the local database.'
            )
        raise SystemExit('No readable photos. Supply --folder.')
    provider = FastLocalProvider(get_config_directory().parent / 'models' / 'clip-vit-base-patch32', config.taxonomy)
    started = monotonic()
    provider.ensure_available()
    load_seconds = monotonic() - started
    print(f'Model ready in {load_seconds:.2f}s', flush=True)
    results = []
    for index, photo in enumerate(photos, 1):
        start = monotonic()
        try:
            decision = provider.classify(photo)
            row = {'photo': photo.name, 'original_path': str(photo.resolve()),
                   'category': decision.level1,
                   'similarity': decision.confidence, 'reason': decision.reason}
        except Exception as error:
            row = {'photo': photo.name, 'original_path': str(photo.resolve()), 'error': str(error)}
        if args.against_abhishek:
            reference = references[index - 1][1]
            row['abhishek_classification'] = reference
            row['exact_match'] = row.get('category') == reference
        row['seconds'] = round(monotonic() - start, 3)
        results.append(row)
        print(f'{index}/{len(photos)} {json.dumps(row)}', flush=True)
    succeeded = sum('error' not in row for row in results)
    report = {
        'model': provider.model_name,
        'reference_standard': 'Abhishek Classification' if args.against_abhishek else None,
        'load_seconds': round(load_seconds, 3),
        'total_seconds': round(monotonic() - started, 3),
        'photos': len(results),
        'successfully_processed': succeeded,
        'failures': len(results) - succeeded,
        'mean_photo_seconds': round(sum(row['seconds'] for row in results) / len(results), 3),
        'review_required': sum(row.get('category') == config.taxonomy.review_required for row in results),
        'missing_source_photos': missing_photos,
        'conflicting_reference_labels': conflicting_references,
        'results': results,
    }
    if args.against_abhishek:
        exact_matches = sum(row.get('exact_match') is True for row in results)
        report['exact_matches'] = exact_matches
        report['mismatches'] = len(results) - exact_matches
        report['accuracy'] = exact_matches / len(results)
    output = args.output or Path(
        'data/benchmark-fast-local-accuracy.json'
        if args.against_abhishek
        else 'data/benchmark-fast-local.json'
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2), encoding='utf-8')
    report['output'] = str(output)
    print(json.dumps({key: value for key, value in report.items() if key != 'results'}), flush=True)


if __name__ == '__main__':
    main()
