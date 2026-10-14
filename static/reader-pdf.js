"use strict";

// Geometry comes from the PDF's actual glyphs, while the selectable DOM uses
// one continuous text run per printed line. This keeps dragging natural and
// avoids the visible per-character boxes of the old overlay.
async function readerLoadPdfText(section) {
  if (!section || section.dataset.textLoading || !state.reader) return;
  section.dataset.textLoading = "true";
  const paperId = state.reader.id;
  const layer = $(".pdf-text-layer", section);
  try {
    const result = await api(`/api/papers/${encodeURIComponent(paperId)}/pdf-text/${section.dataset.page}`);
    if (!section.isConnected || state.reader?.id !== paperId) return;
    for (const block of result.blocks) layer.append(readerPdfLineRuns(block));
    readerSizePdfText(section); readerPaintAnnotations();
    if (!result.blocks.length) section.append(el("small", { class: "pdf-layer-status" }, "此页暂无可选文字（扫描页或无法可靠定位），仍可阅读并使用右侧笔记。"));
  } catch (error) {
    if (!section.isConnected || state.reader?.id !== paperId) return;
    section.append(button("文字层加载失败，点击重试", event => {
      delete section.dataset.textLoading; event.currentTarget.remove(); void readerLoadPdfText(section);
    }, "secondary", "", { class: "button secondary pdf-layer-status", "aria-label": `重试文字层：${error.message}` }));
  }
}

function readerPdfLineRuns(block) {
  const glyphs = [...(block.glyphs || [])].sort((a, b) => {
    const ay = (a.box[1] + a.box[3]) / 2, by = (b.box[1] + b.box[3]) / 2;
    return Math.abs(ay - by) > .006 ? ay - by : a.box[0] - b.box[0];
  });
  const lines = [];
  for (const glyph of glyphs) {
    const center = (glyph.box[1] + glyph.box[3]) / 2;
    let line = lines.at(-1);
    if (!line || Math.abs(center - line.center) > .008 || glyph.box[0] < line.lastX - .01) {
      line = { center, glyphs: [], lastX: -Infinity }; lines.push(line);
    }
    line.glyphs.push(glyph); line.lastX = glyph.box[2];
  }
  const base = block.text || "";
  const container = el("div", { class: "pdf-text-block", dataset: { sourceId: block.id } });
  container.pdfBaseText = base;
  for (const line of lines) {
    let text = "", offsets = [], boxes = [], previousEnd = null;
    for (const glyph of line.glyphs) {
      const start = Number(glyph.start), chars = Array.from(glyph.text || "");
      if (previousEnd !== null && start > previousEnd) {
        const gap = Array.from(base).slice(previousEnd, start);
        if (gap.length && gap.every(ch => /\s/.test(ch))) { text += gap.join(""); offsets.push(...gap.map(() => null)); boxes.push(...gap.map(() => null)); }
      }
      chars.forEach((ch, index) => { text += ch; offsets.push(start + index); boxes.push(glyph.box); });
      previousEnd = Number(glyph.start) + chars.length;
    }
    if (!text) return null;
    const first = line.glyphs[0].box, last = line.glyphs.at(-1).box;
    const run = el("span", { class: "pdf-text-run reader-source-text", dataset: { sourceId: block.id, language: "original", start: offsets.find(Number) ?? 0 },
      style: { left: `${first[0] * 100}%`, top: `${Math.min(...line.glyphs.map(g => g.box[1])) * 100}%` } }, text);
    run.pdfBaseText = base; run.pdfOffsets = offsets; run.pdfBoxes = boxes;
    run.pdfBox = [first[0], Math.min(...line.glyphs.map(g => g.box[1])), last[2], Math.max(...line.glyphs.map(g => g.box[3]))];
    container.append(run);
  }
  return container;
}

function readerSizePdfText(root) {
  const measure = document.createElement("canvas").getContext("2d");
  if (!measure) return;
  measure.font = "100px Arial";
  const pages = root.matches?.(".reader-page-section") ? [root] : $$(".reader-page-section", root);
  for (const section of pages) {
    const page = $(".paper-page", section), width = page.clientWidth, height = page.clientHeight;
    for (const span of $$(".pdf-text-run", section)) {
      const [x0, y0, x1, y1] = span.pdfBox, font = Math.max(8, (y1 - y0) * height);
      span.style.fontSize = `${font}px`;
      const natural = measure.measureText(span.textContent).width * font / 100;
      span.style.transform = `scaleX(${natural ? (x1 - x0) * width / natural : 1})`;
    }
  }
  if (typeof readerQueueAnnotationLayout === "function") readerQueueAnnotationLayout();
}

