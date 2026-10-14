"""Offline compile contract checks; no real TeX dependency in the unit suite."""
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

from ezread import writing, writing_latex


class LatexTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.app = SimpleNamespace(ROOT=base, DATA=base / 'isolated')

    def test_templates_and_invalid_language(self):
        for language, title in [('zh', 'ctexart'), ('en', 'article')]:
            writing.mutate(self.app, {'operation': 'create', 'path': language + '.tex', 'language': language})
            doc = writing.document(self.app, language + '.tex')
            self.assertIn('{' + title + '}', doc['content'])
        with self.assertRaises(ValueError):
            writing.mutate(self.app, {'operation': 'create', 'path': 'invalid.tex', 'language': 'bad'})
        self.assertFalse(writing.target(self.app, 'invalid.tex').exists())

    def test_stale_revision_and_missing_engine(self):
        writing.mutate(self.app, {'operation': 'create', 'path': 'draft.tex'})
        doc = writing.document(self.app, 'draft.tex')
        with self.assertRaises(writing.Conflict):
            writing_latex.compile_preview(self.app, {**doc, 'revision': 'stale'})
        with patch.object(writing_latex.shutil, 'which', return_value=None), self.assertRaisesRegex(ValueError, 'XeLaTeX'):
            writing_latex.compile_preview(self.app, doc)
        self.assertEqual(writing.document(self.app, 'draft.tex'), doc)

    def test_unknown_token_and_root_isolation(self):
        with self.assertRaises(ValueError):
            writing_latex.preview_file(self.app, '../secret')
        with patch.dict(writing_latex.CACHE, {'token': {'root': 'another-root'}}):
            with self.assertRaises(ValueError):
                writing_latex.preview_file(self.app, 'token')
