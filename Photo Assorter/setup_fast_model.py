"""Download pinned public model weights. Inspection photographs are never accessed."""
import hashlib
from pathlib import Path
from urllib.request import urlopen

REVISION = '6b7c523703ae26e39be4b03774966f8571c7f523'
FILES = {
    'onnx/text_model_quantized.onnx': ('sha256', '73baab855d406190da9faa498cfedf65f15cf309f4cc7385b7b032e6d08e5c3a'),
    'onnx/vision_model_quantized.onnx': ('sha256', '583fd1110a514667812fee7d684952aaf82a99b959760c8d7dca7e0ab9839299'),
    'tokenizer.json': ('git', 'bc1f77d20440541dd073ebae6f6c401087c7d34e'),
    'preprocessor_config.json': ('git', 'e0675735fd0052745f2f7b7291e4aa7859389998'),
}


def checksum(path, algorithm):
    digest = hashlib.sha256() if algorithm == 'sha256' else hashlib.sha1()
    if algorithm == 'git':
        digest.update(f'blob {path.stat().st_size}\0'.encode())
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    directory = Path(__file__).resolve().parent / 'models' / 'clip-vit-base-patch32'
    for name, (algorithm, expected) in FILES.items():
        destination = directory / name
        if destination.exists() and checksum(destination, algorithm) == expected:
            print(f'Already verified: {name}', flush=True)
            continue
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_suffix(destination.suffix + '.part')
        print(f'Downloading {name}...', flush=True)
        url = f'https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/{REVISION}/{name}'
        for attempt in range(3):
            with urlopen(url, timeout=120) as response, temporary.open('wb') as output:
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
            if checksum(temporary, algorithm) == expected:
                break
            print(f'Incomplete download; retry {attempt + 1}/3.', flush=True)
        else:
            raise RuntimeError(f'Checksum mismatch for {name}; download not activated.')
        temporary.replace(destination)
        print(f'Verified: {name}', flush=True)
    (directory / 'revision.txt').write_text(REVISION, encoding='ascii')
    print('Fast local model is ready. No photos were uploaded.', flush=True)


if __name__ == '__main__':
    main()
