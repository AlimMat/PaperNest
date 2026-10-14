"""Read-only PDF glyph geometry mapped onto existing immutable block IDs."""
from difflib import SequenceMatcher
import unicodedata


def map_glyphs(block, lines, width, height):
    """Conservative mapping: never stretch a paragraph over an approximate box."""
    if block.get('is_formula') or not block.get('bbox'):
        return []
    x0, y0, x1, y1 = [v * (width if i % 2 == 0 else height)
                       for i, v in enumerate(block['bbox'])]
    glyphs = []
    for line in lines:
        for char in sorted(line['chars'], key=lambda c: c['x0']):
            if not (x0 - .5 <= (char['x0'] + char['x1']) / 2 <= x1 + .5
                    and y0 - .5 <= (char['top'] + char['bottom']) / 2 <= y1 + .5):
                continue
            text = unicodedata.normalize('NFKC', char.get('text', ''))
            for index, value in enumerate(text):
                if value.isspace():
                    continue
                left = char['x0'] + (char['x1'] - char['x0']) * index / len(text)
                right = char['x0'] + (char['x1'] - char['x0']) * (index + 1) / len(text)
                if right > left and char['bottom'] > char['top']:
                    glyphs.append((value, [left / width, char['top'] / height,
                                           right / width, char['bottom'] / height]))
    base = block.get('text_override', block.get('text', ''))
    offsets = [i for i, c in enumerate(base) if not c.isspace()]
    compact = ''.join(base[i] for i in offsets)
    # Disable autojunk: repeated characters are common in scientific prose.
    matcher = SequenceMatcher(None, ''.join(c for c, _ in glyphs), compact, autojunk=False)
    matches = matcher.get_matching_blocks()
    if not compact or sum(m.size for m in matches) / max(len(compact), len(glyphs), 1) < .85:
        return []
    result = []
    for match in matches:
        for delta in range(match.size):
            offset = offsets[match.b + delta]
            result.append({'start': offset, 'text': base[offset],
                           'box': [round(v, 7) for v in glyphs[match.a + delta][1]]})
    return result


def page_text_layer(pdf_path, number, blocks):
    import pdfplumber
    from pdf_tools import _lines, _PDF_LOCK
    with _PDF_LOCK, pdfplumber.open(pdf_path) as pdf:
        if not 1 <= number <= len(pdf.pages):
            raise ValueError('页码超出范围。')
        page = pdf.pages[number - 1]
        lines = _lines(page)
        mapped = []
        for block in blocks:
            if block.get('page') != number:
                continue
            glyphs = map_glyphs(block, lines, page.width, page.height)
            if glyphs:
                mapped.append({'id': block['id'], 'text': block.get('text_override', block.get('text', '')),
                               'glyphs': glyphs})
        return {'page': number, 'blocks': mapped}
