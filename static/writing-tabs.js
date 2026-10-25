"use strict";

function installWritingTabs() {
  const tabs = el("nav", { id: "writing-tabs", "aria-label": "已打开的文稿" });
  $(".writing-toolbar").prepend(tabs);
  tabs.addEventListener("keydown", event => {
    const current = event.target.closest(".writing-tab-select");
    if (!current || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...tabs.querySelectorAll(".writing-tab-select")], index = buttons.indexOf(current);
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
      : (index + (event.key === "ArrowLeft" ? -1 : 1) + buttons.length) % buttons.length;
    buttons[next].focus();
  });
}

function writingRenderTabs() {
  const tabs = $("#writing-tabs");
  if (!tabs) return;
  const scroll = tabs.scrollLeft;
  tabs.replaceChildren(...writingState.tabs.map(doc => {
    const active = doc === writingState.doc;
    const select = button(doc.name, () => {
      if (!active) act(() => writingRun(() => writingOpen(doc.path)));
    }, "secondary", "", { class: "writing-tab-select", "aria-current": active ? "page" : undefined, "aria-label": `切换到 ${doc.path}` });
    const close = button("×", () => act(() => writingRun(() => writingCloseTab(doc))), "secondary", "", {
      class: "writing-tab-close", "aria-label": `关闭标签 ${doc.path}`
    });
    return el("div", { class: `writing-tab${active ? " active" : ""}`, dataset: { path: doc.path } }, select, close);
  }));
  tabs.scrollLeft = scroll;
  const reveal = () => {
    const current = tabs.querySelector(".active");
    if (!current) return;
    const box = current.getBoundingClientRect(), parent = tabs.getBoundingClientRect();
    if (box.left < parent.left) tabs.scrollLeft -= parent.left - box.left;
    else if (box.right > parent.right) tabs.scrollLeft += box.right - parent.right;
  };
  reveal(); requestAnimationFrame(reveal);
}

function writingCaptureTab() {
  const doc = writingState.doc;
  if (!doc) return;
  const panes = ["#writing-source", "#writing-editors", "#writing-preview", "#writing-latex-pages"];
  doc.tabView = {
    panes: panes.map(selector => ({ selector, top: $(selector).scrollTop, left: $(selector).scrollLeft })),
    selection: [$("#writing-source").selectionStart, $("#writing-source").selectionEnd],
    markdownScroll: doc.format === "md" ? writingMarkdown.editor?.getScrollInfo() : null
  };
  if (doc.format === "md") doc.editorDoc = writingMarkdown.editor?.getDoc();
}

function writingRestoreTab(doc) {
  const restore = () => {
    if (writingState.doc !== doc) return;
    const view = doc.tabView;
    for (const { selector, top, left } of view?.panes || []) {
      $(selector).scrollTop = top; $(selector).scrollLeft = left;
    }
    if (doc.format === "md" && view?.markdownScroll) {
      writingMarkdownRefresh();
      writingMarkdown.editor.scrollTo(view.markdownScroll.left, view.markdownScroll.top);
    }
    if (doc.format === "tex" && view) $("#writing-source").setSelectionRange(...view.selection);
  };
  // Clear the old manuscript preview now, so its scroll cannot leak into a new
  // tab; the debounced repaint in writingUpdatePreview preserves the new value.
  $("#writing-preview").replaceChildren();
  for (const selector of ["#writing-source", "#writing-editors", "#writing-preview", "#writing-latex-pages"]) {
    $(selector).scrollTop = 0; $(selector).scrollLeft = 0;
  }
  if (doc.format === "md" && (writingState.preview || writingMarkdown.reading)) {
    $("#writing-preview").append(writingRenderMarkdown(doc.content));
  }
  restore();
  requestAnimationFrame(restore);
}

async function writingCloseTab(doc) {
  const index = writingState.tabs.indexOf(doc);
  if (index < 0) return;
  // Never remove a tab before a failed save or failed replacement open.
  if (doc === writingState.doc) {
    await writingFlush();
    const next = writingState.tabs[index + 1] || writingState.tabs[index - 1];
    if (next) await writingOpen(next.path);
    else {
      writingState.doc = null;
      writingMarkdown.reading = false; writingLatex.reading = false;
      writingRenderDocument(); writingRenderTree();
      writingMarkdown.editor?.swapDoc(new CodeMirror.Doc("", "markdown"));
    }
  }
  writingState.tabs.splice(writingState.tabs.indexOf(doc), 1);
  // Release cached editor history/image references when explicitly closed.
  delete doc.editorDoc; delete doc.tabView;
  writingRenderTabs();
  if (writingState.doc) $("#writing-tabs .active .writing-tab-select")?.focus({ preventScroll: true });
  else $("#writing-new").focus({ preventScroll: true });
}

function writingMutateTabs(operation, path, destination) {
  const matches = doc => doc.path === path || doc.path.startsWith(path + "/");
  if (operation === "trash") writingState.tabs = writingState.tabs.filter(doc => !matches(doc));
  else if (operation === "rename") for (const doc of writingState.tabs.filter(matches)) {
    doc.path = destination + doc.path.slice(path.length);
    doc.name = doc.path.split("/").pop();
    // A compiled PDF token is tied to its original path; regenerate on demand.
    delete doc.latexPreview;
  }
}
