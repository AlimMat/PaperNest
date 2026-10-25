const { chromium } = require(process.env.EZREAD_PLAYWRIGHT || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const origin = process.env.EZREAD_TEST_URL;
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const errors = [], remote = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith(origin)) remote.push(request.url()); });
  const fill = text => page.evaluate(text => writingMarkdown.editor.setValue(text), text);
  const source = () => page.evaluate(() => writingMarkdown.editor.getValue());
  const flush = () => page.evaluate(() => writingFlush());
  const toolMenus = { '有序列表': 'writing-md-paragraph', '行内公式': 'writing-md-insert', '展开图片数据': 'writing-md-more', '折叠图片数据': 'writing-md-more', '撤销': 'writing-md-more', '重做': 'writing-md-more' };
  const tool = name => ({ click: async () => {
    const id = toolMenus[name];
    await page.locator(`#${id}-trigger`).click();
    await page.locator(`#${id}-menu`).getByRole('option', { name, exact: true }).click();
  } });
  const read = async name => (await page.request.get(origin + '/api/writing/document?path=' + encodeURIComponent(name))).json();
  const output = path.join(process.env.EZREAD_TEST_ROOT, 'work/writing-verification');
  fs.mkdirSync(output, { recursive: true });
  try {
    await page.goto(origin);
    await page.waitForFunction(() => !state.loading);
    await page.locator('#mode-writing').click();
    await page.evaluate(async () => {
      for (const path of ['增强写作.md', '图片复制.md']) await writingRequest({ operation: 'create', kind: 'file', path });
      await writingRefresh(); await writingOpen('增强写作.md');
    });
    assert.ok(await page.locator('.writing-save-tools button:visible, #writing-format-tools button:visible').count() <= 12, 'Markdown toolbar has at most twelve visible controls');
    await fill('研究方法');
    // The visible toolbar changes headings without accumulating prefixes.
    for (let level = 1; level <= 6; level++) {
      await page.locator('#writing-heading-level-trigger').click();
      await page.locator(`#writing-heading-level-menu [data-value="${level}"]`).click();
      assert.equal(await source(), '#'.repeat(level) + ' 研究方法');
    }
    await page.locator('#writing-heading-level-trigger').click();
    await page.locator('#writing-heading-level-menu [data-value="0"]').click();
    assert.equal(await source(), '研究方法');
    await fill('第一节\n第二节');
    for (let line = 0; line < 2; line++) {
      await page.evaluate(line => writingMarkdown.editor.setCursor({ line, ch: 0 }), line);
      await page.locator('#writing-heading-level-trigger').click();
      await page.locator('#writing-heading-level-menu [data-value="1"]').click();
    }
    assert.equal(await source(), '# 第一节\n# 第二节');
    await fill('第一项\n第二项');
    await page.evaluate(() => writingMarkdown.editor.execCommand('selectAll'));
    await tool('有序列表').click();
    assert.equal(await source(), '1. 第一项\n2. 第二项');
    await fill('公式：');
    await page.evaluate(() => writingMarkdown.editor.setCursor({ line: 0, ch: 3 }));
    await tool('行内公式').click();
    await page.keyboard.insertText('x^2 + y^2');
    await page.locator('#writing-preview-toggle').click();
    await page.locator('#writing-preview .katex').waitFor();
    assert.match(await source(), /\$x\^2 \+ y\^2\$/);
    const example = '# 研究记录\n\n## 方法与假设\n\n使用 **清晰的结构** 整理想法，支持公式、图片与表格。\n\n行内公式：$E = mc^2$。\n\n$$\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\n$$\n\n- [x] 阅读相关工作\n- [ ] 整理实验结果\n\n| 方法 | 结果 |\n| --- | --- |\n| 基线 | 0.82 |\n\n`$不要渲染$`\n';
    await fill(example);
    await page.waitForFunction(() => document.querySelectorAll('#writing-preview .katex').length === 2);
    assert.equal(await page.locator('#writing-preview table').count(), 1);
    assert.equal(await page.locator('#writing-preview input[type=checkbox]').count(), 2);
    assert.equal(await page.locator('#writing-preview code').innerText(), '$不要渲染$');
    const navigationText = '# 预览定位\n\n这里是第一次出现的定位词。\n\n第二段包含目标词和另一个定位词。';
    await fill(navigationText);
    await page.waitForFunction(() => document.querySelector('#writing-preview').textContent.includes('第二段包含目标词'));
    await page.locator('#writing-preview').getByText('第二段包含目标词和另一个定位词。', { exact: true }).evaluate(node => {
      const range = document.createRange(); range.selectNodeContents(node);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      node.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: node.getBoundingClientRect().left + 4, clientY: node.getBoundingClientRect().top + 4 }));
    });
    await page.waitForFunction(() => writingMarkdown.editor.getSelection().includes('目标词'));
    assert.equal(await page.evaluate(() => writingMarkdown.editor.getCursor().line), 4);
    assert.equal(await source(), navigationText);
    const editorFont = await page.locator('.CodeMirror').evaluate(node => parseFloat(getComputedStyle(node).fontSize));
    const selectionBeforeZoom = await page.evaluate(() => writingMarkdown.editor.listSelections());
    await page.locator('#writing-zoom-in').click();
    assert.equal(await page.locator('#writing-zoom-level').innerText(), '110%');
    assert.ok(await page.locator('.CodeMirror').evaluate(node => parseFloat(getComputedStyle(node).fontSize)) > editorFont);
    assert.equal(await page.locator('.writing-markdown-content').evaluate(node => getComputedStyle(node).zoom), '1.1');
    assert.deepEqual(await page.evaluate(() => writingMarkdown.editor.listSelections()), selectionBeforeZoom);
    assert.equal(await source(), navigationText);
    await page.locator('#writing-zoom-out').click();
    for (let index = 0; index < 5; index++) await page.locator('#writing-zoom-out').click();
    assert.equal(await page.locator('#writing-zoom-out').isDisabled(), true);
    assert.equal(await page.locator('#writing-zoom-level').innerText(), '50%');
    for (let index = 0; index < 15; index++) await page.locator('#writing-zoom-in').click();
    assert.equal(await page.locator('#writing-zoom-in').isDisabled(), true);
    assert.equal(await page.locator('#writing-zoom-level').innerText(), '200%');
    for (let index = 0; index < 10; index++) await page.locator('#writing-zoom-out').click();
    // Generate a synthetic image locally, then dispatch the same binary clipboard
    // payload browsers expose for pasted screenshots (not pasted Markdown text).
    const imageURL = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 480; canvas.height = 160;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#e5eee9'; ctx.fillRect(0, 0, 480, 160);
      ctx.strokeStyle = '#33735b'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(35, 125);
      for (let x = 0; x < 410; x++) ctx.lineTo(35 + x, 125 - Math.sqrt(x) * 4);
      ctx.stroke(); ctx.fillStyle = '#284b3b'; ctx.font = '20px sans-serif'; ctx.fillText('Experiment / learning curve', 35, 35);
      return canvas.toDataURL('image/png');
    });
    const paste = url => page.evaluate(async url => {
      const blob = await (await fetch(url)).blob(), transfer = new DataTransfer();
      transfer.items.add(new File([blob], '实验图.png', { type: 'image/png' }));
      const cm = writingMarkdown.editor; cm.setCursor(cm.posFromIndex(cm.getValue().length)); cm.focus();
      cm.getInputField().dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
    }, url);
    await paste(imageURL);
    await flush();
    await page.locator('.writing-image-fold').waitFor();
    await page.waitForFunction(() => document.querySelector('#writing-preview img')?.naturalWidth === 480);
    const withImage = await source();
    assert.ok(withImage.includes(imageURL));
    assert.equal((await read('增强写作.md')).content, withImage);
    assert.ok((await page.locator('.CodeMirror-code').innerText()).length < 900, 'Base64 must not occupy the visible source');
    await tool('展开图片数据').click();
    assert.equal(await page.locator('.writing-image-fold').count(), 0);
    assert.equal(await source(), withImage);
    await tool('折叠图片数据').click();
    await page.locator('.writing-image-fold').waitFor();
    await tool('撤销').click();
    assert.equal(await source(), navigationText);
    await tool('重做').click();
    assert.equal(await source(), withImage);
    // Typing below a folded embedded image must not jump either pane back to
    // the top when the preview and image-fold marks update.
    const scrollStress = Array.from({ length: 70 }, (_, index) => `上方内容 ${index + 1}`).join('\n\n')
      + `\n![实验图](${imageURL})\n`
      + Array.from({ length: 90 }, (_, index) => `下方内容 ${index + 1}`).join('\n\n');
    await fill(scrollStress);
    await page.evaluate(() => { writingMarkdown.expanded = false; writingMarkdownFold(); });
    assert.equal(await page.evaluate(() => writingMarkdown.editor.getAllMarks().some(mark => mark.writingImage)), true);
    await page.waitForFunction(() => document.querySelector('#writing-preview').textContent.includes('下方内容 90'));
    const scrollBefore = await page.evaluate(() => {
      const cm = writingMarkdown.editor;
      cm.setCursor({ line: 250, ch: cm.getLine(250).length });
      cm.scrollIntoView({ line: 250, ch: 0 }, 80);
      cm.focus();
      const preview = document.querySelector('#writing-preview');
      preview.scrollTop = Math.min(600, preview.scrollHeight - preview.clientHeight);
      return { editor: cm.getScrollInfo().top, preview: preview.scrollTop };
    });
    assert.ok(scrollBefore.editor > 600 && scrollBefore.preview > 0, JSON.stringify(scrollBefore));
    await page.keyboard.insertText('继续输入');
    await page.waitForTimeout(350);
    const scrollAfter = await page.evaluate(() => ({ editor: writingMarkdown.editor.getScrollInfo().top, preview: document.querySelector('#writing-preview').scrollTop }));
    assert.ok(Math.abs(scrollAfter.editor - scrollBefore.editor) <= 2, JSON.stringify({ scrollBefore, scrollAfter }));
    assert.ok(Math.abs(scrollAfter.preview - scrollBefore.preview) <= 2, JSON.stringify({ scrollBefore, scrollAfter }));
    const keptEditor = await page.evaluate(() => {
      window.__readingDoc = writingMarkdown.editor.getDoc();
      return writingMarkdown.editor.getCursor();
    });
    await page.locator('#writing-read-toggle').click();
    await page.waitForFunction(() => writingMarkdown.reading && !writingState.busy);
    await page.waitForTimeout(250);
    const readScroll = await page.locator('#writing-preview').evaluate(node => node.scrollTop);
    assert.ok(Math.abs(readScroll - scrollAfter.preview) <= 2, JSON.stringify({ readScroll, scrollAfter }));
    await page.locator('#writing-read-toggle').click();
    await page.waitForFunction(() => !writingMarkdown.reading && !writingState.busy);
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate(() => window.__readingDoc === writingMarkdown.editor.getDoc()), true);
    assert.deepEqual(await page.evaluate(() => writingMarkdown.editor.getCursor()), keptEditor);
    const restoredScroll = await page.evaluate(() => ({ editor: writingMarkdown.editor.getScrollInfo().top, preview: document.querySelector('#writing-preview').scrollTop }));
    assert.ok(Math.abs(restoredScroll.editor - scrollAfter.editor) <= 2, JSON.stringify({ restoredScroll, scrollAfter }));
    assert.ok(Math.abs(restoredScroll.preview - scrollAfter.preview) <= 2, JSON.stringify({ restoredScroll, scrollAfter }));
    await fill(withImage);
    await page.evaluate(() => { writingMarkdown.expanded = false; writingMarkdownFold(); });
    await page.locator('.writing-image-fold').waitFor();
    // CodeMirror's textarea selection supplies the browser's native copy default.
    // Inspect that payload without overwriting the user's system clipboard.
    const copied = await page.evaluate(() => {
      const cm = writingMarkdown.editor; cm.execCommand('selectAll'); cm.focus();
      const transfer = new DataTransfer();
      cm.getInputField().dispatchEvent(new ClipboardEvent('copy', { clipboardData: transfer, bubbles: true, cancelable: true }));
      const input = cm.getInputField();
      return input.value.slice(input.selectionStart, input.selectionEnd);
    });
    assert.equal(copied, withImage);
    await page.evaluate(async () => { await writingOpen('图片复制.md'); });
    await page.evaluate(text => {
      const transfer = new DataTransfer(); transfer.setData('text/plain', text);
      writingMarkdown.editor.getInputField().dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
    }, copied);
    await flush();
    assert.equal((await read('图片复制.md')).content, withImage);
    await page.evaluate(async () => { await writingOpen('增强写作.md'); writingMarkdown.editor.setCursor({ line: 0, ch: 0 }); });
    await page.locator('.writing-image-fold').waitFor();
    await page.screenshot({ path: path.join(output, 'markdown-enhanced-wide.png') });
    // Reading keeps compact zoom/open/exit controls, preserving edits and undo.
    await page.evaluate(() => writingMarkdown.editor.replaceRange('\n阅读模式检查', { line: 0, ch: 0 }));
    const beforeReading = await source();
    const cursorBeforeReading = await page.evaluate(() => writingMarkdown.editor.getCursor());
    const editingTop = await page.locator('#writing-editors').evaluate(node => node.getBoundingClientRect().top);
    await page.locator('#writing-read-toggle').click();
    await page.waitForFunction(() => writingMarkdown.reading && !writingState.busy);
    assert.equal((await read('增强写作.md')).content, beforeReading);
    assert.equal(await page.locator('#writing-markdown-editor').isVisible(), false);
    assert.equal(await page.locator('#writing-format-tools').isVisible(), false);
    assert.equal(await page.locator('#writing-preview').isVisible(), true);
    assert.equal(await page.locator('.writing-heading').isVisible(), false);
    assert.equal(await page.locator('.writing-status').isVisible(), false);
    const readingControls = ['− 缩小', '+ 放大', '打开阅读', '退出阅读'];
    assert.deepEqual(await page.locator('.writing-save-tools button:visible').allTextContents(), readingControls);
    assert.equal(await page.locator('#writing-zoom-level').isVisible(), true);
    await page.locator('#writing-zoom-in').click();
    assert.equal(await page.locator('#writing-zoom-level').innerText(), '110%');
    assert.equal(await page.evaluate(() => writingMarkdown.reading), true);
    assert.equal(await source(), beforeReading);
    await page.locator('#writing-zoom-out').click();
    assert.equal(await page.locator('#writing-preview-toggle').isVisible(), false);
    const compact = await page.evaluate(() => ({ top: document.querySelector('#writing-editors').getBoundingClientRect().top, bar: document.querySelector('.writing-toolbar').getBoundingClientRect().height }));
    assert.ok(compact.top < 65 && compact.bar <= 52 && compact.top < editingTop - 60, JSON.stringify({ editingTop, compact }));
    await page.waitForFunction(() => document.querySelector('#writing-preview img')?.naturalWidth === 480);
    const readingWidth = await page.evaluate(() => ({
      preview: document.querySelector('#writing-preview').getBoundingClientRect().width,
      area: document.querySelector('#writing-editors').getBoundingClientRect().width
    }));
    assert.ok(Math.abs(readingWidth.preview - readingWidth.area) <= 1, JSON.stringify(readingWidth));
    await page.screenshot({ path: path.join(output, 'markdown-reading-wide.png') });
    await page.locator('#writing-read-toggle').click();
    await page.waitForFunction(() => !writingMarkdown.reading && !writingState.busy);
    assert.equal(await page.locator('#writing-markdown-editor').isVisible(), true);
    assert.equal(await page.locator('#writing-preview').isVisible(), true);
    assert.equal(await page.locator('.writing-heading').isVisible(), true);
    assert.equal(await page.locator('.writing-status').isVisible(), true);
    assert.equal(await page.locator('#writing-zoom-in').isVisible(), true);
    assert.equal(await page.locator('#writing-save').isVisible(), true);
    assert.ok(Math.abs(await page.locator('#writing-editors').evaluate(node => node.getBoundingClientRect().top) - editingTop) <= 1);
    assert.deepEqual(await page.evaluate(() => writingMarkdown.editor.getCursor()), cursorBeforeReading);
    await tool('撤销').click();
    assert.equal(await source(), withImage);
    await page.locator('#writing-preview-toggle').click();
    await page.locator('#writing-read-toggle').click();
    await page.waitForFunction(() => writingMarkdown.reading && !writingState.busy);
    await page.locator('#writing-read-toggle').click();
    await page.waitForFunction(() => !writingMarkdown.reading && !writingState.busy);
    assert.equal(await page.locator('#writing-preview').isVisible(), false, 'Return restores source-only layout');
    await page.locator('#writing-read-toggle').click();
    await page.waitForFunction(() => writingMarkdown.reading && !writingState.busy);
    await page.locator('#writing-read-toggle').click();
    await page.waitForFunction(() => !writingMarkdown.reading && !writingState.busy);
    await page.locator('#writing-preview-toggle').click();
    assert.equal(await page.locator('#writing-markdown-editor').isVisible(), true);
    assert.equal(await page.locator('#writing-preview').isVisible(), true);
    // Picker inserts original bytes; switching immediately awaits the async read.
    await page.evaluate(() => { writingMarkdown.picker = writingState.doc; });
    await page.locator('#writing-image-input').setInputFiles({ name: '原图.png', mimeType: 'image/png', buffer: Buffer.from(imageURL.split(',')[1], 'base64') });
    await page.evaluate(() => writingRun(() => writingOpen('图片复制.md')));
    assert.equal((await read('增强写作.md')).content.split(imageURL).length - 1, 2);
    // Invalid inputs leave the source intact and release the pending-save state.
    const beforeInvalid = await source();
    await page.evaluate(async () => { await writingMarkdownInsertImages([new File(['not an image'], '坏图.png', { type: 'image/png' })]); });
    assert.equal(await source(), beforeInvalid);
    assert.notEqual(await page.locator('#writing-save-status').innerText(), '正在嵌入图片…');
    // Tall embedded images open without modifying bytes or navigating a linked
    // image. Viewer zoom is independent of manuscript zoom and scroll position.
    const tallImage = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 1400; canvas.height = 4800;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1400, 4800);
      ctx.fillStyle = '#285448'; ctx.font = '42px sans-serif';
      for (let y = 80; y < 4800; y += 120) ctx.fillText(`PaperNest image detail / row ${y}`, 40, y);
      return canvas.toDataURL('image/png');
    });
    const imageDocument = `# 大图查看\n\n[![长图](${tallImage})](https://example.invalid/do-not-open)\n\n末尾内容`;
    await fill(imageDocument);
    await page.waitForFunction(() => document.querySelector('#writing-preview img')?.naturalHeight === 4800);
    const checkViewer = async () => {
      await page.locator('#writing-preview img').click();
      await page.waitForFunction(() => document.querySelector('#writing-image-full')?.naturalHeight === 4800);
      assert.equal(await page.locator('#writing-image-dialog').isVisible(), true);
      assert.equal(await page.locator('#writing-image-full').getAttribute('src'), tallImage);
      assert.ok(await page.evaluate(() => writingImageViewer.scale < 1));
      await page.locator('#writing-image-actual').click();
      assert.equal(await page.locator('#writing-image-scale').innerText(), '100%');
      assert.equal(await page.locator('#writing-zoom-level').innerText(), '100%');
      const actualGeometry = await page.locator('#writing-image-stage').evaluate(node => ({
        width: node.clientWidth, height: node.clientHeight, contentHeight: node.scrollHeight,
        imageWidth: document.querySelector('#writing-image-full').getBoundingClientRect().width
      }));
      assert.equal(actualGeometry.imageWidth, 1400);
      assert.ok(actualGeometry.contentHeight > actualGeometry.height);
      await page.locator('#writing-image-zoom-in').click();
      assert.equal(await page.locator('#writing-image-scale').innerText(), '125%');
      await page.locator('#writing-image-zoom-out').click();
      assert.equal(await page.locator('#writing-image-scale').innerText(), '100%');
      const stage = page.locator('#writing-image-stage');
      const box = await stage.boundingBox();
      const priorScroll = await stage.evaluate(node => node.scrollTop);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 100, { steps: 6 });
      await page.mouse.up();
      assert.ok(await stage.evaluate(node => node.scrollTop) >= priorScroll + 95);
      const scroll = await stage.evaluate(node => node.scrollTop);
      await page.mouse.wheel(0, 180);
      await page.waitForFunction(scroll => document.querySelector('#writing-image-stage').scrollTop > scroll, scroll);
      await page.keyboard.down('Control'); await page.mouse.wheel(0, -100); await page.keyboard.up('Control');
      await page.waitForFunction(() => writingImageViewer.scale > 1);
      await page.keyboard.press('0');
      assert.equal(await page.locator('#writing-image-scale').innerText(), '100%');
      await page.keyboard.press('f');
      assert.ok(await page.evaluate(() => writingImageViewer.fit && writingImageViewer.scale < 1));
      await page.screenshot({ path: path.join(output, 'markdown-image-viewer.png') });
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#writing-image-dialog').isVisible(), false);
      assert.equal(await page.locator('#writing-image-full').getAttribute('src'), null);
      assert.equal(await source(), imageDocument);
    };
    await checkViewer();
    await page.locator('#writing-read-toggle').click();
    await page.waitForFunction(() => writingMarkdown.reading && !writingState.busy);
    const imageScroll = await page.locator('#writing-preview').evaluate(node => node.scrollTop);
    await checkViewer();
    assert.equal(await page.evaluate(() => writingMarkdown.reading), true);
    assert.equal(await page.locator('#writing-preview').evaluate(node => node.scrollTop), imageScroll);
    // Keyboard opening, narrow/dark layout, resize refit and nested modal layers.
    await page.locator('#writing-preview img').focus(); await page.keyboard.press('Enter');
    await page.setViewportSize({ width: 560, height: 540 });
    await page.evaluate(() => { state.settings.theme = 'graphite'; applyPreferences(); });
    await page.waitForTimeout(150);
    const viewerGeometry = await page.locator('#writing-image-dialog').evaluate(node => {
      const box = node.getBoundingClientRect(), image = document.querySelector('#writing-image-full').getBoundingClientRect();
      return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, fits: image.height <= document.querySelector('#writing-image-stage').clientHeight };
    });
    assert.ok(viewerGeometry.left >= 0 && viewerGeometry.top >= 0 && viewerGeometry.right <= 560 && viewerGeometry.bottom <= 540 && viewerGeometry.fits, JSON.stringify(viewerGeometry));
    await page.screenshot({ path: path.join(output, 'markdown-image-viewer-narrow-dark.png') });
    await page.locator('#writing-image-close').click();
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.evaluate(() => { state.settings.theme = 'paper'; applyPreferences(); });
    await page.evaluate(text => {
      const modal = el('dialog', { id: 'test-image-parent' }, writingRenderMarkdown(text));
      document.body.append(modal); modal.showModal();
    }, imageDocument);
    await page.locator('#test-image-parent img').click();
    assert.equal(await page.locator('#writing-image-dialog').isVisible(), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#test-image-parent').evaluate(node => node.open), true);
    await page.evaluate(() => { const modal = document.querySelector('#test-image-parent'); modal.close(); modal.remove(); });
    await page.locator('#writing-read-toggle').click();
    await page.waitForFunction(() => !writingMarkdown.reading && !writingState.busy);
    // Raw HTML, scripts, dangerous links and remote images are never executed/fetched.
    await fill('<script>window.markdownUnsafe = true</script>\n\n<img src=x onerror="window.markdownUnsafe = true">\n\n[x](javascript:alert(1))\n\n![remote](https://example.invalid/private.png)\n\n$\\href{javascript:alert(1)}{bad}$');
    await page.locator('#writing-preview .writing-image-unavailable').waitFor();
    assert.equal(await page.locator('#writing-preview script, #writing-preview img, #writing-preview a[href^="javascript:"]').count(), 0);
    assert.equal(await page.evaluate(() => Boolean(window.markdownUnsafe)), false);
    assert.deepEqual(remote, []);
    // Preserve drafts above localStorage quota and above the old 2 MB HTTP/file cap.
    await fill(withImage);
    await flush();
    await page.route('**/api/writing', async route => route.request().method() === 'POST'
      ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"离线测试"}' }) : route.continue());
    const large = withImage + '\n![大图](data:image/png;base64,' + 'AAAA'.repeat(1600000) + ')\n离线大图草稿';
    await fill(large);
    await page.evaluate(async () => { clearTimeout(writingState.timer); await writingDraftQueue; });
    const retained = await page.evaluate(async () => (await writingReadDraft(writingState.doc.path)).content.length);
    assert.equal(retained, large.length);
    page.once('dialog', dialog => dialog.accept());
    await page.reload();
    await page.waitForFunction(() => !state.loading);
    await page.locator('#mode-writing').click();
    await page.evaluate(() => writingOpen('图片复制.md'));
    assert.equal(await source(), large);
    await page.unroute('**/api/writing');
    assert.equal(await page.evaluate(() => ezreadPrepareDesktopClose()), true);
    assert.equal((await read('图片复制.md')).content, large);
    assert.equal(await page.evaluate(async () => Boolean(await writingReadDraft('图片复制.md'))), false);
    await fill(withImage); await flush();
    await page.evaluate(() => { writingState.preview = true; writingUpdatePreview(); });
    await page.waitForFunction(() => document.querySelector('#writing-preview img')?.naturalWidth === 480);
    await page.setViewportSize({ width: 1000, height: 720 });
    await page.evaluate(() => { state.settings.theme = 'graphite'; state.settings.ui_font_size = 20; applyPreferences(); });
    await page.screenshot({ path: path.join(output, 'markdown-enhanced-narrow-dark.png') });
    const geometry = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1, editor: document.querySelector('.CodeMirror').getBoundingClientRect().height, footer: document.querySelector('.writing-status').getBoundingClientRect().bottom, window: innerHeight }));
    assert.equal(geometry.overflow, false, JSON.stringify(geometry));
    assert.ok(geometry.editor > 100 && geometry.footer <= geometry.window + 1, JSON.stringify(geometry));
    await page.locator('#writing-read-toggle').click();
    await page.waitForFunction(() => writingMarkdown.reading && !writingState.busy);
    await page.screenshot({ path: path.join(output, 'markdown-reading-narrow-dark.png') });
    assert.equal(await page.locator('#writing-markdown-editor').isVisible(), false);
    const readingGeometry = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
      preview: document.querySelector('#writing-preview').getBoundingClientRect().height,
      footer: document.querySelector('.writing-status').getBoundingClientRect().bottom
    }));
    assert.equal(readingGeometry.overflow, false);
    assert.ok(readingGeometry.preview > 100 && readingGeometry.footer <= 721, JSON.stringify(readingGeometry));
    assert.deepEqual(await page.locator('.writing-save-tools button:visible').allTextContents(), readingControls);
    assert.equal(await page.locator('.writing-heading').isVisible(), false);
    assert.equal(await page.locator('.writing-status').isVisible(), false);
    await page.locator('#writing-read-toggle').click();
    await page.waitForFunction(() => !writingMarkdown.reading && !writingState.busy);
    await page.locator('#writing-zoom-in').click();
    // Exiting reading schedules a preview repaint; query the current connected
    // node instead of an element handle that may be detached by that repaint.
    await page.waitForFunction(() => {
      const node = document.querySelector('.writing-markdown-content');
      return node && getComputedStyle(node).zoom === '1.1';
    });
    await page.reload();
    await page.waitForFunction(() => !state.loading);
    await page.locator('#mode-writing').click();
    await page.evaluate(() => writingOpen('图片复制.md'));
    assert.equal(await page.locator('#writing-zoom-level').innerText(), '110%');
    assert.equal(await source(), withImage);
    await page.locator('#writing-zoom-out').click();
    await page.evaluate(() => writingOpen('研究计划/论文.docx'));
    assert.equal(await page.locator('#writing-read-toggle').isVisible(), false);
    assert.equal(await page.locator('#writing-word').isVisible(), true);
    assert.equal(await page.locator('#writing-format-tools').isVisible(), true);
    await page.evaluate(() => writingOpen('研究计划/公式.tex'));
    assert.equal(await page.locator('#writing-source').isVisible(), true);
    assert.equal(await page.locator('#writing-preview').isVisible(), false);
    assert.deepEqual(errors, []);
    console.log('Enhanced Markdown passed: H1–H6, lists, math, binary paste, preview, exact-byte save/reopen, fold, copy/paste, undo/redo, picker/switch, invalid images, safe rendering, large IndexedDB draft/reload/close, narrow dark layout.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
