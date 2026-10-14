"""Bounded local XeLaTeX compilation and ephemeral PDF previews."""
from collections import OrderedDict
import io
import math
import os
import re
import secrets
import shutil
import subprocess
import tempfile
import threading
import time

import pdf_tools
from . import processes, writing

COMPILE_LOCK = threading.Lock()
CACHE_LOCK = threading.Lock()
CACHE = OrderedDict()
MAX_PDF = 24 * 1024 * 1024


def template(language='zh'):
    if language not in ('zh', 'en'):
        raise ValueError('请选择中文或英文 LaTeX 模板。')
    chinese = language == 'zh'
    return ('\\documentclass[UTF8]{ctexart}\n' if chinese else '\\documentclass[12pt]{article}\n') + (
        '\\usepackage{amsmath,amssymb}\n'
        '\\usepackage[a4paper,margin=2.5cm]{geometry}\n'
        '\\title{' + ('文章标题' if chinese else 'Article Title') + '}\n'
        '\\author{}\n\\date{}\n\\begin{document}\n\\maketitle\n'
        '\\section{' + ('引言' if chinese else 'Introduction') + '}\n'
        + ('在这里开始写作。' if chinese else 'Start writing here.') + '\n'
        '\\[ E = mc^2 \\]\n\\end{document}\n'
    )


def _run(engine, folder):
    # TeX reads only the isolated source and installed packages; no shell escape,
    # parent/absolute user-file reads, or writes outside this disposable folder.
    env = dict(os.environ, openin_any='p', openout_any='p', shell_escape='f',
               TEXMFOUTPUT=str(folder), TEXMF_OUTPUT_DIRECTORY=str(folder))
    flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
    with (folder / 'console.txt').open('wb') as output:
        process = processes.spawn([engine, '-no-shell-escape', '-no-mktex=tex',
                                   '-interaction=nonstopmode', '-halt-on-error',
                                   '-file-line-error', 'manuscript.tex'],
                                  cwd=folder, env=env, stdin=subprocess.DEVNULL,
                                  stdout=output, stderr=subprocess.STDOUT, creationflags=flags)
        try:
            try:
                process.wait(timeout=40)
            except subprocess.TimeoutExpired as exc:
                process.kill()
                process.wait()
                raise ValueError('LaTeX 编译超过 40 秒，请检查循环宏或过于复杂的排版。') from exc
        finally:
            processes.release(process)
    log = (folder / 'console.txt').read_bytes()[-12000:].decode('utf-8', errors='replace')
    if process.returncode:
        lines = log.splitlines()
        start = next((i for i, line in enumerate(lines) if line.startswith('!') or re.search(r'manuscript\.tex:\d+:', line)), max(0, len(lines) - 14))
        detail = '\n'.join(lines[start:start + 16])[-2200:]
        raise ValueError('LaTeX 编译失败，原稿未改变。请检查下面的行号和提示：\n' + detail)
    return log


def compile_preview(app, data):
    doc = writing.document(app, data.get('path'))
    if doc['format'] != 'tex':
        raise ValueError('只有 LaTeX 文稿可以编译。')
    if data.get('revision') != doc['revision']:
        raise writing.Conflict('文稿已改变，请先保存当前内容，再重新编译。')
    engine = shutil.which('xelatex')
    if not engine:
        raise ValueError('未找到 XeLaTeX。请安装含中文支持的 TeX Live，并重新启动 PaperNest。')
    if not COMPILE_LOCK.acquire(blocking=False):
        raise ValueError('另一个文稿正在编译，请稍后再试。')
    try:
        with tempfile.TemporaryDirectory(prefix='papernest-latex-') as temporary:
            from pathlib import Path
            folder = Path(temporary)
            (folder / 'manuscript.tex').write_text(doc['content'], encoding='utf-8')
            _run(engine, folder)
            log = _run(engine, folder)  # Resolve ordinary labels and references.
            output = folder / 'manuscript.pdf'
            if not output.is_file() or not 0 < output.stat().st_size <= MAX_PDF:
                raise ValueError('未生成有效 PDF，或 PDF 超过 24 MB 预览上限。')
            raw = output.read_bytes()
        with pdf_tools._PDF_LOCK, pdf_tools.pdfium.PdfDocument(raw) as pdf:
            if not 1 <= len(pdf) <= 200:
                raise ValueError('内置预览支持 1–200 页的文稿。')
            sizes = []
            for index in range(len(pdf)):
                page = pdf[index]
                try:
                    width, height = page.get_size()
                    if not all(math.isfinite(v) and 0 < v <= 3000 for v in (width, height)):
                        raise ValueError('PDF 页面尺寸超过内置预览范围。')
                    sizes.append({'width': width, 'height': height})
                finally:
                    page.close()
        token = secrets.token_hex(16)
        with CACHE_LOCK:
            CACHE[token] = {'root': str(writing.root(app)), 'raw': raw, 'pages': sizes,
                            'name': doc['name'][:-4] + '.pdf', 'created': time.monotonic()}
            while len(CACHE) > 8 or sum(len(item['raw']) for item in CACHE.values()) > 64 * 1024 * 1024:
                CACHE.popitem(last=False)
        warnings = [line.strip() for line in log.splitlines() if 'Warning:' in line or 'Missing character:' in line]
        return {'token': token, 'pages': sizes, 'revision': doc['revision'], 'warnings': warnings[:12]}
    finally:
        COMPILE_LOCK.release()


def preview_file(app, token, page=None):
    with CACHE_LOCK:
        item = CACHE.get(token)
        if not item or item['root'] != str(writing.root(app)):
            raise ValueError('预览已过期，请重新编译。')
        if time.monotonic() - item['created'] > 7200:
            del CACHE[token]
            raise ValueError('预览已过期，请重新编译。')
        raw, name, count = item['raw'], item['name'], len(item['pages'])
    if page is None:
        return raw, 'application/pdf', name
    if not 1 <= page <= count:
        raise ValueError('页码超出范围。')
    with pdf_tools._PDF_LOCK, pdf_tools.pdfium.PdfDocument(raw) as pdf:
        sheet = pdf[page - 1]
        try:
            width, height = sheet.get_size()
            scale = min(3, math.sqrt(12_000_000 / (width * height)))
            bitmap = sheet.render(scale=scale)
            try:
                output = io.BytesIO()
                bitmap.to_pil().save(output, format='PNG')
            finally:
                bitmap.close()
        finally:
            sheet.close()
    return output.getvalue(), 'image/png', None
