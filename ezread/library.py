"""Paper metadata, public documents and native file actions."""
from __future__ import annotations
from .context import ApplicationContext
import re
import json
import shutil
import sqlite3
import urllib.parse


def ordered_collections(app: ApplicationContext, docs, con=None):
    if con is None:
        with app.LOCK, app.db() as connection:
            return ordered_collections(app, docs, connection)
    row = con.execute("SELECT value FROM settings WHERE key='collections'").fetchone()
    names = list(dict.fromkeys(json.loads(row[0]) if row else app.DEFAULT_SETTINGS.get('collections', [])))
    for doc in docs:
        names.extend(value for value in collection_names(doc) if value not in names)
    manual = con.execute("SELECT value FROM settings WHERE key='collections_ordered'").fetchone()
    return names if manual and json.loads(manual[0]) is True else sorted(names)


def mutate_collection(app: ApplicationContext, data):
    """Change group names and paper memberships in one SQLite transaction."""
    if not isinstance(data, dict) or set(data) - {'operation', 'name', 'new_name', 'direction'}:
        raise ValueError('分组操作请求无效。')
    operation = data.get('operation')
    if operation not in ('create', 'rename', 'remove', 'move'):
        raise ValueError('分组操作无效。')
    if operation == 'move' and data.get('direction') not in ('up', 'down'):
        raise ValueError('请选择上移或下移。')
    def valid_name(value):
        if not isinstance(value, str):
            raise ValueError('分组名称必须是文字。')
        value = value.strip()
        if not value or len(value) > 100 or re.search(r'[\x00-\x1f\x7f]', value):
            raise ValueError('分组名称须为不超过 100 字的单行文字。')
        return value
    name = valid_name(data.get('name'))
    new_name = valid_name(data.get('new_name')) if operation == 'rename' else None
    with app.LOCK, app.db() as con:
        docs = [(pid, json.loads(raw)) for pid, raw in con.execute('SELECT id,doc FROM papers WHERE deleted=0 ORDER BY rowid ASC')]
        names = ordered_collections(app, [doc for _, doc in docs], con)
        if operation == 'create':
            if name in names:
                raise ValueError('这个分组名称已经存在。')
            if len(names) >= 1000:
                raise ValueError('分组数量已达到上限。')
            names.append(name)
        elif operation == 'move':
            if name not in names:
                raise ValueError('分组不存在或已被修改，请刷新后重试。')
            index = names.index(name)
            adjacent = index + (-1 if data['direction'] == 'up' else 1)
            if 0 <= adjacent < len(names):
                names[index], names[adjacent] = names[adjacent], names[index]
            con.execute("INSERT OR REPLACE INTO settings(key,value) VALUES('collections_ordered','true')")
        else:
            if name not in names:
                raise ValueError('分组不存在或已被修改，请刷新后重试。')
            if operation == 'rename' and new_name != name and new_name in names:
                raise ValueError('这个分组名称已经存在，请使用其他名称。')
            names = [new_name if value == name else value for value in names if operation == 'rename' or value != name]
            if new_name != name:
                for pid, doc in docs:
                    memberships = collection_names(doc)
                    if name not in memberships:
                        continue
                    memberships = [new_name if value == name else value for value in memberships if operation == 'rename' or value != name]
                    doc['collections'] = memberships
                    doc['collection'] = memberships[0] if memberships else ''
                    doc['collection_assignment'] = {'status': 'manual', 'name': doc['collection'], 'names': memberships, 'error': ''}
                    doc['updated_at'] = app.now()
                    con.execute('UPDATE papers SET doc=? WHERE id=?', (json.dumps(doc, ensure_ascii=False), pid))
        con.execute('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)', ('collections', json.dumps(names, ensure_ascii=False)))
    return {'collections': names}


