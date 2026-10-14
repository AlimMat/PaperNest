"""Group mutations preserve PDF bytes, unrelated data and insertion order."""
import contextlib
import copy
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import server
from ezread.library import mutate_collection, ordered_collections


class CollectionManagementTests(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.data = Path(self.stack.enter_context(tempfile.TemporaryDirectory(prefix='collections-', dir=ROOT / 'work')))
        self.stack.enter_context(patch.object(server, 'DATA', self.data))
        self.stack.enter_context(patch.object(server, 'LIBRARY', self.data / 'library'))
        server.init_db()
        self.docs = [
            {'id': 'a' * 16, 'hash': 'a', 'title': 'Shared paper', 'collections': ['VLA', 'Agent'], 'collection': 'VLA'},
            {'id': 'b' * 16, 'hash': 'b', 'title': 'Legacy paper', 'collection': 'VLA'},
            {'id': 'c' * 16, 'hash': 'c', 'title': 'Unrelated paper', 'collections': ['RL'], 'collection': 'RL'},
        ]
        for doc in self.docs:
            doc.update(notes='Original note', text_annotations=[{'id': 'note', 'note': 'Annotation'}], blocks=[], translation={'status': 'idle'})
            server.put_doc(copy.deepcopy(doc))
            source = server.LIBRARY / doc['id'] / 'original.pdf'
            source.parent.mkdir()
            source.write_bytes(b'%PDF-1.7 synthetic original')
        with server.db() as con:
            con.execute('INSERT INTO settings VALUES(?,?)', ('collections', json.dumps(['VLA', 'Agent', 'RL', 'Empty'])))

    def change(self, operation, name, **extra):
        return mutate_collection(server, {'operation': operation, 'name': name, **extra})

    def test_rename_changes_all_memberships_preserving_assets_and_order(self):
        self.change('rename', 'VLA', new_name='机器人')
        self.assertEqual(server.get_doc('a' * 16)['collections'], ['机器人', 'Agent'])
        self.assertEqual(server.get_doc('b' * 16)['collection'], '机器人')
        self.assertNotIn('VLA', server.settings()['collections'])
        self.assertEqual([doc['id'] for doc in server.all_docs()], [doc['id'] for doc in self.docs])
        for before in self.docs:
            after = server.get_doc(before['id'])
            for key in ('notes', 'text_annotations', 'blocks', 'translation', 'hash', 'title'):
                self.assertEqual(after[key], before[key])
            self.assertEqual((server.LIBRARY / before['id'] / 'original.pdf').read_bytes(), b'%PDF-1.7 synthetic original')

    def test_remove_keeps_other_memberships_and_uncategorizes_last(self):
        self.change('remove', 'VLA')
        self.assertEqual(server.get_doc('a' * 16)['collections'], ['Agent'])
        self.assertEqual(server.get_doc('b' * 16)['collections'], [])
        self.assertEqual(server.get_doc('b' * 16)['collection'], '')
        self.assertEqual(server.get_doc('c' * 16), self.docs[2])
        self.assertEqual(len(server.all_docs()), 3)
        self.assertTrue((server.LIBRARY / ('b' * 16) / 'original.pdf').is_file())

    def test_empty_groups_create_rename_remove_and_duplicate_validation(self):
        self.change('rename', 'Empty', new_name='Unused')
        self.change('remove', 'Unused')
        self.change('create', ' Fresh ')
        self.assertIn('Fresh', server.settings()['collections'])
        before = server.all_docs(), server.settings()['collections']
        for operation, name, extra in [('rename', 'VLA', {'new_name': 'Agent'}), ('create', 'Fresh', {}), ('remove', 'Gone', {}), ('rename', 'RL', {'new_name': '\n'}), ('create', 'Bad\nName', {})]:
            with self.assertRaises(ValueError):
                self.change(operation, name, **extra)
            self.assertEqual((server.all_docs(), server.settings()['collections']), before)

    def test_failed_batch_rolls_back_all_memberships_and_group_names(self):
        before = server.all_docs(), server.settings()['collections']
        with server.db() as con:
            con.execute("CREATE TRIGGER fail_group BEFORE UPDATE ON papers WHEN OLD.id='bbbbbbbbbbbbbbbb' BEGIN SELECT RAISE(ABORT,'simulated write failure'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            self.change('rename', 'VLA', new_name='Renamed')
        self.assertEqual((server.all_docs(), server.settings()['collections']), before)

    def test_moves_one_place_persist_rename_and_never_change_papers(self):
        before = server.all_docs()
        self.assertEqual(ordered_collections(server, before), ['Agent', 'Empty', 'RL', 'VLA'])
        self.assertEqual(self.change('move', 'RL', direction='up')['collections'], ['Agent', 'RL', 'Empty', 'VLA'])
        self.assertEqual(ordered_collections(server, server.all_docs()), ['Agent', 'RL', 'Empty', 'VLA'])
        self.change('move', 'Agent', direction='up')
        self.change('move', 'VLA', direction='down')
        self.assertEqual(server.all_docs(), before)
        self.change('rename', 'Empty', new_name='AAA')
        self.assertEqual(ordered_collections(server, server.all_docs()), ['Agent', 'RL', 'AAA', 'VLA'])
        self.change('create', 'New')
        self.assertEqual(ordered_collections(server, server.all_docs())[-1], 'New')
        self.change('remove', 'AAA')
        self.assertEqual(ordered_collections(server, server.all_docs()), ['Agent', 'RL', 'VLA', 'New'])
        with self.assertRaises(ValueError):
            self.change('move', 'Agent', direction='sideways')


if __name__ == '__main__':
    unittest.main()
