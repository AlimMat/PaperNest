"use strict";

const sidebarWidths = { reading: null, writing: null, drag: null };
function sidebarMode() { return writingState.mode === "writing" ? "writing" : "reading"; }
function sidebarWidthLimit() { return Math.max(184, Math.min(480, Math.floor(innerWidth * .45))); }
function sidebarApplyWidth() {
  const root = document.documentElement, maximum = sidebarWidthLimit();
  for (const mode of ["reading", "writing"]) {
    const width = sidebarWidths[mode];
    root.style.setProperty(`--${mode}-sidebar-width`, width ? `${Math.min(width, maximum)}px` : `min(11.5rem, ${maximum}px)`);
  }
  const handle = $("#sidebar-resize");
  const collapsed = sidebarMode() === "writing" && writingState.sidebarCollapsed;
  handle.hidden = collapsed;
  handle.setAttribute("aria-label", sidebarMode() === "writing" ? "调整写作侧栏宽度" : "调整阅读侧栏宽度");
  handle.setAttribute("aria-valuenow", String(Math.round($("#sidebar").getBoundingClientRect().width)));
  handle.setAttribute("aria-valuemax", String(maximum));
}
function sidebarSetWidth(mode, width, persist = true) {
  sidebarWidths[mode] = Math.max(184, Math.min(sidebarWidthLimit(), Math.round(width)));
  sidebarApplyWidth();
  if (persist) writeBrowserSetting(`${mode}SidebarWidth`, String(sidebarWidths[mode]));
}
function sidebarFinishResize(event, cancel = false) {
  const drag = sidebarWidths.drag;
  if (!drag || event.pointerId !== drag.pointerId) return;
  sidebarWidths.drag = null;
  if (cancel) { sidebarWidths[drag.mode] = drag.previous; sidebarApplyWidth(); }
  else writeBrowserSetting(`${drag.mode}SidebarWidth`, String(sidebarWidths[drag.mode]));
  document.body.classList.remove("sidebar-resizing");
  const handle = $("#sidebar-resize");
  if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
  writingMarkdownRefresh();
  window.dispatchEvent(new Event("resize"));
  if (window.ezreadDesktop && window.chrome?.webview) window.chrome.webview.postMessage("ezread-fit-viewport");
}
function installSidebarResize() {
  for (const mode of ["reading", "writing"]) sidebarWidths[mode] = Number(readBrowserSetting(`${mode}SidebarWidth`)) || null;
  sidebarApplyWidth();
  const handle = $("#sidebar-resize");
  handle.addEventListener("pointerdown", event => {
    if (event.button !== 0 || sidebarWidths.drag) return;
    event.preventDefault();
    const mode = sidebarMode();
    sidebarWidths.drag = { mode, pointerId: event.pointerId, x: event.clientX, width: $("#sidebar").getBoundingClientRect().width, previous: sidebarWidths[mode] };
    document.body.classList.add("sidebar-resizing");
    handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener("pointermove", event => {
    const drag = sidebarWidths.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    sidebarSetWidth(drag.mode, drag.width + event.clientX - drag.x, false);
  });
  handle.addEventListener("pointerup", event => sidebarFinishResize(event));
  handle.addEventListener("pointercancel", event => sidebarFinishResize(event, true));
  handle.addEventListener("lostpointercapture", event => sidebarFinishResize(event, true));
  handle.addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const width = $("#sidebar").getBoundingClientRect().width;
    const next = event.key === "Home" ? 184 : event.key === "End" ? sidebarWidthLimit() : width + (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 30 : 10);
    sidebarSetWidth(sidebarMode(), next);
    writingMarkdownRefresh();
    if (window.ezreadDesktop && window.chrome?.webview) window.chrome.webview.postMessage("ezread-fit-viewport");
  });
  window.addEventListener("resize", sidebarApplyWidth);
}