def paper_file_action(app: ApplicationContext, pid, action):
    """Resolve an active paper internally; clients cannot submit arbitrary paths."""
    if not re.fullmatch(r'[a-f0-9]{16}', pid) or action not in ('copy-pdf', 'reveal-pdf', 'copy-path'):
        raise ValueError('无效的文件操作。')
    doc = app.get_doc(pid)
    source = (app.LIBRARY / pid / 'original.pdf').resolve()
    if not source.is_relative_to(app.LIBRARY.resolve()) or not source.is_file():
        raise ValueError('原 PDF 文件不存在。')
    if action == 'copy-path':
        # Return only the server-resolved library path.  Never accept a path
        # supplied by the browser, so this endpoint cannot be used to expose
        # arbitrary local files.
        return {'ok': True, 'path': str(source)}
    import desktop_files
    if action == 'reveal-pdf':
        desktop_files.reveal_pdf(source)
        return {'ok': True}
    # Keep the imported filename when pasted, without renaming the library original.
    filename = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', str(doc.get('filename') or 'paper.pdf')).strip(' .')
    filename = filename[:150] or 'paper.pdf'
    if not filename.lower().endswith('.pdf'):
        filename += '.pdf'
    if re.match(r'^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)', filename, re.I):
        filename = '_' + filename
    folder = app.DATA / 'clipboard' / pid
    target = (folder / filename).resolve()
    if not target.is_relative_to((app.DATA / 'clipboard').resolve()):
        raise ValueError('无效的 PDF 文件名。')
    with app.LOCK, app.FILE_ACTION_LOCK:
        app.get_doc(pid)
        folder.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        desktop_files.copy_pdf(target)
    return {'ok': True, 'filename': filename}


def journal_abbr(name):
    cleaned = re.sub(r'[^a-z0-9]', '', str(name).lower())
    aliases = {
        'ieeetransactionsonrobotics': 'TRO',
        'ieeeroboticsandautomationletters': 'RAL',
        'ieeeasmetransactionsonmechatronics': 'T-MECH',
        'naturecommunications': 'Nat. Commun.',
        'sciencerobotics': 'Sci. Robot.',
        'ieeetransactionsonautomation scienceandengineering'.replace(' ', ''): 'T-ASE',
        'ieeesensorsjournal': 'IEEE Sens. J.',
        'advancedintelligentsystems': 'Adv. Intell. Syst.',
        'softrobotics': 'Soft Robot.',
        'nature': 'Nature', 'science': 'Science',
    }
    return aliases.get(cleaned, name)


def media_url(pid, filename):
    return '/media/' + pid + '/' + urllib.parse.quote(str(filename).replace('\\', '/'), safe='/')


def translation_counts(app: ApplicationContext, doc):
    from .text_actions import original_text
    target = [b for b in doc.get('blocks', []) if b.get('kind') != 'reference' and not b.get('is_formula') and original_text(b).strip()]
    t = dict(doc.get('translation', {}))
    staging = t.pop('staging', None)
    current_done = sum(bool(b.get('translation', '').strip()) for b in target)
    done = sum(bool(staging.get(b['id'], '').strip()) for b in target) if isinstance(staging, dict) else current_done
    t.update(total=len(target), done=done, current_done=current_done)
    t['has_staging'] = isinstance(staging, dict)
    t['current_config'] = doc.get('translation_current', {}).get('config')
    t['current_mixed'] = doc.get('translation_current', {}).get('mixed', bool(current_done and not doc.get('translation_current')))
    t['versions'] = [app.version_metadata(v) for v in reversed(doc.get('translation_versions', []))]
    t['drafts'] = [app.version_metadata(v) for v in reversed(doc.get('translation_drafts', []))]
    t.setdefault('status', 'idle')
    t.setdefault('error', '')
    return t


def collection_names(doc):
    """Return all manual groups, while keeping the old single-group field readable."""
    values = doc.get('collections')
    if not isinstance(values, list):
        values = []
    result = []
    for value in [*values, doc.get('collection', '')]:
        if isinstance(value, str) and value.strip() and value.strip() not in result:
            result.append(value.strip())
    return result


