"""Exercise links with disposable manuscripts/PDFs and mocked system launches."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import server
import codex_models
import codex_usage
from ezread import writing, writing_links
from reportlab.pdfgen import canvas


def main():
    with tempfile.TemporaryDirectory(prefix='writing-links-', dir=ROOT / 'work', ignore_cleanup_errors=True) as folder:
        server.DATA = Path(folder)
        server.LIBRARY = server.DATA / 'library'
        server.init_db()
        for name, kind in [('参考文件夹', 'folder'), ('当前.md', 'file'), ('参考文件夹/参考.md', 'file'), ('参考文件夹/参考.docx', 'file'), ('参考文件夹/参考.tex', 'file')]:
            writing.mutate(server, {'operation': 'create', 'path': name, 'kind': kind})
        pid = '1234567890abcdef'
        pdf = server.LIBRARY / pid / 'original.pdf'
        pdf.parent.mkdir(parents=True)
        output = canvas.Canvas(str(pdf), pagesize=(600, 800))
        output.drawString(40, 700, 'PaperNest local link fixture'); output.showPage(); output.save()
        original = pdf.read_bytes()
        server.put_doc({'id': pid, 'hash': 'synthetic-link', 'title': 'Linked PDF', 'deleted': False, 'notes': 'preserve notes',
                        'blocks': [], 'figures': [], 'pages': [{'number': 1, 'width': 600, 'height': 800, 'image': 'page-001.jpg'}]})
        external = server.DATA / 'external'
        external.mkdir()
        (external / 'external.pdf').write_bytes(original)
        (external / 'plain.txt').write_text('External fixture', encoding='utf-8')
        server.codex_status = lambda **kw: {'available': False, 'authenticated': False}
        codex_models.get = lambda **kw: {'models': [], 'status': 'unavailable', 'refreshing': False}
        codex_usage.snapshot = codex_usage.get = lambda **kw: {'status': 'unavailable', 'buckets': []}
        listener = server.PaperNestHTTPServer(('127.0.0.1', 0), server.Handler)
        server.PORT = listener.server_port
        thread = threading.Thread(target=listener.serve_forever, daemon=True)
        thread.start()
        runtime = Path.home() / '.cache/codex-runtimes/codex-primary-runtime/dependencies/node'
        env = dict(os.environ, EZREAD_TEST_URL=f'http://127.0.0.1:{server.PORT}', EZREAD_TEST_ROOT=str(ROOT),
                   EZREAD_LINK_EXTERNAL=str(external), EZREAD_LINK_WRITING=str(writing.root(server)), EZREAD_LINK_PDF=str(pdf))
        env.setdefault('EZREAD_PLAYWRIGHT', str(runtime / 'node_modules/playwright'))
        try:
            with patch.object(writing_links.os, 'startfile', create=True) as files, patch.object(writing_links.webbrowser, 'open', return_value=True) as browser:
                subprocess.run(['node', str(ROOT / 'tests/browser_writing_links.cjs')], cwd=ROOT, env=env, check=True)
                assert files.call_count == 2, files.call_args_list
                assert browser.call_count == 1, browser.call_args_list
            assert pdf.read_bytes() == original
            assert server.get_doc(pid)['notes'] == 'preserve notes'
            assert len(server.all_docs()) == 1
            print('Local link routing, original bytes/notes, and isolated system-launch checks passed.')
        finally:
            listener.shutdown(); listener.server_close(); thread.join(2)


if __name__ == '__main__':
    main()
