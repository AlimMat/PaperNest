"""Local links use disposable files; opening programs is always mocked."""
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from ezread import writing, writing_links


class WritingLinkTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.docs = {}
        self.app = SimpleNamespace(ROOT=base, DATA=base / 'isolated', LIBRARY=base / 'isolated/library', PORT=12345,
                                   get_doc=self.docs.get, all_docs=lambda: list(self.docs.values()))
        writing.mutate(self.app, {'operation': 'create', 'path': '笔记', 'kind': 'folder'})
        writing.mutate(self.app, {'operation': 'create', 'path': '笔记/当前.md'})
        writing.mutate(self.app, {'operation': 'create', 'path': '参考 空格%.md'})
        self.external = base / '外部 文件.txt'
        self.external.write_text('external', encoding='utf-8')
        self.pdf = base / '外部.pdf'
        self.pdf.write_bytes(b'%PDF-1.4\nsynthetic')

    def resolve(self, href):
        return writing_links.resolve(self.app, {'href': href, 'source': '笔记/当前.md'})

    def test_internal_uri_absolute_relative_and_folder(self):
        path = writing.target(self.app, '参考 空格%.md')
        for href in (str(path), path.as_uri(), '../参考%20空格%25.md', 'papernest://writing/%E5%8F%82%E8%80%83%20%E7%A9%BA%E6%A0%BC%25.md'):
            result = self.resolve(href)
            self.assertEqual(result['kind'], 'writing')
            self.assertEqual(result['path'], '参考 空格%.md')
        folder = self.resolve('papernest://writing/')
        self.assertEqual(folder['kind'], 'folder')
        self.assertEqual(len(folder['entries']), 2)
        self.assertEqual(self.resolve('.')['entries'][0]['path'], '笔记/当前.md')
        writing.mutate(self.app, {'operation': 'create', 'path': 'literal%20.md'})
        literal = writing.target(self.app, 'literal%20.md')
        self.assertEqual(self.resolve(str(literal))['path'], 'literal%20.md')
        self.assertEqual(self.resolve(literal.as_uri())['path'], 'literal%20.md')

    def test_paper_uri_path_and_root_preserve_records(self):
        pid = '1234567890abcdef'
        path = self.app.LIBRARY / pid / 'original.pdf'
        path.parent.mkdir(parents=True)
        path.write_bytes(b'%PDF synthetic')
        self.docs[pid] = {'id': pid, 'title': 'Fixture', 'notes': 'keep'}
        for href in ('papernest://paper/' + pid, path.as_uri(), '/media/' + pid + '/original.pdf', str(path.parent)):
            self.assertEqual(self.resolve(href)['id'], pid)
        self.assertEqual(self.resolve(str(self.app.LIBRARY))['entries'][0]['id'], pid)
        self.assertEqual(self.docs[pid]['notes'], 'keep')
        self.docs[pid]['deleted'] = True
        with self.assertRaises(ValueError):
            self.resolve(path.as_uri())

    def test_external_resolution_does_not_launch_and_open_is_token_bound(self):
        with patch.object(writing_links.os, 'startfile', create=True) as launch:
            result = self.resolve(self.external.as_uri())
            launch.assert_not_called()
            self.assertEqual(result['kind'], 'external')
            writing_links.open_external(self.app, {'token': result['token']})
            launch.assert_called_once_with(str(self.external.resolve()))
            with self.assertRaises(ValueError):
                writing_links.open_external(self.app, {'token': 'unknown', 'path': str(self.external)})
            other = SimpleNamespace(DATA=self.app.ROOT / 'other')
            with self.assertRaises(ValueError):
                writing_links.open_external(other, {'token': result['token']})

    def test_external_pdf_requires_approval_and_uses_browser(self):
        result = self.resolve(self.pdf.as_uri())
        self.assertEqual(result['type'], 'pdf')
        with self.assertRaises(ValueError):
            writing_links.pdf_file(self.app, result['token'])
        with patch.object(writing_links.webbrowser, 'open', return_value=True) as browser:
            writing_links.open_external(self.app, {'token': result['token']})
            self.assertIn('/link-pdf/' + result['token'] + '/document.pdf', browser.call_args.args[0])
        self.assertEqual(writing_links.pdf_file(self.app, result['token']), self.pdf.resolve())
        self.pdf.write_bytes(b'%PDF changed')
        with self.assertRaises(ValueError):
            writing_links.pdf_file(self.app, result['token'])

    def test_security_and_missing_links(self):
        executable = self.app.ROOT / 'danger.cmd'
        executable.write_text('do not execute')
        for href in ('javascript:alert(1)', 'file://remote/share/test.pdf', r'\\server\share\test.pdf',
                     'file:///C:/test.txt:stream', 'papernest://writing/../outside.md', executable.as_uri(),
                     'not-found.md', 'file:///%00bad', 'papernest://paper/not-an-id'):
            with self.subTest(href=href), self.assertRaises(ValueError):
                self.resolve(href)
        with self.assertRaises(ValueError):
            writing_links.resolve(self.app, {'href': self.external.as_uri(), 'source': '../outside.md'})
        result = self.resolve(self.external.as_uri())
        with patch.object(writing_links.time, 'monotonic', return_value=10**15), self.assertRaises(ValueError):
            writing_links.open_external(self.app, {'token': result['token']})


if __name__ == '__main__':
    unittest.main()
