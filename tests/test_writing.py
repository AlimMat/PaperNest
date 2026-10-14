"""Writing tests use independent files; never operate on the user's library."""
import io
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile

from ezread import writing


class WritingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.app = SimpleNamespace(ROOT=base, DATA=base / 'isolated-data')

    def create(self, path, kind='file'):
        return writing.mutate(self.app, {'operation': 'create', 'kind': kind, 'path': path})

    def save(self, path, content, revision=None):
        current = writing.document(self.app, path)
        return writing.mutate(self.app, {'operation': 'save', 'path': path, 'content': content, 'revision': revision or current['revision']})

    def test_three_formats_and_real_docx(self):
        self.create('研究', 'folder')
        for name in ('研究/草稿.md', '研究/文章.tex', '研究/正文.docx'):
            self.create(name)
        self.save('研究/草稿.md', '# 中文\n\n实验记录 😀')
        self.save('研究/文章.tex', r'\section{方法} 中文')
        self.save('研究/正文.docx', '<h1>题目</h1><p>文字 <b>加粗</b><i>斜体</i><u>下划线</u><br>新行</p>')
        self.assertEqual(writing.document(self.app, '研究/草稿.md')['content'], '# 中文\n\n实验记录 😀')
        result = writing.document(self.app, '研究/正文.docx')['content']
        self.assertIn('<h1>题目</h1>', result)
        self.assertIn('<strong>加粗</strong>', result)
        self.assertIn('<em>斜体</em>', result)
        self.assertIn('<u>下划线</u>', result)
        with zipfile.ZipFile(writing.target(self.app, '研究/正文.docx')) as archive:
            self.assertIsNone(archive.testzip())
            self.assertIn('word/document.xml', archive.namelist())
            self.assertIn('word/styles.xml', archive.namelist())
        self.assertFalse((self.app.ROOT / 'writing').exists())
        self.assertFalse((self.app.DATA / 'library.sqlite3').exists())

    def test_external_change_conflict_and_duplicate(self):
        self.create('draft.md')
        stale = writing.document(self.app, 'draft.md')['revision']
        writing.target(self.app, 'draft.md').write_text('外部修改', encoding='utf-8')
        with self.assertRaises(writing.Conflict):
            self.save('draft.md', '覆盖', stale)
        with self.assertRaises(ValueError):
            self.create('draft.md')
        self.assertEqual(writing.document(self.app, 'draft.md')['content'], '外部修改')

    def test_folder_moves_only_siblings_and_preserve_files_and_rename_order(self):
        for name in ('A', 'B', 'C', 'B/X', 'B/Y'):
            self.create(name, 'folder')
        names = ('a.md', 'z.md', 'B/X/keep.md', 'B/a.md', 'B/z.md')
        for name in names:
            self.create(name)
            self.save(name, 'Original ' + name)
        original = {name: writing.document(self.app, name) for name in names}
        def paths():
            return [entry['path'] for entry in writing.snapshot(self.app)['entries']]
        def move(name, direction):
            writing.mutate(self.app, {'operation': 'move-folder', 'path': name, 'direction': direction})
        move('B', 'up')
        self.assertEqual(paths(), ['B', 'B/X', 'B/X/keep.md', 'B/Y', 'B/a.md', 'B/z.md', 'A', 'C', 'a.md', 'z.md'])
        move('B/Y', 'up')
        move('B/Y', 'up')
        self.assertEqual(paths()[:4], ['B', 'B/Y', 'B/X', 'B/X/keep.md'])
        move('B', 'up')
        move('C', 'down')
        for name, doc in original.items():
            self.assertEqual(writing.document(self.app, name), doc)
        writing.mutate(self.app, {'operation': 'rename', 'path': 'B', 'destination': 'ZZ'})
        self.assertEqual(paths()[:4], ['ZZ', 'ZZ/Y', 'ZZ/X', 'ZZ/X/keep.md'])
        writing.mutate(self.app, {'operation': 'trash', 'path': 'ZZ/Y'})
        self.create('ZZ/Y', 'folder')
        self.assertEqual(paths()[:4], ['ZZ', 'ZZ/X', 'ZZ/X/keep.md', 'ZZ/Y'])
        with self.assertRaises(ValueError):
            move('a.md', 'up')
        with self.assertRaises(ValueError):
            move('A', 'sideways')

    def test_folder_order_write_failure_rolls_back_directory_rename(self):
        for name in ('A', 'B'):
            self.create(name, 'folder')
        writing.mutate(self.app, {'operation': 'move-folder', 'path': 'B', 'direction': 'up'})
        with patch.object(writing.os, 'replace', side_effect=PermissionError('locked')):
            with self.assertRaises(PermissionError):
                writing.mutate(self.app, {'operation': 'rename', 'path': 'B', 'destination': 'Z'})
        self.assertEqual([entry['path'] for entry in writing.snapshot(self.app)['entries']], ['B', 'A'])

    def test_copy_path_returns_only_an_existing_supported_writing_file(self):
        self.create('研究', 'folder')
        self.create('研究/draft.md')
        result = writing.mutate(self.app, {'operation': 'copy-path', 'path': '研究/draft.md'})
        self.assertEqual(result, {'ok': True, 'path': str(writing.target(self.app, '研究/draft.md').resolve())})
        with self.assertRaises(ValueError):
            writing.mutate(self.app, {'operation': 'copy-path', 'path': '研究'})
        with self.assertRaises(ValueError):
            writing.mutate(self.app, {'operation': 'copy-path', 'path': '../outside.md'})

    def test_paths_cannot_escape_and_reserved_names(self):
        for path in ('../secret.md', '/absolute.md', 'C:/secret.md', 'x\\a.md', '.trash/a.md', 'a/../b.md', 'a//b.md', 'NUL.md', 'a:stream', 'name. ', 'x/COM1.docx'):
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.create(path)

    def test_atomic_failure_preserves_original(self):
        self.create('draft.md')
        self.save('draft.md', '原稿')
        with patch.object(writing.os, 'replace', side_effect=PermissionError('locked')):
            with self.assertRaises(PermissionError):
                self.save('draft.md', '不能丢失')
        self.assertEqual(writing.document(self.app, 'draft.md')['content'], '原稿')
        self.assertEqual([p.name for p in writing.root(self.app).iterdir()], ['draft.md'])

    def test_rename_move_and_recoverable_removal(self):
        self.create('项目', 'folder')
        self.create('项目/draft.md')
        self.save('项目/draft.md', '保留内容')
        writing.mutate(self.app, {'operation': 'rename', 'path': '项目', 'destination': '新项目'})
        self.assertEqual(writing.document(self.app, '新项目/draft.md')['content'], '保留内容')
        with self.assertRaises(ValueError):
            writing.mutate(self.app, {'operation': 'rename', 'path': '新项目/draft.md', 'destination': 'draft.docx'})
        writing.mutate(self.app, {'operation': 'trash', 'path': '新项目'})
        self.assertEqual(writing.snapshot(self.app)['entries'], [])
        recovered = next((writing.root(self.app) / '.trash').glob('*/draft.md'))
        self.assertEqual(recovered.read_text(encoding='utf-8'), '保留内容')

    def test_word_sanitizes_and_rejects_complex_content(self):
        raw = writing.word_bytes('<p onclick="evil()">safe<img src=x><script>alert(1)</script><b>bold</b></p>')
        content = writing.word_content(raw)
        self.assertNotIn('script', content)
        self.assertNotIn('alert', content)
        self.assertNotIn('img', content)
        self.assertIn('<strong>bold</strong>', content)
        modified = io.BytesIO()
        with zipfile.ZipFile(io.BytesIO(raw)) as source, zipfile.ZipFile(modified, 'w') as destination:
            for name in source.namelist():
                part = source.read(name)
                if name == 'word/document.xml':
                    part = part.replace(b'<w:body>', b'<w:body><w:tbl/>')
                destination.writestr(name, part)
        with self.assertRaises(ValueError):
            writing.word_content(modified.getvalue())

    def test_word_extended_headings_styles_and_simple_lists_roundtrip(self):
        raw = writing.word_bytes('<h6>小标题</h6><p><s>删除</s><sup>2</sup><sub>i</sub></p><ul><li>项目</li></ul><ol><li>步骤</li></ol>')
        content = writing.word_content(raw)
        self.assertIn('<h6>小标题</h6>', content)
        self.assertIn('<s>删除</s>', content)
        self.assertIn('<sup>2</sup>', content)
        self.assertIn('<sub>i</sub>', content)
        self.assertIn('• 项目', content)
        self.assertIn('1. 步骤', content)

    def test_invalid_data_and_missing_files(self):
        self.create('test.md')
        for content in (None, {}, 'x' * (writing.MARKDOWN_MAX_SIZE + 1)):
            with self.assertRaises(ValueError):
                self.save('test.md', content)
        with self.assertRaises(ValueError):
            writing.document(self.app, 'missing.md')
        with self.assertRaises(ValueError):
            self.create('test.exe')

    def test_embedded_images_roundtrip_and_separate_limits(self):
        self.create('images.md')
        content = '# 图片\n\n![图](data:image/png;base64,' + 'abcd' * (2 * 1024 * 1024) + ')\n'
        self.save('images.md', content)
        self.assertEqual(writing.document(self.app, 'images.md')['content'], content)
        self.assertEqual(writing.target(self.app, 'images.md').read_bytes(), content.encode('utf-8'))
        self.create('small.tex')
        with self.assertRaises(ValueError):
            self.save('small.tex', 'x' * (writing.MAX_SIZE + 1))


if __name__ == '__main__':
    unittest.main()
