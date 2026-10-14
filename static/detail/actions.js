async function changeCover(payload) {
  const id = state.detail.id; const data = await api(`/api/papers/${encodeURIComponent(id)}/cover`, { method: "POST", body: payload });
  if (data.paper) updatePaper(data.paper); await openDetail(id); await loadLibrary(); toast("封面已更新");
}
async function translateAction(p, pause = false) {
  if (!pause) { openTranslationSetup([p]); return; }
  const data = await api(`/api/papers/${encodeURIComponent(p.id)}/${pause ? "pause" : "translate"}`, { method: "POST", body: {} });
  if (data.paper) updatePaper(data.paper); await loadLibrary();
  if (state.detail?.id === p.id && $("#detail-dialog").open) { state.detail = normalizeDetail(await api(`/api/papers/${encodeURIComponent(p.id)}`)); renderDetail(); }
  if (state.reader?.id === p.id) await refreshReader();
  toast(pause ? "已请求暂停" : "已加入全文翻译队列");
}
async function runPaperTask(task) {
  if (task !== "summarize") throw new Error("此论文任务已取消。");
  const id = state.detail.id; toast("正在整理研究速览…", "success", 7000);
  const data = await api(`/api/papers/${encodeURIComponent(id)}/${task}`, { method: "POST", body: {} });
  await loadLibrary(); if (state.detail?.id === id) { state.detail = normalizeDetail(await api(`/api/papers/${encodeURIComponent(id)}`)); renderDetail(); }
  const status = data.paper?.[`${task}_status`] || data.status;
  toast(data.message || (ACTIVE_STATUSES.has(status) ? "任务已排队" : "处理完成，结果已保存"));
}

function openCardInfo(p) {
  const year = el("input", { type: "number", min: "1900", max: String(new Date().getFullYear()), step: "1", value: p.year ?? "", "aria-label": "年份", placeholder: "例如 2025" });
  const journal = el("input", { type: "text", value: p.journal || "", "aria-label": "期刊名字", placeholder: "填写期刊名字" });
  const summary = el("textarea", { rows: "5", value: asText(p.summary), "aria-label": "简单介绍", placeholder: "写下你对这篇文章的简单介绍" });
  const save = el("button", { type: "submit", class: "button primary" }, "保存");
  let selectedFigure = null, figuresLoaded = false;
  const coverPreview = el("div", { class: "card-info-cover-preview" }, imageNode(p.cover_url, { alt: "当前封面" }));
  const coverHint = el("p", { class: "small muted", role: "status" }, "保留当前封面，或从论文插图中选择。" );
  const gallery = el("div", { class: "card-info-cover-gallery", role: "radiogroup", "aria-label": "选择论文封面", hidden: true });
  const chooseCover = button("更换封面", event => void act(async () => {
    gallery.hidden = !gallery.hidden;
    chooseCover.setAttribute("aria-expanded", String(!gallery.hidden));
    chooseCover.textContent = gallery.hidden ? "更换封面" : "收起图片";
    if (gallery.hidden || figuresLoaded) return;
    gallery.replaceChildren(el("p", { class: "small muted", role: "status" }, "正在加载论文插图…"));
    try {
      const paper = normalizeDetail(await api(`/api/papers/${encodeURIComponent(p.id)}`));
      if (!form.isConnected || !$("#edit-dialog").open) return;
      const figures = paper.figures || [];
      gallery.replaceChildren(...figures.map((figure, index) => {
        const radio = el("input", { type: "radio", name: "card-cover-figure", value: figure.id,
          "aria-label": `选择第 ${index + 1} 张插图`, checked: figure.path === paper.cover,
          onchange: () => {
            selectedFigure = figure;
            coverPreview.replaceChildren(imageNode(figure.url, { alt: "待保存封面" }));
            coverHint.textContent = "已选择新封面，点击保存后生效。";
          } });
        return el("label", { class: "card-info-cover-choice" }, radio,
          imageNode(figure.url, { alt: `论文插图 ${index + 1}`, onerror: event => {
            radio.disabled = true; event.currentTarget.replaceWith(el("span", { class: "small muted" }, "图片无法加载"));
          } }), el("span", { class: "small" }, `插图 ${index + 1}${figure.page ? ` · 第 ${figure.page} 页` : ""}`));
      }));
      if (!figures.length) gallery.append(el("p", { class: "small muted" }, "这篇论文没有提取到可选插图，继续使用当前封面。"));
      figuresLoaded = true;
    } catch (error) {
      gallery.replaceChildren(el("p", { class: "small error-text" }, "图片列表加载失败，请收起后重新打开。"));
      throw error;
    }
  }, event.currentTarget), "secondary", "image", { "aria-expanded": "false" });
  const coverEditor = el("section", { class: "card-info-cover-editor", "aria-label": "编辑封面" },
    el("div", { class: "card-info-cover-current" }, coverPreview, el("div", {}, el("h3", {}, "封面"), coverHint, chooseCover)), gallery);
  const form = el("form", { class: "metadata-scroll", "aria-labelledby": "metadata-dialog-title" },
    el("p", { class: "card-info-paper-title" }, titleOf(p)),
    field("年份", year), field("期刊名字", personalJournalPicker(journal)), field("简单介绍", summary), coverEditor,
    el("div", { class: "form-actions" }, button("取消", () => closeDialog("#edit-dialog")), save));
  form.addEventListener("submit", event => { event.preventDefault(); void act(async () => {
    await patchPaper(p.id, { year: year.value === "" ? null : Number(year.value), journal: journal.value.trim(), summary: summary.value.trim() });
    if (selectedFigure) {
      const data = await api(`/api/papers/${encodeURIComponent(p.id)}/cover`, { method: "POST", body: { figure_id: selectedFigure.id } });
      if (data.paper) updatePaper(data.paper);
      renderLibrary();
    }
    closeDialog("#edit-dialog");
    if (state.detail?.id === p.id && $("#detail-dialog").open) renderDetail();
    toast("论文信息已保存");
  }, save); });
  $("#edit-content").replaceChildren(el("div", { class: "dialog-heading metadata-heading" },
    el("h2", { id: "metadata-dialog-title" }, "编辑论文信息"), iconButton("close", "关闭编辑", () => closeDialog("#edit-dialog"))), form);
  openDialog("#edit-dialog"); year.focus();
}

