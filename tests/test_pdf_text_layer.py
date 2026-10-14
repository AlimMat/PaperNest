import unittest

from ezread.pdf_text_layer import map_glyphs


def line(text, x=10, y=10):
    return {'chars': [{'text': c, 'x0': x + i * 6, 'x1': x + i * 6 + 5,
                       'top': y, 'bottom': y + 10} for i, c in enumerate(text)]}


class PdfTextLayerTests(unittest.TestCase):
    def test_spaces_unicode_ligatures_and_hyphenation_keep_source_offsets(self):
        block = {'text': 'A fine model 😀 works', 'bbox': [0, 0, 1, 1]}
        mapped = map_glyphs(block, [line('A ﬁne mod-'), line('el 😀 works', y=25)], 300, 100)
        self.assertEqual(''.join(g['text'] for g in mapped), 'Afinemodel😀works')
        for glyph in mapped:
            self.assertEqual(block['text'][glyph['start']], glyph['text'])
            self.assertTrue(all(0 <= v <= 1 for v in glyph['box']))

    def test_columns_with_identical_text_use_their_own_geometry(self):
        lines = [line('same text'), line('same text', x=160)]
        left = map_glyphs({'text': 'same text', 'bbox': [0, 0, .49, 1]}, lines, 300, 100)
        right = map_glyphs({'text': 'same text', 'bbox': [.51, 0, 1, 1]}, lines, 300, 100)
        self.assertEqual(len(left), 8)
        self.assertEqual(len(right), 8)
        self.assertLess(left[0]['box'][0], .49)
        self.assertGreater(right[0]['box'][0], .51)

    def test_unmatched_revised_or_scanned_text_does_not_guess_positions(self):
        block = {'text': 'Original paragraph', 'text_override': 'Completely different content', 'bbox': [0, 0, 1, 1]}
        self.assertEqual(map_glyphs(block, [line('Original paragraph')], 300, 100), [])
        self.assertEqual(map_glyphs(block, [], 300, 100), [])
        self.assertEqual(map_glyphs({**block, 'is_formula': True}, [line('Original paragraph')], 300, 100), [])


if __name__ == '__main__':
    unittest.main()
