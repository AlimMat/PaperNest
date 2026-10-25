"use strict";

// The source document remains ordinary Markdown. Marks affect only the editor's
// display; selections, clipboard, undo and persistence retain the actual bytes.
const writingMarkdown = { editor: null, doc: null, pending: null, previewTimer: null, foldTimer: null, expanded: false, renderer: null, picker: null, reading: false };
const WRITING_MD_LIMIT = 32 * 1024 * 1024;
const WRITING_IMAGE_LIMIT = 8 * 1024 * 1024;
function writingImagePattern() { return /data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\r\n]+/gi; }
function writingMarkdownRefresh() {
  const cm = writingMarkdown.editor;
  // Hidden editors have no usable geometry. Refreshing them would discard the
  // measured line heights and clamp the saved scroll position on read-mode exit.
  if (!cm || !cm.getWrapperElement().getClientRects().length) return;
  const scroll = cm.getScrollInfo();
  cm.refresh();
  cm.scrollTo(scroll.left, scroll.top);
}
function writingMarkdownEditor(doc) {
  if (!writingMarkdown.editor) {
    const host = el("div", { id: "writing-markdown-editor", class: "writing-markdown-editor" });
    $("#writing-source").before(host);
    const editor = writingMarkdown.editor = CodeMirror(host, {
      value: "", mode: "markdown", lineWrapping: true, lineNumbers: true,
      indentUnit: 2, tabSize: 2, viewportMargin: 10, inputStyle: "textarea",
      screenReaderLabel: "Markdown 文稿源码", dragDrop: false,
      extraKeys: {
        "Ctrl-S": () => act(writingFlush), "Cmd-S": () => act(writingFlush),
        "Ctrl-B": () => writingMarkdownWrap("**", "**", "加粗文字"),
        "Ctrl-I": () => writingMarkdownWrap("*", "*", "斜体文字"),
        "Enter": "newlineAndIndentContinueMarkdownList",
        "Tab": cm => cm.somethingSelected() ? cm.indentSelection("add") : cm.replaceSelection("  "),
        "Shift-Tab": cm => cm.indentSelection("subtract")
      }
    });
    editor.on("changes", () => {
      if (!writingMarkdown.doc || writingState.doc !== writingMarkdown.doc || writingState.doc.format !== "md") return;
      $("#writing-source").value = editor.getValue();
      writingChanged();
      clearTimeout(writingMarkdown.foldTimer);
      writingMarkdown.foldTimer = setTimeout(writingMarkdownFold, 100);
    });
    editor.on("paste", (cm, event) => {
      const files = [...(event.clipboardData?.items || [])].filter(item => item.kind === "file" && item.type.startsWith("image/")).map(item => item.getAsFile()).filter(Boolean);
      if (!files.length) {
        const text = event.clipboardData?.getData("text/plain") || "";
        if (!writingImagePattern().test(text) || writingState.busy) return;
        event.preventDefault();
        cm.operation(() => { cm.replaceSelection(text, "end", "paste"); writingMarkdown.expanded = false; writingMarkdownFold(); });
        writingMarkdownFoldLabel();
        return;
      }
      event.preventDefault();
      writingMarkdownInsertImages(files);
    });
    editor.on("cursorActivity", writingMarkdownHeadingState);
    // File drops use the same safe insertion path and never enter PDF import.
    host.addEventListener("dragover", event => { if (event.dataTransfer?.files || [...(event.dataTransfer?.types || [])].includes("Files")) event.preventDefault(); });
    host.addEventListener("drop", event => {
      if (!event.dataTransfer?.files.length) return;
      event.preventDefault(); event.stopPropagation();
      editor.setCursor(editor.coordsChar({ left: event.clientX, top: event.clientY }, "window"));
      writingMarkdownInsertImages([...event.dataTransfer.files]);
    });
    new ResizeObserver(writingMarkdownRefresh).observe(host);
  }
  const editor = writingMarkdown.editor;
  $("#writing-markdown-editor").hidden = doc?.format !== "md";
  if (doc?.format !== "md") { writingMarkdown.doc = null; return; }
  if (writingMarkdown.doc !== doc) {
    if (writingMarkdown.doc) writingMarkdown.doc.editorDoc = editor.getDoc();
    writingMarkdown.doc = null;
    editor.operation(() => {
      editor.swapDoc(doc.editorDoc || new CodeMirror.Doc(doc.content, "markdown"));
      writingMarkdown.doc = doc;
      writingMarkdown.expanded = false;
      writingMarkdownFold();
    });
  }
  editor.setOption("readOnly", writingState.busy);
  requestAnimationFrame(() => editor.refresh());
}
function writingMarkdownFold() {
  const cm = writingMarkdown.editor;
  if (!cm || writingState.doc?.format !== "md") return;
  const scroll = cm.getScrollInfo();
  cm.operation(() => {
    const marks = new Map();
    for (const mark of cm.getAllMarks()) if (mark.writingImage) {
      const pos = mark.find();
      if (pos && !writingMarkdown.expanded) marks.set(cm.indexFromPos(pos.from), mark);
      else mark.clear();
    }
    if (writingMarkdown.expanded) return;
    for (const match of cm.getValue().matchAll(writingImagePattern())) {
      if (marks.has(match.index)) { marks.delete(match.index); continue; }
      const bytes = Math.floor(match[0].slice(match[0].indexOf(",") + 1).replace(/\s/g, "").length * 3 / 4);
      const chip = el("button", { type: "button", class: "writing-image-fold", "aria-label": "展开嵌入图片数据" }, `▸ 图片数据 · ${Math.max(1, Math.round(bytes / 1024))} KB`);
      const mark = cm.markText(cm.posFromIndex(match.index), cm.posFromIndex(match.index + match[0].length), { replacedWith: chip, atomic: true, clearOnEnter: false, inclusiveLeft: false, inclusiveRight: false });
      mark.writingImage = true;
      chip.addEventListener("mousedown", event => event.preventDefault());
      chip.addEventListener("click", () => {
        // Explicit expansion survives typing until the user folds images again.
        writingMarkdown.expanded = true;
        writingMarkdownFold(); writingMarkdownFoldLabel(); cm.focus();
      });
    }
    for (const mark of marks.values()) mark.clear();
  });
  cm.scrollTo(scroll.left, scroll.top);
}
function writingMarkdownFoldLabel() {
  const option = $("#writing-md-more option[value='images']");
  if (option) option.textContent = writingMarkdown.expanded ? "折叠图片数据" : "展开图片数据";
}
function writingMarkdownHeadingState() {
  const control = $("#writing-heading-level"), cm = writingMarkdown.editor;
  if (!control || !cm || writingState.doc?.format !== "md") return;
  const match = /^ {0,3}(#{1,6})\s+/.exec(cm.getLine(cm.getCursor().line));
  const value = String(match ? match[1].length : 0);
  if (control.value !== value) { control.value = value; control.dispatchEvent(new Event("input", { bubbles: true })); }
}
function writingMarkdownWrap(before, after = "", placeholder = "") {
  const cm = writingMarkdown.editor;
  if (!cm || writingState.busy) return;
  const start = cm.getCursor("from"), selected = cm.getSelection();
  cm.replaceSelection(before + (selected || placeholder) + after, "around", "+input");
  const offset = cm.indexFromPos(start) + before.length;
  cm.setSelection(cm.posFromIndex(offset), cm.posFromIndex(offset + (selected || placeholder).length));
  cm.focus();
}
function writingMarkdownLines(transform) {
  const cm = writingMarkdown.editor;
  if (!cm || writingState.busy) return;
  const from = cm.getCursor("from"), to = cm.getCursor("to");
  const last = to.line > from.line && to.ch === 0 ? to.line - 1 : to.line;
  cm.operation(() => {
    for (let line = last; line >= from.line; line--) cm.replaceRange(transform(cm.getLine(line), line - from.line), { line, ch: 0 }, { line, ch: cm.getLine(line).length }, "+input");
  });
  cm.focus();
}
function writingMarkdownToolbar(tools) {
  tools.classList.add("markdown-tools");
  const heading = el("select", { id: "writing-heading-level", "aria-label": "选择标题级别", onchange: event => {
    const level = Number(event.target.value);
    writingMarkdownLines(line => (level ? "#".repeat(level) + " " : "") + line.replace(/^ {0,3}#{1,6}\s+/, ""));
  } }, el("option", { value: "0" }, "正文"), [1, 2, 3, 4, 5, 6].map(level => el("option", { value: String(level) }, `${level} 级标题`)));
  tools.append(heading);
  writingActionMenu(tools, "writing-md-style", "样式", [
    ["bold", "加粗", () => writingMarkdownWrap("**", "**", "加粗文字")],
    ["italic", "斜体", () => writingMarkdownWrap("*", "*", "斜体文字")],
    ["strike", "删除线", () => writingMarkdownWrap("~~", "~~", "删除文字")]
  ]);
  writingActionMenu(tools, "writing-md-paragraph", "段落", [
    ["ul", "无序列表", () => writingMarkdownLines(line => "- " + line.replace(/^\s*(?:[-+*]|\d+\.)\s+(?:\[[ xX]\]\s*)?/, ""))],
    ["ol", "有序列表", () => writingMarkdownLines((line, index) => `${index + 1}. ` + line.replace(/^\s*(?:[-+*]|\d+\.)\s+/, ""))],
    ["todo", "待办列表", () => writingMarkdownLines(line => "- [ ] " + line.replace(/^\s*(?:[-+*]|\d+\.)\s+(?:\[[ xX]\]\s*)?/, ""))],
    ["quote", "引用", () => writingMarkdownLines(line => "> " + line)],
    ["table", "表格", () => writingMarkdownWrap("\n| 项目 | 说明 |\n| --- | --- |\n| ", " | 内容 |\n", "项目一")],
    ["rule", "分隔线", () => writingMarkdownWrap("\n\n---\n\n")]
  ]);
  writingActionMenu(tools, "writing-md-insert", "插入", [
    ["link", "链接", writingShowLinkDialog],
    ["image", "图片", () => { writingMarkdown.picker = writingState.doc; $("#writing-image-input").click(); }],
    ["inline-code", "行内代码", () => writingMarkdownWrap("`", "`", "code")],
    ["code", "代码块", () => writingMarkdownWrap("\n```text\n", "\n```\n", "在这里写代码")],
    ["inline-math", "行内公式", () => writingMarkdownWrap("$", "$", "E = mc^2")],
    ["math", "独立公式", () => writingMarkdownWrap("\n$$\n", "\n$$\n", "\\frac{a}{b} = \\sqrt{x}")]
  ]);
  writingActionMenu(tools, "writing-md-more", "更多", [
    ["images", "展开图片数据", () => { writingMarkdown.expanded = !writingMarkdown.expanded; writingMarkdownFold(); writingMarkdownFoldLabel(); }],
    ["undo", "撤销", () => { writingMarkdown.editor.undo(); writingMarkdown.editor.focus(); }],
    ["redo", "重做", () => { writingMarkdown.editor.redo(); writingMarkdown.editor.focus(); }]
  ]);
  writingMarkdownFoldLabel();
  writingMarkdownHeadingState();
}
async function writingMarkdownReadImage(file) {
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) throw new Error("图片支持 PNG、JPEG、GIF 和 WebP 格式。");
  if (file.size > WRITING_IMAGE_LIMIT) throw new Error("单张图片请控制在 8 MB 以内。");
  const bitmap = await createImageBitmap(file).catch(() => { throw new Error("图片无法读取，请重新复制或选择图片。"); });
  const pixels = bitmap.width * bitmap.height; bitmap.close();
  if (pixels > 40_000_000) throw new Error("图片分辨率过大，请缩小后插入。");
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("读取图片失败。"));
    reader.readAsDataURL(file);
  });
}
function writingMarkdownInsertImages(files) {
  const cm = writingMarkdown.editor, doc = writingState.doc;
  if (!cm || doc?.format !== "md" || writingState.busy || writingMarkdown.pending) return;
  const from = cm.setBookmark(cm.getCursor("from")), to = cm.setBookmark(cm.getCursor("to"));
  const task = (async () => {
    try {
      $("#writing-save-status").textContent = "正在嵌入图片…";
      const images = await Promise.all(files.map(writingMarkdownReadImage));
      if (writingState.doc !== doc) throw new Error("文稿已切换，图片没有插入，请重试。");
      const text = images.map((data, index) => `\n![${(files[index].name || "粘贴图片").replace(/[\[\]\\\r\n]/g, "_")}](${data})\n`).join("\n");
      if (new TextEncoder().encode(cm.getValue() + text).length > WRITING_MD_LIMIT) throw new Error("图片加入后文稿超过 32 MB，请减少图片或分成多个文稿。");
      cm.operation(() => {
        cm.replaceRange(text, from.find(), to.find(), "paste");
        writingMarkdown.expanded = false; writingMarkdownFold();
      });
      writingMarkdownFoldLabel();
      writingState.preview = true; writingUpdatePreview();
      cm.focus();
    } catch (error) {
      toast(error.message, "error", 6500);
      if (writingState.doc === doc) $("#writing-save-status").textContent = doc.content === doc.saved ? "已保存到文件" : "待保存…";
    }
    finally { from.clear(); to.clear(); }
  })();
  writingMarkdown.pending = task;
  task.finally(() => { if (writingMarkdown.pending === task) writingMarkdown.pending = null; });
  return task;
}
function writingMarkdownMath(tex, display) {
  return katex.renderToString(tex, { displayMode: display, throwOnError: false, trust: false, strict: "ignore", maxExpand: 1000, maxSize: 20, macros: {} });
}
function writingMarkdownRenderer() {
  if (writingMarkdown.renderer) return writingMarkdown.renderer;
  const md = markdownit({ html: false, breaks: false, linkify: false, typographer: false });
  const validateLink = md.validateLink;
  md.validateLink = href => /^(?:file:|papernest:|[A-Za-z]:[\\/])/i.test(href) || validateLink(href);
  md.inline.ruler.before("escape", "writing_math", (state, silent) => {
    const start = state.pos, source = state.src;
    const open = source.startsWith("\\(", start) ? "\\(" : source[start] === "$" && source[start + 1] !== "$" ? "$" : "";
    if (!open) return false;
    const close = open === "$" ? "$" : "\\)";
    let end = start + open.length;
    for (; end < source.length; end++) {
      if (source[end] === "\n") return false;
      if (source.startsWith(close, end) && source[end - 1] !== "\\") break;
    }
    if (end >= source.length || end === start + open.length) return false;
    if (!silent) { const token = state.push("writing_math", "math", 0); token.content = source.slice(start + open.length, end); }
    state.pos = end + close.length; return true;
  });
  md.block.ruler.before("fence", "writing_math_block", (state, start, end, silent) => {
    const offset = state.bMarks[start] + state.tShift[start];
    const line = state.src.slice(offset, state.eMarks[start]);
    const open = line.startsWith("$$") ? "$$" : line.startsWith("\\[") ? "\\[" : "";
    if (!open) return false;
    const close = open === "$$" ? "$$" : "\\]";
    const tail = line.slice(open.length), parts = [];
    let next = start, found = tail.indexOf(close);
    if (found >= 0) {
      if (tail.slice(found + close.length).trim()) return false;
      parts.push(tail.slice(0, found));
    }
    else {
      parts.push(tail);
      for (next = start + 1; next < end; next++) {
        const current = state.src.slice(state.bMarks[next] + state.tShift[next], state.eMarks[next]);
        found = current.indexOf(close);
        if (found >= 0 && current.slice(found + close.length).trim()) return false;
        parts.push(found >= 0 ? current.slice(0, found) : current);
        if (found >= 0) break;
      }
    }
    if (found < 0) return false;
    if (silent) return true;
    const token = state.push("writing_math_block", "math", 0);
    token.content = parts.join("\n"); token.map = [start, next + 1]; state.line = next + 1;
    return true;
  }, { alt: ["paragraph", "reference", "blockquote", "list"] });
  md.renderer.rules.writing_math = (tokens, i) => writingMarkdownMath(tokens[i].content, false);
  md.renderer.rules.writing_math_block = (tokens, i) => `<div class="writing-math-block" data-writing-source-line="${tokens[i].map?.[0] ?? ""}">${writingMarkdownMath(tokens[i].content, true)}</div>`;
  const imageRenderer = md.renderer.rules.image;
  md.renderer.rules.image = (tokens, i, options, env, renderer) => {
    const token = tokens[i], src = token.attrGet("src") || "";
    if (!/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/i.test(src)) return `<span class="writing-image-unavailable">[图片：${md.utils.escapeHtml(token.content || "请粘贴图片以嵌入文稿")}]</span>`;
    token.attrSet("loading", "lazy"); token.attrSet("decoding", "async");
    return imageRenderer(tokens, i, options, env, renderer);
  };
  md.core.ruler.after("inline", "writing_tasks", state => {
    for (let i = 2; i < state.tokens.length; i++) {
      const token = state.tokens[i];
      if (token.type !== "inline" || state.tokens[i - 2].type !== "list_item_open" || token.children?.[0]?.type !== "text") continue;
      const match = /^\[([ xX])\]\s+/.exec(token.children[0].content);
      if (!match) continue;
      token.children[0].content = token.children[0].content.slice(match[0].length);
      const check = new state.Token("html_inline", "", 0);
      check.content = `<input type="checkbox" disabled${match[1] !== " " ? " checked" : ""} aria-label="待办状态"> `;
      token.children.unshift(check);
    }
  });
  const mappedBlocks = ["paragraph_open", "heading_open", "blockquote_open", "bullet_list_open", "ordered_list_open", "list_item_open", "table_open", "thead_open", "tbody_open", "tr_open", "code_block", "fence", "hr"];
  for (const type of mappedBlocks) {
    const original = md.renderer.rules[type];
    md.renderer.rules[type] = (tokens, index, options, env, slf) => {
      const token = tokens[index];
      const rendered = original ? original(tokens, index, options, env, slf) : slf.renderToken(tokens, index, options);
      const line = token.map?.[0];
      if (line === undefined || !rendered.startsWith("<")) return rendered;
      return rendered.replace(/^<([A-Za-z][^\s/>]*)/, `<$1 data-writing-source-line="${line}"`);
    };
  }
  writingMarkdown.renderer = md;
  return md;
}
function writingPreviewNavigate(text, source, event) {
  if (writingState.doc?.path !== source || writingState.doc?.format !== "md" || !writingMarkdown.editor || writingState.busy) return;
  const block = event.target.closest("[data-writing-source-line]");
  if (!block) return;
  let selected = window.getSelection()?.toString().trim();
  // Synthetic double-clicks (and some CJK browser configurations) do not
  // always leave a DOM selection behind. Recover the clicked text from the
  // caret position so the same gesture remains useful in those cases.
  if (!selected) {
    const caret = document.caretRangeFromPoint?.(event.clientX, event.clientY)
      || (() => { const position = document.caretPositionFromPoint?.(event.clientX, event.clientY); if (!position) return null; const range = document.createRange(); range.setStart(position.offsetNode, position.offset); range.collapse(true); return range; })();
    const node = caret?.startContainer?.nodeType === Node.TEXT_NODE ? caret.startContainer : null;
    if (node) {
      const value = node.textContent || "", offset = caret.startOffset;
      const isWord = char => /[A-Za-z0-9_\u3400-\u9fff]/u.test(char);
      let left = offset, right = offset;
      while (left > 0 && isWord(value[left - 1])) left -= 1;
      while (right < value.length && isWord(value[right])) right += 1;
      selected = value.slice(left, right).trim();
    }
  }
  if (!selected) selected = block.textContent?.trim() || "";
  if (!selected) return;
  const line = Number(block.dataset.writingSourceLine), lines = text.split("\n");
  const start = Number.isInteger(line) && line >= 0 && line < lines.length
    ? lines.slice(0, line).reduce((total, value) => total + value.length + 1, 0) : 0;
  const candidates = [selected, selected.replace(/\s+/g, " ")];
  let index = -1;
  for (const candidate of candidates) {
    if (!candidate) continue;
    index = text.indexOf(candidate, start);
    if (index >= 0) break;
  }
  if (index < 0) for (const candidate of candidates) {
    if (!candidate) continue;
    index = text.indexOf(candidate);
    if (index >= 0) break;
  }
  if (index < 0) return;
  const cm = writingMarkdown.editor, from = cm.posFromIndex(index), to = cm.posFromIndex(index + selected.length);
  cm.focus(); cm.setSelection(from, to); cm.scrollIntoView({ from, to }, 80);
}
function writingRenderMarkdown(text, source = writingState.doc?.path) {
  const content = el("div", { class: "writing-markdown-content" });
  // Raw HTML is disabled in markdown-it. Only our fixed markup and KaTeX with
  // trust:false may generate HTML; image URLs are constrained to embedded raster.
  content.innerHTML = writingMarkdownRenderer().render(text);
  writingBindLinks(content, source);
  writingBindImages(content);
  content.addEventListener("dblclick", event => writingPreviewNavigate(text, source, event));
  return content;
}