function openMetadata(p) {
  const inputs = {};
  function input(key, type = "text", extra = {}) { const n = el("input", { type, value: p[key] ?? "", ...extra }); inputs[key] = n; return n; }
  const typeSelect = el("select", {}, Object.entries(PAPER_TYPES).map(([value, name]) => el("option", { value }, name))); typeSelect.value = paperType(p);
  const tags = el("input", { value: list(p.tags).join("，"), placeholder: "主题标签" });
  const authors = el("textarea", { value: list(p.authors).map(asText).join("\n"), rows: "3" });
  const summary = el("textarea", { value: asText(p.summary), rows: "3" });
  const conferenceFields = el("section", { class: "inline-fields" }, field("会议全称", input("conference_name")), field("会议简称", input("conference_abbr", "text", { placeholder: "会议简称" })));
  function updateTypeFields() { conferenceFields.classList.toggle("hidden", typeSelect.value !== "conference"); }
  typeSelect.addEventListener("change", updateTypeFields); updateTypeFields();
  const heading = el("div", { class: "dialog-heading metadata-heading" }, el("h2", { id: "metadata-dialog-title" }, "编辑论文信息"), iconButton("close", "关闭编辑", () => closeDialog("#edit-dialog")));
  const form = el("form", { class: "metadata-scroll", "aria-labelledby": "metadata-dialog-title" }, field("文献类型", typeSelect), field("中文标题", input("title_zh", "text", { placeholder: "中文标题" })), field("原文标题", input("title", "text", { required: true })), el("div", { class: "inline-fields" }, field("期刊 / 出版来源全称", personalJournalPicker(input("journal"))), field("来源简称", input("journal_abbr", "text", { placeholder: "来源简称" }))), el("div", { class: "inline-fields" }, field("发表年份", input("year", "number", { min: "1800", max: "2200" })), field("DOI", input("doi", "text", { placeholder: "DOI" }))), field("作者", authors), field("一句话简介", summary), conferenceFields, field("主题标签", tags));
  const save = el("button", { type: "submit", class: "button primary" }, "保存信息");
  form.append(el("div", { class: "inline-fields" }, field("发表时间", input("publication_date", "text", { placeholder: "YYYY-MM-DD，可只填写年份" })), field("发表页码", input("page_range", "text", { placeholder: "例如 38402-38416" }))),
    el("div", { class: "inline-fields" }, field("卷", input("volume")), field("期", input("issue"))), field("文章编号（无传统页码时）", input("article_number")));
  form.append(el("div", { class: "form-actions" }, button("彻底删除", event => act(async () => {
    if (!confirm(`彻底删除《${titleOf(p)}》？PDF、笔记、批注、译文和分组归属将一并删除，无法恢复。再次导入将作为全新论文。`)) return;
    await flushDetailNotes();
    await api(`/api/papers/${encodeURIComponent(p.id)}`, { method: "DELETE" });
    clearPaperBrowserData(p.id); state.selectedPapers.delete(p.id);
    closeDialog("#edit-dialog"); $("#detail-dialog").close(); state.detail = null;
    await loadLibrary(); toast("论文及其笔记和记录已彻底删除");
  }, event.currentTarget), "danger", "trash", { style: { marginRight: "auto" } }), button("取消", () => closeDialog("#edit-dialog")), save));
  form.addEventListener("submit", event => { event.preventDefault(); act(async () => {
    const patch = Object.fromEntries(Object.entries(inputs).map(([key, node]) => [key, key === "year" ? node.value === "" ? null : Number(node.value) : node.value.trim()]));
    patch.paper_type = typeSelect.value;
    if (typeSelect.value !== "conference") { delete patch.conference_name; delete patch.conference_abbr; }
    patch.tags = list(tags.value); patch.authors = authors.value.split("\n").map(x => x.trim()).filter(Boolean); patch.summary = summary.value.trim();
    await patchPaper(p.id, patch); closeDialog("#edit-dialog"); renderDetail(); toast("论文信息已保存");
  }, save); });
  $("#edit-content").replaceChildren(heading, form); openDialog("#edit-dialog");
}

