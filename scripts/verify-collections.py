"""Check group management using isolated papers and an ephemeral server."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import server


def main():
    with tempfile.TemporaryDirectory(prefix='collection-browser-', dir=ROOT / 'work', ignore_cleanup_errors=True) as folder:
        server.DATA = Path(folder)
        server.LIBRARY = server.DATA / 'library'
        server.init_db()
        for index, memberships in enumerate([['VLA', 'Agent'], ['VLA'], ['RL']], 1):
            pid = f'{index:016x}'
            server.put_doc({'id': pid, 'hash': pid, 'title': f'Synthetic paper {index}', 'collections': memberships,
                            'collection': memberships[0], 'notes': 'Saved note', 'blocks': [], 'pages': [], 'figures': [], 'translation': {'status': 'idle'}})
            target = server.LIBRARY / pid / 'original.pdf'
            target.parent.mkdir()
            target.write_bytes(b'%PDF-1.7 synthetic fixture')
        listener = server.PaperNestHTTPServer(('127.0.0.1', 0), server.Handler)
        server.PORT = listener.server_port
        thread = threading.Thread(target=listener.serve_forever, daemon=True)
        thread.start()
        runtime = Path.home() / '.cache/codex-runtimes/codex-primary-runtime/dependencies/node'
        env = dict(os.environ, EZREAD_TEST_URL=f'http://127.0.0.1:{server.PORT}', EZREAD_TEST_ROOT=str(ROOT))
        env.setdefault('EZREAD_PLAYWRIGHT', str(runtime / 'node_modules/playwright'))
        try:
            subprocess.run(['node', str(ROOT / 'tests/browser_collections.cjs')], cwd=ROOT, env=env, check=True)
            subprocess.run(['node', str(ROOT / 'tests/browser_sidebar.cjs')], cwd=ROOT, env=env, check=True)
            assert len(server.all_docs()) == 3
            for doc in server.all_docs():
                assert doc['notes'] == 'Saved note'
                assert (server.LIBRARY / doc['id'] / 'original.pdf').read_bytes() == b'%PDF-1.7 synthetic fixture'
            print('Group management passed; all PDF bytes and notes preserved.')
        finally:
            listener.shutdown()
            listener.server_close()
            thread.join(2)


if __name__ == '__main__':
    main()
