const { chromium } = require(process.env.EZREAD_PLAYWRIGHT || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const origin = process.env.EZREAD_TEST_URL;
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [], remote = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith(origin)) remote.push(request.url()); });
  const output = path.join(process.env.EZREAD_TEST_ROOT, 'work/writing-links-verification'); fs.mkdirSync(output, { recursive: true });
  const external = process.env.EZREAD_LINK_EXTERNAL;
  const fileURL = name => pathToFileURL(path.join(external, name)).href;
  const current = '# Current manuscript\n\n[参考文稿](papernest://writing/' + encodeURIComponent('参考文件夹') + '/' + encodeURIComponent('参考.md') + ')\n\n[文件夹](papernest://writing/' + encodeURIComponent('参考文件夹') + ')\n\n[库内PDF](<' + pathToFileURL(process.env.EZREAD_LINK_PDF).href + '>)\n\n[外部PDF](<' + fileURL('external.pdf') + '>)\n\n[外部文件](<' + fileURL('plain.txt') + '>)\n\n[外部文件夹](<' + pathToFileURL(external).href + '>)\n\n[网页](https://example.com)\n\n[不安全](javascript:alert(1))';
  const click = name => page.locator('#writing-preview').getByRole('link', { name, exact: true }).click();
  const identity = () => page.evaluate(() => writingMarkdown.editor === window.keptEditor && writingMarkdown.editor.getDoc() === window.keptDoc && writingState.doc.path === '当前.md');
  try {
    await page.goto(origin); await page.waitForFunction(() => !state.loading);
    await page.locator('#mode-writing').click();
    await page.evaluate(async () => {
      const doc = await api('/api/writing/document?path=' + encodeURIComponent('参考文件夹/参考.md'));
      await writingRequest({ operation: 'save', path: doc.path, revision: doc.revision, content: '# 左侧参考\n\n只读内容。\n\n[另一个Word](./参考.docx)' });
      await writingOpen('当前.md');
      window.keptEditor = writingMarkdown.editor; window.keptDoc = writingMarkdown.editor.getDoc();
    });
    await page.evaluate(async text => { writingMarkdown.editor.setValue(text); await writingFlush(); writingState.preview = true; writingUpdatePreview(); }, current);
    await page.locator('#writing-preview a').filter({ hasText: '参考文稿' }).waitFor();
    assert.equal(await page.locator('#writing-preview a').filter({ hasText: '不安全' }).count(), 0);
    await click('参考文稿');
    await page.waitForFunction(() => writingLinks.active);
    await page.locator('#writing-link-reference-body h1').filter({ hasText: '左侧参考' }).waitFor();
    assert.equal(await identity(), true);
    const bounds = await page.evaluate(() => ({ left: document.querySelector('.writing-link-reference').getBoundingClientRect().right, right: document.querySelector('#writing-link-right').getBoundingClientRect().left }));
    assert.ok(bounds.left <= bounds.right, JSON.stringify(bounds));
    await page.locator('#writing-link-reference-body a').click();
    await page.waitForFunction(() => document.querySelector('#writing-link-reference-title').textContent === '参考.docx');
    assert.equal(await identity(), true);
    await click('文件夹');
    await page.locator('#writing-link-reference-body button').filter({ hasText: '参考.md' }).waitFor();
    await page.locator('#writing-link-reference-body button').filter({ hasText: '参考.tex' }).click();
    await page.waitForFunction(() => document.querySelector('#writing-link-reference-body img')?.naturalWidth > 100, null, { timeout: 100000 });
    assert.equal(await identity(), true);
    await click('文件夹');
    await page.locator('#writing-link-reference-body button').filter({ hasText: '参考.md' }).click();
    await page.locator('#writing-link-reference-body h1').waitFor();
    await page.locator('.CodeMirror textarea').focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('\n\n持续写作');
    await page.keyboard.press('Control+s');
    await page.waitForFunction(() => writingState.doc.content === writingState.doc.saved);
    await page.screenshot({ path: path.join(output, 'linked-manuscript-wide.png') });
    const toolBounds = await page.evaluate(() => ({
      format: document.querySelector('#writing-format-tools').getBoundingClientRect().bottom,
      save: document.querySelector('.writing-save-tools').getBoundingClientRect().top
    }));
    assert.ok(toolBounds.format <= toolBounds.save + 1, JSON.stringify(toolBounds));
    await page.locator('#writing-link-divider').focus(); await page.keyboard.press('ArrowRight');
    assert.ok(await page.evaluate(() => writingLinks.ratio > .5));
    await page.locator('#writing-link-divider').focus(); await page.keyboard.press('Home');
    await page.locator('#writing-read-toggle').click(); await page.waitForFunction(() => writingMarkdown.reading && !writingState.busy);
    assert.deepEqual(await page.locator('.writing-save-tools button:visible').allTextContents(), ['− 缩小', '+ 放大', '打开阅读', '退出阅读']);
    assert.equal(await page.locator('#writing-link-reference-body').isVisible(), true);
    await page.locator('#writing-read-toggle').click(); await page.waitForFunction(() => !writingMarkdown.reading && !writingState.busy);
    await page.setViewportSize({ width: 1000, height: 720 });
    await page.screenshot({ path: path.join(output, 'linked-manuscript-narrow.png') });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.locator('.writing-link-reference-bar button').click();
    assert.equal(await identity(), true);
    await page.setViewportSize({ width: 1600, height: 1000 });
    await click('库内PDF');
    await page.waitForFunction(() => readwrite.active && !readwrite.switching);
    await page.waitForFunction(() => document.querySelector('#original-scroll img')?.naturalWidth > 100);
    assert.equal(await identity(), true);
    await page.screenshot({ path: path.join(output, 'linked-pdf-wide.png') });
    await click('参考文稿');
    await page.waitForFunction(() => writingLinks.active && !readwrite.active && !document.querySelector('#reader-dialog').open);
    assert.equal(await identity(), true);
    await page.locator('.writing-link-reference-bar button').click();
    for (const name of ['外部PDF', '外部文件', '外部文件夹']) {
      await click(name); await page.locator('#writing-link-external').waitFor({ state: 'visible' });
      assert.ok((await page.locator('#writing-link-external-path').innerText()).startsWith(external));
      if (name === '外部PDF') {
        const token = await page.evaluate(() => writingLinks.external.token);
        const blocked = await page.request.get(origin + '/api/writing/link-pdf/' + token + '/document.pdf'); assert.equal(blocked.status(), 400);
        await page.locator('#writing-link-external').getByRole('button', { name: '取消', exact: true }).click();
        await click(name);
      }
      await page.locator('#writing-link-external').getByRole('button', { name: '打开', exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('#writing-link-external').open);
      if (name === '外部PDF') {
        const token = await page.evaluate(() => writingLinks.external.token);
        const response = await page.request.get(origin + '/api/writing/link-pdf/' + token + '/document.pdf');
        assert.equal(response.status(), 200); assert.match(response.headers()['content-type'], /application\/pdf/);
        assert.equal((await response.body()).subarray(0, 5).toString(), '%PDF-');
      }
    }
    // Insert at a remembered cursor position and choose a library target.
    await page.locator('#writing-md-insert-trigger').click();
    await page.locator('#writing-md-insert-menu').getByRole('option', { name: '链接', exact: true }).click();
    await page.locator('#writing-link-dialog').waitFor({ state: 'visible' });
    await page.screenshot({ path: path.join(output, 'insert-local-link.png') });
    await page.locator('#writing-link-text').fill('插入的参考');
    await page.locator('#writing-link-dialog summary').click();
    await page.locator('#writing-link-search').fill('参考.md');
    await page.locator('#writing-link-choices button').click();
    await page.locator('#writing-link-dialog').getByRole('button', { name: '插入链接', exact: true }).click();
    await page.locator('#writing-preview a').filter({ hasText: '插入的参考' }).waitFor();
    await click('插入的参考'); await page.waitForFunction(() => writingLinks.active);
    assert.equal(await identity(), true);
    await page.locator('.writing-link-reference-bar button').click();
    await page.evaluate(() => writingShowLinkDialog());
    await page.locator('#writing-link-text').fill('绝对文件地址');
    await page.locator('#writing-link-address').fill(path.join(process.env.EZREAD_LINK_WRITING, '参考文件夹', '参考.md'));
    await page.locator('#writing-link-dialog').getByRole('button', { name: '插入链接', exact: true }).click();
    await page.locator('#writing-preview').getByRole('link', { name: '绝对文件地址', exact: true }).waitFor();
    await click('绝对文件地址'); await page.waitForFunction(() => writingLinks.active);
    assert.equal(await identity(), true);
    await page.locator('#mode-reading').click();
    await page.waitForFunction(() => writingState.mode === 'reading' && !writingState.busy);
    assert.equal(await page.locator('#writing-linked-workspace').isVisible(), false);
    await page.locator('#mode-writing').click();
    await page.waitForFunction(() => writingState.mode === 'writing' && !writingState.busy);
    assert.equal(await identity(), true);
    assert.equal(await page.locator('#writing-preview a').filter({ hasText: '网页' }).getAttribute('target'), '_blank');
    const badOrigin = await page.request.post(origin + '/api/writing/link', { data: { href: fileURL('plain.txt'), source: '当前.md' }, headers: { Origin: 'https://evil.example' } });
    assert.equal(badOrigin.status(), 403);
    const missing = await page.request.post(origin + '/api/writing/link', { data: { href: 'missing.md', source: '当前.md' } }); assert.equal(missing.status(), 400);
    assert.deepEqual(errors, []); assert.deepEqual(remote, []);
    console.log('Writing links passed: insert/search, file URIs, folders, relative nested links, Word, PDF split, retained editor/content, compact reading, narrow layout, confirmation/cancel, browser PDF bytes and origin protection.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
