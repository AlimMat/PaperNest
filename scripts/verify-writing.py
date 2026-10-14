"""Exercise the writing workspace against isolated data and mocked model services."""
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
import codex_models
import codex_usage
from ezread import writing


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--latex-only', action='store_true', help='Only exercise the actual XeLaTeX preview workflow.')
    parser.add_argument('--workspace-only', action='store_true', help='Exercise workspace controls, sidebar and file operations without compiling LaTeX previews.')
    args = parser.parse_args()
    (ROOT / 'work').mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='writing-check-', dir=ROOT / 'work', ignore_cleanup_errors=True) as folder:
        server.DATA = Path(folder)
        server.LIBRARY = server.DATA / 'library'
        server.init_db()
        server.codex_status = lambda **kw: {'available': False, 'authenticated': False}
        codex_models.get = lambda **kw: {'models': [], 'status': 'unavailable', 'refreshing': False}
        codex_usage.snapshot = codex_usage.get = lambda **kw: {'status': 'unavailable', 'buckets': []}
        listener = server.PaperNestHTTPServer(('127.0.0.1', 0), server.Handler)
        server.PORT = listener.server_port
        thread = threading.Thread(target=listener.serve_forever, daemon=True)
        thread.start()
        runtime = Path.home() / '.cache/codex-runtimes/codex-primary-runtime/dependencies/node'
        env = dict(os.environ, EZREAD_TEST_URL=f'http://127.0.0.1:{server.PORT}', EZREAD_TEST_ROOT=str(ROOT),
                   EZREAD_TEST_WRITING_ROOT=str(writing.root(server).resolve()))
        env.setdefault('EZREAD_PLAYWRIGHT', str(runtime / 'node_modules/playwright'))
        try:
            if args.latex_only:
                writing.mutate(server, {'operation': 'create', 'path': '增强写作.md'})
            else:
                subprocess.run(['node', str(ROOT / 'tests/browser_writing.cjs')], cwd=ROOT, env=env, check=True)
                if not args.workspace_only:
                    subprocess.run(['node', str(ROOT / 'tests/browser_markdown.cjs')], cwd=ROOT, env=env, check=True)
            if not args.workspace_only:
                subprocess.run(['node', str(ROOT / 'tests/browser_latex.cjs')], cwd=ROOT, env=env, check=True)
            if not args.latex_only:
                assert writing.document(server, '研究计划/实验.md')['content'].startswith('# 研究计划')
                assert 'Word 正文' in writing.document(server, '研究计划/论文.docx')['content']
                assert '\\section{实验}' in writing.document(server, '研究计划/公式.tex')['content']
            assert server.all_docs() == [], 'Writing unexpectedly changed the PDF library'
            print('Writing files, independent paper data, and browser checks passed.')
        finally:
            listener.shutdown()
            listener.server_close()
            thread.join(2)


if __name__ == '__main__':
    main()
