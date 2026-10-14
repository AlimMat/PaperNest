"""Personal journal persistence and disabled translation boundaries; isolated data only."""
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import queue
import tempfile
import threading
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request

import server
from ezread import features, personal_journals as journals
from ezread.journal_catalogue import CatalogueConflict

PID = '0123456789abcdef'


class PersonalJournalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='personal-journals-', dir=Path.cwd() / 'work')
        self.addCleanup(self.temp.cleanup)
        self.data = Path(self.temp.name)

    def save(self, changes, revision=None):
        return journals.apply_changes(self.data, changes, revision or journals.snapshot(self.data)['revision'])

    def test_optional_issn_edit_delete_and_history_preserve_legacy(self):
        legacy = self.data / 'journal_tiers.csv'
        legacy.write_text('legacy catalogue', encoding='utf-8')
        self.assertEqual(journals.snapshot(self.data)['rows'], [])
        saved = self.save([{'action': 'upsert', 'name': 'Robot Journal', 'tier': 'q1', 'aliases': 'RJ'}])
        row = saved['rows'][0]
        self.assertEqual(row['issn'], '')
        self.assertEqual(journals.classify(self.data, {'journal': 'RJ'})['tier'], 'q1')
        updated = self.save([{'action': 'upsert', 'id': row['id'], 'tier': 'q3'}])
        self.assertEqual(updated['rows'][0]['id'], row['id'])
        self.assertEqual(journals.snapshot(self.data)['counts']['q3'], 1)
        self.assertEqual(len(list((self.data / 'personal-journal-history').glob('*.json'))), 1)
        self.save([{'action': 'delete', 'id': row['id']}])
        self.assertEqual(journals.classify(self.data, {'journal': 'Robot Journal'})['tier'], 'other')
        self.assertEqual(legacy.read_text(encoding='utf-8'), 'legacy catalogue')

    def test_stale_duplicate_and_invalid_changes_never_overwrite(self):
        original = journals.snapshot(self.data)
        saved = self.save([{'action': 'upsert', 'name': 'Robot Journal', 'tier': 'q2'}])
        with self.assertRaises(CatalogueConflict):
            self.save([{'action': 'upsert', 'name': 'Other', 'tier': 'q1'}], original['revision'])
        for change in ({'name': 'robot JOURNAL', 'tier': 'q4'}, {'name': '', 'tier': 'q1'},
                       {'name': 'Other', 'tier': 'top'}, {'id': [], 'name': 'Other', 'tier': 'q1'}):
            with self.assertRaises(ValueError):
                self.save([{'action': 'upsert', **change}])
            self.assertEqual(journals.snapshot(self.data), saved)

    def test_ambiguous_aliases_are_not_guessed(self):
        self.save([{'action': 'upsert', 'name': name, 'tier': tier, 'aliases': 'Shared'}
                   for name, tier in [('First', 'q1'), ('Second', 'q2')]])
        self.assertEqual(journals.classify(self.data, {'journal': 'Shared'})['tier'], 'other')
        self.assertEqual(journals.classify(self.data, {'journal': 'First', 'journal_issn': 'stale'})['tier'], 'q1')

    def test_http_journal_changes_refresh_papers_and_translation_is_disabled(self):
        with patch.object(server, 'DATA', self.data), patch.object(server, 'LIBRARY', self.data / 'library'), \
             patch.object(server, 'JOBS', queue.Queue()), patch.object(server, 'codex_status') as model_status, \
             patch.object(server.SELECTION_SESSION, 'start') as prepare:
            server.init_db()
            server.put_doc({'id': PID, 'hash': 'synthetic', 'journal': 'Robot Journal', 'notes': 'keep',
                            'blocks': [{'id': 'b1', 'text': 'original', 'translation': '保留译文'}]})
            before = server.get_doc(PID)
            httpd = ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
            thread = threading.Thread(target=httpd.serve_forever, daemon=True)
            thread.start()
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

            def request(path, method='GET', body=None):
                req = urllib.request.Request(f'http://127.0.0.1:{httpd.server_port}{path}', method=method,
                    data=json.dumps(body).encode() if body is not None else None, headers={'Content-Type': 'application/json'})
                with opener.open(req, timeout=3) as response:
                    return json.load(response)

            try:
                with patch.object(server, 'PORT', httpd.server_port):
                    base = request('/api/personal-journals')
                    payload = {'revision': base['revision'], 'changes': [{'action': 'upsert', 'name': 'Robot Journal', 'tier': 'q1'}]}
                    saved = request('/api/personal-journals', 'PATCH', payload)
                    papers = request('/api/papers')
                    self.assertEqual(papers['papers'][0]['journal_tier'], 'q1')
                    self.assertEqual(papers['journal_catalogue_revision'], saved['revision'])
                    with self.assertRaises(urllib.error.HTTPError) as stale:
                        request('/api/personal-journals', 'PATCH', payload)
                    self.assertEqual(stale.exception.code, 409)
                    self.assertFalse(features.TRANSLATION_ENABLED)
                    for endpoint in ('/api/selection-session', f'/api/papers/{PID}/translate', f'/api/papers/{PID}/ai/highlight'):
                        with self.assertRaises(urllib.error.HTTPError) as disabled:
                            request(endpoint, 'POST', {})
                        self.assertEqual(disabled.exception.code, 410)
                    for action in ('translate_word', 'translate_sentence', 'retranslate', 'translate'):
                        with self.assertRaises(urllib.error.HTTPError) as disabled:
                            request(f'/api/papers/{PID}/text-actions', 'POST', {'action': action})
                        self.assertEqual(disabled.exception.code, 410)
                    with self.assertRaisesRegex(ValueError, '停用'):
                        server.enqueue(PID, 'translate')
                    self.assertTrue(server.JOBS.empty())
                    self.assertEqual(server.get_doc(PID), before)
                    prepare.assert_not_called()
                    model_status.assert_not_called()
            finally:
                httpd.shutdown()
                thread.join(3)
                httpd.server_close()


if __name__ == '__main__':
    unittest.main()
