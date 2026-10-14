"""Explicit manuscript links; resolving never launches programs or reads external text."""
from __future__ import annotations

import os
from pathlib import Path
import re
import secrets
import threading
import time
import urllib.parse
import webbrowser

from . import writing

LOCK = threading.RLock()
TICKETS = {}
TTL = 2 * 60 * 60
SAFE_FILES = {'.pdf', '.md', '.tex', '.txt', '.doc', '.docx', '.odt', '.rtf',
              '.xls', '.xlsx', '.csv', '.ppt', '.pptx', '.png', '.jpg', '.jpeg',
              '.gif', '.webp', '.bmp', '.mp3', '.wav', '.mp4', '.mkv', '.zip', '.7z'}


def _paper(app, pid):
    if not re.fullmatch(r'[a-f0-9]{16}', pid):
        raise ValueError('论文链接无效。')
    doc = app.get_doc(pid)
    path = app.LIBRARY / pid / 'original.pdf'
    if not doc or doc.get('deleted') or not path.is_file():
        raise ValueError('链接的论文已被移除。')
    return {'kind': 'paper', 'id': pid, 'title': doc.get('title') or '论文'}


def _writing(app, relative):
    path = writing.target(app, relative, empty=True)
    if path.is_dir():
        entries = [entry for entry in writing.snapshot(app)['entries']
                   if entry['path'].rpartition('/')[0] == relative]
        return {'kind': 'folder', 'title': path.name, 'path': relative, 'entries': entries}
    doc = writing.document(app, relative)
    return {'kind': 'writing', 'title': path.name, 'path': relative, 'document': doc}


def _stamp(path):
    stat = path.stat()
    return (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns)


def resolve(app, data):
    href, source = data.get('href'), data.get('source')
    if not isinstance(href, str) or not 1 <= len(href) <= 4096 or re.search(r'[\x00-\x1f]', href):
        raise ValueError('链接地址无效。')
    origin = writing.target(app, source)
    if not origin.is_file() or origin.suffix.lower() not in writing.EXTENSIONS:
        raise ValueError('链接来源文稿不存在。')
    href = href.strip()
    if href.startswith('papernest://'):
        parsed = urllib.parse.urlsplit(href)
        relative = urllib.parse.unquote(parsed.path.lstrip('/'))
        if parsed.query or parsed.fragment:
            raise ValueError('PaperNest 链接无效。')
        if parsed.netloc == 'paper':
            return _paper(app, relative)
        if parsed.netloc == 'writing':
            return _writing(app, relative)
        raise ValueError('PaperNest 链接类型无效。')
    if href.startswith('/media/'):
        match = re.fullmatch(r'/media/([a-f0-9]{16})/original\.pdf', href)
        if not match:
            raise ValueError('论文链接无效。')
        return _paper(app, match[1])
    if href.lower().startswith('file:'):
        parsed = urllib.parse.urlsplit(href)
        if parsed.netloc not in ('', 'localhost') or parsed.query:
            raise ValueError('仅支持本机文件链接，不支持网络共享。')
        value = urllib.parse.unquote(parsed.path)
        if re.match(r'^/[A-Za-z]:/', value):
            value = value[1:]
    else:
        if re.match(r'^[A-Za-z][A-Za-z0-9+.-]*:', href) and not re.match(r'^[A-Za-z]:[\\/]', href):
            raise ValueError('这里只接受本地路径或 PaperNest 链接。')
        # A copied absolute filesystem path is literal: percent-encoded-looking
        # filenames must not be decoded. URI/Markdown-relative paths are encoded.
        value = href if Path(href).is_absolute() else urllib.parse.unquote(href)
    value = value.replace('\\', '/')
    if value.startswith('//') or re.search(r'[\x00-\x1f]', value) or ':' in re.sub(r'^[A-Za-z]:', '', value):
        raise ValueError('仅支持普通本机路径。')
    path = Path(value)
    if not path.is_absolute():
        path = origin.parent / path
    try:
        path = path.resolve(strict=True)
    except (OSError, RuntimeError):
        raise ValueError('链接的文件或文件夹不存在。') from None
    base = writing.root(app).resolve()
    if path.is_relative_to(base):
        return _writing(app, path.relative_to(base).as_posix() if path != base else '')
    library = app.LIBRARY.resolve()
    if path == library:
        return {'kind': 'papers', 'title': 'PaperNest 文献库', 'entries': [
            _paper(app, doc['id']) for doc in app.all_docs() if not doc.get('deleted')
            and (library / doc['id'] / 'original.pdf').is_file()]}
    if path.is_relative_to(library):
        relative = path.relative_to(library).parts
        if len(relative) == 1 or len(relative) == 2 and relative[1] == 'original.pdf':
            return _paper(app, relative[0])
        raise ValueError('此链接不是库内原始 PDF，请链接文稿或论文文件。')
    if not path.is_dir() and (not path.is_file() or path.suffix.lower() not in SAFE_FILES):
        raise ValueError('不支持打开此文件类型；程序、脚本和快捷方式不会从文稿链接执行。')
    token = secrets.token_hex(16)
    with LOCK:
        now = time.monotonic()
        for key, ticket in list(TICKETS.items()):
            if ticket['expires'] <= now:
                del TICKETS[key]
        if len(TICKETS) >= 128:
            del TICKETS[next(iter(TICKETS))]
        TICKETS[token] = {'path': path, 'stamp': _stamp(path), 'data': str(app.DATA.resolve()),
                          'expires': now + TTL, 'approved': False}
    return {'kind': 'external', 'path': str(path), 'title': path.name, 'token': token,
            'type': 'folder' if path.is_dir() else 'pdf' if path.suffix.lower() == '.pdf' else 'file'}


def _ticket(app, token):
    if not isinstance(token, str):
        raise ValueError('链接已过期，请重新点击。')
    ticket = TICKETS.get(token)
    if not ticket or ticket['expires'] <= time.monotonic() or ticket['data'] != str(app.DATA.resolve()):
        raise ValueError('链接已过期，请重新点击。')
    try:
        if _stamp(ticket['path']) != ticket['stamp']:
            raise ValueError('链接目标已经改变，请重新点击确认。')
    except OSError:
        raise ValueError('链接目标已经移除。') from None
    return ticket


def open_external(app, data):
    with LOCK:
        ticket = _ticket(app, data.get('token'))
        path = ticket['path']
        try:
            if path.is_file() and path.suffix.lower() == '.pdf':
                ticket['approved'] = True
                url = f'http://127.0.0.1:{app.PORT}/api/writing/link-pdf/{data["token"]}/document.pdf'
                if not webbrowser.open(url):
                    raise OSError('browser unavailable')
            else:
                if os.name != 'nt':
                    raise ValueError('系统文件打开功能需要 Windows。')
                os.startfile(str(path))
        except OSError:
            ticket['approved'] = False
            raise ValueError('未能打开链接，请检查默认程序是否可用。') from None
    return {'ok': True}


def pdf_file(app, token):
    with LOCK:
        ticket = _ticket(app, token)
        if not ticket['approved'] or ticket['path'].suffix.lower() != '.pdf' or not ticket['path'].is_file():
            raise ValueError('请先在文稿中确认打开此 PDF。')
        return ticket['path']