function openCrop(figure) {
  if (!figure) { toast("请先选择一张已提取的论文图片", "warn"); return; }
  let crop = [0, 0, 1, 1], picture = null, dragStart = null;
  const canvas = el("canvas", { width: 800, height: 700, "aria-label": "在所选论文图片上拖动鼠标，框选封面区域" });
  const ctx = canvas.getContext("2d"), selectionLabel = el("span", {}, "正在载入所选图片…");
  const save = button("保存为封面", event => act(async () => { if (!picture) throw new Error("请等待图片载入"); await changeCover({ figure_id: figure.id, bbox: crop }); closeDialog("#crop-dialog"); }, event.currentTarget), "primary", "check", { disabled: true });
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!picture) return;
    ctx.drawImage(picture, 0, 0, canvas.width, canvas.height);
    const [x0, y0, x1, y1] = crop, x = x0 * canvas.width, y = y0 * canvas.height, w = (x1 - x0) * canvas.width, h = (y1 - y0) * canvas.height;
    ctx.fillStyle = "rgba(25,47,29,.35)";
    ctx.fillRect(0, 0, canvas.width, y); ctx.fillRect(0, y + h, canvas.width, canvas.height - y - h); ctx.fillRect(0, y, x, h); ctx.fillRect(x + w, y, canvas.width - x - w, h);
    ctx.strokeStyle = "#779d58"; ctx.lineWidth = 3; ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
    selectionLabel.textContent = `选中 ${Math.round((x1 - x0) * 100)}% 宽 × ${Math.round((y1 - y0) * 100)}% 高`;
  }
  const img = new Image();
  img.onload = () => { picture = img; const scale = Math.min(1, 1300 / img.naturalWidth); canvas.width = Math.round(img.naturalWidth * scale); canvas.height = Math.round(img.naturalHeight * scale); draw(); save.disabled = false; };
  img.onerror = () => { selectionLabel.textContent = "图片载入失败，请选择另一张图片"; };
  function point(event) { const r = canvas.getBoundingClientRect(); return [Math.max(0, Math.min(1, (event.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (event.clientY - r.top) / r.height))]; }
  canvas.addEventListener("pointerdown", event => { if (!picture) return; event.preventDefault(); dragStart = point(event); canvas.setPointerCapture(event.pointerId); });
  canvas.addEventListener("pointermove", event => { if (!dragStart) return; const now = point(event); crop = [Math.min(dragStart[0], now[0]), Math.min(dragStart[1], now[1]), Math.max(dragStart[0], now[0]), Math.max(dragStart[1], now[1])]; draw(); });
  canvas.addEventListener("pointerup", () => { dragStart = null; if (crop[2] - crop[0] < .015 || crop[3] - crop[1] < .015) { crop = [0, 0, 1, 1]; draw(); } });
  canvas.addEventListener("pointercancel", () => { dragStart = null; });
  $("#crop-content").replaceChildren(el("div", { class: "dialog-heading" }, el("div", {}, el("h2", {}, "裁剪所选图片")), iconButton("close", "关闭裁剪", () => closeDialog("#crop-dialog"))), el("div", { class: "crop-controls" }, button("使用完整图片", () => { crop = [0, 0, 1, 1]; draw(); }, "secondary"), selectionLabel), el("div", { class: "crop-preview" }, canvas), el("div", { class: "form-actions" }, button("取消", () => closeDialog("#crop-dialog")), save));
  openDialog("#crop-dialog"); img.src = safeUrl(figure.url);
}
