"use strict";

// Selection is never represented by a selected paragraph. Persisted anchors use
// Unicode code points and source block IDs; native DOM Ranges stay transient.
const readerTextUI = { popup: null, editor: null, noteView: null, selection: null, request: null, clientId: null, bound: false, annotations: [], painted: [],
  selecting: false, placement: false, selectionTimer: 0, menuKey: "", railFrame: 0, layoutObserver: null };
function readerTextRoot() { return $("#translation-scroll") || $("#original-scroll"); }
function readerOriginalText(block) { return Object.hasOwn(block, "text_override") ? block.text_override : asText(block.text); }
function readerTextLanguage(block) { return readerRuntime.textLanguage === "original" ? "original" : block.translation || block.translation_manually_edited ? "translation" : "original"; }
function readerTextValue(block, language = readerTextLanguage(block)) { return language === "original" ? readerOriginalText(block) : asText(block.translation); }
function readerTextSpan(block, attrs = {}) {
  const language = readerTextLanguage(block);
  return el("span", { ...attrs, class: `reader-source-text ${block.highlight ? "legacy-highlighted" : ""} ${attrs.class || ""}`,
    dataset: { sourceId: block.id, page: block.page, language } }, readerTextValue(block, language));
}
function readerHasTextSelection() {
  const selection = window.getSelection?.(), root = readerTextRoot();
  return Boolean(selection && !selection.isCollapsed && selection.rangeCount && root &&
    root.contains(selection.getRangeAt(0).startContainer) && root.contains(selection.getRangeAt(0).endContainer));
}
function readerTextProtected() { return Boolean(readerTextUI.popup || readerTextUI.editor || readerHasTextSelection()); }
function readerSelectionSnapshot() {
  const selection = window.getSelection();
  if (!readerHasTextSelection()) return null;
  const domRange = selection.getRangeAt(0).cloneRange(), ranges = [];
  if (readerTextRoot()?.id === "original-scroll") return readerPdfSelectionSnapshot(domRange);
  for (const span of $$(".translated-text .reader-source-text", readerTextRoot())) {
    if (!domRange.intersectsNode(span) || !span.textContent) continue;
    const whole = document.createRange(); whole.selectNodeContents(span);
    if (domRange.compareBoundaryPoints(Range.END_TO_START, whole) >= 0 || domRange.compareBoundaryPoints(Range.START_TO_END, whole) <= 0) continue;
    const part = whole.cloneRange();
    if (span.contains(domRange.startContainer)) part.setStart(domRange.startContainer, domRange.startOffset);
    if (span.contains(domRange.endContainer)) part.setEnd(domRange.endContainer, domRange.endOffset);
    const prefix = whole.cloneRange(); prefix.setEnd(part.startContainer, part.startOffset);
    const start = Array.from(prefix.toString()).length, quote = part.toString();
    if (!quote) continue;
    ranges.push({ block_id: span.dataset.sourceId, language: span.dataset.language,
      start, end: start + Array.from(quote).length, quote, base_text: span.textContent });
  }
  return ranges.length ? { paperId: state.reader.id, text: selection.toString(), ranges, domRange } : null;
}
function readerAnchorRange(anchor) {
  const span = $$(".reader-source-text", readerTextRoot()).find(n => n.dataset.sourceId === anchor.block_id && n.dataset.language === anchor.language);
  if (!span || anchor.status === "needs_review") return null;
  const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT), points = [];
  let node, count = 0;
  while ((node = walker.nextNode())) { const length = Array.from(node.data).length; points.push({ node, start: count, end: count + length }); count += length; }
  const locate = offset => {
    const point = points.find(p => offset >= p.start && offset <= p.end);
    return point ? [point.node, Array.from(point.node.data).slice(0, offset - point.start).join("").length] : null;
  };
  const start = locate(anchor.start), end = locate(anchor.end);
  if (!start || !end) return null;
  const range = document.createRange(); range.setStart(...start); range.setEnd(...end); return range;
}
function readerCloseTextPopup(force = false) {
  if (readerTextUI.editor && !force) return;
  readerCancelTranslation();
  const popup = readerTextUI.popup;
  if (popup) { popup.readerDragCleanup?.(); try { popup.hidePopover(); } catch {} popup.remove(); }
  readerTextUI.popup = null;
}
function readerTextPopover(node, x, y) {
  readerCloseTextPopup(true);
  node.setAttribute("popover", "manual"); $("#reader-dialog").append(node); readerTextUI.popup = node;
  if (typeof node.showPopover === "function") node.showPopover();
  const rect = node.getBoundingClientRect(), width = document.documentElement.clientWidth, height = window.innerHeight;
  const left = Math.max(8, Math.min(x, width - rect.width - 8));
  let top = Math.max(8, Math.min(y, height - rect.height - 8));
  if (node.classList.contains("reader-text-menu")) {
    for (const notice of $$("#toasts .toast")) {
      const box = notice.getBoundingClientRect(), above = box.top - rect.height - 8;
      if (left < box.right && left + rect.width > box.left && top < box.bottom && top + rect.height > box.top && above >= 8)
        top = Math.min(top, above);
    }
  }
  node.style.left = `${left}px`;
  node.style.top = `${top}px`;
  return node;
}
function readerEnablePopupDrag(node, onMove = null) {
  const handle = $(":scope > strong", node);
  if (!handle) return;
  handle.classList.add("reader-popup-drag-handle");
  handle.setAttribute("role", "button"); handle.tabIndex = 0;
  handle.setAttribute("aria-label", "移动批注框");
  handle.title = "按住标题拖动，或聚焦后用方向键移动";
  let drag = null;
  const move = (x, y) => {
    const rect = node.getBoundingClientRect();
    const left = Math.max(8, Math.min(x, document.documentElement.clientWidth - rect.width - 8));
    const top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));
    node.style.left = `${left}px`; node.style.top = `${top}px`;
    onMove?.({ x: left, y: top });
  };
  const finish = event => {
    if (!drag || event.pointerId !== drag.id) return;
    drag = null; handle.classList.remove("dragging");
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
  };
  handle.addEventListener("pointerdown", event => {
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    const rect = node.getBoundingClientRect();
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
    handle.setPointerCapture(event.pointerId); handle.classList.add("dragging");
  });
  handle.addEventListener("pointermove", event => {
    if (drag && event.pointerId === drag.id) move(drag.left + event.clientX - drag.x, drag.top + event.clientY - drag.y);
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) handle.addEventListener(type, finish);
  handle.addEventListener("keydown", event => {
    const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!direction) return;
    event.preventDefault();
    const rect = node.getBoundingClientRect(), step = event.shiftKey ? 40 : 10;
    move(rect.left + direction[0] * step, rect.top + direction[1] * step);
  });
  const fit = () => { const rect = node.getBoundingClientRect(); move(rect.left, rect.top); };
  window.addEventListener("resize", fit);
  node.readerDragCleanup = () => {
    window.removeEventListener("resize", fit);
    if (drag) finish({ pointerId: drag.id });
  };
  fit();
}
function readerTextPayload(selection) { return { ranges: selection.ranges, selected_text: selection.text }; }
function readerTextRequestId() { return crypto.randomUUID(); }
function readerBlockSelection(span) {
  const block = state.reader.blocks.find(item => item.id === span?.dataset.sourceId), text = span?.textContent || "";
  if (!block || !text) return null;
  const language = span.dataset.language || readerTextLanguage(block);
  return { paperId: state.reader.id, text, ranges: [{ block_id: block.id, language, start: 0, end: Array.from(text).length, quote: text, base_text: text }] };
}
function readerPointSelection(event, span) {
  if (span?.classList.contains("pdf-text-run")) return readerPdfPointSelection(span, event);
  const block = state.reader.blocks.find(item => item.id === span?.dataset.sourceId), text = span?.textContent || "";
  if (!block || !text) return null;
  const caret = document.caretPositionFromPoint?.(event.clientX, event.clientY);
  const legacy = !caret && document.caretRangeFromPoint?.(event.clientX, event.clientY);
  const node = caret?.offsetNode || legacy?.startContainer, offset = caret?.offset ?? legacy?.startOffset;
  if (!node || !span.contains(node)) return readerBlockSelection(span);
  const prefix = document.createRange(); prefix.selectNodeContents(span); prefix.setEnd(node, offset);
  const start = Math.min(Array.from(text).length - 1, Array.from(prefix.toString()).length);
  const quote = Array.from(text)[start];
  return { paperId: state.reader.id, text: quote, ranges: [{ block_id: block.id, language: span.dataset.language || readerTextLanguage(block), start, end: start + 1, quote, base_text: text }] };
}
function readerSetTextLanguage(language) {
  if (readerTextUI.editor || readerRuntime.editor) { toast("请先保存或取消当前编辑", "warn"); return; }
  readerCloseTextPopup(true); window.getSelection().removeAllRanges();
  readerRuntime.textLanguage = language; readerWriteLocal("language", state.reader.id, { value: language });
  readerRuntime.structureSignature = ""; renderTranslations();
  $$('[data-text-language]').forEach(n => n.setAttribute("aria-pressed", String(n.dataset.textLanguage === language)));
  $("#reader-text-pane-label").replaceChildren(icon("translate"), language === "original" ? "英文原文" : "译文与原文");
}
async function readerApplyTextAction(action, data = {}, requestId = readerTextRequestId()) {
  const pid = state.reader.id;
  const result = await api(`/api/papers/${encodeURIComponent(pid)}/text-actions`, { method: "POST", body: { action, ...data, request_id: requestId } });
  if (state.reader?.id === pid && result.paper) { updatePaper(normalizeDetail(result)); renderTranslations(); readerPaintAnnotations(); }
  return result;
}
async function readerCopyText(selection) {
  try { await navigator.clipboard.writeText(selection.text); }
  catch {
    const native = window.getSelection(); native.removeAllRanges(); native.addRange(selection.domRange.cloneRange());
    if (!document.execCommand("copy")) throw Error("复制未完成，请使用 Ctrl+C。");
  }
  readerCloseTextPopup(); toast("已复制");
}
function readerSelectionMenu(event) {
  if (readerRuntime.interactionMode === "read" || readerTextUI.editor) return;
  if (event.target.closest("input,textarea,.block-editor,.reader-text-editor")) return;
  const selection = readerSelectionSnapshot();
  if (!selection) return;
  event.preventDefault(); event.stopPropagation();
  readerShowSelectionMenu(selection, event.clientX, event.clientY);
}
function readerShowSelectionMenu(selection, x, y) {
  if (readerRuntime.interactionMode === "read") return;
  clearTimeout(readerTextUI.selectionTimer);
  readerTextUI.menuKey = readerTranslationKey(selection);
  readerTextUI.selection = selection;
  const item = (label, action, disabled = false) => button(label, e => act(action, e.currentTarget), "reader-text-menu-item", "", { role: "menuitem", disabled });
  const menu = el("div", { class: "reader-text-menu", role: "menu", "aria-label": "所选文字操作", onmousedown: e => e.preventDefault(),
    onkeydown: e => {
      const items = $$("button:not(:disabled)", menu), index = items.indexOf(document.activeElement);
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); readerCloseTextPopup(); }
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) { e.preventDefault(); items[e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : (index + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus(); }
    } },
    item("复制", () => readerCopyText(selection)),
    el("div", { class: "reader-text-highlight-row", role: "group", "aria-label": "高亮" },
      el("span", { class: "reader-text-menu-label" }, "高亮"),
      el("div", { class: "reader-text-highlight-colors" }, [["黄色高亮", "yellow"], ["红色高亮", "red"]].map(([label, color]) =>
        el("button", { type: "button", class: "reader-text-color", role: "menuitem", "aria-label": label,
          onclick: e => act(async () => {
            await readerApplyTextAction("highlight", { ...readerTextPayload(selection), color }); readerCloseTextPopup(); readerPaintAnnotations();
          }, e.currentTarget) }, el("span", { class: `reader-text-color-dot ${color}`, "aria-hidden": "true" }))))),
    item("添加定位笔记", () => readerOpenTextEditor("note", selection)),
    // Translation actions are disabled; keep native selection, highlights and notes.
    );
  readerTextPopover(menu, x, y);
}
function readerQueueSelectionMenu() {
  clearTimeout(readerTextUI.selectionTimer);
  if (readerRuntime.interactionMode === "read") return;
  readerTextUI.selectionTimer = setTimeout(() => {
    if (readerRuntime.interactionMode === "read" || readerTextUI.selecting || readerTextUI.editor || readerRuntime.editor ||
        document.activeElement?.closest("input,textarea,.block-editor,.reader-text-editor")) return;
    const selection = readerSelectionSnapshot();
    if (!selection || readerTranslationKey(selection) === readerTextUI.menuKey ||
        readerTextUI.popup && !readerTextUI.popup.classList.contains("reader-text-menu")) return;
    const rects = [...selection.domRange.getClientRects()].filter(r => r.width && r.height);
    const rect = rects.at(-1);
    if (rect) readerShowSelectionMenu(selection, rect.left, rect.bottom + 8);
  }, 100);
}
function readerTextDraftKey(editor) {
  return editor.kind === "comment" ? `comment-${editor.annotation.id}` : "text-action";
}
function readerCommentDraft(item) {
  const draft = readerReadLocal(`comment-${item.id}`, state.reader.id);
  if (draft) return draft;
  const old = readerReadLocal("text-action", state.reader.id);
  return old?.annotation?.id === item.id && old.annotation.kind === "highlight" ? old : null;
}
function readerDiscardTextDraft(editor) {
  readerRemoveLocal(readerTextDraftKey(editor), editor.paperId);
  if (editor.kind === "comment" && readerReadLocal("text-action", editor.paperId)?.annotation?.id === editor.annotation.id)
    readerRemoveLocal("text-action", editor.paperId);
}
function readerTextDraft(editor = readerTextUI.editor) {
  if (!editor) return true;
  const value = editor.kind === "note" ? readerNotePlainText(editor.content) : editor.input.value;
  const content = editor.kind === "note" ? readerCollectNoteContent(editor.content) : editor.kind === "comment" ? editor.commentImages : null;
  if (editor.kind === "note" && value === editor.originalValue && (editor.input?.value || "") === editor.originalTitle && JSON.stringify(content) === JSON.stringify(editor.originalContent || [])) {
    readerRemoveLocal("text-action", editor.paperId); return true;
  }
  return readerWriteLocal(readerTextDraftKey(editor), editor.paperId, { kind: editor.kind, selection: { paperId: editor.selection.paperId, text: editor.selection.text, ranges: editor.selection.ranges },
    annotation: editor.annotation, value, note_title: editor.kind === "note" ? editor.input?.value || "" : "", note_content: content, requestId: editor.requestId, originalValue: editor.originalValue });
}
function readerNotePlainText(root) { return root ? root.innerText.replace(/\u00a0/g, " ").trim() : ""; }
function readerCollectNoteContent(root) {
  const result = [];
  const text = value => {
    if (!value) return;
    const last = result.at(-1);
    if (last?.type === "text") last.text += value; else result.push({ type: "text", text: value });
  };
  const visit = node => {
    for (const child of node.childNodes || []) {
      if (child.nodeType === Node.TEXT_NODE) text(child.data);
      else if (child.nodeType === Node.ELEMENT_NODE && child.tagName === "IMG" && child.src.startsWith(location.origin)) {
        result.push({ type: "image", src: new URL(child.getAttribute("src"), location.href).pathname, alt: child.alt || "" });
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        if (child.tagName === "BR") text("\n");
        visit(child);
        if (["DIV", "P", "LI"].includes(child.tagName)) text("\n");
      }
    }
  };
  visit(root); return result.map(item => item.type === "text" ? { ...item, text: item.text.replace(/\n{3,}/g, "\n\n") } : item).filter(item => item.type === "image" || item.text);
}
function readerRenderNoteContent(root, content, fallback = "") {
  root.replaceChildren();
  const items = Array.isArray(content) && content.length ? content : [{ type: "text", text: fallback }];
  for (const item of items) {
    if (item.type === "image" && typeof item.src === "string") root.append(el("img", { src: safeUrl(item.src), alt: item.alt || "笔记图片", loading: "lazy" }));
    else if (item.type === "text") root.append(document.createTextNode(item.text || ""));
  }
}
async function readerUploadNoteImage(file) {
  if (!file?.type?.startsWith("image/")) throw Error("请选择图片文件。");
  const form = new FormData(); form.append("file", file, file.name || "pasted-image.png");
  const result = await api(`/api/papers/${encodeURIComponent(state.reader.id)}/note-media`, { method: "POST", body: form });
  return result.url;
}
function readerInsertNoteImage(root, url) {
  const selection = window.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  const image = el("img", { src: safeUrl(url), alt: "笔记图片", loading: "lazy" });
  if (!range || !root.contains(range.commonAncestorContainer)) { root.append(el("br"), image); return; }
  range.deleteContents(); range.insertNode(image); range.setStartAfter(image); range.collapse(true); selection.removeAllRanges(); selection.addRange(range);
}
function renderReaderNoteEditor() {
  const editor = readerTextUI.editor, pane = $("#reader-notes");
  if (!editor || !pane) return;
  if (editor.form?.isConnected) return;
  const content = editor.content || el("div", { class: "reader-rich-note", contenteditable: "true", role: "textbox", "aria-label": "定位笔记内容" });
  editor.content = content;
  readerRenderNoteContent(content, editor.initialContent, editor.initialValue);
  const input = editor.input || el("input", { class: "reader-note-title", type: "text", value: editor.initialTitle, placeholder: "笔记标题（可选）", "aria-label": "笔记标题" });
  editor.input = input;
  const hint = editor.hint || el("p", { class: "reader-text-save-hint", role: "status" }, "支持直接粘贴图片"); editor.hint = hint;
  const form = el("div", { class: "reader-note-editor", "aria-label": "正文定位笔记" },
    el("div", { class: "section-heading" }, el("h3", {}, editor.annotation ? "编辑定位笔记" : "新建定位笔记"), iconButton("close", "关闭笔记编辑", () => { readerTextDraft(); readerTextUI.editor = null; readerRuntime.noteEditor = null; renderReaderNotesPane(); })),
    el("blockquote", { class: "reader-text-quote" }, editor.selection.text || "当前段落"), input, content,
    el("div", { class: "reader-note-toolbar" }, button("插入图片", () => editor.file.click(), "secondary", "image"), el("input", { type: "file", accept: "image/png,image/jpeg,image/gif,image/webp", hidden: true, onchange: e => act(async () => { const url = await readerUploadNoteImage(e.target.files[0]); readerInsertNoteImage(content, url); editor.requestId = readerTextRequestId(); readerTextDraft(editor); hint.textContent = "图片已插入，点击保存定位笔记"; }, e.currentTarget) })),
    hint, el("div", { class: "reader-text-card-actions" },
      editor.annotation ? button("删除", event => act(async () => {
        if (!confirm("删除这条定位笔记？")) return;
        await readerApplyTextAction("delete_annotation", { annotation_id: editor.annotation.id, modified_at: editor.annotation.modified_at, revision: editor.annotation.revision });
        readerRemoveLocal("text-action", editor.paperId); readerTextUI.editor = null; readerRuntime.noteEditor = null; renderReaderNotesPane(); readerPaintAnnotations();
      }, event.currentTarget), "danger", "trash") : null,
      button("取消", () => { readerRemoveLocal("text-action", editor.paperId); readerFinishNoteEditing(editor); }), button("保存定位笔记", () => act(readerFlushTextEditor, null), "primary", "check")));
  editor.form = form; editor.file = $("input[type=file]", form);
  content.addEventListener("input", () => { editor.requestId = readerTextRequestId(); readerTextDraft(editor); hint.textContent = "草稿已保存在本机，正在等待同步…"; });
  content.addEventListener("paste", event => {
    const file = [...(event.clipboardData?.items || [])].find(item => item.type.startsWith("image/"))?.getAsFile();
    if (!file) return;
    event.preventDefault(); act(async () => { hint.textContent = "正在上传图片…"; const url = await readerUploadNoteImage(file); readerInsertNoteImage(content, url); editor.requestId = readerTextRequestId(); readerTextDraft(editor); hint.textContent = "图片已插入，点击保存定位笔记"; }, null);
  });
  input.addEventListener("input", () => { editor.requestId = readerTextRequestId(); readerTextDraft(editor); });
  pane.replaceChildren(form);
  content.focus({ preventScroll: true });
}
function readerOpenNoteEditor(selection, annotation = null, restored = null) {
  readerCloseTextPopup(true);
  const initialContent = restored?.note_content || annotation?.note_content || (annotation?.note ? [{ type: "text", text: annotation.note }] : []);
  const editor = { kind: "note", selection, annotation, paperId: state.reader.id, requestId: restored?.requestId || readerTextRequestId(),
    initialContent, initialValue: restored?.value ?? (annotation?.note || ""), initialTitle: restored?.note_title ?? (annotation?.note_title || ""),
    originalValue: annotation?.note || "", originalTitle: annotation?.note_title || "",
    originalContent: annotation?.note_content?.length ? annotation.note_content : (annotation?.note ? [{ type: "text", text: annotation.note }] : []), saving: null };
  readerTextUI.noteView = null;
  readerTextUI.editor = editor; readerRuntime.noteEditor = editor;
  toggleReaderNotes(true); readerTextDraft(editor);
}
function readerFinishNoteEditing(editor) {
  readerTextUI.editor = null; readerRuntime.noteEditor = null;
  if (editor.annotation) readerShowNote(editor.annotation);
  else renderReaderNotesPane();
}
function readerShowNote(annotation) {
  readerCloseTextPopup(true);
  readerTextUI.noteView = annotation;
  toggleReaderNotes(true);
}
function renderReaderNoteView() {
  const item = readerTextUI.noteView, pane = $("#reader-notes");
  const content = el("div", { class: "reader-note-view-content" });
  readerRenderNoteContent(content, item.note_content, item.note || "");
  const draft = readerReadLocal("text-action", state.reader.id);
  const restored = draft?.kind === "note" && draft.annotation?.id === item.id ? draft : null;
  pane.replaceChildren(el("section", { class: "reader-note-view", "aria-label": "定位笔记" },
    el("div", { class: "section-heading" }, el("h3", {}, item.note_title || "定位笔记"),
      button(restored ? "继续编辑草稿" : "编辑", () => readerOpenNoteEditor({ paperId: state.reader.id, text: item.quote, ranges: item.ranges || [] }, item, restored), "secondary"),
      iconButton("close", "收起笔记", () => { readerTextUI.noteView = null; toggleReaderNotes(false); })),
    item.quote ? el("blockquote", { class: "reader-text-quote" }, item.quote) : null, content));
}
function renderReaderNotesPane() {
  const pane = $("#reader-notes"), entry = readerRuntime.notes;
  if (!pane || !entry) return;
  if (readerTextUI.editor?.kind === "note") { renderReaderNoteEditor(); return; }
  if (readerTextUI.noteView) { renderReaderNoteView(); return; }
  const textarea = el("textarea", { class: "notes-area", value: entry.value, placeholder: "论文笔记", "aria-label": "论文笔记", id: "reader-notes-text" });
  textarea.addEventListener("input", () => {
    entry.value = textarea.value; entry.storageOk = readerWriteLocal("notes", entry.id, { value: entry.value });
    readerNotesHint(entry.storageOk ? "草稿已保存在本机，正在等待同步…" : "草稿暂未保存，请保持窗口打开");
    clearTimeout(entry.timer); entry.timer = setTimeout(() => { readerSaveNotes().catch(() => {}); }, 650);
  });
  textarea.addEventListener("blur", () => { readerSaveNotes().catch(() => {}); });
  pane.replaceChildren(el("div", { class: "section-heading" }, el("h3", {}, "论文笔记"), iconButton("close", "收起笔记", () => toggleReaderNotes(false))), textarea,
    el("div", { class: "save-hint", id: "reader-notes-hint", role: "status" }, entry.value !== entry.savedValue ? "已恢复本机草稿" : ""),
    button("立即保存", event => act(readerSaveNotes, event.currentTarget), "secondary", "check"));
}
function readerOpenTextEditor(kind, selection, annotation = null, restored = null) {
  if (kind === "note" && annotation?.kind === "highlight" && !annotation.legacy) kind = "comment";
  if (kind === "note") { readerOpenNoteEditor(selection, annotation, restored); return; }
  const initial = restored?.value ?? (kind === "revise" ? selection.text : annotation?.note || "");
  const input = el("textarea", { rows: kind === "revise" ? "6" : "4", value: initial, "aria-label": kind === "revise" ? "修订选中的文字" : "所选文字批注" });
  const hint = el("p", { class: "reader-text-save-hint", role: "status" }, "草稿保存在本机");
  const editor = { kind, selection, annotation, paperId: state.reader.id, input, requestId: restored?.requestId || readerTextRequestId(),
    originalValue: restored?.originalValue ?? initial,
    commentImages: (restored?.note_content || annotation?.note_content || []).filter(part => part.type === "image"), saving: null };
  const form = el("form", { class: "reader-text-card reader-text-editor", "aria-label": kind === "revise" ? "修订所选文字" : "添加批注" },
    el("strong", {}, kind === "revise" ? "修订所选文字" : "批注"),
    annotation?.kind === "highlight" ? null : el("blockquote", { class: "reader-text-quote" }, selection.text), input, hint,
    el("div", { class: "reader-text-card-actions" }, button("取消", () => {
      readerDiscardTextDraft(editor); readerTextUI.editor = null; readerCloseTextPopup(true);
      if (kind === "comment") readerShowAnnotation(annotation, editor.position.x, editor.position.y);
    }),
      el("button", { type: "submit", class: "button primary" }, "保存")));
  input.addEventListener("input", () => { editor.requestId = readerTextRequestId(); readerTextDraft(editor); });
  form.addEventListener("submit", e => { e.preventDefault(); act(() => readerFlushTextEditor(), $("button[type=submit]", form)); });
  const rect = readerTextRoot().getBoundingClientRect();
  const popupRect = readerTextUI.popup?.getBoundingClientRect();
  editor.position = kind === "comment" ? (popupRect ? { x: popupRect.left, y: popupRect.top } : readerAnnotationPosition(annotation)) : { x: rect.left + 24, y: rect.top + 28 };
  readerTextPopover(form, editor.position.x, editor.position.y); readerTextUI.editor = editor; editor.hint = hint;
  if (kind === "comment") readerEnablePopupDrag(form, position => { editor.position = position; });
  readerTextDraft(editor); input.focus();
}
async function readerFlushTextEditor() {
  const editor = readerTextUI.editor;
  if (!editor) return;
  if (editor.saving) return editor.saving;
  const value = editor.kind === "note" ? readerNotePlainText(editor.content) : editor.input.value;
  const content = editor.kind === "note" ? readerCollectNoteContent(editor.content) : null;
  const unchanged = editor.kind === "note" ? value === editor.originalValue && (editor.input?.value || "") === editor.originalTitle && JSON.stringify(content) === JSON.stringify(editor.originalContent || []) : value === editor.originalValue;
  if (unchanged) {
    readerDiscardTextDraft(editor);
    if (editor.kind === "note") readerFinishNoteEditing(editor);
    else {
      readerTextUI.editor = null; readerCloseTextPopup(true);
      if (editor.kind === "comment") readerShowAnnotation(editor.annotation, editor.position.x, editor.position.y);
    }
    return;
  }
  readerTextDraft(editor);
  editor.saving = (async () => {
    try {
      if (editor.kind === "note" && !value.trim() && !content.length) throw Error("请先填写笔记或插入图片。");
      const body = { ...readerTextPayload(editor.selection), ...(editor.kind === "revise" ? { replacement: value } : { note: value, note_title: editor.input?.value || "", note_content: content }) };
      if (editor.kind === "comment") {
        body.note_title = editor.annotation.note_title || "";
        // Preserve images from comments created in the former shared note editor.
        body.note_content = [{ type: "text", text: value }, ...editor.commentImages];
      }
      const action = editor.annotation ? "edit_annotation" : editor.kind;
      if (editor.annotation) Object.assign(body, { annotation_id: editor.annotation.id, modified_at: editor.annotation.modified_at, previous_note: editor.annotation.note, previous_note_title: editor.annotation.note_title || "", previous_note_content: editor.annotation.note_content || [], revision: editor.annotation.revision });
      if (editor.annotation?.legacy) {
        await readerApplyTextAction("edit_legacy_note", { block_id: editor.annotation.block_id, note: value, previous_note: editor.annotation.note || "" }, editor.requestId);
      } else await readerApplyTextAction(action, body, editor.requestId);
      if (readerTextUI.editor !== editor) return;
      const currentValue = editor.kind === "note" ? readerNotePlainText(editor.content) : editor.input.value;
      if (editor.kind === "note") {
        editor.annotation = editor.annotation
          ? (state.reader.text_annotations || []).find(item => item.id === editor.annotation.id)
          : [...(state.reader.text_annotations || [])].reverse().find(item => item.kind === "note" && item.quote === editor.selection.text);
        editor.originalValue = value; editor.originalTitle = body.note_title; editor.originalContent = content;
        if (currentValue !== value || editor.input.value !== body.note_title || JSON.stringify(readerCollectNoteContent(editor.content)) !== JSON.stringify(content)) {
          editor.requestId = readerTextRequestId(); readerTextDraft(editor); return;
        }
        readerRemoveLocal("text-action", editor.paperId); readerPaintAnnotations();
        readerFinishNoteEditing(editor);
      } else {
        if (editor.kind === "comment" && !editor.annotation.legacy) {
          editor.annotation = state.reader.text_annotations.find(item => item.id === editor.annotation.id) || editor.annotation;
          editor.originalValue = value;
        }
        if (currentValue !== value) { editor.requestId = readerTextRequestId(); readerTextDraft(editor); return; }
        readerDiscardTextDraft(editor); readerTextUI.editor = null; readerCloseTextPopup(true);
        window.getSelection().removeAllRanges(); renderTranslations(); readerPaintAnnotations();
        if (editor.kind === "comment") {
          const item = state.reader.text_annotations.find(item => item.id === editor.annotation.id);
          if (item) readerShowAnnotation(item, editor.position.x, editor.position.y);
        }
        toast(editor.kind === "revise" ? "修订已保存" : "批注已保存");
      }
    } catch (error) { readerTextDraft(editor); editor.hint.textContent = error.message; throw error; }
    finally { editor.saving = null; }
  })();
  return editor.saving;
}
function readerCancelTranslation() {
  const request = readerTextUI.request;
  readerTextUI.request = null;
  if (!request) return;
  clearTimeout(request.progressTimer);
  clearInterval(request.elapsedTimer);
  request.completed = true;
  request.controller.abort();
  // Closing fetch alone does not interrupt the backend model turn.
  void api(`/api/papers/${encodeURIComponent(request.paperId)}/text-actions`, {
    method: "POST", keepalive: true, body: { action: "cancel_translation",
      client_id: request.clientId, request_id: request.id }
  }).catch(() => {});
}
function readerTranslationKey(selection) { return JSON.stringify([selection.paperId, selection.ranges]); }
function readerTranslationErrorMessage(error) {
  const text = error.message || "翻译请求失败。";
  return /Failed to fetch|NetworkError|Network request failed/i.test(text)
    ? "无法连接本机翻译服务，请检查 PaperNest 后台是否运行。" : text;
}
function readerFitTranslationPopup(popup) {
  const box = popup.getBoundingClientRect();
  popup.style.left = `${Math.max(8, Math.min(box.left, document.documentElement.clientWidth - box.width - 8))}px`;
  popup.style.top = `${Math.max(8, Math.min(box.top, window.innerHeight - box.height - 8))}px`;
}
async function readerTranslationProgress(request, popup, repeat = true) {
  if (request.controller.signal.aborted || readerTextUI.request !== request || !popup.isConnected) return;
  try {
    const query = new URLSearchParams({ client_id: request.clientId, request_id: request.id });
    const result = await api(`/api/papers/${encodeURIComponent(request.paperId)}/selection-progress?${query}`, {
      signal: request.controller.signal
    });
    if (request.controller.signal.aborted || readerTextUI.request !== request || !popup.isConnected) return;
    const events = result.events || [];
    $(".reader-translation-current-status", popup).textContent = events.at(-1)?.text || "等待通道状态…";
    if (!request.completed) {
      if (result.output) $(".reader-selected-translation-result", popup).textContent = result.output;
    }
    readerFitTranslationPopup(popup);
  } catch (error) {
    if (!request.controller.signal.aborted && readerTextUI.request === request && popup.isConnected)
      $(".reader-translation-current-status", popup).textContent = `进度连接：${readerTranslationErrorMessage(error)}`;
  } finally {
    if (repeat && !request.completed && !request.controller.signal.aborted && readerTextUI.request === request && popup.isConnected)
      request.progressTimer = setTimeout(() => { void readerTranslationProgress(request, popup); }, 500);
  }
}
async function readerTranslateRange(selection = readerSelectionSnapshot(), kind = "sentence") {
  if (!selection || readerTextUI.editor) return;
  if (!["word", "sentence"].includes(kind)) return;
  if (Array.from(selection.text).length > 1200) { toast("一次最多选择 1200 个字符", "warn"); return; }
  const cancelButton = kind === "sentence" ? button("取消翻译", () => {
    if (readerTextUI.request !== request || request.completed) return;
    readerCancelTranslation();
    $(".reader-selected-translation-result", popup).textContent = "已取消本次翻译。";
    $(".reader-translation-current-status", popup).textContent = "翻译对话保留，下次继续使用。";
    $(".reader-translation-progress-hint", popup).textContent = `调用进度 · 用时 ${((Date.now() - request.started) / 1000).toFixed(1)} 秒`;
    cancelButton.remove(); readerFitTranslationPopup(popup);
  }) : null;
  const popup = el("div", { class: "reader-text-card reader-selected-translation", role: "status" },
    el("strong", {}, kind === "word" ? "翻译单词 · 离线词典" : "翻译句子"), el("blockquote", { class: "reader-text-quote" }, selection.text),
    el("p", { class: "reader-selected-translation-result" }, kind === "word" ? "正在查词…" : "正在提交翻译请求…"),
    kind === "sentence" ? el("div", { class: "reader-translation-progress" },
      el("p", { class: "reader-translation-progress-hint" }, "调用进度 · 已等待 0 秒"),
      el("p", { class: "reader-translation-current-status", "aria-label": "最新模型状态" }, "等待通道状态…"),
      el("div", { class: "reader-text-card-actions" }, cancelButton)) : null);
  const rect = selection.domRange?.getBoundingClientRect?.() || readerTextRoot().getBoundingClientRect();
  readerTextPopover(popup, rect.left, rect.bottom + 8);
  readerTextUI.clientId ||= readerTextRequestId();
  const request = { id: readerTextRequestId(), clientId: readerTextUI.clientId, paperId: selection.paperId,
    key: readerTranslationKey(selection), controller: new AbortController(), completed: false, started: Date.now() };
  readerTextUI.request = request;
  if (kind === "sentence") {
    request.elapsedTimer = setInterval(() => {
      if (popup.isConnected && !request.completed)
        $(".reader-translation-progress-hint", popup).textContent = `调用进度 · 已等待 ${Math.floor((Date.now() - request.started) / 1000)} 秒`;
    }, 1000);
    request.progressTimer = setTimeout(() => { void readerTranslationProgress(request, popup); }, 150);
  }
  try {
    const result = await api(`/api/papers/${encodeURIComponent(selection.paperId)}/text-actions`, {
      method: "POST", signal: request.controller.signal, body: { action: kind === "word" ? "translate_word" : "translate_sentence",
        ...readerTextPayload(selection), client_id: request.clientId, request_id: request.id }
    });
    request.completed = true;
    if (readerTextUI.request === request && popup.isConnected && state.reader?.id === request.paperId)
      $(".reader-selected-translation-result", popup).textContent = result.translation;
  } catch (error) {
    request.completed = true;
    if (!request.controller.signal.aborted && readerTextUI.request === request && popup.isConnected)
      $(".reader-selected-translation-result", popup).textContent = readerTranslationErrorMessage(error);
  } finally {
    clearTimeout(request.progressTimer); clearInterval(request.elapsedTimer);
    cancelButton?.remove();
    if (kind === "sentence" && readerTextUI.request === request && popup.isConnected) {
      $(".reader-translation-progress-hint", popup).textContent = `调用进度 · 用时 ${((Date.now() - request.started) / 1000).toFixed(1)} 秒`;
      await readerTranslationProgress(request, popup, false);
    }
    if (popup.isConnected) readerFitTranslationPopup(popup);
    if (readerTextUI.request === request) readerTextUI.request = null;
  }
}
function readerAnnotationPosition(item) {
  const root = readerTextRoot().getBoundingClientRect();
  const rects = readerTextUI.painted.filter(p => p.item.id === item.id).flatMap(p => [...p.range.getClientRects()]);
  const rect = rects.filter(r => r.width && r.height && r.bottom > root.top && r.top < root.bottom).at(-1);
  return rect ? { x: rect.left, y: rect.bottom + 8 } : { x: root.left + 24, y: root.top + 28 };
}
function readerShowAnnotation(item, x, y) {
  if (readerTextUI.editor) return;
  if (!item.legacy && item.kind === "note") {
    readerShowNote(item); return;
  }
  const position = readerAnnotationPosition(item);
  x ??= position.x; y ??= position.y;
  const draft = item.kind === "highlight" && !item.legacy ? readerCommentDraft(item) : null;
  const content = el("div", { class: "reader-annotation-note" });
  readerRenderNoteContent(content, item.note_content, item.note || "");
  const card = el("div", { class: "reader-text-card", "aria-label": "文字标记" },
    el("strong", {}, item.legacy ? "原有段落标记" : item.kind === "note" ? "批注" : item.color === "red" ? "红色高亮" : "黄色高亮"),
    item.status === "needs_review" ? el("p", { class: "reader-annotation-review" }, "待核对：文字已变化，未将标记贴到不确定的位置。") : null,
    item.kind === "highlight" ? null : el("blockquote", { class: "reader-text-quote" }, item.quote), content,
    el("div", { class: "reader-text-card-actions" },
      button("关闭", () => readerCloseTextPopup()),
      button(draft ? "继续编辑批注" : item.note ? "编辑批注" : "添加批注", () => {
        readerOpenTextEditor("comment", { paperId: state.reader.id, text: item.quote, ranges: item.ranges || [] }, item, draft);
      }),
      button(item.kind === "highlight" ? "取消高亮" : "删除批注", e => act(async () => {
        if (item.legacy) await patchBlock(item.block_id, item.kind === "highlight" ? { highlight: false } : { note: "" });
        else await readerApplyTextAction("delete_annotation", { annotation_id: item.id, modified_at: item.modified_at, revision: item.revision });
        readerDiscardTextDraft({ kind: "comment", annotation: item, paperId: state.reader.id });
        readerCloseTextPopup(); renderTranslations(); readerPaintAnnotations();
      }, e.currentTarget))));
  readerTextPopover(card, x, y);
  if (item.kind === "highlight") readerEnablePopupDrag(card);
}
function readerPaintAnnotations() {
  if (!state.reader || !readerTextRoot()) return;
  readerTextUI.annotations = state.reader.text_annotations || [];
  readerTextUI.painted = [];
  const yellow = [], red = [], notes = [];
  const all = [...readerTextUI.annotations];
  for (const block of state.reader.blocks) {
    if (block.note) all.push({ id: `legacy-note:${block.id}`, legacy: true, block_id: block.id, kind: "note", quote: readerOriginalText(block), note: block.note, ranges: [{ block_id: block.id }] });
    if (block.highlight) all.push({ id: `legacy-highlight:${block.id}`, legacy: true, block_id: block.id, kind: "highlight", quote: readerOriginalText(block), ranges: [{ block_id: block.id }] });
  }
  for (const item of all) {
    if (item.legacy && item.kind !== "note" && readerTextRoot()?.id !== "original-scroll") continue;
    for (const anchor of item.ranges) {
      if (readerTextRoot()?.id === "original-scroll") {
        const block = state.reader.blocks.find(b => b.id === anchor.block_id);
        const mapped = item.legacy && block ? { ...anchor, language: "original", start: 0,
          end: Array.from(readerOriginalText(block)).length, quote: readerOriginalText(block) } : anchor;
        for (const range of readerPdfAnchorRanges(mapped)) {
          if (item.kind === "highlight") (item.color === "red" ? red : yellow).push(range);
          if (item.kind === "note") notes.push(range);
          readerTextUI.painted.push({ range, item });
        }
        continue;
      }
      let range;
      if (item.legacy) {
        const span = $$(".reader-source-text", readerTextRoot()).find(n => n.dataset.sourceId === anchor.block_id);
        if (span) { range = document.createRange(); range.selectNodeContents(span); }
      } else range = readerAnchorRange(anchor);
      if (!range) continue;
      if (item.kind === "highlight") (item.color === "red" ? red : yellow).push(range);
      if (item.kind === "note") notes.push(range);
      readerTextUI.painted.push({ range, item });
    }
  }
  if (typeof Highlight === "function" && globalThis.CSS?.highlights) {
    CSS.highlights.set("ezread-text-highlight", new Highlight(...yellow));
    CSS.highlights.set("ezread-text-highlight-red", new Highlight(...red));
    CSS.highlights.set("ezread-text-note", new Highlight(...notes));
  }
  const review = $("#reader-review-annotations");
  if (review) { const count = all.filter(a => a.status === "needs_review").length; review.hidden = count === 0; review.textContent = `待核对标记 ${count}`; }
  readerLayoutAnnotationRails();
  readerTextUI.layoutObserver ||= new ResizeObserver(readerQueueAnnotationLayout);
  readerTextUI.layoutObserver.disconnect();
  readerTextUI.layoutObserver.observe(readerTextRoot());
  $$(".translated-text", readerTextRoot()).forEach(node => readerTextUI.layoutObserver.observe(node));
}
function readerQueueAnnotationLayout() {
  if (readerTextUI.railFrame) return;
  readerTextUI.railFrame = requestAnimationFrame(() => { readerTextUI.railFrame = 0; readerLayoutAnnotationRails(); });
}
function readerLayoutAnnotationRails() {
  const root = readerTextRoot();
  if (!state.reader || !root) return;
  if (root.id === "original-scroll") { readerPdfNoteMarkers(); return; }
  $$(".reader-annotation-rails", root).forEach(node => node.remove());
  const paragraphs = new Map();
  for (const { range, item } of readerTextUI.painted) {
    if (item.kind !== "note") continue;
    const container = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer : range.startContainer.parentElement;
    const span = container?.closest(".reader-source-text");
    const paragraph = span?.closest(".translation-block");
    if (!paragraph?.isConnected) continue;
    const rects = [...range.getClientRects()].filter(r => r.width && r.height);
    if (!rects.length) continue;
    const box = paragraph.getBoundingClientRect();
    const interval = { top: Math.min(...rects.map(r => r.top)) - box.top - paragraph.clientTop,
      bottom: Math.max(...rects.map(r => r.bottom)) - box.top - paragraph.clientTop, items: [item] };
    if (!paragraphs.has(paragraph)) paragraphs.set(paragraph, []);
    paragraphs.get(paragraph).push(interval);
  }
  for (const [paragraph, intervals] of paragraphs) {
    // Overlapping notes share one rail and a chooser, so no note hides another.
    const merged = [];
    for (const interval of intervals.sort((a, b) => a.top - b.top)) {
      const last = merged.at(-1);
      if (last && interval.top <= last.bottom + 1) {
        last.bottom = Math.max(last.bottom, interval.bottom);
        for (const item of interval.items) if (!last.items.some(v => v.id === item.id)) last.items.push(item);
      } else merged.push(interval);
    }
    const layer = el("div", { class: "reader-annotation-rails" });
    for (const interval of merged) layer.append(el("button", { type: "button", class: "reader-annotation-rail",
      "aria-label": interval.items.length === 1 ? "查看批注" : `查看此处的 ${interval.items.length} 条批注`,
      dataset: { annotationIds: interval.items.map(item => item.id).join(" ") },
      style: { top: `${interval.top}px`, height: `${interval.bottom - interval.top}px` },
      onpointerdown: e => e.preventDefault(), onclick: e => {
        if (readerTextUI.editor) return;
        window.getSelection().removeAllRanges();
        const rect = e.currentTarget.getBoundingClientRect();
        if (interval.items.length === 1) readerShowAnnotation(interval.items[0], rect.right + 8, rect.top);
        else readerShowAnnotationChoices(interval.items, rect.right + 8, rect.top);
      } }));
    paragraph.append(layer);
  }
}
function readerShowAnnotationChoices(items, x, y) {
  readerTextPopover(el("div", { class: "reader-text-card reader-annotation-choices", "aria-label": "此处批注" },
    el("strong", {}, "此处批注"), items.map(item => button(item.note_title || item.note || item.quote, () => readerShowAnnotation(item, x, y), "reader-text-menu-item")),
    button("关闭", () => readerCloseTextPopup())), x, y);
}
function readerAnnotationClick(event) {
  if (event.target.closest("button,input,textarea,a") || readerHasTextSelection() || readerTextUI.editor) return;
  if (readerTextUI.placement) {
    const span = event.target.closest?.(".reader-source-text"), selection = readerPointSelection(event, span);
    if (selection) {
      event.preventDefault(); event.stopPropagation(); readerTextUI.placement = false;
      const control = $("#reader-place-note"); if (control) { control.setAttribute("aria-pressed", "false"); control.classList.remove("active"); }
      readerOpenNoteEditor(selection); return;
    }
  }
  for (const painted of [...readerTextUI.painted].reverse()) {
    if (painted.item.kind === "note") continue;
    const rect = [...painted.range.getClientRects()].find(rect => event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom);
    if (rect) {
      readerShowAnnotation(painted.item, rect.left, rect.bottom + 8); return;
    }
  }
}
function readerTextList(kind = "annotations") {
  const entries = kind === "history" ? [...(state.reader.text_revision_history || [])].reverse() : (state.reader.text_annotations || []).filter(a => a.status === "needs_review");
  const card = el("div", { class: "reader-text-card reader-text-list" }, el("strong", {}, kind === "history" ? "文字修订历史" : "待核对标记"),
    entries.length ? entries.map(item => kind === "history" ? el("section", {}, el("p", {}, `${item.changes[0]?.language === "original" ? "原文" : "译文"} · ${item.created_at}`),
      el("blockquote", { class: "reader-text-quote" }, item.changes.map(c => c.before).join("\n")), button("恢复这次修改前的文字", e => act(async () => {
        await readerApplyTextAction("restore_revision", { revision_id: item.id }); readerCloseTextPopup(); window.getSelection().removeAllRanges(); renderTranslations();
      }, e.currentTarget))) : button(item.note_title || item.note || item.quote, () => readerShowAnnotation(item, 120, 100))) : el("p", {}, "暂无记录"),
    button("关闭", () => readerCloseTextPopup()));
  const rect = readerTextRoot().getBoundingClientRect(); readerTextPopover(card, rect.left + 24, rect.top + 24);
}
function readerBindTextSelection() {
  const root = readerTextRoot();
  if (!root) return;
  root.addEventListener("contextmenu", readerSelectionMenu);
  root.addEventListener("copy", event => {
    if (root.id !== "original-scroll") return;
    const selection = readerSelectionSnapshot();
    if (selection && event.clipboardData) { event.preventDefault(); event.clipboardData.setData("text/plain", selection.text); }
  });
  root.addEventListener("click", readerAnnotationClick);
  root.addEventListener("pointerdown", e => {
    if (e.button !== 0 || e.target.closest("button,input,textarea,a")) return;
    readerTextUI.selecting = true; readerTextUI.menuKey = ""; clearTimeout(readerTextUI.selectionTimer); readerCancelTranslation();
  });
  root.addEventListener("keyup", e => { if (e.shiftKey) readerQueueSelectionMenu(); });
  root.addEventListener("scroll", () => { if (readerTextUI.popup?.classList.contains("reader-text-menu")) readerCloseTextPopup(); }, { passive: true });
  readerPaintAnnotations();
  const draft = readerReadLocal("text-action", state.reader.id);
  if (draft?.selection?.paperId === state.reader.id && ["note", "revise"].includes(draft.kind) && !readerTextUI.editor) {
    const saved = draft.kind === "note" && (state.reader.text_annotations || []).find(item => item.id === draft.annotation?.id);
    if (saved) readerShowAnnotation(saved);
    else readerOpenTextEditor(draft.kind, draft.selection, draft.annotation, draft);
  }
  if (readerTextUI.bound) return;
  readerTextUI.bound = true;
  window.addEventListener("resize", readerQueueAnnotationLayout);
  document.addEventListener("pointerup", e => {
    if (e.button !== 0 || !readerTextUI.selecting) return;
    readerTextUI.selecting = false; readerQueueSelectionMenu();
  });
  document.addEventListener("pointercancel", () => { readerTextUI.selecting = false; });
  document.addEventListener("pointerdown", e => { if (readerTextUI.popup && !readerTextUI.popup.contains(e.target) && !readerTextUI.editor) readerCloseTextPopup(); });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && readerTextUI.popup) {
      e.preventDefault(); e.stopPropagation(); readerTextDraft();
      if (readerTextUI.editor) readerTextUI.editor = null;
      readerCloseTextPopup(true);
    }
  }, true);
  document.addEventListener("selectionchange", () => {
    if (readerTextUI.request) {
      const selection = readerSelectionSnapshot();
      if (!selection || readerTranslationKey(selection) !== readerTextUI.request.key) readerCloseTextPopup();
    }
    if (!readerHasTextSelection()) {
      readerTextUI.menuKey = ""; clearTimeout(readerTextUI.selectionTimer);
      if (readerTextUI.popup?.classList.contains("reader-text-menu")) readerCloseTextPopup();
      if (!readerTextUI.popup && !readerTextUI.editor && readerScrollActive()) setTimeout(() => { if (!readerTextProtected() && readerScrollActive()) renderTranslations(); }, 0);
    } else readerQueueSelectionMenu();
  });
}
function readerReleaseTextUI() {
  readerTextDraft(); readerTextUI.editor = null; readerTextUI.noteView = null; readerCloseTextPopup(true); readerTextUI.painted = [];
  clearTimeout(readerTextUI.selectionTimer); cancelAnimationFrame(readerTextUI.railFrame);
  readerTextUI.railFrame = 0; readerTextUI.selecting = false; readerTextUI.menuKey = ""; readerTextUI.layoutObserver?.disconnect();
  if (globalThis.CSS?.highlights) { CSS.highlights.delete("ezread-text-highlight"); CSS.highlights.delete("ezread-text-highlight-red"); CSS.highlights.delete("ezread-text-note"); }
}