function readerPdfRunBounds(domRange, run) {
  const whole = document.createRange(); whole.selectNodeContents(run);
  if (domRange.compareBoundaryPoints(Range.END_TO_START, whole) >= 0 || domRange.compareBoundaryPoints(Range.START_TO_END, whole) <= 0) return null;
  const part = whole.cloneRange();
  if (run.contains(domRange.startContainer)) part.setStart(domRange.startContainer, domRange.startOffset);
  if (run.contains(domRange.endContainer)) part.setEnd(domRange.endContainer, domRange.endOffset);
  const prefix = whole.cloneRange(); prefix.setEnd(part.startContainer, part.startOffset);
  const suffix = whole.cloneRange(); suffix.setStart(part.endContainer, part.endOffset);
  return { start: Array.from(prefix.toString()).length, end: Array.from(whole.toString()).length - Array.from(suffix.toString()).length };
}

function readerPdfSelectionSnapshot(domRange) {
  const byBlock = new Map();
  for (const run of $$(".pdf-text-run", $("#original-scroll"))) {
    const bounds = readerPdfRunBounds(domRange, run); if (!bounds) continue;
    const selected = run.pdfOffsets.slice(bounds.start, bounds.end).filter(offset => Number.isInteger(offset));
    if (!selected.length) continue;
    const start = Math.min(...selected), end = Math.max(...selected) + 1, id = run.dataset.sourceId;
    // Printed lines share a source paragraph. Submit one continuous source
    // range per paragraph, including normalized spaces and line-end hyphenation.
    const existing = byBlock.get(id);
    if (existing) {
      existing.start = Math.min(existing.start, start);
      existing.end = Math.max(existing.end, end);
    } else byBlock.set(id, { block_id: id, language: "original", start, end, base_text: run.pdfBaseText });
  }
  const ranges = [...byBlock.values()].map(range => ({ ...range,
    quote: Array.from(range.base_text).slice(range.start, range.end).join("") }));
  return ranges.length ? { paperId: state.reader.id, text: ranges.map(r => r.quote).join("\n"), ranges, domRange } : null;
}

function readerPdfAnchorRanges(anchor) {
  if (anchor.language !== "original" || anchor.status === "needs_review") return [];
  const block = $$(".pdf-text-block", $("#original-scroll")).find(n => n.dataset.sourceId === anchor.block_id);
  if (!block || Array.from(block.pdfBaseText).slice(anchor.start, anchor.end).join("") !== anchor.quote) return [];
  return $$(".pdf-text-run", block).map(run => {
    const indexes = run.pdfOffsets.map((offset, index) => Number.isInteger(offset) && offset >= anchor.start && offset < anchor.end ? index : -1).filter(index => index >= 0);
    if (!indexes.length) return null;
    const range = document.createRange(), text = run.firstChild;
    const chars = Array.from(text.textContent);
    range.setStart(text, chars.slice(0, indexes[0]).join("").length);
    range.setEnd(text, chars.slice(0, indexes.at(-1) + 1).join("").length); return range;
  }).filter(Boolean);
}

function readerPdfPointSelection(span, event = null) {
  const block = span?.closest(".pdf-text-block") || span?.parentElement;
  if (!block) return null;
  const run = span.classList.contains("pdf-text-run") ? span : span.closest(".pdf-text-run");
  const offset = event && run?.firstChild ? Math.min(run.pdfOffsets.length - 1, Math.max(0, (document.caretPositionFromPoint?.(event.clientX, event.clientY)?.offset ?? 0))) : 0;
  let sourceOffset = run?.pdfOffsets[offset];
  if (!Number.isInteger(sourceOffset)) sourceOffset = run?.pdfOffsets.find(Number.isInteger) ?? 0;
  const start = sourceOffset, quote = Array.from(run?.pdfBaseText || "")[start] || "";
  return { paperId: state.reader.id, text: quote, ranges: [{ block_id: block.dataset.sourceId, language: "original", start,
    end: start + Array.from(quote).length, quote, base_text: run?.pdfBaseText || "" }] };
}

function readerPdfNoteMarkers() {
  const root = $("#original-scroll"); if (!root) return;
  $$(".pdf-note-marker", root).forEach(n => n.remove());
  const seen = new Set();
  for (const { range, item } of readerTextUI.painted) {
    if (item.kind !== "note" || seen.has(item.id)) continue;
    const container = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer : range.startContainer.parentElement;
    const glyph = container?.closest(".pdf-text-run");
    if (!glyph) continue;
    seen.add(item.id);
    const [x0, y0] = glyph.pdfBox;
    $(".paper-page", glyph.closest(".reader-page-section")).append(el("button", {
      class: "pdf-note-marker", type: "button", "aria-label": item.note_title || "查看定位笔记",
      style: { left: `${x0 * 100}%`, top: `${y0 * 100}%` },
      onpointerdown: e => e.preventDefault(), onclick: e => { e.stopPropagation(); readerShowAnnotation(item, e.clientX, e.clientY); }
    }, icon("edit")));
  }
}
