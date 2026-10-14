"use strict";

async function openSettings(initialPanel = "appearance") {
  function preferenceRange(key, label, min, max) {
    return el("div", { class: "preference-control" }, el("label", {}, label), el("input", { type: "range", min, max, step: 1, value: state.settings[key] ?? DEFAULT_PREFERENCES[key], dataset: { preference: key }, "aria-label": label, oninput: event => changePreference({ [key]: Number(event.target.value) }) }), el("output", { dataset: { preferenceOutput: key } }, `${state.settings[key]} px`));
  }
  const themes = el("div", { class: "theme-grid" }, THEME_CHOICES.map(([value, name]) => el("button", { type: "button", class: `theme-choice ${state.settings.theme === value ? "selected" : ""}`, dataset: { themeChoice: value }, "aria-pressed": state.settings.theme === value, onclick: () => changePreference({ theme: value }) }, el("span", { class: "theme-swatch", "aria-hidden": "true" }), name)));
  const panels = [
    ["appearance", "外观与字号", el("div", {},
      el("h3", {}, "阅读主题"), themes,
      el("section", { class: "settings-section" }, el("h3", {}, "PDF 背景"),
        el("div", { class: "preference-control" }, el("label", { for: "pdf-background-color" }, "页面周围背景"),
          el("input", { type: "color", id: "pdf-background-color", "aria-label": "PDF 周围背景颜色", dataset: { preference: "pdf_background" }, oninput: event => changePreference({ pdf_background: event.target.value }) }),
          button("跟随主题", () => changePreference({ pdf_background: "theme" }))),
        el("p", { class: "small muted" }, "纸张底色"),
        el("div", { class: "pdf-paper-choices" }, [["#ffffff", "原始白色"], ["#fff8e7", "暖米色"], ["#e8f2e5", "护眼绿"], ["#eeeeee", "浅灰色"]].map(([color, label]) =>
          button(label, () => changePreference({ pdf_paper_color: color }), "secondary", "", { dataset: { paperColor: color }, style: { "--swatch-color": color }, "aria-pressed": state.settings.pdf_paper_color === color }))),
        el("p", { class: "small muted" }, "纸张底色只改变阅读显示，也会轻微影响插图颜色；原始白色保留原图色彩。")),
      el("section", { class: "settings-section" }, el("h3", {}, "字号"),
        preferenceRange("ui_font_size", "界面字号", 14, 22),
        preferenceRange("reader_font_size", "笔记字号", 14, 28),
        el("div", { class: "preference-preview" }, "这行文字用来展示笔记字号的大小。"),
        el("p", { class: "small muted" }, "PDF 正文大小通过阅读页的缩放调节，保持原有排版。")),
      el("section", { class: "settings-section" }, el("h3", {}, "笔记栏"),
        preferenceRange("reader_notes_width", "笔记栏宽度", 260, 720),
        el("p", { class: "small muted" }, "也可以拖动 PDF 与笔记之间的分隔线。")))],
    ["journals", "期刊信息", journalCataloguePanel()],
    ["data", "文献与备份", el("div", {}, el("h3", {}, "本地文献库"), el("p", { class: "settings-path" }, state.status?.data_dir || "本机文献库"), el("div", { class: "settings-data-actions" }, el("a", { href: "/api/export", class: "button secondary", download: "PaperNest-library-backup.zip" }, icon("download"), "导出完整备份")), el("p", { class: "small muted" }, "删除论文会彻底清除 PDF、笔记和历史记录；再次导入将作为全新论文。"))],
    ["about", "关于", el("div", { class: "about-ezread" }, el("img", { src: "/static/papernest-icon.png", width: "84", height: "84", alt: "PaperNest" }), el("h3", {}, "PaperNest"), el("p", { class: "small muted" }, state.status?.version ? `版本 ${state.status.version} · 本地论文阅读器` : "本地论文阅读器"))]
  ];
  const nav = el("div", { class: "settings-tabs", role: "tablist", "aria-label": "设置分类" });
  const body = el("div", { class: "settings-panels" });
  function selectPanel(id, focus = false) {
    $$("[role=tab]", nav).forEach(tab => { const selected = tab.dataset.panel === id; tab.setAttribute("aria-selected", String(selected)); tab.tabIndex = selected ? 0 : -1; if (selected && focus) tab.focus(); });
    $$("[role=tabpanel]", body).forEach(panel => { panel.hidden = panel.id !== `settings-panel-${id}`; });
    footer.hidden = id !== "appearance";
    $("#settings-dialog").scrollTop = 0;
  }
  for (const [id, name, content] of panels) {
    const tab = el("button", { role: "tab", id: `settings-tab-${id}`, dataset: { panel: id }, "aria-controls": `settings-panel-${id}`, onclick: () => selectPanel(id) }, name);
    nav.append(tab); body.append(el("section", { role: "tabpanel", id: `settings-panel-${id}`, "aria-labelledby": tab.id }, content));
  }
  nav.addEventListener("keydown", event => {
    const tabs = $$("[role=tab]", nav), index = tabs.indexOf(document.activeElement);
    if (index < 0) return;
    const offset = ["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : ["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 0;
    if (offset) { event.preventDefault(); selectPanel(tabs[(index + offset + tabs.length) % tabs.length].dataset.panel, true); }
  });
  const footer = el("div", { class: "preference-status" }, el("p", { class: "save-hint", id: "preference-save-status", role: "status" }));
  $("#settings-content").replaceChildren(el("div", { class: "dialog-heading" }, el("h2", {}, "设置"), iconButton("close", "关闭设置", () => { void flushPreferences(); closeDialog("#settings-dialog"); })), nav, body, footer);
  $("#settings-dialog").classList.add("settings-dialog-wide"); openDialog("#settings-dialog"); selectPanel(panels.some(([id]) => id === initialPanel) ? initialPanel : "appearance"); syncPreferenceControls();
}
