"""Local writing files, independent of the paper database and PDF resources."""
from __future__ import annotations

import hashlib
import html
from html.parser import HTMLParser
import io
import json
import os
import re
import secrets
import threading
import time
import xml.etree.ElementTree as ET
import zipfile

LOCK = threading.RLock()
EXTENSIONS = {'.md', '.tex', '.docx'}
MAX_SIZE = 2 * 1024 * 1024
MARKDOWN_MAX_SIZE = 32 * 1024 * 1024
W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
ET.register_namespace('w', W)


class Conflict(ValueError):
    pass


def root(app):
    # Isolated data directories also get isolated writing files in tests/profiles.
    location = app.ROOT / 'writing' if app.DATA.resolve() == (app.ROOT / 'data').resolve() else app.DATA / 'writing'
    if location.is_symlink() or location.resolve() != location.absolute():
        raise ValueError('写作目录不能使用符号链接或目录联接。')
    location.mkdir(parents=True, exist_ok=True)
    return location


def target(app, relative, *, empty=False):
    if not isinstance(relative, str) or (not relative and not empty):
        raise ValueError('请选择写作文件。')
    base = root(app)
    for part in relative.split('/') if relative else []:
        if (not part or part.startswith('.') or part.endswith((' ', '.')) or len(part) > 150
                or re.search(r'[<>:"\\|?*\x00-\x1f]', part)
                or re.fullmatch(r'(?i)(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?', part)):
            raise ValueError('文件名无效，请勿使用特殊字符或系统保留名称。')
    path = base / relative
    if len(str(path)) > 240 or not path.resolve().is_relative_to(base.resolve()):
        raise ValueError('写作路径无效或过长。')
    current = path
    while current != base:
        if current.is_symlink() or current.resolve() != current.absolute():
            raise ValueError('写作目录中不能操作符号链接或目录联接。')
        current = current.parent
    return path


def revision(raw):
    return hashlib.sha256(raw).hexdigest()


def read_bytes(path):
    if not path.is_file() or path.suffix.lower() not in EXTENSIONS:
        raise ValueError('文稿不存在或格式不支持。')
    limit = MARKDOWN_MAX_SIZE if path.suffix.lower() == '.md' else MAX_SIZE
    if path.stat().st_size > limit:
        raise ValueError(f'文稿超过 {limit // (1024 * 1024)} MB，请使用外部编辑器打开。')
    return path.read_bytes()


