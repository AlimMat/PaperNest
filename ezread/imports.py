"""PDF ingestion, deduplication and local source structure."""
from __future__ import annotations
from .context import ApplicationContext
import hashlib
import re
import secrets
from pathlib import Path


def import_pdf(app: ApplicationContext, content, filename, collection=''):
    import pdf_tools
    if not content or b'%PDF-' not in content[:1024]:
        raise ValueError('文件不是有效的 PDF。')
    if collection is None:
        collection = ''
    if not isinstance(collection, str) or len(collection) > 100 or re.search(r'[\x00-\x1f\x7f]', collection):
        raise ValueError('导入分组名称无效。')
    collection = collection.strip()
    def check_collection():
        from .library import ordered_collections
        if collection and collection not in ordered_collections(app, app.all_docs()):
            raise ValueError('目标分组不存在，请刷新后重试。')
    with app.LOCK:
        check_collection()
    fingerprint = hashlib.sha256(content).hexdigest()
    with app.LOCK, app.db() as con:
        duplicate = con.execute('SELECT id,deleted FROM papers WHERE hash=?', (fingerprint,)).fetchone()
    if duplicate:
        if duplicate[1]:
            # Legacy trash entries must never resurrect old notes or groups.
            app.delete_paper(duplicate[0])
        else:
            if collection:
                def assign(existing):
                    memberships = app.collection_names(existing)
                    if collection not in memberships:
                        from .library import patch_paper_fields
                        patch_paper_fields(existing, {'collections': [*memberships, collection]})
                with app.LOCK:
                    check_collection()
                    app.update_doc(duplicate[0], assign)
            doc = app.public_doc(app.get_doc(duplicate[0]))
            doc['duplicate'] = True
            return doc
    pid = secrets.token_hex(8)
    asset_dir = app.LIBRARY / pid
    asset_dir.mkdir()
    source = app.DATA / 'tmp' / f'{pid}.pdf'
    try:
        source.write_bytes(content)
        extracted = pdf_tools.extract_document(source, asset_dir)
        metadata = extracted.pop('metadata', {})
        # Accommodate top-level metadata without confusing document geometry.
        for key in ('title', 'doi', 'authors', 'journal', 'year', 'abstract'):
            if extracted.get(key) and not metadata.get(key):
                metadata[key] = extracted[key]
        import paper_metadata
        metadata = paper_metadata.normalize_publication(metadata)
        doc = {**extracted, **metadata, 'id': pid, 'hash': fingerprint, 'filename': Path(filename).name,
               'title': metadata.get('title') or Path(filename).stem,
               'title_zh': '', 'summary': '', 'overview_sections': [],
               'journal': metadata.get('journal', ''), 'journal_abbr': app.journal_abbr(metadata.get('journal', '')),
               'paper_type': metadata.get('paper_type') or ('journal' if metadata.get('journal') else 'other'),
               'conference_name': metadata.get('conference_name', ''), 'conference_abbr': metadata.get('conference_abbr', ''),
               'conference_track': metadata.get('conference_track', 'unknown'),
               'authors': metadata.get('authors', []), 'tags': [], 'collections': [collection] if collection else [],
               'collection': collection, 'favorite': False,
               'created_at': app.now(), 'updated_at': app.now(), 'last_read': '', 'read_page': 1,
               'notes': '', 'deleted': False,
               'translation': {'status': 'idle', 'error': ''}}
        if not doc.get('blocks'):
            doc['import_warning'] = '未提取到可选文字，可能是扫描件。可查看原文和选封面，暂不能全文翻译。'
        import paper_structure
        doc['reading_structure'] = paper_structure.organize(doc)
        from .publication import assessment
        doc['metadata_enrichment'] = assessment(doc)
        with app.LOCK:
            check_collection()
            if collection:
                doc['collection_assignment'] = {'status': 'manual', 'name': collection, 'names': [collection], 'error': ''}
            app.put_doc(doc)
        import paper_ai
        with app.LOCK, app.db() as con:
            paper_ai.ensure(con, pid)
        if doc.get('blocks'):
            app.schedule_structure(pid)
        return app.public_doc(app.get_doc(pid))
    except Exception:
        # A failure after put_doc must also remove its hash, not leave a ghost duplicate.
        if asset_dir.parent == app.LIBRARY and re.fullmatch(r'[a-f0-9]{16}', asset_dir.name):
            app.delete_paper(pid)
        raise
    finally:
        source.unlink(missing_ok=True)
