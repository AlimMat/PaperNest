# Local writing dependencies

These pinned MIT-licensed libraries are used only by the enhanced Markdown workspace. No CDN, package manager, build tool, or internet access is required when using PaperNest.

* CodeMirror 5.65.21: source editing, selections, undo/redo and reversible image-data folds. https://codemirror.net/5/
* markdown-it 15.0.2: Markdown parsing with raw HTML disabled. https://github.com/markdown-it/markdown-it
* KaTeX 0.19.0: offline TeX math rendering, including local fonts, with trust disabled. https://katex.org/

Each directory contains its upstream LICENSE. Reproduce downloads using `python scripts/vendor-writing-libs.py`; the script verifies pinned npm SHA-512 archive hashes before copying only browser assets.
