async function loadLibrary(showLoading = false) {
  if (showLoading) { state.loading = true; renderLibrary(); }
  const data = await api("/api/papers");
  state.papers = data.papers || []; state.collections = list(data.collections).map(c => typeof c === "object" ? c.name : c).filter(Boolean); state.loading = false;
  clearMissingPaperBrowserData(state.papers);
  renderLibrary(); if ($("#queue-dialog").open) renderQueue();
}
function allCollections() { return [...new Set([...state.collections, ...state.papers.flatMap(paperCollections)])]; }
async function moveCollection(direction) {
  if (state.collectionBusy || state.view !== "collection" || !state.collection) return;
  const name = state.collection;
  state.collectionBusy = true; state.collectionGeneration++; renderNav();
  try {
    const result = await api("/api/collections", { method: "POST", body: { operation: "move", name, direction } });
    state.collections = result.collections; state.settings.collections = result.collections;
  } finally { state.collectionBusy = false; renderNav(); }
}
function showCollectionDialog(operation = "create") {
  if (state.collectionBusy) return;
  const name = operation === "create" ? "" : state.view === "collection" ? state.collection : "";
  if (operation !== "create" && !name) return;
  const form = $("#collection-form"), remove = operation === "remove";
  form.dataset.operation = operation; form.dataset.name = name;
  $("#collection-dialog-title").textContent = remove ? "移除分组" : operation === "rename" ? "重命名分组" : "新建文件夹分组";
  $("#collection-name-field").hidden = remove;
  $("#collection-name").required = !remove;
  $("#collection-name").value = name;
  $("#collection-dialog-help").textContent = remove ? `移除「${name}」分组？其中的 PDF、笔记和批注都会保留，其他分组不受影响。没有其他分组的论文会显示在“未分类”中。` : "";
  $("#collection-confirm").textContent = remove ? "移除分组" : operation === "rename" ? "保存名称" : "创建分组";
  openDialog("#collection-dialog");
  if (remove) $("#collection-confirm").focus();
  else { $("#collection-name").focus(); $("#collection-name").select(); }
}
async function submitCollectionDialog() {
  if (state.collectionBusy) return;
  const form = $("#collection-form"), operation = form.dataset.operation;
  const name = operation === "create" ? $("#collection-name").value.trim() : form.dataset.name;
  const newName = $("#collection-name").value.trim();
  state.collectionBusy = true; state.collectionGeneration++; renderNav();
  try {
    const result = await api("/api/collections", { method: "POST", body: { operation, name, ...(operation === "rename" ? { new_name: newName } : {}) } });
    state.collections = result.collections; state.settings.collections = result.collections;
    // Reflect memberships locally before fetching again, so even a failed GET
    // cannot resurrect the old group through allCollections().
    if (operation !== "create") for (const paper of state.papers) {
      paper.collections = paperCollections(paper).flatMap(value => value === name ? operation === "rename" ? [newName] : [] : [value]);
      paper.collection = paper.collections[0] || "";
    }
    closeDialog("#collection-dialog");
    setView(operation === "remove" ? "all" : "collection", operation === "remove" ? "" : operation === "rename" ? newName : name);
    toast(operation === "remove" ? "分组已移除，PDF 和笔记已保留" : operation === "rename" ? "分组已重命名" : "分组已创建");
    await loadLibrary();
  } finally { state.collectionBusy = false; renderNav(); }
}
async function movePapers(ids, collection) {
  if (!allCollections().includes(collection)) throw new Error("分组不存在，请刷新后重试");
  let moved = 0;
  for (const id of ids) {
    try { const paper = state.papers.find(item => item.id === id); await api(`/api/papers/${encodeURIComponent(id)}`, { method: "PATCH", body: { collections: [...new Set([...paperCollections(paper), collection])] } }); moved++; }
    catch (error) { toast(`${id}：${error.message}`, "error"); }
  }
  await loadLibrary();
  if (moved) toast(`已将 ${moved} 篇论文添加到「${collection}」`);
}
async function deletePapers(ids) {
  let removed = 0;
  for (const id of ids) {
    try { await api(`/api/papers/${encodeURIComponent(id)}`, { method: "DELETE" }); clearPaperBrowserData(id); state.selectedPapers.delete(id); removed++; }
    catch (error) { toast(`${id}：${error.message}`, "error"); }
  }
  await loadLibrary();
  if (removed) toast(`已彻底删除 ${removed} 篇论文及其笔记和记录`);
}
function confirmDeletePapers(ids) {
  if (ids.length && confirm(`彻底删除这 ${ids.length} 篇论文？PDF、笔记、批注、译文和分组归属将一并删除，无法恢复。再次导入将作为全新论文。`)) return deletePapers(ids);
}
async function removePapersFromCollection(ids, collection) {
  if (!collection) return;
  let removed = 0;
  for (const id of new Set(ids)) {
    try {
      const paper = normalizeDetail(await api(`/api/papers/${encodeURIComponent(id)}`));
      if (!paperHasCollection(paper, collection)) continue;
      await patchPaper(id, { collections: paperCollections(paper).filter(name => name !== collection) });
      state.selectedPapers.delete(id);
      removed++;
    } catch (error) { toast(`${id}：${error.message}`, "error"); }
  }
  await loadLibrary();
  if (removed) toast(`已从「${collection}」移除 ${removed} 篇论文，PDF 和笔记已保留`);
}
function closeCardMenu(restoreFocus = false) {
  const id = activeCardMenuId; activeCardMenuId = null;
  $("#card-context-menu").classList.add("hidden");
  if (restoreFocus && id) $(`.paper-card[data-paper-id="${CSS.escape(id)}"]`)?.focus();
}
function beginPaperSelection(id) {
  state.selectionMode = true; state.selectedPapers.add(id); renderLibrary();
}
function cancelPaperSelection() {
  state.selectionMode = false; state.selectedPapers.clear(); renderLibrary();
}
async function paperFileAction(id, action) {
  const result = await api(`/api/papers/${encodeURIComponent(id)}/${action}`, { method: "POST", body: {} });
  toast(action === "copy-pdf" ? `已复制 PDF 文件「${result.filename}」` : "已在文件夹中选中原 PDF", "success", 6500);
}
function openCardMenu(p, x, y) {
  closeFilterMenu(); closeCardMenu(); activeCardMenuId = p.id;
  const collection = state.view === "collection" ? state.collection : "";
  const menu = $("#card-context-menu");
  const item = (label, iconName, action) => el("button", { type: "button", role: "menuitem", onclick: () => { closeCardMenu(); action(); } },
    icon(iconName), el("span", {}, el("span", { class: "context-menu-label" }, label)));
  menu.replaceChildren(
    item("编辑信息与封面", "edit", () => openCardInfo(p)),
    item("论文简介", "file", () => void act(() => openDetail(p.id))),
    item(p.favorite ? "取消收藏" : "收藏论文", "star", () => void act(() => patchPaper(p.id, { favorite: !p.favorite }))),
    item("多选", "select", () => beginPaperSelection(p.id)),
    ...(collection && paperHasCollection(p, collection) ? [item(`从「${collection}」分组移除`, "close", () => void act(() => removePapersFromCollection([p.id], collection)))] : []),
    item("复制 PDF", "copy", () => void act(() => paperFileAction(p.id, "copy-pdf"))),
    item("在文件夹显示", "folder", () => void act(() => paperFileAction(p.id, "reveal-pdf")))
  );
  menu.classList.remove("hidden");
  const box = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, innerWidth - box.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, innerHeight - box.height - 8))}px`;
  menu.querySelector("button").focus({ preventScroll: true });
}
function openMovePapers(ids) {
  const names = allCollections(), select = el("select", { "aria-label": "目标分组" }, names.map(name => el("option", { value: name }, name)));
  $("#move-collection-content").replaceChildren(
    el("div", { class: "dialog-heading" }, el("h2", {}, "添加到分组"), iconButton("close", "关闭添加分组", () => closeDialog("#move-collection-dialog"))),
    el("p", { class: "small muted" }, `已选择 ${ids.length} 篇论文`),
    names.length ? field("目标分组", select) : el("p", {}, "暂无可用分组"),
    el("div", { class: "form-actions" }, button("取消", () => closeDialog("#move-collection-dialog"), "secondary"),
      button("确认添加", event => void act(async () => { await movePapers(ids, select.value); closeDialog("#move-collection-dialog"); }, event.currentTarget), "primary", "folder", { disabled: !names.length }))
  );
  openDialog("#move-collection-dialog");
}
function positionPaperDragPreview(event) {
  if (!paperDragPreview || !(event.clientX || event.clientY)) return;
  paperDragPreview.style.left = `${Math.max(8, Math.min(event.clientX + 14, innerWidth - paperDragPreview.offsetWidth - 8))}px`;
  paperDragPreview.style.top = `${Math.max(8, Math.min(event.clientY + 14, innerHeight - paperDragPreview.offsetHeight - 8))}px`;
}
function startPaperDragPreview(event, p) {
  closeCardMenu(); paperDragPreview?.remove();
  const sourceImage = event.currentTarget.querySelector(".card-cover img");
  const image = sourceImage ? sourceImage.cloneNode(false) : icon("file");
  image.removeAttribute("loading"); image.removeAttribute("id");
  paperDragPreview = el("div", { class: `paper-drag-preview tier-${tierOf(p)}`, "aria-hidden": "true" }, image,
    el("div", {}, el("span", { class: "drag-preview-title" }, titleOf(p)), el("strong", {}, `共 ${draggingPaperIds.length} 篇`)));
  document.body.append(paperDragPreview); positionPaperDragPreview(event);
  // Hide the browser's large translucent ghost; the opaque mini card follows dragover.
  const blank = document.createElement("canvas"); blank.width = blank.height = 1;
  event.dataTransfer.setDragImage(blank, 0, 0);
}
function endPaperDrag() {
  draggingPaperIds = []; paperDragPreview?.remove(); paperDragPreview = null;
  $$(".is-dragging,.drop-active").forEach(node => node.classList.remove("is-dragging", "drop-active"));
  if (paperDragDeferredRender) { paperDragDeferredRender = false; renderLibrary(); }
}
function makeDropTarget(node, kind, collection = "") {
  node.addEventListener("dragover", event => {
    if (!draggingPaperIds.length) return;
    event.preventDefault(); event.dataTransfer.dropEffect = "move"; node.classList.add("drop-active");
  });
  node.addEventListener("dragleave", event => { if (!node.contains(event.relatedTarget)) node.classList.remove("drop-active"); });
  node.addEventListener("drop", event => {
    node.classList.remove("drop-active");
    if (!draggingPaperIds.length) return;
    event.preventDefault(); event.stopPropagation();
    const ids = [...draggingPaperIds]; draggingPaperIds = [];
    void act(() => kind === "trash" ? confirmDeletePapers(ids) : movePapers(ids, collection));
  });
  return node;
}
