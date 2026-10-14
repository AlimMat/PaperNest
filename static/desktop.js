"use strict";

// The native window's minimum width follows the two-column library geometry.
// The shortened window pans the complete page through sidebar wheel messages.
function ezreadDesktopViewportMetrics() {
  const layout = paperLayoutMetrics();
  return { gutter: Math.max(0, innerWidth - document.body.clientWidth),
    minimumWidth: layout.minimumWidth, pixelRatio: devicePixelRatio,
    // The existing native contract uses dialogOpen to fit to the actual window
    // height and suspend the library's full-monitor page. Writing needs the
    // same fit mode, including when there is no modal dialog.
    dialogOpen: Boolean(document.querySelector("dialog[open]")) ||
      (typeof writingState !== "undefined" && writingState.mode === "writing") };
}

function ezreadDesktopSidebarWheel(event) {
  if (typeof writingState !== "undefined" && writingState.mode === "writing") return;
  if (event.ctrlKey || event.defaultPrevented || !event.cancelable || document.querySelector("dialog[open]")) return;
  const sidebar = document.querySelector(".sidebar");
  if (!sidebar) return;
  const box = sidebar.getBoundingClientRect();
  if (event.clientX < box.left || event.clientX >= box.right || event.clientY < box.top || event.clientY >= box.bottom) return;
  if (event.target?.closest?.("[popover]")) return;
  // Reading controls stay fixed. Only the group list owns sidebar scrolling;
  // do not forward its wheel events to the native whole-page panning handler.
  const reading = document.querySelector("#reading-sidebar");
  if (reading && !reading.hidden) {
    if (!event.target?.closest?.("#collections-nav")) event.preventDefault();
    return;
  }
  const line = Number.parseFloat(getComputedStyle(sidebar).lineHeight) || 24;
  const unit = event.deltaMode === 1 ? line : event.deltaMode === 2 ? window.innerHeight : 1;
  const deltaY = event.deltaY * unit;
  if (!Number.isFinite(deltaY) || !deltaY) return;
  event.preventDefault();
  window.chrome.webview.postMessage({ type: "ezread-sidebar-wheel", deltaY, pixelRatio: window.devicePixelRatio || 1 });
}

if (typeof window !== "undefined" && window.ezreadDesktop && window.chrome?.webview) {
  document.addEventListener("wheel", ezreadDesktopSidebarWheel, { passive: false, capture: true });
}

// Invoked only by the native window's close handshake. Preserve local drafts
// first; a network failure may leave a recoverable draft but must not discard it.
async function ezreadPrepareDesktopClose() {
  if (typeof writingState !== "undefined" && writingState.busy) return false;
  if (typeof writingFlush === "function") {
    try { await writingFlush(); } catch { return false; }
  }
  if (typeof readerScrollActive === "function" && readerScrollActive() && !readerPersistDrafts()) return false;
  if (typeof detailNoteSaves !== "undefined") {
    for (const entry of detailNoteSaves.values()) {
      if (entry.released || entry.value === entry.savedValue) continue;
      if (!readerWriteLocal("notes", entry.id, { value: entry.value })) return false;
    }
  }
  const saves = [];
  if (typeof readerCancelTranslation === "function") readerCancelTranslation();
  if (typeof readerFlushTextEditor === "function") saves.push(readerFlushTextEditor());
  if (typeof readerScrollActive === "function" && readerScrollActive()) {
    if (typeof saveReadPage === "function") saves.push(saveReadPage());
    if (typeof readerSaveNotes === "function") saves.push(readerSaveNotes());
  }
  if (typeof detailNoteSaves !== "undefined") {
    for (const entry of detailNoteSaves.values()) if (!entry.released) saves.push(entry.flush());
  }
  await Promise.allSettled(saves);
  if (typeof flushPreferences === "function") {
    while (preferenceSaveBusy) await new Promise(resolve => setTimeout(resolve, 50));
    await flushPreferences();
    if (Object.keys(pendingPreferences).length) return false;
  }
  if (typeof readerScrollActive === "function" && readerScrollActive() && !readerPersistDrafts()) return false;
  // Failed requests retain their local copies through the existing save code.
  return true;
}
