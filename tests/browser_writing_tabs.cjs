const { chromium } = require(process.env.EZREAD_PLAYWRIGHT || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const origin = process.env.EZREAD_TEST_URL;
  const tab = name => page.locator('.writing-tab').filter({ has: page.getByRole('button', { name: `切换到 ${name}`, exact: true }) });
  const switchTab = async name => {
    await tab(name).locator('.writing-tab-select').click();
    await page.waitForFunction(name => writingState.doc?.path === name && !writingState.busy, name);
  };
  const closeTab = async name => {
    await tab(name).locator('.writing-tab-close').click();
    await page.waitForFunction(name => !writingState.tabs.some(doc => doc.path === name) && !writingState.busy, name);
  };
  try {
    await page.goto(origin); await page.waitForFunction(() => !state.loading);
    await page.locator('#mode-writing').click();
    await page.evaluate(async () => {
      await writingRequest({ operation: 'create', kind: 'folder', path: '标签测试' });
      for (const name of ['甲.md', '乙.md', 'Word.docx', '公式.tex']) await writingRequest({ operation: 'create', kind: 'file', path: '标签测试/' + name });
      await writingRefresh(); await writingOpen('标签测试/甲.md');
      writingState.preview = true;
      writingMarkdown.editor.setValue(Array.from({ length: 100 }, (_, i) => `## 段落 ${i}\n\n正文内容 ${i}`).join('\n\n'));
      writingUpdatePreview();
    });
    await page.waitForTimeout(250);
    const position = await page.evaluate(() => {
      const cm = writingMarkdown.editor;
      cm.setCursor({ line: 180, ch: 2 }); cm.scrollIntoView({ line: 180, ch: 0 }, 40);
      cm.replaceSelection('新增');
      document.querySelector('#writing-preview').scrollTop = 900;
      window.tabsDoc = cm.getDoc();
      return { cursor: cm.getCursor(), top: cm.getScrollInfo().top };
    });
    await page.evaluate(() => writingOpen('标签测试/乙.md'));
    await switchTab('标签测试/甲.md'); await page.waitForTimeout(250);
    assert.equal(await page.evaluate(() => writingMarkdown.editor.getDoc() === window.tabsDoc), true);
    assert.deepEqual(await page.evaluate(() => writingMarkdown.editor.getCursor()), position.cursor);
    assert.ok(Math.abs(await page.evaluate(() => writingMarkdown.editor.getScrollInfo().top) - position.top) < 3);
    assert.equal(await page.locator('#writing-preview').evaluate(node => node.scrollTop), 900);
    await page.evaluate(() => writingMarkdown.editor.undo());
    assert.equal(await page.evaluate(() => writingState.doc.content.includes('新增')), false);
    await page.evaluate(() => writingOpen('标签测试/甲.md'));
    assert.equal(await page.locator('.writing-tab').count(), 2, 'Opening twice does not duplicate tabs');
    await page.locator('#writing-read-toggle').click(); await page.waitForFunction(() => !writingState.busy);
    await switchTab('标签测试/乙.md');
    assert.equal(await page.evaluate(() => writingMarkdown.reading), true);
    await switchTab('标签测试/甲.md');
    assert.equal(await page.evaluate(() => writingMarkdown.reading), true);
    const geometry = await page.evaluate(() => ({
      tabs: document.querySelector('#writing-tabs').getBoundingClientRect().right,
      zoom: document.querySelector('#writing-zoom-out').getBoundingClientRect().left
    }));
    assert.ok(geometry.tabs <= geometry.zoom, JSON.stringify(geometry));
    const out = path.join(process.env.EZREAD_TEST_ROOT, 'work/writing-verification'); fs.mkdirSync(out, { recursive: true });
    await page.screenshot({ path: path.join(out, 'writing-reading-tabs.png') });
    await closeTab('标签测试/甲.md');
    assert.equal(await page.evaluate(() => writingState.doc.path), '标签测试/乙.md');
    assert.equal(await page.evaluate(() => writingMarkdown.reading), true);
    await page.evaluate(() => writingOpen('标签测试/甲.md'));
    await closeTab('标签测试/乙.md');
    assert.equal(await page.evaluate(() => writingState.doc.path), '标签测试/甲.md');
    assert.equal((await page.request.get(origin + '/api/writing/document?path=' + encodeURIComponent('标签测试/乙.md'))).status(), 200);
    await page.locator('#writing-read-toggle').click(); await page.waitForFunction(() => !writingState.busy);
    // A save error must block both switching and closing, keeping the draft.
    await page.evaluate(() => writingMarkdown.editor.replaceRange('未保存', { line: 0, ch: 0 }));
    await page.route('**/api/writing', route => route.request().method() === 'POST'
      ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"测试保存失败"}' }) : route.continue());
    await tab('标签测试/甲.md').locator('.writing-tab-close').click();
    await page.waitForFunction(() => !writingState.busy);
    assert.equal(await page.locator('.writing-tab').count(), 1);
    assert.equal(await page.evaluate(() => writingState.doc.content.startsWith('未保存')), true);
    await page.unroute('**/api/writing'); await page.evaluate(() => writingFlush());
    await closeTab('标签测试/甲.md');
    assert.equal(await page.locator('#writing-empty').isVisible(), true);
    assert.equal(await page.evaluate(() => writingState.doc), null);
    await page.evaluate(async () => { await writingOpen('标签测试/乙.md'); await writingOpen('标签测试/Word.docx'); });
    assert.equal(await page.locator('#writing-word').isVisible(), true);
    const external = await (await page.request.get(origin + '/api/writing/document?path=' + encodeURIComponent('标签测试/乙.md'))).json();
    await page.request.post(origin + '/api/writing', { data: { operation: 'save', path: external.path, revision: external.revision, content: '# 外部更新的正文' } });
    await switchTab('标签测试/乙.md');
    assert.equal(await page.evaluate(() => writingState.doc.content), '# 外部更新的正文');
    // Rename a parent folder and remove it: no stale or duplicate tab paths.
    await page.evaluate(async () => {
      writingShowDialog('rename', 'folder', '', '标签测试');
      document.querySelector('#writing-name').value = '标签改名';
      await writingSubmit();
    });
    assert.deepEqual(await page.evaluate(() => writingState.tabs.map(doc => doc.path)), ['标签改名/乙.md', '标签改名/Word.docx']);
    await switchTab('标签改名/Word.docx');
    // Many long names remain inside the toolbar, including narrow dark reading.
    await page.evaluate(async () => {
      for (let i = 0; i < 9; i++) {
        const name = `标签改名/很长的文稿名称用于检查横向滚动-${i}.md`;
        await writingRequest({ operation: 'create', kind: 'file', path: name }); await writingOpen(name);
      }
      writingMarkdown.editor.setValue('# 标签阅读\n\n正文');
    });
    await page.locator('#writing-read-toggle').click(); await page.waitForFunction(() => !writingState.busy);
    await page.setViewportSize({ width: 1000, height: 720 });
    await page.evaluate(() => { state.settings.theme = 'graphite'; applyPreferences(); });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    assert.equal(await page.locator('#writing-zoom-in').isVisible(), true);
    assert.ok(await page.locator('#writing-tabs').evaluate(node => node.scrollWidth > node.clientWidth));
    await page.screenshot({ path: path.join(out, 'writing-tabs-narrow-dark.png') });
    await page.evaluate(async () => { writingShowDialog('trash', 'folder', '', '标签改名'); await writingSubmit(); });
    assert.equal(await page.locator('.writing-tab').count(), 0);
    assert.equal(await page.locator('#writing-empty').isVisible(), true);
    assert.deepEqual(errors, []);
    console.log('Writing tabs passed: switch, deduplication, undo/cursor/scroll, reading, save failure, close without delete, last close, Word, folder rename/remove and overflow.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
