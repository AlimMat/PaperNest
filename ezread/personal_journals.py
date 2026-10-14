"""User-curated quartiles, independent of the retained legacy tier catalogue."""
from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import threading
import unicodedata
from pathlib import Path

from .journal_catalogue import CatalogueConflict, _write_lock

TIERS = ('q1', 'q2', 'q3', 'q4', 'other')
FIELDS = ('id', 'tier', 'name', 'issn', 'aliases', 'basis', 'source_url')
_LOCK = threading.RLock()


def name_key(value):
    return re.sub(r'\W+', '', unicodedata.normalize('NFKC', str(value or '')).casefold())


def snapshot(data_dir):
    path = Path(data_dir) / 'personal-journals.json'
    raw = path.read_bytes() if path.exists() else b'[]'
    rows = json.loads(raw)
    if not isinstance(rows, list):
        raise ValueError('个人期刊库格式无效，请从备份恢复。')
    return {'rows': rows, 'revision': hashlib.sha256(raw).hexdigest(),
            'counts': {tier: sum(row['tier'] == tier for row in rows) for tier in TIERS}, 'error': ''}


def apply_changes(data_dir, changes, expected_revision):
    if not isinstance(changes, list) or not 1 <= len(changes) <= 100:
        raise ValueError('请提交有效的期刊修改。')
    path = Path(data_dir) / 'personal-journals.json'
    path.parent.mkdir(parents=True, exist_ok=True)
    with _LOCK, _write_lock(path):
        before = snapshot(data_dir)
        if expected_revision != before['revision']:
            raise CatalogueConflict('期刊库已更新，请重新打开期刊页后再保存。')
        rows = {row['id']: dict(row) for row in before['rows']}
        for change in changes:
            if not isinstance(change, dict) or set(change) - {*FIELDS, 'action'}:
                raise ValueError('期刊信息包含无效字段。')
            identifier = change.get('id')
            if identifier is not None and (not isinstance(identifier, str) or not re.fullmatch(r'[a-f0-9]{24}', identifier)):
                raise ValueError('无效的期刊标识。')
            if identifier and identifier not in rows:
                raise ValueError('该期刊已不存在，请刷新列表。')
            action = change.get('action')
            if action == 'delete':
                if not identifier:
                    raise ValueError('请选择需要移除的期刊。')
                del rows[identifier]
                continue
            if action != 'upsert':
                raise ValueError('未知的期刊操作。')
            row = {key: change.get(key, rows.get(identifier, {}).get(key, '')) for key in FIELDS if key != 'id'}
            if any(not isinstance(value, str) or len(value) > 2000 or '\n' in value or '\r' in value for value in row.values()):
                raise ValueError('期刊字段须为不超过 2000 字的单行文字。')
            row = {key: value.strip() for key, value in row.items()}
            if not name_key(row['name']) or row['tier'] not in TIERS:
                raise ValueError('请填写期刊名称并选择分区。')
            if row['source_url'] and not row['source_url'].startswith(('https://', 'http://')):
                raise ValueError('来源链接须以 https:// 或 http:// 开头。')
            if any(key != identifier and name_key(old['name']) == name_key(row['name']) for key, old in rows.items()):
                raise ValueError('这个期刊已在库中，请搜索后编辑。')
            row['id'] = identifier or secrets.token_hex(12)
            rows[row['id']] = row
        if len(rows) > 5000:
            raise ValueError('期刊库最多保存 5000 条。')
        ordered = sorted(rows.values(), key=lambda row: (TIERS.index(row['tier']), name_key(row['name'])))
        raw = json.dumps(ordered, ensure_ascii=False, indent=2).encode('utf-8')
        if path.exists():
            history = path.parent / 'personal-journal-history'
            history.mkdir(exist_ok=True)
            (history / f"{before['revision']}.json").write_bytes(path.read_bytes())
        temporary = path.with_suffix(f'.{secrets.token_hex(6)}.tmp')
        try:
            with temporary.open('xb') as stream:
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)
        return snapshot(data_dir)


def classify(data_dir, doc):
    catalogue = snapshot(data_dir)
    # The user-selected name wins over stale ISSNs extracted from the PDF.
    name = name_key(doc.get('journal'))
    exact = [row for row in catalogue['rows'] if name and name_key(row['name']) == name]
    matches = exact or [row for row in catalogue['rows'] if name and name in
                        [name_key(alias) for alias in row['aliases'].split(';') if alias.strip()]]
    tier = matches[0]['tier'] if len(matches) == 1 else doc.get('paper_type') if doc.get('paper_type') in ('conference', 'preprint') else 'other'
    return {'tier': tier, 'catalogue_revision': catalogue['revision']}
