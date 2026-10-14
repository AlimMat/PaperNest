"""Permanent deletion and fresh reimport, using isolated data and no model calls."""
import copy
from contextlib import ExitStack
from pathlib import Path
import queue
import shutil
import tempfile
import threading
import unittest
from unittest.mock import patch

import paper_ai
import server
from ezread.selection_requests import SelectionRequests


class PermanentDeletionTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.data = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        for name, value in [('DATA', self.data), ('LIBRARY', self.data / 'library'),
                            ('CANCEL', {}), ('QUEUED', set()), ('RESUME_REQUESTED', set()),
                            ('STRUCTURE_QUEUED', set()), ('STRUCTURE_JOBS', queue.Queue()),
                            ('SELECTION_REQUESTS', SelectionRequests())]:
            self.stack.enter_context(patch.object(server, name, value))
        server.init_db()
        self.extracted = {'metadata': {'title': 'Synthetic fresh import'},
                          'blocks': [{'id': 'p1-b0', 'page': 1, 'text': 'Test text.'}],
                          'pages': [{'number': 1}], 'figures': []}

        def extract(source, assets):
            shutil.copy2(source, assets / 'original.pdf')
            return copy.deepcopy(self.extracted)

        self.extract = self.stack.enter_context(patch('pdf_tools.extract_document', side_effect=extract))
        self.content = b'%PDF-1.7 synthetic deletion fixture'
        self.first = server.import_pdf(self.content, 'fixture.pdf')
        self.pid = self.first['id']
        server.update_doc(self.pid, lambda doc: doc.update(notes='old notes', collections=['RL'], collection='RL'))
        with server.db() as con:
            paper_ai.add_message(con, self.pid, 1, 'user', 'question', 'old conversation')

    def test_library_insertion_order_survives_edits_reload_delete_and_reimport(self):
        second, third = 'b' * 16, 'a' * 16
        for pid in (second, third):
            server.put_doc({'id': pid, 'hash': pid, 'title': pid, 'created_at': '2026-01-01T00:00:00Z'})
        expected = [self.pid, second, third]
        self.assertEqual([d['id'] for d in server.all_docs()], expected)
        server.update_doc(second, lambda d: d.update(last_read='2099-01-01', title='AAA', year=2099))
        server.init_db()
        self.assertEqual([d['id'] for d in server.all_docs()], expected)
        server.delete_paper(self.pid)
        fresh = server.import_pdf(self.content, 'fixture.pdf')
        self.assertEqual([d['id'] for d in server.all_docs()], [second, third, fresh['id']])

    def test_delete_removes_assets_records_and_reimport_is_fresh(self):
        other = 'a' * 16
        server.put_doc({'id': other, 'hash': 'other', 'title': 'Keep me'})
        assets = server.LIBRARY / self.pid
        (assets / 'notes').mkdir()
        (assets / 'notes' / 'image.png').write_bytes(b'note image')
        clipboard = self.data / 'clipboard' / self.pid
        clipboard.mkdir(parents=True)
        (clipboard / 'paper.pdf').write_bytes(self.content)
        temp = self.data / 'tmp' / f'{self.pid}.pdf'
        temp.write_bytes(self.content)
        event = threading.Event()
        server.CANCEL[(self.pid, 'translate')] = event
        server.RESUME_REQUESTED.add((self.pid, 'translate'))
        selection = server.SELECTION_REQUESTS.begin(self.pid, {'client_id': 'c' * 16, 'request_id': 'r' * 16})
        server.delete_paper(self.pid)
        self.assertTrue(event.is_set() and selection.is_set())
        for target in (assets, clipboard, temp):
            self.assertFalse(target.exists())
        with server.db() as con:
            self.assertIsNone(con.execute('SELECT 1 FROM papers WHERE id=?', (self.pid,)).fetchone())
            for table in ('paper_ai', 'paper_ai_generations', 'paper_ai_messages'):
                self.assertEqual(con.execute(f'SELECT count(*) FROM {table} WHERE paper_id=?', (self.pid,)).fetchone()[0], 0)
        self.assertEqual(server.get_doc(other)['title'], 'Keep me')
        second = server.import_pdf(self.content, 'fixture.pdf')
        self.assertNotEqual(second['id'], self.pid)
        self.assertFalse(second.get('duplicate'))
        self.assertEqual(second['collections'], [])
        self.assertEqual(server.get_doc(second['id'])['notes'], '')
        self.assertEqual(self.extract.call_count, 2)
        self.assertEqual((server.LIBRARY / second['id'] / 'original.pdf').read_bytes(), self.content)

    def test_legacy_trash_with_missing_folder_is_new_import(self):
        server.update_doc(self.pid, lambda doc: doc.update(deleted=True))
        shutil.rmtree(server.LIBRARY / self.pid)
        second = server.import_pdf(self.content, 'fixture.pdf')
        self.assertNotEqual(second['id'], self.pid)
        self.assertEqual(second['collections'], [])
        with self.assertRaises(ValueError):
            server.get_doc(self.pid, include_deleted=True)

    def test_failed_post_import_processing_leaves_no_hash_or_assets(self):
        content = b'%PDF-1.7 failed import fixture'
        with patch.object(server, 'schedule_structure', side_effect=RuntimeError('simulated failure')):
            with self.assertRaisesRegex(RuntimeError, 'simulated failure'):
                server.import_pdf(content, 'failed.pdf')
        self.assertEqual(len(server.all_docs(True)), 1)
        self.assertEqual([item.name for item in server.LIBRARY.iterdir()], [self.pid])
        result = server.import_pdf(content, 'retry.pdf')
        self.assertFalse(result.get('duplicate'))
        self.assertTrue((server.LIBRARY / result['id'] / 'original.pdf').is_file())

    def test_failed_file_delete_retains_record_for_retry(self):
        with patch('ezread.storage.shutil.rmtree', side_effect=PermissionError('locked')):
            with self.assertRaises(PermissionError):
                server.delete_paper(self.pid)
        self.assertEqual(server.get_doc(self.pid)['notes'], 'old notes')
        server.delete_paper(self.pid)
        server.delete_paper(self.pid)  # Retry after a lost response is idempotent.

    def test_late_writers_cannot_recreate_deleted_history(self):
        server.delete_paper(self.pid)
        with server.db() as con:
            with self.assertRaises(ValueError):
                paper_ai.ensure(con, self.pid)
            with self.assertRaises(ValueError):
                paper_ai.add_message(con, self.pid, 1, 'assistant', 'answer', 'late answer')
        with self.assertRaises(ValueError):
            server.update_doc(self.pid, lambda doc: doc.update(notes='late note'))

    def test_invalid_path_cannot_delete_other_files(self):
        for value in ('..', '../library', '', 'a' * 15, 'a' * 16 + '/..'):
            with self.assertRaises(ValueError):
                server.delete_paper(value)
        self.assertTrue((server.LIBRARY / self.pid / 'original.pdf').is_file())


if __name__ == '__main__':
    unittest.main()
