"use strict";

const writingLatex = { reading: false, compiling: null };

function writingLatexTemplateField() {
  const dialog = writingState.dialog;
  $("#writing-latex-language-field").hidden = !(dialog?.operation === "create" && dialog.kind === "file" && $("#writing-format").value === "tex");
}

function writingLatexLanguage(language) {
  if (writingState.busy || writingState.doc?.format !== "tex") return;
  const source = $("#writing-source"), content = source.value;
  // Preserve all body text and package declarations; custom publisher classes
  // remain untouched. Changing typesetting is never translation of the text.
  const pattern = /^[ \t]*\\documentclass\s*(?:\[([^\]]*)\])?\s*\{(article|report|book|ctexart|ctexrep|ctexbook)\}/m;
  const match = pattern.exec(content);
  if (!match) { toast("这是自定义文档类，请在源码中调整排版，或新建中文／英文模板。", "warning"); return; }
  const chinese = language === "zh";
  const classes = { article: "ctexart", report: "ctexrep", book: "ctexbook", ctexart: "article", ctexrep: "report", ctexbook: "book" };
  const currentChinese = match[2].startsWith("ctex");
  if (currentChinese === chinese) return;
  const options = (match[1] || "").split(",").map(value => value.trim()).filter(value => value && !/^(UTF8|GBK|fontset\s*=|scheme\s*=)/i.test(value));
  if (chinese) options.unshift("UTF8");
  const replacement = `\\documentclass${options.length ? `[${options.join(",")}]` : ""}{${classes[match[2]]}}`;
  source.focus(); source.setSelectionRange(match.index, match.index + match[0].length);
  document.execCommand("insertText", false, replacement);
  writingChanged();
  toast(chinese ? "已切换中文排版，正文保持不变。" : "已切换英文排版，正文保持不变。含中文正文时请使用中文排版。");
}

function writingLatexClass(kind) {
  if (writingState.busy || writingState.doc?.format !== "tex" || !["article", "report", "book"].includes(kind)) return;
  const source = $("#writing-source"), content = source.value;
  const pattern = /^[ \t]*\\documentclass\s*(?:\[([^\]]*)\])?\s*\{(article|report|book|ctexart|ctexrep|ctexbook)\}/m;
  const match = pattern.exec(content);
  if (!match) { toast("这是自定义文档类，请在源码中调整排版。", "warning"); return; }
  const chinese = match[2].startsWith("ctex"), classes = { article: "ctexart", report: "ctexrep", book: "ctexbook" };
  const next = chinese ? classes[kind] : kind;
  if (match[2] === next) return;
  const options = match[1] ? `[${match[1]}]` : "";
  source.focus(); source.setSelectionRange(match.index, match.index + match[0].length);
  document.execCommand("insertText", false, `\\documentclass${options}{${next}}`);
  writingChanged(); toast(`已切换为 ${kind} 文档，正文保持不变。`);
}

function writingLatexUpdate(doc, visible) {
  $("#writing-latex-preview").hidden = !visible;
  if (!visible) return;
  const preview = doc.latexPreview;
  const status = $("#writing-latex-status");
  $("#writing-latex-compile").disabled = Boolean(preview?.pending);
  $("#writing-latex-compile").textContent = preview?.pending ? "编译中…" : "重新编译";
  const stale = preview?.content !== doc.content;
  $("#writing-latex-preview").classList.toggle("latex-status-needed", Boolean(preview?.pending || preview?.error || stale || !preview?.token));
  status.textContent = preview?.pending ? "正在用 XeLaTeX 排版…" : preview?.error ? (preview.token ? "编译失败，下面保留上次成功的 PDF" : "编译未成功，请修改源码后重新编译") : stale && preview?.token ? "内容已更改，点击重新编译更新预览" : preview?.token ? `PDF · ${preview.pages.length} 页` : "首次预览将自动编译";
  const error = $("#writing-latex-error");
  error.hidden = !preview?.error;
  error.textContent = preview?.error || "";
  const warnings = $("#writing-latex-warnings");
  warnings.hidden = !preview?.warnings?.length;
  warnings.textContent = preview?.warnings?.length ? "排版提示（如缺字，请使用中文排版）：\n" + preview.warnings.join("\n") : "";
  const download = $("#writing-latex-download");
  download.hidden = !preview?.token;
  if (preview?.token) download.href = `/api/writing/latex/${preview.token}/document.pdf`;
  const pages = $("#writing-latex-pages");
  if (pages.dataset.token !== (preview?.token || "")) {
    pages.dataset.token = preview?.token || "";
    pages.replaceChildren();
    for (const [index, size] of (preview?.pages || []).entries()) {
      const img = el("img", { src: `/api/writing/latex/${preview.token}/${index + 1}.png`, alt: `PDF 第 ${index + 1} 页`, loading: index ? "lazy" : "eager", width: Math.round(size.width * 3), height: Math.round(size.height * 3) });
      img.addEventListener("error", () => { status.textContent = "页面加载失败或预览已过期，请重新编译。"; });
      pages.append(el("figure", {}, img, el("figcaption", {}, `第 ${index + 1} 页 / 共 ${preview.pages.length} 页`)));
    }
    pages.scrollTop = 0;
  }
  if (!preview) writingLatexCompile();
}

async function writingLatexCompile() {
  const doc = writingState.doc;
  if (doc?.format !== "tex" || doc.latexPreview?.pending) return;
  const previous = doc.latexPreview;
  const preview = doc.latexPreview = { ...previous, pending: true, error: "" };
  const update = () => { if (writingState.doc === doc) writingLatexUpdate(doc, writingState.preview || writingLatex.reading); };
  update();
  try {
    // A document switch may leave a real XeLaTeX process finishing in the
    // background. Wait for it before starting the next local preview.
    while (writingLatex.compiling) await writingLatex.compiling.catch(() => {});
    if (writingState.doc !== doc) { doc.latexPreview = previous; return; }
    await writingFlush();
    if (writingState.doc !== doc) { doc.latexPreview = previous; return; }
    const content = doc.content;
    const request = api("/api/writing/latex-preview", { method: "POST", body: { path: doc.path, revision: doc.revision } });
    writingLatex.compiling = request;
    let result;
    try { result = await request; }
    finally { if (writingLatex.compiling === request) writingLatex.compiling = null; }
    // Compiling does not lock the editor. A result of older text remains clearly
    // marked stale, and completion for another document cannot replace this UI.
    Object.assign(preview, result, { content });
  } catch (error) { preview.error = error.message; }
  finally { preview.pending = false; update(); }
}

function installWritingLatex() {
  $("#writing-format").addEventListener("change", writingLatexTemplateField);
  $("#writing-latex-compile").addEventListener("click", writingLatexCompile);
}
