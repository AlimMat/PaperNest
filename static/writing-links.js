"use strict";

const writingLinks = { active: false, ratio: .5, request: 0, insertion: null, external: null };
const writingInternalHref = path => "papernest://writing/" + path.split("/").map(encodeURIComponent).join("/");

function writingLinkDestination(value) {
  value = value.trim().replace(/^"(.*)"$/, "$1");
  if (/^[A-Za-z]:[\\/]/.test(value)) {
    const path = value.replace(/\\/g, "/");
    return "file:///" + path.slice(0, 2) + path.slice(2).split("/").map(encodeURIComponent).join("/");
  }
  if (/^(https?:|mailto:|file:|papernest:)/i.test(value)) return value.replace(/ /g, "%20");
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) || value.startsWith("\\\\") || value.startsWith("//")) throw Error("请选择网址、普通本机路径或 PaperNest 内容。");
  return value.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/");
}

function writingShowLinkDialog() {
  const cm = writingMarkdown.editor, doc = writingState.doc;
  if (doc?.format !== "md" || writingState.busy) return;
  writingLinks.insertion = { doc, from: cm.getCursor("from"), to: cm.getCursor("to") };
  $("#writing-link-text").value = cm.getSelection() || "";
  $("#writing-link-address").value = "";
  $("#writing-link-search").value = "";
  $("#writing-link-error").textContent = "";
  writingLinkChoices();
  openDialog("#writing-link-dialog");
  $("#writing-link-address").focus();
  act(async () => { await writingRefresh(); writingLinkChoices(); });
}

function writingLinkChoices() {
  const query = $("#writing-link-search").value.toLowerCase().trim();
  const entries = [
    { title: "写作文件夹", detail: "全部文稿", href: writingInternalHref("") },
    ...writingState.entries.map(item => ({ title: (item.kind === "folder" ? "文件夹 · " : "文稿 · ") + item.name, detail: item.path, href: writingInternalHref(item.path) })),
    ...state.papers.map(item => ({ title: "论文 · " + titleOf(item), detail: paperCollections(item).join(" · "), href: "papernest://paper/" + item.id }))
  ].filter(item => `${item.title} ${item.detail}`.toLowerCase().includes(query));
  $("#writing-link-choices").replaceChildren(...entries.map(item => button("", () => {
    $("#writing-link-address").value = item.href;
    if (!$("#writing-link-text").value) $("#writing-link-text").value = item.title.replace(/^(文件夹|文稿|论文) · /, "");
  }, "secondary", "", { class: "readwrite-choice" })).map((node, index) => {
    node.append(el("strong", {}, entries[index].title), el("span", {}, entries[index].detail)); return node;
  }));
}

function writingInsertLink(event) {
  event.preventDefault();
  try {
    const saved = writingLinks.insertion;
    if (!saved || saved.doc !== writingState.doc) throw Error("文稿已切换，请重新插入链接。");
    const address = $("#writing-link-address").value;
    if (!address.trim()) throw Error("请填写链接地址或选择 PaperNest 内容。");
    const href = writingLinkDestination(address);
    const label = ($("#writing-link-text").value.trim() || address).replace(/[\\[\]]/g, "\\$&").replace(/[\r\n]/g, " ");
    if (/[<>\r\n]/.test(href)) throw Error("链接地址不能包含尖括号或换行。");
    const cm = writingMarkdown.editor;
    cm.replaceRange(`[${label}](<${href}>)`, saved.from, saved.to, "+input");
    $("#writing-link-dialog").close(); cm.focus();
  } catch (error) { $("#writing-link-error").textContent = error.message; }
}

function writingBindLinks(content, source) {
  for (const link of content.querySelectorAll("a")) {
    const href = link.getAttribute("href") || "";
    if (/^(https?:|mailto:)/i.test(href)) { link.target = "_blank"; link.rel = "noopener noreferrer"; continue; }
    if (href.startsWith("#")) continue;
    // Never let WebView navigate to file:// or treat a relative path as an app route.
    link.addEventListener("click", event => {
      event.preventDefault();
      act(() => writingOpenLink(href, source));
    });
    link.addEventListener("auxclick", event => event.preventDefault());
  }
}

async function writingOpenLink(href, source = writingState.doc?.path) {
  if (writingState.busy || readwrite.switching) return;
  const request = ++writingLinks.request;
  await writingFlush();
  const result = await api("/api/writing/link", { method: "POST", body: { href, source } });
  if (request !== writingLinks.request) return;
  if (result.kind === "external") {
    writingLinks.external = result;
    $("#writing-link-external-path").textContent = result.path;
    $("#writing-link-external-help").textContent = result.type === "pdf" ? "此 PDF 不在 PaperNest 文献库，将在默认浏览器中打开原始 PDF。" : "此内容不在 PaperNest 中，将使用系统默认程序打开。";
    openDialog("#writing-link-external"); return;
  }
  if (result.kind === "paper") {
    writingLinksDetach();
    await readwriteSelectPaper(result.id);
    return;
  }
  if (readwrite.active && !(await closeReader())) return;
  if (writingState.mode !== "writing") await writingSwitch("writing");
  if (request !== writingLinks.request) return;
  writingLinksEnter();
  $("#writing-link-reference-title").textContent = result.title;
  const body = $("#writing-link-reference-body");
  body.replaceChildren(); body.scrollTop = 0;
  if (result.kind === "writing") {
    const doc = result.document;
    if (doc.format === "md") body.append(writingRenderMarkdown(doc.content, doc.path));
    else if (doc.format === "docx") {
      const article = el("article", { class: "writing-markdown-content" });
      article.innerHTML = writingSafeWord(doc.content); body.append(article);
    } else {
      const status = el("p", { class: "small" }, "正在排版链接的 LaTeX 文稿…"); body.append(status);
      try {
        const preview = await api("/api/writing/latex-preview", { method: "POST", body: { path: doc.path, revision: doc.revision } });
        if (!writingLinks.active || request !== writingLinks.request) return;
        status.textContent = `只读预览 · ${preview.pages.length} 页`;
        for (const [index, page] of preview.pages.entries()) body.append(el("img", { class: "writing-linked-pdf", src: `/api/writing/latex/${preview.token}/${index + 1}.png`, alt: `第 ${index + 1} 页`, loading: index ? "lazy" : "eager", width: Math.round(page.width * 3), height: Math.round(page.height * 3) }));
      } catch (error) { if (request === writingLinks.request) status.textContent = `预览失败：${error.message}`; }
    }
  } else {
    for (const item of result.entries) {
      const address = result.kind === "papers" ? "papernest://paper/" + item.id : writingInternalHref(item.path);
      body.append(button(item.title || (item.kind === "folder" ? "▸ " : "") + item.name, () => act(() => writingOpenLink(address, source)), "secondary", "", { class: "writing-linked-entry" }));
    }
    if (!result.entries.length) body.append(el("p", { class: "small" }, "此文件夹为空。"));
  }
}

