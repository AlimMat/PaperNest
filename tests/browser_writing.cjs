const { chromium } = require(process.env.EZREAD_PLAYWRIGHT || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const origin = process.env.EZREAD_TEST_URL;
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  // This suite checks workspace/file controls. Actual compilation is covered
  // by browser_latex.cjs; avoid launching it incidentally during view switches.
  await page.route('**/api/writing/latex-preview', route => route.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"工作区测试不执行 LaTeX 编译"}' }));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.__copiedText = value; } } });
  });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const post = async body => {
    const response = await page.request.post(origin + '/api/writing', { data: body });
    assert.equal(response.status(), 200, await response.text());
    return response.json();
  };
  const read = async name => (await page.request.get(origin + '/api/writing/document?path=' + encodeURIComponent(name))).json();
  const saved = () => page.waitForFunction(() => writingState.doc?.content === writingState.doc?.saved && !writingState.saving && !writingState.busy);
  const markdownFill = text => page.evaluate(text => writingMarkdown.editor.setValue(text), text);
  async function create(name, format = 'md') {
    await page.locator('#writing-new').click();
    await page.locator('#writing-name').fill(name);
    await page.locator('#writing-format-trigger').click();
    await page.locator(`#writing-format-menu [data-value="${format}"]`).click();
    await page.locator('#writing-confirm').click();
    await page.waitForFunction(() => !document.querySelector('#writing-dialog').open);
    await saved();
  }
  const open = async file => {
    await page.locator(`.writing-tree-item[data-path="${file}"]`).click();
    await page.waitForFunction(file => writingState.doc?.path === file && !writingState.busy, file);
  };
  try {
    await page.goto(origin);
    await page.waitForFunction(() => !state.loading);
    await page.locator('#mode-writing').click();
    await page.locator('#writing-empty').waitFor({ state: 'visible' });
    const expandedLayout = await page.evaluate(() => ({
      sidebar: document.querySelector('#sidebar').getBoundingClientRect().width,
      workspace: document.querySelector('main.workspace').getBoundingClientRect().left
    }));
    await page.locator('#writing-sidebar-toggle').click();
    await page.waitForFunction(() => document.body.classList.contains('writing-sidebar-collapsed') && document.querySelector('#sidebar').getBoundingClientRect().width < 100);
    const collapsedLayout = await page.evaluate(() => ({
      sidebar: document.querySelector('#sidebar').getBoundingClientRect().width,
      workspace: document.querySelector('main.workspace').getBoundingClientRect().left,
      logo: getComputedStyle(document.querySelector('.brand-icon')).display,
      brand: getComputedStyle(document.querySelector('.brand > span')).display,
      stored: localStorage.getItem('ezread-writing-sidebar-collapsed')
    }));
    assert.ok(collapsedLayout.sidebar < expandedLayout.sidebar - 80, JSON.stringify({ expandedLayout, collapsedLayout }));
    assert.ok(collapsedLayout.workspace < expandedLayout.workspace - 80, JSON.stringify({ expandedLayout, collapsedLayout }));
    assert.notEqual(collapsedLayout.logo, 'none');
    assert.equal(collapsedLayout.brand, 'none');
    assert.equal(collapsedLayout.stored, 'true');
    assert.equal(await page.locator('#writing-sidebar-toggle').getAttribute('aria-expanded'), 'false');
    await page.locator('#writing-sidebar-toggle').click();
    await page.waitForFunction(() => !document.body.classList.contains('writing-sidebar-collapsed') && document.querySelector('#sidebar').getBoundingClientRect().width > 150);
    assert.equal(await page.locator('#writing-sidebar-toggle').getAttribute('aria-expanded'), 'true');
    assert.equal(await page.getByRole('button', { name: '文件地址', exact: true }).isDisabled(), true);
    await page.locator('#writing-folder').click();
    await page.locator('#writing-name').fill('研究计划');
    await page.locator('#writing-confirm').click();
    await page.waitForFunction(() => !document.querySelector('#writing-dialog').open);
    await create('实验');
    const markdown = '# 研究计划\n\n阅读与写作放在一起。\n\n- 验证假设\n- 记录结果\n\n**结论**：保留原始数据。';
    await markdownFill(markdown);
    const expectedWritingPath = path.join(process.env.EZREAD_TEST_WRITING_ROOT, '研究计划', '实验.md');
    await page.getByRole('button', { name: '文件地址', exact: true }).click();
    await page.waitForFunction(expected => window.__copiedText === expected, expectedWritingPath);
    assert.equal(await page.evaluate(() => window.__copiedText), expectedWritingPath);
    assert.equal((await read('研究计划/实验.md')).content, markdown, 'copying the path first flushes pending edits');
    await page.getByText('已复制写作文件地址', { exact: true }).waitFor();
    await page.getByRole('button', { name: '收起文件夹“研究计划”', exact: true }).click();
    assert.equal(await page.locator('.writing-tree-item[data-path="研究计划/实验.md"]').count(), 0, 'collapsed folders hide their children');
    await page.locator('#writing-search').fill('实验');
    assert.equal(await page.locator('.writing-tree-item[data-path="研究计划/实验.md"]').count(), 1, 'search reveals matches inside collapsed folders');
    await page.locator('#writing-search').fill('');
    assert.equal(await page.locator('.writing-tree-item[data-path="研究计划/实验.md"]').count(), 0, 'clearing search restores the collapsed tree');
    await page.getByRole('button', { name: '展开文件夹“研究计划”', exact: true }).click();
    assert.equal(await page.locator('.writing-tree-item[data-path="研究计划/实验.md"]').count(), 1, 'expanded folders restore their children');
    await page.locator('#writing-preview-toggle').click();
    await saved();
    assert.equal((await read('研究计划/实验.md')).content, markdown);
    assert.equal(await page.locator('#writing-preview h1').innerText(), '研究计划');
    const output = path.join(process.env.EZREAD_TEST_ROOT, 'work/writing-verification');
    fs.mkdirSync(output, { recursive: true });
    await page.screenshot({ path: path.join(output, 'markdown-wide.png') });
    await page.locator('#writing-sidebar-toggle').click();
    await page.waitForFunction(() => document.querySelector('#sidebar').getBoundingClientRect().width < 100);
    await page.screenshot({ path: path.join(output, 'markdown-sidebar-collapsed.png') });
    await page.locator('#writing-sidebar-toggle').click();
    await page.waitForFunction(() => document.querySelector('#sidebar').getBoundingClientRect().width > 150);
    await create('论文', 'docx');
    assert.ok(await page.locator('.writing-toolbar button:visible').count() <= 12, 'Word toolbar has at most twelve visible controls');
    await page.locator('#writing-word').fill('Word 正文：中文和 English。');
    const wordBeforeZoom = await page.locator('#writing-word').innerHTML();
    await page.locator('#writing-zoom-in').click();
    assert.equal(await page.locator('#writing-word').evaluate(node => getComputedStyle(node).zoom), '1.1');
    assert.equal(await page.locator('#writing-word').innerHTML(), wordBeforeZoom);
    await page.locator('#writing-zoom-out').click();
    await page.locator('#writing-word').press('Control+Home');
    await page.locator('#writing-word').press('Control+Shift+End');
    await page.locator('#writing-word-style-trigger').click();
    await page.locator('#writing-word-style-menu').getByRole('option', { name: '加粗', exact: true }).click();
    await saved();
    let word = await read('研究计划/论文.docx');
    assert.match(word.content, /<strong>Word 正文/);
    await page.screenshot({ path: path.join(output, 'word-wide.png') });
    await create('公式', 'tex');
    assert.ok(await page.locator('.writing-toolbar button:visible').count() <= 12, 'LaTeX toolbar has at most twelve visible controls');
    await page.locator('#writing-source').fill('\\documentclass{article}\n\\begin{document}\n\\section{实验}\nE=mc^2\n\\end{document}');
    const latexBeforeZoom = await page.locator('#writing-source').inputValue();
    const latexFont = await page.locator('#writing-source').evaluate(node => parseFloat(getComputedStyle(node).fontSize));
    await page.locator('#writing-zoom-in').click();
    assert.ok(await page.locator('#writing-source').evaluate(node => parseFloat(getComputedStyle(node).fontSize)) > latexFont);
    assert.equal(await page.locator('#writing-source').inputValue(), latexBeforeZoom);
    await page.locator('#writing-zoom-out').click();
    // Switching before the debounce expires must flush the current document.
    await open('研究计划/论文.docx');
    assert.match((await read('研究计划/公式.tex')).content, /section\{实验\}/);
    assert.match(await page.locator('#writing-word').innerText(), /Word 正文/);
    assert.equal(await page.locator('#writing-word strong').count(), 1);
    await open('研究计划/实验.md');
    await page.setViewportSize({ width: 1000, height: 720 });
    await page.screenshot({ path: path.join(output, 'markdown-narrow.png') });
    const geometry = await page.evaluate(() => {
      const editor = document.querySelector('#writing-markdown-editor').getBoundingClientRect();
      const footer = document.querySelector('.writing-status').getBoundingClientRect();
      return { horizontal: document.documentElement.scrollWidth > innerWidth + 1, height: editor.height, footer: footer.bottom, viewport: innerHeight };
    });
    assert.equal(geometry.horizontal, false, JSON.stringify(geometry));
    assert.ok(geometry.height > 100 && geometry.footer <= geometry.viewport + 1, JSON.stringify(geometry));
    await page.evaluate(() => { state.settings.theme = 'graphite'; state.settings.ui_font_size = 20; applyPreferences(); });
    await page.screenshot({ path: path.join(output, 'markdown-dark-large-font.png') });
    assert.equal(await page.locator('.CodeMirror').evaluate(node => getComputedStyle(node).backgroundColor), await page.locator('.writing-document').evaluate(node => getComputedStyle(node).backgroundColor));
    await page.evaluate(() => { state.settings.theme = 'paper'; state.settings.ui_font_size = 16; applyPreferences(); });
    await page.setViewportSize({ width: 1440, height: 960 });
    // Server rejects stale writes without discarding the local editor draft.
    const disk = await read('研究计划/实验.md');
    await post({ operation: 'save', path: disk.path, revision: disk.revision, content: '# 外部编辑' });
    await markdownFill('# 我的未保存草稿');
    await page.locator('#writing-recovery').waitFor({ state: 'visible' });
    assert.equal((await read(disk.path)).content, '# 外部编辑');
    assert.equal(await page.evaluate(() => ezreadPrepareDesktopClose()), false);
    await page.locator('#writing-save-copy').click();
    await page.locator('#writing-confirm').click();
    await page.waitForFunction(() => !document.querySelector('#writing-dialog').open);
    assert.equal((await read('研究计划/实验-草稿.md')).content, '# 我的未保存草稿');
    // Restore the fixture's original manuscript through the public contract.
    const external = await read(disk.path);
    await post({ operation: 'save', path: disk.path, revision: external.revision, content: markdown });
    await page.locator('#writing-rename').click();
    await page.locator('#writing-name').fill('恢复稿.md');
    await page.locator('#writing-confirm').click();
    await page.waitForFunction(() => !document.querySelector('#writing-dialog').open);
    assert.equal((await read('研究计划/恢复稿.md')).content, '# 我的未保存草稿');
    await page.locator('#writing-trash').click();
    await page.locator('#writing-confirm').click();
    await page.waitForFunction(() => !document.querySelector('#writing-dialog').open);
    assert.equal(await page.locator('[data-path="研究计划/恢复稿.md"]').count(), 0);
    // Local draft recovery after a failed network save and reload.
    await open('研究计划/实验.md');
    await page.route('**/api/writing', async route => {
      if (route.request().method() === 'POST') await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"离线测试"}' });
      else await route.continue();
    });
    await markdownFill(markdown + '\n\n离线草稿');
    await page.locator('#writing-recovery').waitFor({ state: 'visible' });
    page.once('dialog', dialog => dialog.accept());
    await page.reload();
    await page.locator('#mode-writing').click();
    await open('研究计划/实验.md');
    assert.match(await page.locator('#writing-source').inputValue(), /离线草稿/);
    await page.unroute('**/api/writing');
    assert.equal(await page.evaluate(() => ezreadPrepareDesktopClose()), true);
    await saved();
    assert.match((await read('研究计划/实验.md')).content, /离线草稿/);
    await page.locator('#mode-reading').click();
    await page.locator('#library-view').waitFor({ state: 'visible' });
    await page.locator('#mode-writing').click();
    assert.match(await page.locator('#writing-source').inputValue(), /离线草稿/);
    await page.locator('#writing-search').fill('论文');
    assert.equal(await page.locator('.writing-tree-item:not(.writing-tree-folder)[data-path]').count(), 1);
    await page.locator('#writing-search').fill('');
    await page.evaluate(async () => {
      for (const name of ['OrderA', 'OrderB', 'OrderC', 'OrderB/X', 'OrderB/Y']) await writingRequest({ operation: 'create', kind: 'folder', path: name });
      for (const name of ['OrderB/a.md', 'OrderB/z.md']) await writingRequest({ operation: 'create', kind: 'file', path: name });
      await writingRefresh();
      window.__orderEditor = writingMarkdown.editor;
    });
    const folders = () => page.locator('.writing-tree-folder[data-path]').evaluateAll(nodes => nodes.map(node => node.dataset.path));
    const orderFolders = async () => (await folders()).filter(name => name.startsWith('Order'));
    const currentContent = await page.locator('#writing-source').inputValue();
    await page.locator('.writing-tree-folder[data-path="OrderB"]').click();
    await page.locator('#writing-folder-up').click(); await saved();
    assert.deepEqual(await orderFolders(), ['OrderB', 'OrderB/X', 'OrderB/Y', 'OrderA', 'OrderC']);
    assert.equal(await page.evaluate(() => window.__orderEditor === writingMarkdown.editor), true);
    assert.equal(await page.locator('#writing-source').inputValue(), currentContent);
    await page.locator('.writing-tree-folder[data-path="OrderB/Y"]').click();
    await page.locator('#writing-folder-up').click(); await saved();
    assert.deepEqual(await orderFolders(), ['OrderB', 'OrderB/Y', 'OrderB/X', 'OrderA', 'OrderC']);
    assert.equal(await page.locator('#writing-folder-up').isDisabled(), true);
    assert.deepEqual(await page.locator('.writing-tree-item:not(.writing-tree-folder)[data-path^="OrderB/"]').allTextContents(), ['a.md', 'z.md']);
    await page.reload(); await page.waitForFunction(() => !state.loading);
    await page.locator('#mode-writing').click();
    await page.waitForFunction(() => writingState.mode === 'writing' && !writingState.busy);
    assert.deepEqual(await orderFolders(), ['OrderB', 'OrderB/Y', 'OrderB/X', 'OrderA', 'OrderC']);
    await page.locator('.writing-tree-folder[data-path="OrderB"]').click();
    await page.locator('#writing-folder-down').click(); await saved();
    assert.deepEqual(await orderFolders(), ['OrderA', 'OrderB', 'OrderB/Y', 'OrderB/X', 'OrderC']);
    await page.locator('.writing-tree-root button').click();
    assert.equal(await page.locator('#writing-folder-up').isDisabled(), true);
    assert.equal(await page.locator('#writing-folder-down').isDisabled(), true);
    await page.evaluate(async () => {
      for (let index = 0; index < 24; index++) await writingRequest({ operation: 'create', kind: 'folder', path: `滚动测试 ${String(index + 1).padStart(2, '0')}` });
      await writingRefresh();
    });
    const fixedSelectors = ['.brand', '.workspace-tabs', '.writing-search-row', '.writing-create', '.writing-tree-tools', '.writing-folder-tools', '#writing-open-folder', '#settings-button'];
    const fixedPositions = () => page.evaluate(selectors => selectors.map(selector => document.querySelector(selector).getBoundingClientRect().top), fixedSelectors);
    for (const size of [{ width: 1440, height: 960 }, { width: 1000, height: 720 }]) {
      await page.setViewportSize(size);
      await page.locator('#writing-tree').evaluate(node => { node.scrollTop = 0; });
      const before = await fixedPositions();
      await page.locator('#writing-tree').hover(); await page.mouse.wheel(0, 550);
      await page.waitForFunction(() => document.querySelector('#writing-tree').scrollTop > 100);
      assert.deepEqual(await fixedPositions(), before);
      assert.equal(await page.locator('#writing-sidebar').evaluate(node => node.scrollTop), 0);
      assert.ok(await page.locator('#settings-button').evaluate(node => node.getBoundingClientRect().bottom <= innerHeight));
      await page.screenshot({ path: path.join(output, `writing-tree-scroll-${size.width}.png`) });
    }
    await page.locator('#writing-sidebar-toggle').click();
    await page.waitForFunction(() => document.querySelector('#sidebar').getBoundingClientRect().width < 100);
    assert.equal(await page.locator('#writing-tree').isVisible(), false);
    await page.locator('#writing-sidebar-toggle').click();
    await page.waitForFunction(() => document.querySelector('#sidebar').getBoundingClientRect().width > 150);
    assert.equal(await page.locator('#writing-tree').isVisible(), true);
    // Host/origin and path protections are exercised over HTTP too.
    const unsafe = await page.request.post(origin + '/api/writing', { headers: { Origin: 'https://example.invalid' }, data: { operation: 'create', path: 'bad.md' } });
    assert.equal(unsafe.status(), 403);
    const traversal = await page.request.post(origin + '/api/writing', { data: { operation: 'create', path: '../bad.md' } });
    assert.equal(traversal.status(), 400);
    assert.deepEqual(errors, []);
    console.log('Writing browser checks passed: three formats, preview, formatting, save/reopen, close, draft recovery, conflicts, rename, trash, search, layout, HTTP protections.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
