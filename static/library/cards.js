function renderLibrary() {
  if (draggingPaperIds.length) { paperDragDeferredRender = true; return; }
  if ($("#queue-dialog").open) { renderNav(); return; }
  paperLayoutCleanup?.(); paperLayoutCleanup = null;
  paperLayoutObserver?.disconnect(); paperLayoutObserver = null;
  renderNav();
  selectOptions("#filter-journal", [...new Set(state.papers.map(journalOf))].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" })), "所有出版来源");
  $("#library-view").setAttribute("aria-label", state.collection || VIEW_NAMES[state.view] || VIEW_NAMES.all);
  const hasFilters = Boolean(state.query || $$(".filter-group select").some(s => s.value));
  $("#clear-filters").classList.toggle("hidden", !hasFilters);
  syncFilterTriggers();
  const grid = $("#paper-grid"), empty = $("#empty-state");
  grid.classList.remove("masonry", "is-laid-out"); grid.style.height = "";
  if (state.loading) { grid.replaceChildren(...Array.from({ length: 6 }, () => el("div", { class: "skeleton-card" }))); empty.classList.add("hidden"); return; }
  const papers = filteredPapers(); $("#result-count").textContent = `${papers.length} 篇论文${hasFilters ? ` / 共 ${state.papers.length} 篇` : ""}`;
  empty.classList.toggle("hidden", state.papers.length > 0); grid.classList.toggle("hidden", !state.papers.length);
  if (state.papers.length && !papers.length) grid.replaceChildren(el("div", { class: "no-results", style: { columnSpan: "all" } }, el("h3", {}, "暂时没有匹配的论文"), button("查看全部论文", () => { clearFilters(); setView("all"); }, "subtle", "", { style: { marginTop: "20px" } })));
  else if (papers.length) renderMasonry(grid, papers);
  else grid.replaceChildren();
  renderLegend(); renderBulkbar(papers);
}
function measurePaperCardSize(card, minimumWidth, cache) {
  const image = card.querySelector("img"), font = getComputedStyle(document.documentElement).fontSize;
  const key = `${minimumWidth}:${font}:${card.textContent}`;
  const saved = cache.get(card);
  if (saved?.key === key) return saved.size;
  // Cancel the native page scale only for an invisible measuring copy. Fonts
  // and borders then use one physical pixel per logical CSS pixel everywhere.
  const clone = card.cloneNode(true), pixelRatio = window.devicePixelRatio || 1;
  clone.inert = true; clone.setAttribute("aria-hidden", "true");
  Object.assign(clone.style, { position: "fixed", left: "-10000px", top: "0", width: `${minimumWidth}px`, height: "auto", margin: "0", visibility: "hidden", pointerEvents: "none", transform: "none", zoom: String(1 / pixelRatio) });
  const clonedImage = clone.querySelector("img");
  if (clonedImage && image?.naturalWidth) { clonedImage.width = image.naturalWidth; clonedImage.height = image.naturalHeight; }
  document.body.append(clone);
  const description = clone.querySelector(".card-description");
  // Measure the actual wrapping, not the character count: only this paper grows.
  description.style.display = "block"; description.style.webkitLineClamp = "unset";
  const maximumHeight = parseFloat(getComputedStyle(description).lineHeight) * 3;
  const fits = width => {
    clone.style.width = `${width}px`;
    return description.scrollHeight <= maximumHeight + 1;
  };
  let width = minimumWidth;
  if (!fits(width)) {
    let low = Math.ceil(minimumWidth), high = 1920;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (fits(middle)) high = middle; else low = middle + 1;
    }
    width = low;
  }
  clone.style.width = `${width}px`;
  const height = Math.ceil(clone.getBoundingClientRect().height * pixelRatio);
  const size = { width, height };
  clone.remove(); cache.set(card, { key, size });
  return size;
}
function paperLayoutMetrics(grid = $("#paper-grid")) {
  const container = grid.parentElement, containerStyle = getComputedStyle(container);
  const sidebar = $(".sidebar"), gap = Math.round((Number.parseFloat(getComputedStyle(grid).columnGap) || 0) * 10) / 10;
  const padding = (Number.parseFloat(containerStyle.paddingLeft) || 0) + (Number.parseFloat(containerStyle.paddingRight) || 0);
  const sidebarWidth = sidebar.getBoundingClientRect().width;
  // Preserve the original compact width for papers with short descriptions.
  const cardWidth = Math.round((1920 - sidebarWidth - padding - 4 * gap) / 5 * 10) / 10;
  return { cardWidth, gap, available: container.clientWidth - padding,
    minimumWidth: sidebarWidth + padding + 2 * cardWidth + gap };
}
function renderMasonry(grid, papers) {
  const cards = papers.map(renderCard);
  const geometry = new WeakMap();
  grid.classList.add("masonry");
  grid.replaceChildren(...cards);
  let scheduled = false;
  const layout = () => {
    scheduled = false;
    if (!grid.isConnected || !grid.classList.contains("masonry") || grid.firstElementChild !== cards[0]) return;
    const metrics = paperLayoutMetrics(grid), width = metrics.cardWidth, gap = metrics.gap;
    if (metrics.available <= 0 || width <= 0) return;
    grid.style.gridTemplateColumns = "none";
    let x = 0, y = 0, rowHeight = 0, usedWidth = 0;
    for (const card of cards) {
      const size = measurePaperCardSize(card, width, geometry);
      const cardWidth = Math.min(size.width, metrics.available), height = size.height;
      if (x && x + cardWidth > metrics.available + .5) { x = 0; y += rowHeight + gap; rowHeight = 0; }
      card.style.width = `${cardWidth}px`;
      card.style.height = `${height}px`;
      card.style.left = `${x}px`; card.style.top = `${y}px`;
      usedWidth = Math.max(usedWidth, x + cardWidth);
      rowHeight = Math.max(rowHeight, height); x += cardWidth + gap;
    }
    grid.style.width = `${usedWidth}px`;
    grid.style.height = `${y + rowHeight}px`;
    grid.classList.add("is-laid-out");
  };
  const schedule = () => { if (!scheduled) { scheduled = true; requestAnimationFrame(layout); } };
  cards.forEach(card => card.querySelector("img")?.addEventListener("load", schedule));
  if (window.ResizeObserver) {
    paperLayoutObserver = new ResizeObserver(schedule);
    paperLayoutObserver.observe(grid);
    paperLayoutObserver.observe(grid.parentElement);
    cards.forEach(card => {
      paperLayoutObserver.observe(card);
      for (const selector of [".card-body", ".card-content"]) { const part = card.querySelector(selector); if (part) paperLayoutObserver.observe(part); }
    });
  } else {
    window.addEventListener("resize", schedule);
    paperLayoutCleanup = () => window.removeEventListener("resize", schedule);
  }
  schedule();
}
function renderCard(p) {
  const rank = rankAppearance(p);
  const edit = event => { event.stopPropagation(); if (state.selectionMode) togglePaperSelection(p.id); else openCardInfo(p); };
  const cover = el("div", { class: "card-cover" }, imageNode(p.cover_url, { alt: "论文封面", draggable: "false", onerror: event => event.currentTarget.replaceWith(placeholderImage()) }));
  const body = el("div", { class: "card-body" },
    el("h2", { class: "card-title" }, titleOf(p)),
    el("div", { class: "card-content" }, cover,
    el("div", { class: "card-info-lines" },
      el("button", { type: "button", class: "card-info-line card-year", "aria-label": "编辑年份", onclick: edit }, el("span", { class: "card-field-label" }, "年份"), el("span", {}, p.year || "点击填写")),
      el("button", { type: "button", class: "card-info-line card-journal-name", "aria-label": "编辑期刊名字", onclick: edit }, el("span", { class: "card-field-label" }, "期刊"), el("span", {}, asText(p.journal).trim() || "点击填写")),
      el("button", { type: "button", class: "card-info-line card-summary", "aria-label": "编辑简单介绍", onclick: edit }, el("span", { class: "card-field-label" }, "介绍"), el("span", { class: "card-description" }, asText(p.summary).trim() || "点击填写")))));
  const activate = () => state.selectionMode ? togglePaperSelection(p.id) : act(() => openReader(p.id));
  let dragStarted = false;
  return el("article", { class: `paper-card text-paper-card paper-${rank.type} tier-${rank.tier} ${state.selectionMode && state.selectedPapers.has(p.id) ? "is-selected" : ""}`, dataset: { paperId: p.id }, draggable: "true", tabindex: "0", role: "group", "aria-label": `阅读论文：${titleOf(p)}`, ondragstart: event => {
    if (event.target.closest("button, a")) { event.preventDefault(); return; }
    draggingPaperIds = state.selectionMode && state.selectedPapers.has(p.id) ? [...state.selectedPapers] : [p.id];
    dragStarted = true; event.currentTarget.classList.add("is-dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-ezread-papers", JSON.stringify(draggingPaperIds));
    startPaperDragPreview(event, p);
  }, ondrag: positionPaperDragPreview, ondragend: () => { endPaperDrag(); setTimeout(() => { dragStarted = false; }, 0); },
  oncontextmenu: event => { event.preventDefault(); event.stopPropagation(); openCardMenu(p, event.clientX, event.clientY); },
  onclick: event => { if (!dragStarted && !event.target.closest("button, a")) activate(); }, onkeydown: event => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "ContextMenu" || event.shiftKey && event.key === "F10") { event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); openCardMenu(p, rect.left + 24, rect.top + 24); }
    else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activate(); }
  } }, body);
}
function togglePaperSelection(id) { if (state.selectedPapers.has(id)) state.selectedPapers.delete(id); else state.selectedPapers.add(id); renderLibrary(); }
function renderBulkbar(papers) {
  const bar = $("#bulkbar"); bar.classList.toggle("hidden", !state.selectionMode);
  if (!state.selectionMode) return;
  const validIds = new Set(state.papers.map(p => p.id)); for (const id of state.selectedPapers) if (!validIds.has(id)) state.selectedPapers.delete(id);
  const collection = state.view === "collection" ? state.collection : "";
  const collectionIds = state.papers.filter(p => state.selectedPapers.has(p.id) && paperHasCollection(p, collection)).map(p => p.id);
  bar.replaceChildren(button("取消", cancelPaperSelection, "secondary", "close", { class: "button secondary bulkbar-cancel", title: "退出多选并清空选择（Esc）" }),
    el("div", { class: "bulkbar-actions" },
      el("span", { class: "bulkbar-count", role: "status" }, `已选 ${state.selectedPapers.size} 篇`),
      button("全选", () => { papers.forEach(p => state.selectedPapers.add(p.id)); renderLibrary(); }, "secondary", "", { title: "选中当前筛选结果中的全部论文" }),
      button("清空选择", () => { state.selectedPapers.clear(); renderLibrary(); }, "secondary"),
      button("添加到分组", () => openMovePapers([...state.selectedPapers]), "secondary", "folder", { disabled: !state.selectedPapers.size }),
      collection ? button("从当前分组移除", event => void act(() => removePapersFromCollection(collectionIds, collection), event.currentTarget), "secondary", "", { disabled: !collectionIds.length, "aria-label": `从「${collection}」分组移除` }) : null,
      button("彻底删除", event => void act(() => confirmDeletePapers([...state.selectedPapers]), event.currentTarget), "danger", "trash", { disabled: !state.selectedPapers.size })));
}
function renderLegend() {
  $("#if-legend").replaceChildren(...["q1", "q2", "q3", "q4", "other", "conference", "preprint"].map(tier => el("span", { class: `legend-tile legend-${tier}` }, TIER_NAMES[tier])));
}
function clearFilters() { closeFilterMenu(); state.query = ""; $("#search").value = ""; $$(".filter-group select").forEach(s => { s.value = ""; }); renderLibrary(); }
