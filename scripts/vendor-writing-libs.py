"""Install pinned, integrity-checked browser assets; no npm build or runtime CDN."""
import base64
import hashlib
import io
from pathlib import Path
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1] / 'static/vendor'
PACKAGES = [
    ('codemirror', '5.65.21', '6teYk0bA0nR3QP0ihGMoxuKzpl5W80FpnHpBJpgy66NK3cZv5b/d/HY8PnRvfSsCG1MTfr92u2WUl+wT0E40mQ==',
     ['lib/codemirror.js', 'lib/codemirror.css', 'mode/markdown/markdown.js', 'addon/edit/continuelist.js', 'LICENSE']),
    ('markdown-it', '15.0.2', 'q4IGxMv56jCqT4OCRCADBoDP3LO4MhmTXjFbphHPXs4g3j9Xg5RDnxqN8IF/3vIWEU+VCnUq+7JUg/cfy2E6Qw==',
     ['dist/browser/markdown-it.umd.min.js', 'LICENSE']),
    ('katex', '0.19.0', 'v6Tznz3zJ7u3niRCoDTsumM2+HA2XXcCu+WAacCeHD2z3p9A9Ks987o5FzfTGBN0e8A0vjEgIDvLbICrXpdw/Q==',
     ['dist/katex.min.js', 'dist/katex.min.css', 'LICENSE', 'dist/fonts/']),
]


def main():
    for name, version, checksum, paths in PACKAGES:
        url = f'https://registry.npmjs.org/{name}/-/{name}-{version}.tgz'
        with urllib.request.urlopen(url, timeout=60) as response:
            raw = response.read()
        assert base64.b64encode(hashlib.sha512(raw).digest()).decode() == checksum, name
        with tarfile.open(fileobj=io.BytesIO(raw), mode='r:gz') as archive:
            count = 0
            for member in archive.getmembers():
                relative = member.name.removeprefix('package/')
                if not member.isfile() or not any(relative == p or (p.endswith('/') and relative.startswith(p)) for p in paths):
                    continue
                destination = ROOT / name / relative
                assert destination.resolve().is_relative_to((ROOT / name).resolve())
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(archive.extractfile(member).read())
                count += 1
        assert any((ROOT / name / filename).is_file() for filename in ('LICENSE', 'LICENSE.md')), f'{name}: license missing'
        assert all((ROOT / name / filename).is_file() for filename in paths if not filename.endswith('/')), f'{name}: asset missing'
        print(f'{name} {version}: {count} local assets, SHA-512 verified')


if __name__ == '__main__':
    main()
