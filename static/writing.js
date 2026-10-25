"use strict";

function writingDraftKey(path) { return `ezread-writing-draft:${writingState.root}:${path}`; }
function writingParent(path) { return path.split("/").slice(0, -1).join("/"); }
function writingRequest(body) { return api("/api/writing", { method: "POST", body }); }

function writingSetZoom(value, persist = true) {
  const zoom = Math.max(50, Math.min(200, Math.round(value / 10) * 10));
  if (!Number.isFinite(zoom)) return;
  const ratio = zoom / writingState.zoom;
  const panes = ["#writing-source", "#writing-editors", "#writing-preview", "#writing-latex-pages"].map(selector => {
    const node = $(selector);
    return { node, top: node.scrollTop, left: node.scrollLeft };
  });
  const cm = writingMarkdown.editor, scroll = cm?.getScrollInfo();
  writingState.zoom = zoom;
  $("#writing-view").style.setProperty("--writing-scale", String(zoom / 100));
  $("#writing-zoom-level").textContent = `${zoom}%`;
  $("#writing-zoom-out").disabled = zoom === 50;
  $("#writing-zoom-in").disabled = zoom === 200;
  writingMarkdownRefresh();
  if (scroll && writingState.doc?.format === "md") cm.scrollTo(scroll.left * ratio, scroll.top * ratio);
  for (const { node, top, left } of panes) { node.scrollTop = top * ratio; node.scrollLeft = left * ratio; }
  if (persist) writeBrowserSetting("writingZoom", String(zoom));
}

async function writingCopyPath() {
  const doc = writingState.doc;
  if (!doc) throw Error("请先打开一个写作文件。");
  await writingFlush();
  const result = await writingRequest({ operation: "copy-path", path: doc.path });
  if (writingState.doc !== doc) throw Error("当前文稿已经切换，请重试。");
  if (typeof result?.path !== "string" || !result.path) throw Error("未获取到写作文件地址，请重试。");
  await copyPlainText(result.path);
  toast("已复制写作文件地址", "success", 5000);
}

