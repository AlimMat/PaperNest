"""Synthetic PDF/browser integration check; no user library or model calls."""
import argparse
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import server
import codex_bridge
import codex_models
import codex_usage
import pdfplumber
from reportlab.pdfgen import canvas
from PIL import Image, ImageDraw


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--readwrite-only', action='store_true')
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='pdf-selection-', dir=ROOT / 'work', ignore_cleanup_errors=True) as folder:
        server.DATA = Path(folder)
        server.LIBRARY = server.DATA / 'library'
        server.init_db()
        pid = '1234567890abcdef'
        asset = server.LIBRARY / pid
        asset.mkdir(parents=True)
        source = asset / 'original.pdf'
        pdf = canvas.Canvas(str(source), pagesize=(600, 800))
        for number in range(1, 3):
            pdf.setFont('Helvetica', 14)
            pdf.drawString(45, 720, 'Robot learning improves control.')
            pdf.drawString(330, 720, 'Language guides actions.')
            pdf.drawString(45, 695, 'Second line with useful notes.')
            pdf.drawString(45, 650, 'Scene perturba-')
            pdf.drawString(45, 625, 'tions affect control.')
            pdf.drawString(45, 600, 'Another paragraph stays separate.')
            pdf.showPage()
        pdf.save()
        original = source.read_bytes()
        blocks, pages = [], []
        with pdfplumber.open(source) as doc:
            for number, page in enumerate(doc.pages, 1):
                pages.append({'number': number, 'width': 600, 'height': 800, 'image': f'page-{number:03}.jpg'})
                groups = [([c for c in page.chars if c['x0'] < 300 and c['top'] < 90], 'Robot learning improves control.'),
                          ([c for c in page.chars if c['x0'] >= 300], 'Language guides actions.'),
                          ([c for c in page.chars if c['x0'] < 300 and 90 <= c['top'] < 125], 'Second line with useful notes.'),
                          ([c for c in page.chars if c['x0'] < 300 and 125 <= c['top'] < 180], 'Scene perturbations affect control.'),
                          ([c for c in page.chars if c['x0'] < 300 and c['top'] >= 180], 'Another paragraph stays separate.')]
                for index, (chars, text) in enumerate(groups):
                    blocks.append({'id': f'p{number}-b{index}', 'page': number, 'text': text, 'kind': 'paragraph',
                                   'bbox': [min(c['x0'] for c in chars) / 600, min(c['top'] for c in chars) / 800,
                                            max(c['x1'] for c in chars) / 600, max(c['bottom'] for c in chars) / 800]})
        figures = []
        for number, size in enumerate(((320, 180), (220, 300)), 1):
            filename = f'figure-{number:03}.png'
            picture = Image.new('RGB', size, '#eef4ed')
            draw = ImageDraw.Draw(picture)
            draw.rectangle((25, 30, size[0] - 25, size[1] - 30), fill='#90b59d', outline='#365b47', width=3)
            draw.text((40, 50), f'Figure {number}', fill='#18392b')
            picture.save(asset / filename)
            figures.append({'id': f'figure-{number}', 'path': filename, 'page': number})
        server.put_doc({'id': pid, 'hash': 'synthetic', 'title': 'PDF selection fixture', 'deleted': False,
                        'blocks': blocks, 'pages': pages, 'figures': figures, 'translation': {'status': 'idle'}, 'notes': ''})
        if args.readwrite_only:
            from ezread import writing
            import shutil
            second = 'abcdef1234567890'
            second_asset = server.LIBRARY / second
            second_asset.mkdir()
            shutil.copyfile(source, second_asset / 'original.pdf')
            server.put_doc({**server.get_doc(pid), 'id': second, 'hash': 'synthetic-second', 'title': 'Second reference paper', 'figures': []})
            for name in ('读写草稿.md', '第二份文稿.md'):
                writing.mutate(server, {'operation': 'create', 'path': name})
        server.codex_status = lambda **kw: {'available': False, 'authenticated': False}
        codex_bridge.prepare_selection = lambda **kw: None
        codex_models.get = lambda **kw: {'models': [], 'status': 'unavailable', 'refreshing': False}
        codex_usage.snapshot = codex_usage.get = lambda **kw: {'status': 'unavailable', 'buckets': []}
        listener = server.PaperNestHTTPServer(('127.0.0.1', 0), server.Handler)
        server.PORT = listener.server_port
        thread = threading.Thread(target=listener.serve_forever, daemon=True)
        thread.start()
        env = dict(os.environ, EZREAD_TEST_URL=f'http://127.0.0.1:{server.PORT}', EZREAD_TEST_ROOT=str(ROOT),
                   EZREAD_TEST_PDF_PATH=str(source.resolve()))
        runtime = Path.home() / '.cache/codex-runtimes/codex-primary-runtime/dependencies/node'
        env.setdefault('EZREAD_PLAYWRIGHT', str(runtime / 'node_modules/playwright'))
        try:
            test = 'browser_readwrite.cjs' if args.readwrite_only else 'browser_pdf_selection.cjs'
            subprocess.run(['node', str(ROOT / 'tests' / test)], cwd=ROOT, env=env, check=True)
            assert source.read_bytes() == original, 'PDF bytes changed'
            if not args.readwrite_only:
                saved = server.get_doc(pid)
                assert len(saved['text_annotations']) >= 2
                assert any(part.get('type') == 'image' for note in saved['text_annotations']
                           for part in note.get('note_content', [])), 'Note image was not persisted'
            print('PDF byte preservation and database persistence verified.')
        finally:
            listener.shutdown()
            listener.server_close()
            thread.join(2)


if __name__ == '__main__':
    main()