class WordHTML(HTMLParser):
    """Only the basic styles exposed by our editor become Word document content."""
    def __init__(self, content):
        super().__init__(convert_charrefs=True)
        self.blocks = []
        self.current = None
        self.styles = []
        self.lists = []
        self.ignored = 0
        self.feed(content)
        self.finish()

    def finish(self):
        if self.current is not None:
            self.blocks.append(self.current)
            self.current = None

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style'):
            self.ignored += 1
        if self.ignored:
            return
        if tag in ('ul', 'ol'):
            self.lists.append({'tag': tag, 'index': 0})
        elif tag in ('p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'li'):
            self.finish()
            block_tag = tag if tag.startswith('h') else 'p'
            self.current = {'tag': block_tag, 'runs': []}
            if tag == 'blockquote':
                self.current['runs'].append(('> ', set()))
            elif tag == 'li':
                if self.lists:
                    self.lists[-1]['index'] += 1
                    prefix = '• ' if self.lists[-1]['tag'] == 'ul' else f"{self.lists[-1]['index']}. "
                else:
                    prefix = '• '
                self.current['runs'].append((prefix, set()))
        elif tag in ('b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'sup', 'sub'):
            self.styles.append(tag)
        elif tag == 'br':
            self.handle_data('\n')

    def handle_endtag(self, tag):
        if tag in ('script', 'style'):
            self.ignored = max(0, self.ignored - 1)
            return
        if self.ignored:
            return
        if tag in ('ul', 'ol'):
            if self.lists:
                self.lists.pop()
        elif tag in ('p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'li'):
            self.finish()
        elif tag in self.styles:
            self.styles.reverse()
            self.styles.remove(tag)
            self.styles.reverse()

    def handle_data(self, text):
        if self.ignored or not text:
            return
        if self.current is None:
            self.current = {'tag': 'p', 'runs': []}
        self.current['runs'].append((text, set(self.styles)))


def word_bytes(content):
    if re.search(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', content):
        raise ValueError('正文包含 Word 不支持的控制字符。')
    doc = ET.Element(f'{{{W}}}document')
    body = ET.SubElement(doc, f'{{{W}}}body')
    for block in WordHTML(content).blocks or [{'tag': 'p', 'runs': []}]:
        p = ET.SubElement(body, f'{{{W}}}p')
        if block['tag'].startswith('h'):
            prop = ET.SubElement(p, f'{{{W}}}pPr')
            ET.SubElement(prop, f'{{{W}}}pStyle', {f'{{{W}}}val': 'Heading' + block['tag'][1]})
        for text, styles in block['runs']:
            for index, line in enumerate(text.split('\n')):
                run = ET.SubElement(p, f'{{{W}}}r')
                props = ET.SubElement(run, f'{{{W}}}rPr')
                for name, active in [('b', {'b', 'strong'} & styles), ('i', {'i', 'em'} & styles), ('u', {'u'} & styles)]:
                    if active:
                        ET.SubElement(props, f'{{{W}}}{name}', {f'{{{W}}}val': 'single' if name == 'u' else '1'})
                if {'s', 'strike', 'del'} & styles:
                    ET.SubElement(props, f'{{{W}}}strike')
                vertical = 'superscript' if 'sup' in styles else 'subscript' if 'sub' in styles else ''
                if vertical:
                    ET.SubElement(props, f'{{{W}}}vertAlign', {f'{{{W}}}val': vertical})
                if index:
                    ET.SubElement(run, f'{{{W}}}br')
                ET.SubElement(run, f'{{{W}}}t', {'{http://www.w3.org/XML/1998/namespace}space': 'preserve'}).text = line
    section = ET.SubElement(body, f'{{{W}}}sectPr')
    ET.SubElement(section, f'{{{W}}}pgSz', {f'{{{W}}}w': '11906', f'{{{W}}}h': '16838'})
    ET.SubElement(section, f'{{{W}}}pgMar', {f'{{{W}}}{key}': '1440' for key in ('top', 'bottom', 'left', 'right')})
    styles = ET.Element(f'{{{W}}}styles')
    for level, size in [(1, 36), (2, 30), (3, 26), (4, 24), (5, 22), (6, 20)]:
        style = ET.SubElement(styles, f'{{{W}}}style', {f'{{{W}}}type': 'paragraph', f'{{{W}}}styleId': f'Heading{level}'})
        ET.SubElement(style, f'{{{W}}}name', {f'{{{W}}}val': f'heading {level}'})
        pp = ET.SubElement(style, f'{{{W}}}pPr')
        ET.SubElement(pp, f'{{{W}}}outlineLvl', {f'{{{W}}}val': str(level - 1)})
        rp = ET.SubElement(style, f'{{{W}}}rPr')
        ET.SubElement(rp, f'{{{W}}}b')
        ET.SubElement(rp, f'{{{W}}}sz', {f'{{{W}}}val': str(size)})
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>')
        archive.writestr('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
        archive.writestr('word/_rels/document.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>')
        archive.writestr('word/document.xml', ET.tostring(doc, encoding='utf-8', xml_declaration=True))
        archive.writestr('word/styles.xml', ET.tostring(styles, encoding='utf-8', xml_declaration=True))
    return output.getvalue()


def word_content(raw):
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            if archive.getinfo('word/document.xml').file_size > MAX_SIZE * 4:
                raise ValueError('Word 正文过大。')
            document = ET.fromstring(archive.read('word/document.xml'))
        # Never silently strip advanced external Word content when saving.
        unsupported = ('tbl', 'drawing', 'pict', 'object', 'fldChar', 'hyperlink', 'numPr', 'altChunk', 'sdt', 'ins', 'del', 'headerReference', 'footerReference', 'footnoteReference', 'endnoteReference', 'commentRangeStart', 'dstrike', 'highlight', 'color', 'jc', 'ind')
        if any(document.find(f'.//{{{W}}}{tag}') is not None for tag in unsupported):
            raise ValueError('此 Word 含表格、图片或复杂排版，请在 Word 中编辑；内置编辑器支持基础文字排版。')
        result = []
        for p in document.findall(f'{{{W}}}body/{{{W}}}p'):
            style = p.find(f'{{{W}}}pPr/{{{W}}}pStyle')
            name = style.get(f'{{{W}}}val', '') if style is not None else ''
            tag = 'h' + name[-1] if name in tuple(f'Heading{level}' for level in range(1, 7)) else 'p'
            parts = []
            for run in p.findall(f'{{{W}}}r'):
                text = ''.join(html.escape(child.text or '') if child.tag == f'{{{W}}}t' else '<br>' if child.tag == f'{{{W}}}br' else '\t' if child.tag == f'{{{W}}}tab' else '' for child in run)
                for prop, wrapper in [('b', 'strong'), ('i', 'em'), ('u', 'u')]:
                    value = run.find(f'{{{W}}}rPr/{{{W}}}{prop}')
                    if value is not None and value.get(f'{{{W}}}val', '1') not in ('0', 'false', 'none'):
                        text = f'<{wrapper}>{text}</{wrapper}>'
                strike = run.find(f'{{{W}}}rPr/{{{W}}}strike')
                if strike is not None and strike.get(f'{{{W}}}val', '1') not in ('0', 'false', 'none'):
                    text = f'<s>{text}</s>'
                vertical = run.find(f'{{{W}}}rPr/{{{W}}}vertAlign')
                if vertical is not None and vertical.get(f'{{{W}}}val') in ('superscript', 'subscript'):
                    wrapper = 'sup' if vertical.get(f'{{{W}}}val') == 'superscript' else 'sub'
                    text = f'<{wrapper}>{text}</{wrapper}>'
                parts.append(text)
            result.append(f'<{tag}>{"".join(parts)}</{tag}>')
        return ''.join(result) or '<p><br></p>'
    except (zipfile.BadZipFile, KeyError, ET.ParseError) as exc:
        raise ValueError('无法读取此 Word 文件。') from exc


def document(app, relative):
    with LOCK:
        path = target(app, relative)
        raw = read_bytes(path)
        content = word_content(raw) if path.suffix.lower() == '.docx' else raw.decode('utf-8-sig')
        return {'path': relative, 'name': path.name, 'format': path.suffix.lower()[1:], 'content': content, 'revision': revision(raw)}


def snapshot(app):
    with LOCK:
        base = root(app)
        ranks = {name: index for index, name in enumerate(folder_order(app))}
        entries = []
        def walk(folder, depth=0):
            if depth > 16:
                return
            for path in sorted(folder.iterdir(), key=lambda p: (not p.is_dir(), ranks.get(p.relative_to(base).as_posix(), len(ranks)) if p.is_dir() else 0, p.name.casefold())):
                if path.name.startswith('.') or path.is_symlink() or path.resolve() != path.absolute():
                    continue
                if path.is_dir() or path.suffix.lower() in EXTENSIONS:
                    entries.append({'path': path.relative_to(base).as_posix(), 'name': path.name, 'kind': 'folder' if path.is_dir() else 'file'})
                    if path.is_dir():
                        walk(path, depth + 1)
        walk(base)
        return {'root': str(base), 'entries': entries}


def atomic_write(path, raw):
    temporary = path.with_name('.save-' + secrets.token_hex(8))
    try:
        with temporary.open('xb') as output:
            output.write(raw)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def order_file(app):
    path = root(app) / '.folder-order.json'
    if path.is_symlink() or path.resolve() != path.absolute():
        raise ValueError('文件夹顺序保存路径无效。')
    return path


def folder_order(app):
    path = order_file(app)
    if not path.exists():
        return []
    try:
        if path.stat().st_size > 2 * 1024 * 1024:
            raise ValueError('文件夹顺序记录过大。')
        values = json.loads(path.read_text(encoding='utf-8'))
        if not isinstance(values, list) or any(not isinstance(value, str) for value in values):
            raise ValueError('文件夹顺序记录无效。')
        return list(dict.fromkeys(values))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError('无法读取文件夹顺序记录。') from exc


def save_folder_order(app, names):
    atomic_write(order_file(app), json.dumps(names, ensure_ascii=False).encode('utf-8'))


def mutate(app, data):
    with LOCK:
        operation = data.get('operation')
        if operation == 'open-folder':
            os.startfile(str(root(app)))
            return {'ok': True}
        path = target(app, data.get('path'))
        if operation == 'move-folder':
            if not path.is_dir() or data.get('direction') not in ('up', 'down'):
                raise ValueError('请选择文件夹和上移／下移方向。')
            folders = [entry['path'] for entry in snapshot(app)['entries'] if entry['kind'] == 'folder']
            siblings = [name for name in folders if name.rpartition('/')[0] == data['path'].rpartition('/')[0]]
            if data['path'] not in siblings:
                raise ValueError('文件夹已改变，请刷新后重试。')
            index = siblings.index(data['path'])
            adjacent = index + (-1 if data['direction'] == 'up' else 1)
            if 0 <= adjacent < len(siblings):
                first, second = folders.index(siblings[index]), folders.index(siblings[adjacent])
                folders[first], folders[second] = folders[second], folders[first]
                save_folder_order(app, folders)
            return {'ok': True}
        if operation == 'copy-path':
            if not path.is_file() or path.suffix.lower() not in EXTENSIONS:
                raise ValueError('文稿不存在或格式不支持。')
            return {'ok': True, 'path': str(path.resolve())}
        if operation == 'create':
            if not path.parent.is_dir():
                raise ValueError('上级文件夹不存在。')
            if path.exists():
                raise ValueError('此名称已存在，请换一个名称。')
            if data.get('kind') == 'folder':
                path.mkdir()
            else:
                if path.suffix.lower() not in EXTENSIONS:
                    raise ValueError('请选择 Markdown、Word 或 LaTeX 格式。')
                content = ''
                if path.suffix.lower() == '.tex':
                    from .writing_latex import template
                    content = template(data.get('language', 'zh'))
                raw = word_bytes('<p><br></p>') if path.suffix.lower() == '.docx' else content.encode('utf-8')
                with path.open('xb') as output:
                    output.write(raw)
            return {'path': data['path']}
        if operation == 'save':
            content = data.get('content')
            limit = MARKDOWN_MAX_SIZE if path.suffix.lower() == '.md' else MAX_SIZE
            if not isinstance(content, str) or len(content.encode('utf-8')) > limit:
                raise ValueError(f'文稿内容无效或超过 {limit // (1024 * 1024)} MB。')
            before = read_bytes(path)
            if data.get('revision') != revision(before):
                raise Conflict('磁盘上的文稿已改变。你的草稿已保留，请另存草稿或重新读取，避免覆盖外部修改。')
            raw = word_bytes(content) if path.suffix.lower() == '.docx' else content.encode('utf-8')
            atomic_write(path, raw)
            return {'revision': revision(raw)}
        if operation == 'rename':
            destination = target(app, data.get('destination'))
            if not path.exists() or destination.exists() or not destination.parent.is_dir():
                raise ValueError('目标名称已存在或文件夹不存在。')
            if path.is_dir() and destination.is_relative_to(path):
                raise ValueError('不能将文件夹移动到自身内部。')
            if path.is_file() and path.suffix.lower() != destination.suffix.lower():
                raise ValueError('重命名时请保留原有文件扩展名。')
            order = folder_order(app) if path.is_dir() else []
            path.rename(destination)
            if order:
                old, new = data['path'], data['destination']
                renamed = [new + name[len(old):] if name == old or name.startswith(old + '/') else name for name in order]
                try:
                    save_folder_order(app, renamed)
                except Exception:
                    destination.rename(path)
                    raise
            return {'path': data['destination']}
        if operation == 'trash':
            if not path.exists():
                raise ValueError('文件已不存在。')
            trash = root(app) / '.trash'
            if trash.is_symlink() or trash.resolve() != trash.absolute():
                raise ValueError('回收目录无效。')
            trash.mkdir(exist_ok=True)
            order = folder_order(app) if path.is_dir() else []
            destination = trash / f'{time.time_ns()}-{path.name}'
            path.rename(destination)
            if order:
                try:
                    save_folder_order(app, [name for name in order if name != data['path'] and not name.startswith(data['path'] + '/')])
                except Exception:
                    destination.rename(path)
                    raise
            return {'ok': True, 'message': '已移到 writing/.trash，可在磁盘恢复。'}
        raise ValueError('未知的写作操作。')
