async function importFiles(files) {
  const pdfs = [...files].filter(file => file.name.toLowerCase().endsWith(".pdf"));
  if (!pdfs.length) { toast("请选择 PDF 文件", "warn"); return; }
  if (state.importing) { toast("正在导入，请等待当前批次完成", "warn"); return; }
  // Importing while a group is selected is an intentional shortcut: keep the
  // new papers in that group, including PDFs dropped directly onto the window.
  const targetCollection = state.view === "collection" && state.collection ? state.collection : "";
  state.importing = true; $("#import-progress-title").textContent = `正在导入 ${pdfs.length} 篇论文`; $("#import-progress").classList.remove("hidden");
  try {
    const form = new FormData(); pdfs.forEach(file => form.append("files", file));
    if (targetCollection) form.append("collection", targetCollection);
    const data = await api("/api/import", { method: "POST", body: form });
    await loadLibrary();
    if (targetCollection) {
      if (allCollections().includes(targetCollection)) setView("collection", targetCollection);
      else setView("all");
    } else setView("all");
    const count = (data.papers || []).length;
    if (count) toast(targetCollection ? `已导入 ${count} 篇论文，并加入「${targetCollection}」` : `已导入：${count} 篇论文`);
    else if (!(data.errors || []).length) toast("未导入论文，请检查所选文件", "warn");
    for (const error of data.errors || []) toast(asText(error), "error", 9000);
    $("#import-progress").classList.add("hidden");
    for (const p of data.papers || []) {
      if (p.metadata_enrichment?.missing?.length && p.metadata_enrichment.status === "needs_consent") await openPublicationLookup(p);
    }
  } finally { state.importing = false; $("#import-progress").classList.add("hidden"); $("#file-input").value = ""; }
}
