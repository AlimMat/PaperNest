"use strict";

// One read-only, top-layer viewer shared by previews and linked manuscripts.
// It uses the original rendered data URL; no canvas conversion or file writes.
const writingImageViewer = { dialog: null, scale: 1, fit: true, origin: null, drag: null };

function writingBindImages(content) {
  for (const image of content.querySelectorAll("img")) {
    image.tabIndex = 0;
    image.setAttribute("role", "button");
    image.setAttribute("aria-haspopup", "dialog");
    image.setAttribute("aria-label", `查看大图：${image.alt || "图片"}`);
    image.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      writingOpenImage(image);
    });
    image.addEventListener("keydown", event => {
      if (!["Enter", " "].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      writingOpenImage(image);
    });
  }
}

function writingImageZoom(value, fit = false, point = null) {
  const viewer = writingImageViewer, image = $("#writing-image-full"), stage = $("#writing-image-stage");
  if (!viewer.dialog?.open || !image.naturalWidth || !image.naturalHeight) return;
  const box = stage.getBoundingClientRect(), before = image.getBoundingClientRect();
  const x = point?.x ?? box.left + stage.clientWidth / 2;
  const y = point?.y ?? box.top + stage.clientHeight / 2;
  const relativeX = before.width ? (x - before.left) / before.width : .5;
  const relativeY = before.height ? (y - before.top) / before.height : .5;
  viewer.fit = fit;
  viewer.scale = fit ? Math.min(1, (stage.clientWidth - 32) / image.naturalWidth, (stage.clientHeight - 32) / image.naturalHeight)
    : Math.max(.001, Math.min(8, value));
  viewer.scale = Math.max(.00001, viewer.scale);
  const width = image.naturalWidth * viewer.scale, height = image.naturalHeight * viewer.scale;
  image.style.width = `${width}px`; image.style.height = `${height}px`;
  const surface = $("#writing-image-surface");
  surface.style.width = `${Math.max(stage.clientWidth, width + 32)}px`;
  surface.style.height = `${Math.max(stage.clientHeight, height + 32)}px`;
  if (fit) { stage.scrollLeft = 0; stage.scrollTop = 0; }
  else {
    const after = image.getBoundingClientRect();
    stage.scrollLeft += after.left + relativeX * width - x;
    stage.scrollTop += after.top + relativeY * height - y;
  }
  $("#writing-image-scale").textContent = `${Number((viewer.scale * 100).toFixed(1))}%`;
  $("#writing-image-zoom-out").disabled = viewer.scale <= .001;
  $("#writing-image-zoom-in").disabled = viewer.scale >= 8;
  stage.classList.toggle("can-pan", surface.offsetWidth > stage.clientWidth || surface.offsetHeight > stage.clientHeight);
}

function writingCreateImageViewer() {
  const viewer = writingImageViewer;
  if (viewer.dialog) return;
  const control = (label, id, action) => button(label, action, "secondary", "", { id });
  const image = el("img", { id: "writing-image-full", alt: "", draggable: "false" });
  const stage = el("div", { id: "writing-image-stage", tabindex: "0", "aria-label": "图片查看区域，可滚动或拖动查看", "aria-describedby": "writing-image-help" },
    el("div", { id: "writing-image-surface" }, image));
  const dialog = el("dialog", { id: "writing-image-dialog", "aria-labelledby": "writing-image-title" },
    el("header", { class: "writing-image-toolbar" },
      el("h2", { id: "writing-image-title" }, "查看图片"),
      el("div", { class: "writing-image-controls" },
        control("− 缩小", "writing-image-zoom-out", () => writingImageZoom(viewer.scale / 1.25)),
        el("span", { id: "writing-image-scale", role: "status", "aria-label": "图片缩放比例" }, "100%"),
        control("+ 放大", "writing-image-zoom-in", () => writingImageZoom(viewer.scale * 1.25)),
        control("原始大小", "writing-image-actual", () => writingImageZoom(1)),
        control("适应窗口", "writing-image-fit", () => writingImageZoom(1, true)),
        control("关闭", "writing-image-close", () => closeDialog("#writing-image-dialog")))),
    stage, el("p", { id: "writing-image-help" }, "滚轮滚动 · Ctrl + 滚轮缩放 · 拖动查看 · Esc 关闭"));
  viewer.dialog = dialog;
  document.body.append(dialog);
  image.addEventListener("load", () => { if (dialog.open) writingImageZoom(1, true); });
  image.addEventListener("error", () => { if (dialog.open) $("#writing-image-help").textContent = "图片无法加载，请关闭后重试。"; });
  dialog.addEventListener("close", () => {
    viewer.drag = null;
    stage.classList.remove("panning");
    image.removeAttribute("src");
    if (viewer.origin?.isConnected) viewer.origin.focus({ preventScroll: true });
    viewer.origin = null;
  });
  dialog.addEventListener("keydown", event => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (["+", "=", "-", "0", "f", "F"].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      if (event.key === "0") writingImageZoom(1);
      else if (event.key.toLowerCase() === "f") writingImageZoom(1, true);
      else writingImageZoom(viewer.scale * (event.key === "-" ? .8 : 1.25));
    }
  });
  stage.addEventListener("wheel", event => {
    if (!event.ctrlKey || !event.deltaY) return;
    event.preventDefault(); event.stopPropagation();
    writingImageZoom(viewer.scale * (event.deltaY < 0 ? 1.1 : 1 / 1.1), false, { x: event.clientX, y: event.clientY });
  }, { passive: false });
  stage.addEventListener("pointerdown", event => {
    if (event.button !== 0 || !stage.classList.contains("can-pan")) return;
    event.preventDefault(); stage.focus({ preventScroll: true });
    viewer.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: stage.scrollLeft, top: stage.scrollTop };
    stage.setPointerCapture(event.pointerId); stage.classList.add("panning");
  });
  stage.addEventListener("pointermove", event => {
    const drag = viewer.drag;
    if (!drag || drag.id !== event.pointerId) return;
    stage.scrollLeft = drag.left + drag.x - event.clientX;
    stage.scrollTop = drag.top + drag.y - event.clientY;
  });
  const endDrag = event => {
    if (viewer.drag?.id !== event.pointerId) return;
    viewer.drag = null; stage.classList.remove("panning");
    if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
  };
  stage.addEventListener("pointerup", endDrag);
  stage.addEventListener("pointercancel", endDrag);
  stage.addEventListener("lostpointercapture", endDrag);
  window.addEventListener("resize", () => { if (dialog.open) writingImageZoom(viewer.scale, viewer.fit); });
}

function writingOpenImage(image) {
  if (!image.complete || !image.naturalWidth) return;
  writingCreateImageViewer();
  const viewer = writingImageViewer, full = $("#writing-image-full");
  viewer.origin = image; viewer.fit = true;
  $("#writing-image-title").textContent = image.alt || "查看图片";
  $("#writing-image-help").textContent = "滚轮滚动 · Ctrl + 滚轮缩放 · 拖动查看 · Esc 关闭";
  full.alt = image.alt || "图片";
  openDialog("#writing-image-dialog");
  full.src = image.currentSrc || image.src;
  if (full.complete && full.naturalWidth) writingImageZoom(1, true);
}