async function writingRun(task) {
  if (writingState.busy) return;
  writingState.busy = true;
  $("#writing-source").readOnly = true;
  writingMarkdown.editor?.setOption("readOnly", true);
  $("#writing-word").contentEditable = "false";
  try { return await task(); }
  finally {
    writingState.busy = false;
    $("#writing-source").readOnly = false;
    writingMarkdown.editor?.setOption("readOnly", false);
    $("#writing-word").contentEditable = "true";
    writingRenderTree();
  }
}
function writingFailure(message) {
  $("#writing-save-status").textContent = "未保存到文件";
  $("#writing-error").textContent = message;
  $("#writing-recovery").hidden = false;
}
async function writingFlush() {
  if (writingMarkdown.pending) await writingMarkdown.pending;
  clearTimeout(writingState.timer);
  if (writingState.saving) { await writingState.saving; return writingFlush(); }
  const doc = writingState.doc;
  if (!doc || doc.content === doc.saved) return true;
  writingState.saving = (async () => {
    try {
      while (doc.content !== doc.saved) {
        const content = doc.content;
        await writingRemember(doc);
        $("#writing-save-status").textContent = "正在保存…";
        const result = await writingRequest({ operation: "save", path: doc.path, content, revision: doc.revision });
        doc.revision = result.revision; doc.saved = content;
        if (doc.content === content) await writingForget(doc.path); else await writingRemember(doc);
      }
      $("#writing-save-status").textContent = "已保存到文件";
      $("#writing-recovery").hidden = true;
      return true;
    } catch (error) {
      const local = await writingRemember(doc);
      writingFailure(`${error.message}${local ? " 本机草稿已保留。" : " 本机草稿也未能保存，请复制正文备份，暂勿关闭窗口。"}`);
      throw error;
    }
  })();
  try { return await writingState.saving; } finally { writingState.saving = null; }
}
function writingChanged() {
  const doc = writingState.doc;
  if (!doc) return;
  doc.content = doc.format === "docx" ? $("#writing-word").innerHTML : $("#writing-source").value;
  $("#writing-save-status").textContent = "待保存…";
  const content = doc.content;
  writingRemember(doc).then(retained => {
    if (writingState.doc === doc && doc.content === content && doc.content !== doc.saved && !writingState.saving) $("#writing-save-status").textContent = retained ? "待保存 · 草稿已保留" : "待保存 · 本机草稿不可用";
  });
  writingUpdatePreview(false); writingCount();
  clearTimeout(writingState.timer);
  writingState.timer = setTimeout(() => { writingFlush().catch(() => {}); }, 900);
}
function writingCount() {
  const doc = writingState.doc;
  const text = doc?.format === "docx" ? $("#writing-word").innerText : (doc?.content || "").replace(writingImagePattern(), "");
  $("#writing-word-count").textContent = `${Array.from(text.replace(/\s/g, "")).length.toLocaleString()} 字符`;
}
function writingUpdatePreview(refreshEditor = true) {
  const markdown = writingState.doc?.format === "md";
  const latex = writingState.doc?.format === "tex";
  const reading = markdown && writingMarkdown.reading || latex && writingLatex.reading;
  const visible = (markdown || latex) && (writingState.preview || reading);
  $("#writing-preview").hidden = !(markdown && visible);
  $("#writing-source").hidden = !latex || reading;
  writingLatexUpdate(writingState.doc, latex && visible);
  $("#writing-editors").classList.toggle("with-preview", visible && !reading);
  $("#writing-document").classList.toggle("reading-manuscript", reading);
  $("#writing-view").classList.toggle("manuscript-reading", reading);
  writingPlaceTabs();
  if ($("#writing-markdown-editor")) $("#writing-markdown-editor").hidden = !markdown || reading;
  $("#writing-format-tools").hidden = reading;
  $("#writing-preview-toggle").setAttribute("aria-pressed", String(visible && !reading));
  $("#writing-preview-toggle").textContent = visible && !reading ? "收起预览" : "预览";
  $("#writing-read-toggle").setAttribute("aria-pressed", String(reading));
  $("#writing-read-toggle").textContent = reading ? "退出阅读" : "阅读模式";
  clearTimeout(writingMarkdown.previewTimer);
  if (markdown && visible) writingMarkdown.previewTimer = setTimeout(() => {
    if (writingState.doc?.format !== "md" || !(writingState.preview || writingMarkdown.reading)) return;
    const preview = $("#writing-preview"), scroll = preview.scrollTop;
    preview.replaceChildren(writingRenderMarkdown(writingState.doc.content)); preview.scrollTop = scroll;
  }, 150);
  if (refreshEditor) writingMarkdownRefresh();
}
function writingSafeWord(content) {
  const parsed = new DOMParser().parseFromString(content, "text/html");
  const clean = document.createElement("div");
  const copy = (source, parent) => {
    if (source.nodeType === Node.TEXT_NODE) { parent.append(document.createTextNode(source.textContent)); return; }
    if (source.nodeType !== Node.ELEMENT_NODE || ["SCRIPT", "STYLE", "IFRAME", "OBJECT"].includes(source.tagName)) return;
    const allowed = ["P", "DIV", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "UL", "OL", "LI", "B", "STRONG", "I", "EM", "U", "S", "STRIKE", "DEL", "SUP", "SUB", "BR"];
    const destination = allowed.includes(source.tagName) ? document.createElement(source.tagName.toLowerCase()) : parent;
    if (destination !== parent) parent.append(destination);
    for (const child of source.childNodes) copy(child, destination);
  };
  for (const child of parsed.body.childNodes) copy(child, clean);
  return clean.innerHTML;
}
function writingInsert(before, after = "") {
  const editor = $("#writing-source");
  editor.focus();
  const selected = editor.value.slice(editor.selectionStart, editor.selectionEnd);
  document.execCommand("insertText", false, before + selected + after);
  writingChanged();
}
function writingActionMenu(tools, id, label, actions) {
  const lookup = new Map(actions.map(item => [item[0], item[2]]));
  const select = el("select", { id, class: "writing-tool-select", "aria-label": label, onchange: event => {
    const action = lookup.get(event.target.value);
    event.target.value = "";
    event.target.dispatchEvent(new Event("input", { bubbles: true }));
    if (action && !writingState.busy) action();
  } }, el("option", { value: "", selected: true, disabled: true }, label),
  actions.map(([value, text]) => el("option", { value }, text)));
  tools.append(select);
  return select;
}
function writingWordCommand(command, value = null) {
  const editor = $("#writing-word");
  editor.focus(); document.execCommand(command, false, value); writingChanged();
}
function writingWordWrap(before, after, placeholder) {
  const editor = $("#writing-word"); editor.focus();
  const selection = window.getSelection();
  const selected = selection && selection.rangeCount && editor.contains(selection.anchorNode) ? selection.toString() : "";
  document.execCommand("insertText", false, before + (selected || placeholder) + after); writingChanged();
}
function writingWordToolbar(tools) {
  writingActionMenu(tools, "writing-word-format", "格式", [
    ["p", "正文", () => writingWordCommand("formatBlock", "p")],
    ...[1, 2, 3, 4, 5, 6].map(level => [`h${level}`, `${level} 级标题`, () => writingWordCommand("formatBlock", `h${level}`)])
  ]);
  writingActionMenu(tools, "writing-word-style", "样式", [
    ["bold", "加粗", () => writingWordCommand("bold")], ["italic", "斜体", () => writingWordCommand("italic")],
    ["underline", "下划线", () => writingWordCommand("underline")], ["strike", "删除线", () => writingWordCommand("strikeThrough")],
    ["sup", "上标", () => writingWordCommand("superscript")], ["sub", "下标", () => writingWordCommand("subscript")],
    ["clear", "清除文字格式", () => writingWordCommand("removeFormat")]
  ]);
  writingActionMenu(tools, "writing-word-paragraph", "段落", [
    ["ul", "项目符号列表", () => writingWordCommand("insertUnorderedList")], ["ol", "编号列表", () => writingWordCommand("insertOrderedList")],
    ["quote", "引用段落", () => writingWordCommand("formatBlock", "blockquote")],
    ["paragraph", "新段落", () => writingWordCommand("insertParagraph")], ["line", "换行", () => writingWordCommand("insertLineBreak")]
  ]);
  writingActionMenu(tools, "writing-word-insert", "插入", [
    ["dash", "破折号 —", () => writingWordCommand("insertText", "—")], ["quotes", "中文引号", () => writingWordWrap("“", "”", "引用文字")],
    ["checkbox", "待办方框 ☐", () => writingWordCommand("insertText", "☐ ")], ["check", "完成方框 ☑", () => writingWordCommand("insertText", "☑ ")],
    ["date", "当前日期", () => writingWordCommand("insertText", new Intl.DateTimeFormat("zh-CN").format(new Date()))]
  ]);
  writingActionMenu(tools, "writing-word-edit", "编辑", [
    ["undo", "撤销", () => writingWordCommand("undo")], ["redo", "重做", () => writingWordCommand("redo")],
    ["select", "全选", () => writingWordCommand("selectAll")]
  ]);
}
function writingLatexToolbar(tools) {
  writingActionMenu(tools, "writing-latex-layout", "排版", [
    ["zh", "中文排版", () => writingLatexLanguage("zh")], ["en", "英文排版", () => writingLatexLanguage("en")],
    ["article", "文章 article", () => writingLatexClass("article")], ["report", "报告 report", () => writingLatexClass("report")],
    ["book", "书籍 book", () => writingLatexClass("book")]
  ]);
  writingActionMenu(tools, "writing-latex-structure", "结构", [
    ["part", "部分", () => writingInsert("\\part{", "}")], ["chapter", "章（report/book）", () => writingInsert("\\chapter{", "}")],
    ["section", "一级章节", () => writingInsert("\\section{", "}")], ["subsection", "二级章节", () => writingInsert("\\subsection{", "}")],
    ["subsubsection", "三级章节", () => writingInsert("\\subsubsection{", "}")], ["paragraph", "段落标题", () => writingInsert("\\paragraph{", "}")]
  ]);
  writingActionMenu(tools, "writing-latex-style", "样式", [
    ["bold", "加粗", () => writingInsert("\\textbf{", "}")], ["italic", "斜体", () => writingInsert("\\textit{", "}")],
    ["emph", "强调", () => writingInsert("\\emph{", "}")], ["underline", "下划线", () => writingInsert("\\underline{", "}")],
    ["quote", "引用块", () => writingInsert("\n\\begin{quote}\n", "\n\\end{quote}\n")]
  ]);
  writingActionMenu(tools, "writing-latex-insert", "插入", [
    ["itemize", "无序列表", () => writingInsert("\n\\begin{itemize}\n  \\item ", "\n\\end{itemize}\n")],
    ["enumerate", "有序列表", () => writingInsert("\n\\begin{enumerate}\n  \\item ", "\n\\end{enumerate}\n")],
    ["description", "说明列表", () => writingInsert("\n\\begin{description}\n  \\item[术语] ", "\n\\end{description}\n")],
    ["table", "表格", () => writingInsert("\n\\begin{table}[htbp]\n\\centering\n\\begin{tabular}{ll}\n项目 & 说明 \\\\\n\\hline\n", " & 内容 \\\\\n\\end{tabular}\n\\caption{表格标题}\n\\label{tab:result}\n\\end{table}\n")],
    ["footnote", "脚注", () => writingInsert("\\footnote{", "}")], ["cite", "引用文献", () => writingInsert("\\cite{", "}")],
    ["label", "标签", () => writingInsert("\\label{", "}")], ["ref", "交叉引用", () => writingInsert("\\ref{", "}")],
    ["verbatim", "原样代码块", () => writingInsert("\n\\begin{verbatim}\n", "\n\\end{verbatim}\n")], ["page", "分页", () => writingInsert("\n\\newpage\n")]
  ]);
  writingActionMenu(tools, "writing-latex-math", "公式", [
    ["inline", "行内公式", () => writingInsert("\\(", "\\)")], ["display", "独立公式", () => writingInsert("\\[\n", "\n\\]")],
    ["equation", "带编号公式", () => writingInsert("\n\\begin{equation}\n", "\n\\end{equation}\n")],
    ["align", "多行对齐", () => writingInsert("\n\\begin{align}\n", "\n\\end{align}\n")],
    ["cases", "分段函数", () => writingInsert("\\begin{cases}\n", "\n\\end{cases}")],
    ["matrix", "矩阵", () => writingInsert("\\begin{bmatrix}\n", "\n\\end{bmatrix}")]
  ]);
}
function writingRenderDocument() {
  const doc = writingState.doc;
  writingRenderTabs();
  writingMarkdownEditor(doc);
  $("#writing-empty").hidden = Boolean(doc);
  $("#writing-document").hidden = !doc;
  $("#writing-copy-path").disabled = !doc; $("#writing-rename").disabled = !doc; $("#writing-trash").disabled = !doc;
  $("#writing-title").textContent = doc?.name || "让想法落在纸上";
  $("#writing-path").textContent = doc ? doc.path : writingState.root || "文稿单独保存在 writing 文件夹";
  if (!doc) { writingUpdatePreview(); return; }
  const word = doc.format === "docx";
  // Word has no preview pane, so never leave the compact preview header
  // active when switching from a Markdown/LaTeX document.
  if (word && writingState.headingCollapsed) writingSetHeadingCollapsed(false, false);
  $("#writing-source").hidden = word || doc.format === "md"; $("#writing-word").hidden = !word;
  if (word) $("#writing-word").innerHTML = writingSafeWord(doc.content);
  else $("#writing-source").value = doc.content;
  $("#writing-preview-toggle").hidden = word;
  $("#writing-read-toggle").hidden = word;
  const tools = $("#writing-format-tools"); tools.replaceChildren();
  tools.classList.remove("markdown-tools"); tools.classList.add("writing-menu-tools");
  if (word) {
    writingWordToolbar(tools);
  } else if (doc.format === "md") {
    writingMarkdownToolbar(tools);
  } else {
    writingLatexToolbar(tools);
  }
  $("#writing-format-hint").textContent = word ? "Word · 基础文字排版" : doc.format === "tex" ? "LaTeX · XeLaTeX 本地 PDF 预览" : "Markdown · Ctrl+S 保存";
  $("#writing-save-status").textContent = doc.content === doc.saved ? "已保存到文件" : "已恢复未保存草稿";
  $("#writing-recovery").hidden = doc.content === doc.saved;
  if (doc.content !== doc.saved) $("#writing-error").textContent = "已恢复上次草稿。点击保存继续，或另存为新文稿。";
  writingUpdatePreview(); writingCount();
}
async function writingOpen(path, { discard = false } = {}) {
  if (!discard) await writingFlush();
  const data = await api(`/api/writing/document?path=${encodeURIComponent(path)}`);
  writingCaptureTab();
  const cached = writingState.tabs.find(item => item.path === path);
  const doc = !discard && cached?.revision === data.revision && cached.saved === data.content ? cached : { ...data, saved: data.content };
  if (!discard && cached?.revision === data.revision && doc !== cached) doc.tabView = cached.tabView;
  if (!discard && doc !== cached) {
    try {
      const draft = await writingReadDraft(path);
      if (draft && typeof draft.content === "string" && typeof draft.revision === "string") {
        doc.content = doc.format === "docx" ? writingSafeWord(draft.content) : draft.content;
        if (doc.content !== doc.saved) doc.revision = draft.revision;
      }
    } catch {}
  } else if (discard) await writingForget(path);
  if (cached) writingState.tabs[writingState.tabs.indexOf(cached)] = doc;
  else writingState.tabs.push(doc);
  // Reading remains reading when switching between Markdown and LaTeX tabs.
  const reading = writingMarkdown.reading || writingLatex.reading;
  writingMarkdown.reading = reading && doc.format === "md";
  writingLatex.reading = reading && doc.format === "tex";
  writingState.doc = doc; writingState.folder = writingParent(path);
  writingRenderTree(); writingRenderDocument();
  writingRestoreTab(doc);
}
async function writingRefresh() {
  const result = await api("/api/writing");
  writingState.root = result.root; writingState.entries = result.entries;
  const folders = new Set(result.entries.filter(entry => entry.kind === "folder").map(entry => entry.path));
  for (const path of writingState.collapsedFolders) if (!folders.has(path)) writingState.collapsedFolders.delete(path);
  if (!result.entries.some(entry => entry.kind === "folder" && entry.path === writingState.folder)) writingState.folder = "";
  writingRenderTree();
  if (!writingState.doc) writingRenderDocument();
}
function writingRenderTree() {
  const tree = $("#writing-tree"), query = $("#writing-search").value.trim().toLowerCase();
  const scroll = tree.scrollTop;
  const visiblePaths = new Set();
  if (query) for (const entry of writingState.entries) {
    if (!entry.path.toLowerCase().includes(query)) continue;
    visiblePaths.add(entry.path);
    let parent = writingParent(entry.path);
    while (parent) { visiblePaths.add(parent); parent = writingParent(parent); }
  }
  const hiddenByCollapsedFolder = path => {
    let parent = writingParent(path);
    while (parent) {
      if (writingState.collapsedFolders.has(parent)) return true;
      parent = writingParent(parent);
    }
    return false;
  };
  const folderChildren = new Set(writingState.entries.map(entry => writingParent(entry.path)).filter(Boolean));
  const folderLabel = (entry, root = false) => button(entry.name, () => { writingState.folder = entry.path; writingRenderTree(); }, "secondary", "folder", {
    class: `writing-tree-item writing-tree-folder ${writingState.folder === entry.path ? "selected" : ""}`,
    "aria-pressed": String(writingState.folder === entry.path),
    ...(root ? {} : { dataset: { path: entry.path } })
  });
  const folderRow = entry => {
    const collapsed = writingState.collapsedFolders.has(entry.path), hasChildren = folderChildren.has(entry.path);
    const disclosure = hasChildren
      ? el("button", { type: "button", class: "writing-tree-disclosure", "aria-label": `${collapsed ? "展开" : "收起"}文件夹“${entry.name}”`, "aria-expanded": String(!collapsed), onclick: () => { if (collapsed) writingState.collapsedFolders.delete(entry.path); else writingState.collapsedFolders.add(entry.path); writingRenderTree(); } }, icon("chevron"))
      : el("span", { class: "writing-tree-disclosure-spacer", "aria-hidden": "true" });
    const row = el("div", { class: "writing-tree-folder-row" }, disclosure, folderLabel(entry));
    row.style.paddingLeft = `${12 * Math.min(entry.path.split("/").length - 1, 8)}px`;
    return row;
  };
  tree.replaceChildren(el("div", { class: "writing-tree-folder-row writing-tree-root" }, el("span", { class: "writing-tree-disclosure-spacer", "aria-hidden": "true" }), folderLabel({ name: "全部文稿", path: "" }, true)));
  for (const entry of writingState.entries) {
    if (query ? !visiblePaths.has(entry.path) : hiddenByCollapsedFolder(entry.path)) continue;
    if (entry.kind === "folder") { tree.append(folderRow(entry)); continue; }
    const node = button(entry.name, () => act(() => writingRun(() => writingOpen(entry.path))), "secondary", "file", { class: `writing-tree-item ${writingState.doc?.path === entry.path ? "active" : ""}`, "aria-current": writingState.doc?.path === entry.path ? "page" : undefined, dataset: { path: entry.path } });
    node.style.paddingLeft = `${34 + 12 * Math.min(entry.path.split("/").length - 1, 8)}px`;
    tree.append(node);
  }
  if (tree.childElementCount === 1) tree.append(el("p", { class: "writing-tree-empty" }, query ? "没有匹配的文稿" : "新建文件夹或文稿，从这里开始。"));
  $("#writing-folder-rename").disabled = !writingState.folder;
  $("#writing-folder-trash").disabled = !writingState.folder;
  const siblings = writingState.entries.filter(entry => entry.kind === "folder" && writingParent(entry.path) === writingParent(writingState.folder));
  const index = siblings.findIndex(entry => entry.path === writingState.folder);
  $("#writing-folder-up").disabled = writingState.busy || index <= 0;
  $("#writing-folder-down").disabled = writingState.busy || index < 0 || index >= siblings.length - 1;
  tree.scrollTop = scroll;
}
async function writingMoveFolder(direction) {
  if (!writingState.folder) return;
  writingRenderTree();
  await writingRequest({ operation: "move-folder", path: writingState.folder, direction });
  await writingRefresh();
}
function writingSetSidebarCollapsed(collapsed, persist = true) {
  writingState.sidebarCollapsed = Boolean(collapsed);
  const active = writingState.mode === "writing" && writingState.sidebarCollapsed;
  document.body.classList.toggle("writing-sidebar-collapsed", active);
  const toggle = $("#writing-sidebar-toggle");
  toggle.setAttribute("aria-expanded", String(!writingState.sidebarCollapsed));
  toggle.setAttribute("aria-label", writingState.sidebarCollapsed ? "展开写作侧栏" : "收起写作侧栏");
  if (persist) writeBrowserSetting("writingSidebarCollapsed", String(writingState.sidebarCollapsed));
  if (typeof sidebarApplyWidth === "function") sidebarApplyWidth();
  requestAnimationFrame(() => {
    writingMarkdownRefresh();
    window.dispatchEvent(new Event("resize"));
  });
}
function writingSetHeadingCollapsed(collapsed, persist = true) {
  writingState.headingCollapsed = Boolean(collapsed);
  const view = $("#writing-view");
  view.classList.toggle("writing-heading-collapsed", writingState.headingCollapsed);
  const toggle = $("#writing-heading-toggle");
  toggle.setAttribute("aria-expanded", String(!writingState.headingCollapsed));
  toggle.setAttribute("aria-label", writingState.headingCollapsed ? "展开写作顶部栏" : "收起写作顶部栏");
  writingPlaceTabs();
  if (persist) writeBrowserSetting("writingHeadingCollapsed", String(writingState.headingCollapsed));
}
async function writingSwitch(mode) {
  await writingFlush();
  if (mode !== "writing") { ++writingLinks.request; writingLinksDetach(); }
  if (mode === "writing") await writingRefresh();
  writingState.mode = mode;
  document.body.classList.toggle("writing-mode", mode === "writing");
  document.body.classList.toggle("writing-sidebar-collapsed", mode === "writing" && writingState.sidebarCollapsed);
  $("#reading-sidebar").hidden = mode === "writing";
  $("#library-view").hidden = mode === "writing";
  $("#writing-sidebar").hidden = mode !== "writing";
  $("#writing-view").hidden = mode !== "writing";
  $("#mode-reading").setAttribute("aria-pressed", String(mode === "reading"));
  $("#mode-writing").setAttribute("aria-pressed", String(mode === "writing"));
  sidebarApplyWidth();
  if (mode === "writing") window.scrollTo(0, 0);
  if (window.ezreadDesktop && window.chrome?.webview) window.chrome.webview.postMessage("ezread-fit-viewport");
  if (mode === "reading") { renderLibrary(); window.dispatchEvent(new Event("resize")); }
}
function writingShowDialog(operation, kind = "file", format = "md", path = "") {
  const removal = operation === "trash", rename = operation === "rename", reload = operation === "reload";
  writingState.dialog = { operation, kind, path };
  $("#writing-dialog-title").textContent = reload ? "重新读取文稿" : removal ? "移到写作回收目录" : rename ? "重命名 / 移动" : operation === "copy" ? "另存草稿" : kind === "folder" ? "新建文件夹" : "新建文稿";
  $("#writing-name-field").hidden = removal || reload;
  $("#writing-parent-field").hidden = removal || reload;
  $("#writing-format-field").hidden = removal || rename || reload || operation === "copy" || kind === "folder";
  $("#writing-name").required = !removal && !reload;
  $("#writing-name").value = rename ? path.split("/").pop() : operation === "copy" ? `${writingState.doc.name.replace(/\.[^.]+$/, "")}-草稿` : "";
  $("#writing-format").value = format;
  $("#writing-latex-language").value = "zh";
  writingLatexTemplateField();
  const parent = $("#writing-parent"); parent.replaceChildren(el("option", { value: "" }, "写作根目录"));
  for (const entry of writingState.entries) if (entry.kind === "folder" && (!rename || (entry.path !== path && !entry.path.startsWith(path + "/")))) parent.append(el("option", { value: entry.path }, entry.path));
  parent.value = rename ? writingParent(path) : writingState.folder;
  $("#writing-dialog-help").textContent = reload ? "将放弃当前未保存草稿，读取磁盘上的内容。建议先使用“另存草稿”保留两个版本。" : removal ? `「${path}」将移到 writing/.trash，${kind === "folder" ? "其中的文稿会一起移入。" : ""}需要时可在磁盘恢复，不影响文献库。` : rename ? "选择其他文件夹即可移动；文件扩展名需要保留。" : "文件直接保存在本机独立的写作目录。";
  $("#writing-confirm").textContent = reload ? "放弃草稿并读取" : removal ? "移除" : rename ? "保存" : "创建";
  openDialog("#writing-dialog");
  if (!removal && !reload) $("#writing-name").focus();
}
async function writingSubmit() {
  const { operation, kind, path } = writingState.dialog;
  if (operation === "reload") {
    clearTimeout(writingState.timer);
    if (writingState.saving) await writingState.saving.catch(() => {});
    await writingOpen(writingState.doc.path, { discard: true });
  } else if (operation === "copy") {
    clearTimeout(writingState.timer);
    if (writingState.saving) await writingState.saving.catch(() => {});
    const original = writingState.doc, destination = writingNewPath(original.format);
    await writingRequest({ operation: "create", kind: "file", path: destination });
    const created = await api(`/api/writing/document?path=${encodeURIComponent(destination)}`);
    await writingRequest({ operation: "save", path: destination, content: original.content, revision: created.revision });
    await writingForget(original.path);
    writingState.tabs = writingState.tabs.filter(doc => doc !== original);
    await writingOpen(destination, { discard: true });
  } else {
    await writingFlush();
    if (operation === "trash" || operation === "rename") {
      const parent = $("#writing-parent").value;
      const destination = `${parent ? parent + "/" : ""}${$("#writing-name").value.trim()}`;
      const current = writingState.doc?.path;
      await writingRequest({ operation, path, destination });
      writingMutateTabs(operation, path, destination);
      if (current && (current === path || current.startsWith(path + "/"))) {
        await writingForget(current);
        if (operation === "trash") {
          writingState.doc = null;
          if (writingState.tabs.length) await writingOpen(writingState.tabs[0].path);
        }
        else await writingOpen(destination + current.slice(path.length));
      }
      writingState.folder = operation === "rename" && kind === "folder" ? destination : writingParent(path);
    } else {
      const destination = writingNewPath(kind === "folder" ? "" : $("#writing-format").value);
      await writingRequest({ operation: "create", kind, path: destination, language: $("#writing-latex-language").value });
      if (kind === "file") await writingOpen(destination); else writingState.folder = destination;
    }
  }
  await writingRefresh(); writingRenderDocument(); $("#writing-dialog").close();
}
function writingNewPath(format) {
  let name = $("#writing-name").value.trim();
  if (!name) throw new Error("请输入名称。");
  if (format && !name.toLowerCase().endsWith(`.${format}`)) name += `.${format}`;
  const parent = $("#writing-parent").value;
  return `${parent ? parent + "/" : ""}${name}`;
}
function installWriting() {
  installWritingTabs();
  installWritingLinks();
  installWritingLatex();
  installReadwrite();
  writingSetZoom(Number(readBrowserSetting("writingZoom") || 100), false);
  for (const [id, step] of [["#writing-zoom-out", -10], ["#writing-zoom-in", 10]]) {
    $(id).addEventListener("mousedown", event => event.preventDefault());
    $(id).addEventListener("click", () => writingSetZoom(writingState.zoom + step));
  }
  writingState.sidebarCollapsed = readBrowserSetting("writingSidebarCollapsed") === "true";
  writingSetSidebarCollapsed(writingState.sidebarCollapsed, false);
  writingState.headingCollapsed = readBrowserSetting("writingHeadingCollapsed") === "true";
  writingSetHeadingCollapsed(writingState.headingCollapsed, false);
  $("#writing-image-input").addEventListener("change", event => {
    if (writingMarkdown.picker === writingState.doc && event.target.files.length) writingMarkdownInsertImages([...event.target.files]);
    event.target.value = "";
  });
  $("#mode-writing").addEventListener("click", () => act(() => writingRun(() => writingSwitch("writing"))));
  $("#mode-reading").addEventListener("click", () => act(() => writingRun(() => writingSwitch("reading"))));
  $("#writing-sidebar-toggle").addEventListener("click", () => writingSetSidebarCollapsed(!writingState.sidebarCollapsed));
  $("#writing-heading-toggle").addEventListener("click", () => writingSetHeadingCollapsed(!writingState.headingCollapsed));
  $("#writing-new").addEventListener("click", () => writingShowDialog("create"));
  $("#writing-folder").addEventListener("click", () => writingShowDialog("create", "folder"));
  $$("[data-new-writing]").forEach(node => node.addEventListener("click", () => writingShowDialog("create", "file", node.dataset.newWriting)));
  $("#writing-search").addEventListener("input", writingRenderTree);
  $("#writing-refresh").addEventListener("click", () => act(() => writingRun(writingRefresh)));
  $("#writing-open-folder").addEventListener("click", () => act(() => writingRequest({ operation: "open-folder" })));
  $("#writing-copy-path").addEventListener("click", event => act(() => writingRun(writingCopyPath), event.currentTarget));
  $("#writing-save").addEventListener("click", () => act(writingFlush));
  $("#writing-source").addEventListener("input", writingChanged);
  $("#writing-word").addEventListener("input", writingChanged);
  $("#writing-word").addEventListener("paste", event => { event.preventDefault(); document.execCommand("insertText", false, event.clipboardData.getData("text/plain")); writingChanged(); });
  $("#writing-word").addEventListener("drop", event => event.preventDefault());
  $("#writing-preview-toggle").addEventListener("click", () => {
    if (writingState.busy) return;
    const view = writingState.doc?.format === "tex" ? writingLatex : writingMarkdown;
    writingState.preview = view.reading || !writingState.preview;
    view.reading = false;
    writingSetHeadingCollapsed(writingState.preview, false);
    writingUpdatePreview();
  });
  $("#writing-reading-open-paper").addEventListener("click", () => readwritePick("paper"));
  $("#writing-read-toggle").addEventListener("click", () => act(() => writingRun(async () => {
    await writingFlush();
    const view = writingState.doc?.format === "tex" ? writingLatex : writingMarkdown;
    view.reading = !view.reading;
    writingUpdatePreview();
    if (!view.reading) {
      if (writingState.doc?.format === "tex") $("#writing-source").focus();
      else writingMarkdown.editor?.focus();
    }
  })));
  $("#writing-rename").addEventListener("click", () => writingShowDialog("rename", "file", "", writingState.doc.path));
  $("#writing-trash").addEventListener("click", () => writingShowDialog("trash", "file", "", writingState.doc.path));
  $("#writing-folder-rename").addEventListener("click", () => writingShowDialog("rename", "folder", "", writingState.folder));
  $("#writing-folder-up").addEventListener("click", () => act(() => writingRun(() => writingMoveFolder("up"))));
  $("#writing-folder-down").addEventListener("click", () => act(() => writingRun(() => writingMoveFolder("down"))));
  $("#writing-folder-trash").addEventListener("click", () => writingShowDialog("trash", "folder", "", writingState.folder));
  $("#writing-save-copy").addEventListener("click", () => writingShowDialog("copy", "file", writingState.doc.format));
  $("#writing-reload").addEventListener("click", () => writingShowDialog("reload"));
  $("#writing-form").addEventListener("submit", event => { event.preventDefault(); act(() => writingRun(writingSubmit), $("#writing-confirm")); });
  document.addEventListener("keydown", event => {
    if (writingState.mode !== "writing" && !readwrite.active || document.querySelector('dialog[open]:not(#reader-dialog)')) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); act(writingFlush); }
  });
  window.addEventListener("beforeunload", event => {
    const doc = writingState.doc;
    if (doc && doc.content !== doc.saved) { writingRemember(doc); event.preventDefault(); event.returnValue = ""; }
  });
}
