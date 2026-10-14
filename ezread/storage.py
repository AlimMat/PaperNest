"""SQLite connection, documents and settings persistence."""
from __future__ import annotations
from .context import ApplicationContext
from .preferences import THEMES
import copy
import contextlib
import json
import sqlite3
import re
import shutil


def init_db(app: ApplicationContext):
    app.LIBRARY.mkdir(parents=True, exist_ok=True)
    (app.DATA / 'tmp').mkdir(exist_ok=True)
    with contextlib.closing(sqlite3.connect(app.DATA / 'library.sqlite3')) as con:
        con.execute('PRAGMA journal_mode=WAL')
        con.execute('CREATE TABLE IF NOT EXISTS papers (id TEXT PRIMARY KEY, hash TEXT UNIQUE, doc TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0)')
        con.execute('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
        import paper_ai
        paper_ai.init(con)
        con.commit()
    for doc in app.all_docs(include_deleted=True):
        changed = False
        for key, value in {'paper_type': 'journal', 'conference_name': '', 'conference_abbr': '',
                           'conference_track': 'unknown'}.items():
            if key not in doc:
                doc[key] = value
                changed = True
        if doc.get('translation', {}).get('status') in ('running', 'queued'):
            doc['translation']['status'] = 'paused'
            doc['translation']['error'] = '上次任务已保存，可继续翻译。'
            changed = True
        for kind in ('summarize', 'team'):
            if doc.get(kind + '_status') in ('running', 'queued'):
                doc[kind + '_status'] = 'error'
                doc[kind + '_error'] = '上次任务未完成，可重新启动。'
                changed = True
        if changed:
            app.put_doc(doc)


@contextlib.contextmanager
def db(app: ApplicationContext):
    con = sqlite3.connect(app.DATA / 'library.sqlite3', timeout=30)
    try:
        with con:
            yield con
    finally:
        con.close()


def all_docs(app: ApplicationContext, include_deleted=False):
    with app.LOCK, app.db() as con:
        # UPSERT preserves rowid, so reads/edits cannot move a paper. New imports
        # append, including batches with identical timestamps and missing dates.
        rows = con.execute('SELECT doc FROM papers' + ('' if include_deleted else ' WHERE deleted=0') + ' ORDER BY rowid ASC').fetchall()
        return [json.loads(r[0]) for r in rows]


def get_doc(app: ApplicationContext, pid, include_deleted=False):
    with app.LOCK, app.db() as con:
        row = con.execute('SELECT doc FROM papers WHERE id=?' + ('' if include_deleted else ' AND deleted=0'), (pid,)).fetchone()
        if not row:
            raise ValueError('这篇文献不存在或已删除。')
        return json.loads(row[0])


def put_doc(app: ApplicationContext, doc):
    with app.LOCK, app.db() as con:
        con.execute('INSERT INTO papers(id,hash,doc,deleted) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET doc=excluded.doc,deleted=excluded.deleted',
                    (doc['id'], doc['hash'], json.dumps(doc, ensure_ascii=False), int(doc.get('deleted', False))))


def update_doc(app: ApplicationContext, pid, fn):
    with app.LOCK:
        doc = app.get_doc(pid, include_deleted=True)
        fn(doc)
        doc['updated_at'] = app.now()
        app.put_doc(doc)
        return doc


def delete_paper(app: ApplicationContext, pid):
    """Permanently remove one paper and its owned assets; never follow redirects."""
    if not isinstance(pid, str) or not re.fullmatch(r'[a-f0-9]{16}', pid):
        raise ValueError('无效的论文 ID。')
    with app.LOCK, app.FILE_ACTION_LOCK:
        targets = [app.LIBRARY / pid, app.DATA / 'clipboard' / pid, app.DATA / 'tmp' / f'{pid}.pdf']
        for target in targets:
            if (not target.resolve().is_relative_to(app.DATA.resolve())
                    or target.resolve() != target.parent.resolve() / target.name or target.is_symlink()):
                raise ValueError('论文资源路径异常，未执行删除。')
        for key, event in list(app.CANCEL.items()):
            if key[0] == pid:
                event.set()
                app.CANCEL.pop(key, None)
        app.RESUME_REQUESTED.difference_update(key for key in list(app.RESUME_REQUESTED) if key[0] == pid)
        app.QUEUED.difference_update(key for key in list(app.QUEUED) if key[0] == pid)
        app.STRUCTURE_QUEUED.discard(pid)
        app.SELECTION_REQUESTS.forget_paper(pid)
        # Keep the database record if file deletion fails, so the operation is retryable.
        for target in targets:
            if target.is_dir():
                shutil.rmtree(target)
            else:
                target.unlink(missing_ok=True)
        with app.db() as con:
            con.execute('PRAGMA secure_delete=ON')
            for table in ('paper_ai_messages', 'paper_ai_generations', 'paper_ai'):
                con.execute(f'DELETE FROM {table} WHERE paper_id=?', (pid,))
            con.execute('DELETE FROM papers WHERE id=?', (pid,))


def settings(app: ApplicationContext):
    out = copy.deepcopy(app.DEFAULT_SETTINGS)
    with app.LOCK, app.db() as con:
        for k, v in con.execute('SELECT key,value FROM settings'):
            if k in app.DEFAULT_SETTINGS:
                out[k] = json.loads(v)
    if out.get('theme') not in THEMES:
        out['theme'] = app.DEFAULT_SETTINGS['theme']
    return out
