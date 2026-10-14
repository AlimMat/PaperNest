"use strict";

const readwrite = { active: false, ratio: .5, picker: "paper", switching: false };

function readwriteSync() {
  const back = $(".reader-back");
  if (back) back.replaceChildren(icon("chevron"), readwrite.active ? "更换论文" : writingState.mode === "writing" ? "返回写作" : "文献库");
  const open = $("#reader-open-writing");
  if (open) open.hidden = readwrite.active;
}

async function readwriteEnter() {
  if (readwrite.active) return;
  if (!readerScrollActive()) { readwritePick("paper"); return; }
  await writingFlush();
  await writingRefresh();
  writingLinksDetach();
  readerPreserveLayout(() => {
    readwrite.active = true;
    $("#reader-dialog").classList.add("readwrite-active");
    $("#readwrite-writing-host").append($("#writing-view"));
    $("#writing-view").hidden = false;
    $("#readwrite-writing").hidden = false;
    $("#readwrite-divider").hidden = false;
    readwriteSetRatio(readwrite.ratio);
  });
  readwriteSync();
  requestAnimationFrame(writingMarkdownRefresh);
}

function readwriteDetach() {
  if (!readwrite.active) return;
  readwrite.active = false;
  $("main.workspace").append($("#writing-view"));
  $("#writing-view").hidden = writingState.mode !== "writing";
  $("#reader-dialog").classList.remove("readwrite-active");
  $("#readwrite-writing").hidden = true;
  $("#readwrite-divider").hidden = true;
  readwriteSync();
  requestAnimationFrame(writingMarkdownRefresh);
}

async function readwriteOnlyReading() {
  await writingFlush();
  readerPreserveLayout(readwriteDetach);
}

async function readwriteOnlyWriting() {
  await writingFlush();
  if (await closeReader()) await writingSwitch("writing");
}

function readwritePick(kind) {
  readwrite.picker = kind;
  $("#readwrite-picker-title").textContent = kind === "paper" ? "选择左侧阅读的论文" : "选择右侧写作的文稿";
  $("#readwrite-search").value = "";
  $("#readwrite-search").placeholder = kind === "paper" ? "搜索论文标题、分组…" : "搜索文稿名称、文件夹…";
  readwriteRenderPicker();
  openDialog("#readwrite-picker");
  $("#readwrite-search").focus();
  if (kind === "writing") act(async () => { await writingRefresh(); readwriteRenderPicker(); });
}

function readwriteRenderPicker() {
  const query = $("#readwrite-search").value.trim().toLowerCase();
  const paper = readwrite.picker === "paper";
  const entries = paper ? state.papers.map(item => ({ id: item.id, title: titleOf(item), detail: paperCollections(item).join(" · ") }))
    : writingState.entries.filter(item => item.kind === "file").map(item => ({ id: item.path, title: item.name, detail: item.path }));
  const matches = entries.filter(item => `${item.title} ${item.detail}`.toLowerCase().includes(query));
  const list = $("#readwrite-picker-list");
  list.replaceChildren(...matches.map(item => button("", () => act(() => readwriteSelect(item.id)), "secondary", "", { class: "readwrite-choice", disabled: readwrite.switching })));
  [...list.children].forEach((node, index) => node.append(el("strong", {}, matches[index].title), el("span", {}, matches[index].detail)));
  if (!matches.length) list.append(el("p", { class: "small" }, query ? "没有匹配的内容。" : paper ? "文献库中还没有论文，请先在阅读文献页面导入 PDF。" : "还没有文稿，关闭此窗口后可点击“新建文稿”。"));
}

async function readwriteSelect(id) {
  if (readwrite.switching) return;
  readwrite.switching = true;
  readwriteRenderPicker();
  const kind = readwrite.picker;
  try {
    if (kind === "writing") await writingRun(() => writingOpen(id));
    else {
      if (readwrite.active) await writingFlush();
      // Keep the same editor node while the existing reader saves and changes PDF.
      if (!readerScrollActive() || state.reader.id !== id) await openReader(id);
      if (!readerScrollActive() || state.reader.id !== id) return;
      await readwriteEnter();
    }
    $("#readwrite-picker").close();
    readwriteSync();
  } finally { readwrite.switching = false; readwriteRenderPicker(); }
}

async function readwriteSelectPaper(id) {
  if (readwrite.switching) return;
  readwrite.switching = true;
  try {
    await writingFlush();
    if (!readerScrollActive() || state.reader.id !== id) await openReader(id);
    if (readerScrollActive() && state.reader.id === id) await readwriteEnter();
  } finally { readwrite.switching = false; }
}

function readwriteSetRatio(value) {
  readwrite.ratio = Math.max(.3, Math.min(.7, value));
  $("#reader-dialog").style.setProperty("--readwrite-left", `${readwrite.ratio * 100}%`);
  $("#readwrite-divider").setAttribute("aria-valuenow", Math.round(readwrite.ratio * 100));
}

function installReadwrite() {
  $("#writing-open-reading").addEventListener("click", () => readwritePick("paper"));
  $("#readwrite-choose-writing").addEventListener("click", () => readwritePick("writing"));
  $("#readwrite-new-writing").addEventListener("click", () => writingShowDialog("create"));
  $("#readwrite-only-reading").addEventListener("click", () => act(readwriteOnlyReading));
  $("#readwrite-only-writing").addEventListener("click", () => act(readwriteOnlyWriting));
  $("#readwrite-search").addEventListener("input", readwriteRenderPicker);
  const divider = $("#readwrite-divider");
  divider.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    event.preventDefault(); divider.setPointerCapture(event.pointerId);
  });
  divider.addEventListener("pointermove", event => {
    if (!divider.hasPointerCapture(event.pointerId)) return;
    const box = $("#reader-dialog").getBoundingClientRect();
    readwriteSetRatio((event.clientX - box.left) / box.width);
  });
  divider.addEventListener("pointerup", event => { if (divider.hasPointerCapture(event.pointerId)) divider.releasePointerCapture(event.pointerId); });
  divider.addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
    event.preventDefault(); readwriteSetRatio(event.key === "Home" ? .5 : readwrite.ratio + (event.key === "ArrowLeft" ? -.02 : .02));
  });
}