function writingLinksEnter() {
  if (writingLinks.active) return;
  writingLinks.active = true;
  $("main.workspace").append($("#writing-linked-workspace"));
  $("#writing-link-right").append($("#writing-view"));
  $("#writing-linked-workspace").hidden = false;
  requestAnimationFrame(writingMarkdownRefresh);
}

function writingLinksDetach() {
  if (!writingLinks.active) return;
  writingLinks.active = false;
  $("main.workspace").append($("#writing-view"));
  $("#writing-linked-workspace").hidden = true;
  $("#writing-link-reference-body").replaceChildren();
  requestAnimationFrame(writingMarkdownRefresh);
}

function installWritingLinks() {
  const dialog = el("dialog", { id: "writing-link-dialog" },
    el("form", { onsubmit: writingInsertLink },
      el("div", { class: "dialog-heading" }, el("h2", {}, "插入链接"), button("取消", () => $("#writing-link-dialog").close(), "secondary")),
      el("label", { class: "field" }, "显示文字", el("input", { id: "writing-link-text", placeholder: "例如：实验记录、参考论文" })),
      el("label", { class: "field" }, "网址或本地文件／文件夹地址", el("input", { id: "writing-link-address", placeholder: "https://… 或 D:\\资料\\论文.pdf", required: true, autocomplete: "off" })),
      el("p", { class: "small" }, "也可以粘贴“文件地址”，或填写相对于当前文稿的路径。"),
      el("details", {}, el("summary", {}, "从 PaperNest 选择论文、文稿或文件夹"), el("input", { id: "writing-link-search", type: "search", placeholder: "搜索库内内容…", oninput: writingLinkChoices }), el("div", { id: "writing-link-choices" })),
      el("p", { id: "writing-link-error", class: "error", role: "alert" }), el("button", { type: "submit", class: "button primary" }, "插入链接")));
  const external = el("dialog", { id: "writing-link-external" }, el("h2", {}, "打开外部本地链接"), el("p", { id: "writing-link-external-help" }), el("p", { id: "writing-link-external-path" }),
    el("div", { class: "writing-linked-buttons" }, button("取消", () => external.close(), "secondary"), button("打开", event => act(async () => {
      const target = writingLinks.external;
      if (!target) return;
      await api("/api/writing/link-open", { method: "POST", body: { token: target.token } }); external.close();
    }, event.currentTarget), "primary")));
  const divider = el("div", { id: "writing-link-divider", role: "separator", tabindex: "0", "aria-label": "调整链接阅读与写作的宽度", "aria-orientation": "vertical", "aria-valuemin": "30", "aria-valuemax": "70", "aria-valuenow": "50" });
  const split = el("section", { id: "writing-linked-workspace", hidden: true }, el("section", { class: "writing-link-reference", "aria-label": "链接内容（只读）" },
    el("header", { class: "writing-link-reference-bar" }, el("strong", { id: "writing-link-reference-title" }), button("关闭左栏", () => { ++writingLinks.request; writingLinksDetach(); }, "secondary")),
    el("div", { id: "writing-link-reference-body" })), divider, el("div", { id: "writing-link-right" }));
  document.body.append(dialog, external);
  $("main.workspace").append(split);
  const ratio = value => {
    writingLinks.ratio = Math.max(.3, Math.min(.7, value));
    split.style.setProperty("--writing-link-left", `${writingLinks.ratio * 100}%`);
    divider.setAttribute("aria-valuenow", Math.round(writingLinks.ratio * 100));
  };
  divider.addEventListener("pointerdown", event => { if (event.button !== 0) return; event.preventDefault(); divider.setPointerCapture(event.pointerId); });
  divider.addEventListener("pointermove", event => { if (!divider.hasPointerCapture(event.pointerId)) return; const box = split.getBoundingClientRect(); ratio((event.clientX - box.left) / box.width); });
  divider.addEventListener("pointerup", event => { if (divider.hasPointerCapture(event.pointerId)) divider.releasePointerCapture(event.pointerId); });
  divider.addEventListener("keydown", event => { if (!["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return; event.preventDefault(); ratio(event.key === "Home" ? .5 : writingLinks.ratio + (event.key === "ArrowLeft" ? -.02 : .02)); });
}