def public_doc(app: ApplicationContext, doc, full=False):
    from . import personal_journals
    import paper_ai
    hidden = {'hash', 'blocks', 'pages', 'figures', 'translation_versions', 'translation_current',
              'translation_runs', 'translation_drafts', 'jif', 'jif_year', 'jif_source_url',
              'quartiles', 'metrics_source', 'metrics_sources', 'metrics_status', 'metrics_error',
              'metrics_note', 'conference_rankings', 'read_state', 'reading_structure', 'collection_assignment'}
    hidden.update({'text_annotations', 'text_revision_history', 'text_action_receipts'})
    hidden.update({'team', 'team_sources', 'team_status', 'team_error'})
    out = {k: v for k, v in doc.items() if k not in hidden}
    out['collections'] = collection_names(doc)
    # `collection` is retained as a compatibility alias for older clients.
    out['collection'] = out['collections'][0] if out['collections'] else ''
    from .publication import assessment
    out['metadata_enrichment'] = assessment(doc)
    out.setdefault('paper_type', 'journal')
    out.setdefault('conference_name', '')
    out.setdefault('conference_abbr', '')
    out.setdefault('conference_track', 'unknown')
    import paper_metadata
    out = paper_metadata.normalize_publication(out)
    if out.get('journal') != doc.get('journal'):
        out['journal_abbr'] = app.journal_abbr(out.get('journal', ''))
    for key in ('journal_tier', 'tier_needs_review', 'catalogue_revision'):
        out.pop(key, None)
    tier_info = personal_journals.classify(app.DATA, out)
    out['journal_tier'] = tier_info.pop('tier')
    out.update(tier_info)
    for key in ('tier_basis', 'tier_source_url', 'tier_journal'):
        out.pop(key, None)
    out['cover_url'] = app.media_url(doc['id'], doc.get('cover') or 'page-001.jpg')
    out['translation'] = app.translation_counts(doc)
    out['page_count'] = len(doc.get('pages', []))
    out['original_url'] = app.media_url(doc['id'], 'original.pdf')
    structure = doc.get('reading_structure', {})
    out['structure_status'] = structure.get('status', 'local')
    out['structure_error'] = structure.get('error', '')
    try:
        with app.LOCK, app.db() as con:
            out['paper_ai'] = paper_ai.summary(con, doc['id'])
    except sqlite3.OperationalError as exc:
        if 'no such table: paper_ai' not in str(exc):
            raise
        # Pure metadata previews may run before init_db (including isolated tests).
        out['paper_ai'] = {'generation': 1, 'model': None,
                           'reasoning_effort': None, 'has_chat': False}
    if full:
        import copy
        from . import text_actions
        import paper_structure
        if structure.get('version') != paper_structure.VERSION or structure.get('source_fingerprint') != paper_structure.fingerprint(doc):
            structure = paper_structure.organize(doc)
        out['reading_structure'] = structure
        out['blocks'] = [{**b, 'translation_needs_review': text_actions.review_needed(b), **({'image_url': app.media_url(doc['id'], b['image'])} if b.get('image') else {})} for b in doc.get('blocks', [])]
        out['text_annotations'] = text_actions.resolved_annotations(doc)
        out['text_revision_history'] = copy.deepcopy(doc.get('text_revision_history', []))
        out['pages'] = [{**p, 'image_url': app.media_url(doc['id'], p.get('image', f"page-{p['number']:03}.jpg"))} for p in doc.get('pages', [])]
        out['figures'] = [{**f, 'url': app.media_url(doc['id'], f.get('path', ''))} for f in doc.get('figures', [])]
    return out


def patch_paper_fields(doc, fields):
    import paper_metadata
    publication_changed = any(key in fields and fields[key] != doc.get(key)
                              for key in (*paper_metadata.PUBLICATION_FIELDS, 'title', 'paper_type', 'conference_abbr'))
    doc.update(fields)
    saved = doc.get('metadata_enrichment')
    if publication_changed and isinstance(saved, dict) and saved.get('checked_at'):
        from .publication import assessment
        checked = saved['checked_at']
        saved = assessment(doc)
        saved.update(checked_at=None, previous_checked_at=checked,
                     status='needs_consent' if saved['missing'] else 'complete')
        doc['metadata_enrichment'] = saved
    provenance = doc.setdefault('metadata_provenance', {})
    for key in (*paper_metadata.PUBLICATION_FIELDS, 'title', 'paper_type', 'conference_abbr'):
        if key in fields:
            provenance[key] = {'source': 'manual'}
    if 'collections' in fields:
        names = fields['collections']
        doc['collections'] = names
        doc['collection'] = names[0] if names else ''
        doc['collection_assignment'] = {'status': 'manual', 'name': doc['collection'], 'names': names, 'error': ''}
    elif 'collection' in fields:
        doc['collections'] = [fields['collection']] if fields['collection'] else []
        doc['collection_assignment'] = {'status': 'manual', 'name': fields['collection'], 'error': ''}
