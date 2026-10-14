const { chromium } = require(process.env.EZREAD_PLAYWRIGHT || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const origin = process.env.EZREAD_TEST_URL, pid = '1234567890abcdef';
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.__copiedText = value; } } });
  });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const translationCalls = [];
  page.on("request", request => { if (/selection-session|\/translate$/.test(request.url()) || /translate_word|translate_sentence/.test(request.postData() || "")) translationCalls.push(request.url()); });
  async function selectText(expectMenu = true) {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    // Pointer selection must work on the actual PDF glyph hit boxes.
    const run = await page.locator('.pdf-text-block[data-source-id="p1-b0"] .pdf-text-run').first().boundingBox();
    const selected = await page.evaluate(() => { const node = document.querySelector('.pdf-text-block[data-source-id="p1-b0"] .pdf-text-run'); const range = document.createRange(); range.setStart(node.firstChild, 0); range.setEnd(node.firstChild, 14); const rect = range.getBoundingClientRect(); return { left: rect.left, right: rect.right, y: rect.top + rect.height / 2 }; });
    await page.mouse.move(run.x + 0.1, selected.y);
    await page.mouse.down();
    await page.mouse.move(selected.right - 0.1, selected.y, { steps: 15 });
    await page.mouse.up();
    if (expectMenu) await page.waitForSelector('.reader-text-menu');
    else { await page.waitForTimeout(300); assert.equal(await page.locator('.reader-text-menu').count(), 0); }
    assert.equal(await page.evaluate(() => readerSelectionSnapshot().text), 'Robot learning');
  }
  try {
    await page.goto(origin); await page.waitForSelector('.paper-card');
    assert.equal(await page.title(), 'PaperNest');
    assert.equal(await page.getByRole('button', { name: /^翻译任务/ }).count(), 0);
    await verifyPersonalJournals(page);

    assert.equal(await page.locator('.brand span').innerText(), 'PaperNest');
    assert.ok(await page.locator('.brand-icon').evaluate(img => img.complete && img.naturalWidth > 0 && img.src.includes('papernest-icon.png')));
    assert.ok(await page.locator('.brand').evaluate(node => node.scrollWidth <= node.clientWidth + 1));
    await page.waitForFunction(() => { const image = document.querySelector('.paper-card .card-cover img'); return image?.complete && image.naturalWidth > 0; });
    assert.equal(await page.locator('.paper-card .card-cover').count(), 1);
    assert.ok(await page.locator('.paper-card').evaluate(card => {
      const cover = card.querySelector('.card-cover').getBoundingClientRect();
      const info = card.querySelector('.card-info-lines').getBoundingClientRect();
      const year = card.querySelector('.card-year').getBoundingClientRect();
      const journal = card.querySelector('.card-journal-name').getBoundingClientRect();
      const summary = card.querySelector('.card-summary').getBoundingClientRect();
      return cover.bottom < info.top && Math.abs(cover.width - info.width) < 1 && Math.abs(cover.height - 88 * 4 / 3) < 1 &&
        year.right < summary.left && journal.right < summary.left && year.bottom <= journal.top &&
        Math.abs(summary.top - year.top) < 1 && info.right <= card.getBoundingClientRect().right;
    }), 'Original-height cover spans the card; year and journal sit below left, description below right');
    assert.equal(await page.locator('.paper-card .card-title').innerText(), 'PDF selection fixture');
    // Only a paper with a longer description widens; all cards keep the same height.
    await page.waitForFunction(() => Boolean(pollTimer));
    await page.evaluate(() => {
      clearInterval(pollTimer);
      window.cardLayoutFixture = { papers: state.papers, font: document.documentElement.style.fontSize };
      state.papers = [
        { ...state.papers[0], title: 'HarnessPAI: An Evolving Harness for Physical AI', year: 2026, journal: 'arxiv', summary: 'agent+VLA' },
        { ...state.papers[0], id: 'card-width-fixture', title: 'Show-Harness: Just a VLM Can Play Robots', year: 2026, journal: 'arxiv', summary: '只有VLM+上下左右的命令控制机械臂，通过语言指令完成抓取和放置，并根据执行结果调整接下来的动作。' }
      ];
      document.documentElement.style.fontSize = '16px'; renderLibrary();
    });
    async function cardBoxes() {
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      return page.locator('.paper-card').evaluateAll(cards => cards.map(card => {
        const description = card.querySelector('.card-description'), rect = card.getBoundingClientRect();
        return { width: rect.width, height: rect.height, x: rect.left, y: rect.top, right: rect.right, bottom: rect.bottom,
          clipped: card.scrollWidth > card.clientWidth + 1, descriptionFits: description.scrollHeight <= description.clientHeight + 1 };
      }));
    }
    for (const width of [1920, 1280, 800]) {
      await page.setViewportSize({ width, height: 900 });
      const boxes = await cardBoxes(), [short, long] = boxes;
      const contentLeft = await page.locator('#library-view').evaluate(node => node.getBoundingClientRect().left + parseFloat(getComputedStyle(node).paddingLeft));
      assert.ok(Math.abs(short.x - contentLeft) < 1, 'First card starts at the left content edge');
      assert.ok(short.width < 340 && long.width > short.width + 40 && Math.abs(short.height - long.height) < 1, JSON.stringify(boxes));
      assert.ok(boxes.every(b => b.right <= width && !b.clipped), JSON.stringify(boxes));
      assert.ok(short.right <= long.x || long.right <= short.x || short.bottom <= long.y || long.bottom <= short.y, 'Cards never overlap');
      if (width >= 1280) assert.ok(long.descriptionFits, 'The expanded card shows its entire description');
    }
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.evaluate(() => { document.documentElement.style.fontSize = '20px'; renderLibrary(); });
    const beforeEdit = await cardBoxes();
    await page.screenshot({ path: path.join(process.env.EZREAD_TEST_ROOT, 'work/individual-card-widths.png') });
    await page.evaluate(() => { state.papers[1].summary = '简短介绍'; renderLibrary(); });
    const shortened = await cardBoxes();
    assert.equal(shortened[0].width, beforeEdit[0].width);
    assert.equal(shortened[1].height, beforeEdit[1].height);
    assert.equal(shortened[1].width, shortened[0].width);
    await page.evaluate(() => {
      state.papers = window.cardLayoutFixture.papers;
      document.documentElement.style.fontSize = window.cardLayoutFixture.font;
      delete window.cardLayoutFixture; renderLibrary(); pollTimer = setInterval(poll, 6000);
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    console.log('PASS: fixed card height, independent description-driven widths, shrinking after edits and narrow-window wrapping.');
    await page.getByRole('button', { name: '编辑年份', exact: true }).click();
    await page.getByRole('spinbutton', { name: '年份', exact: true }).fill('2025');
    await page.getByRole('textbox', { name: '期刊名字', exact: true }).fill('MRJ');
    await page.getByRole('button', { name: 'My Robotics Journal · Q1', exact: true }).click();
    assert.equal(await page.getByRole('textbox', { name: '期刊名字', exact: true }).inputValue(), 'My Robotics Journal');
    await page.getByRole('textbox', { name: '简单介绍', exact: true }).fill('这是我自己填写的简单介绍。');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('#edit-dialog').open);
    await page.reload(); await page.waitForSelector('.paper-card');
    assert.deepEqual(await page.locator('.paper-card .card-info-line').allTextContents(), ['年份2025', '期刊My Robotics Journal', '介绍这是我自己填写的简单介绍。']);
    assert.equal(await page.locator('.paper-card .card-title').innerText(), 'PDF selection fixture');
    await page.getByRole('button', { name: '编辑年份', exact: true }).click();
    await page.getByRole('button', { name: '更换封面', exact: true }).click();
    await page.getByRole('radio', { name: '选择第 1 张插图', exact: true }).check();
    assert.ok((await page.getByAltText('待保存封面').getAttribute('src')).endsWith('/figure-001.png'));
    await page.locator('#edit-dialog').getByRole('button', { name: '取消', exact: true }).click();
    assert.ok((await page.locator('.paper-card .card-cover img').getAttribute('src')).endsWith('/page-001.jpg'));
    await page.getByRole('button', { name: '编辑年份', exact: true }).click();
    await page.getByRole('button', { name: '更换封面', exact: true }).click();
    await page.getByRole('radio', { name: '选择第 2 张插图', exact: true }).check();
    await page.setViewportSize({ width: 620, height: 780 });
    await page.getByAltText('待保存封面').scrollIntoViewIfNeeded();
    assert.ok(await page.locator('#edit-dialog').evaluate(node => node.scrollWidth <= node.clientWidth + 1));
    await page.screenshot({ path: path.join(process.env.EZREAD_TEST_ROOT, 'work/cover-picker.png') });
    const coverUrl = `${origin}/api/papers/${pid}/cover`;
    await page.route(coverUrl, route => route.fulfill({ status: 500, json: { error: '模拟封面保存失败' } }));
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByText('模拟封面保存失败', { exact: true }).waitFor();
    assert.equal(await page.locator('#edit-dialog').evaluate(node => node.open), true);
    assert.equal(await page.getByRole('radio', { name: '选择第 2 张插图', exact: true }).isChecked(), true);
    await page.unroute(coverUrl);
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('#edit-dialog').open);
    await page.reload(); await page.waitForSelector('.paper-card');
    assert.ok((await page.locator('.paper-card .card-cover img').getAttribute('src')).endsWith('/figure-002.png'));
    await page.getByRole('button', { name: '编辑年份', exact: true }).click();
    await page.getByRole('button', { name: '更换封面', exact: true }).click();
    assert.equal(await page.getByRole('radio', { name: '选择第 2 张插图', exact: true }).isChecked(), true);
    await page.locator('#edit-dialog').getByRole('button', { name: '取消', exact: true }).click();
    const detailUrl = `${origin}/api/papers/${pid}`;
    await page.route(detailUrl, async route => {
      const response = await route.fetch(); const body = await response.json(); body.paper.figures = [];
      await route.fulfill({ response, json: body });
    });
    await page.getByRole('button', { name: '编辑年份', exact: true }).click();
    await page.getByRole('button', { name: '更换封面', exact: true }).click();
    await page.getByText('这篇论文没有提取到可选插图，继续使用当前封面。', { exact: true }).waitFor();
    await page.locator('#edit-dialog').getByRole('button', { name: '取消', exact: true }).click();
    await page.unroute(detailUrl);
    await page.setViewportSize({ width: 1440, height: 1000 });
    console.log('PASS: cover picker preview, cancel, save/retry, reload persistence, empty state and narrow layout.');
    await page.evaluate(() => {
      state.collections = ['Agent', 'VLA']; state.settings.collections = ['Agent', 'VLA'];
      state.papers[0].collections = ['Agent', 'VLA']; state.papers[0].collection = 'Agent'; renderLibrary();
    });
    for (const group of ['Agent', 'VLA']) {
      await page.getByRole('button', { name: new RegExp(`^${group}\\s+1$`) }).click();
      assert.equal(await page.locator('.paper-card').count(), 1, `paper is visible in ${group}`);
    }
    await page.evaluate(() => setView('all'));
    await page.evaluate(async id => { await patchPaper(id, { collections: ['Agent', 'VLA'] }); await openDetail(id); }, pid);
    await page.locator('#detail-collection-trigger').click();
    assert.equal(await page.getByRole('option', { name: 'Agent', exact: true }).count(), 1);
    await page.getByRole('option', { name: 'Agent', exact: true }).locator('input').uncheck();
    await page.waitForFunction(() => state.detail.collections.length === 1 && state.detail.collections[0] === 'VLA');
    await page.getByRole('button', { name: '完成', exact: true }).click();
    await page.getByRole('button', { name: '关闭论文', exact: true }).click();
    await page.screenshot({ path: path.join(process.env.EZREAD_TEST_ROOT, 'work/text-cards.png') });
    await page.evaluate(id => openReader(id), pid);
    await page.waitForSelector('.pdf-text-run');
    const readerToolbarLabels = await page.locator('.reader-tools > button, .reader-interaction-switch > button').allTextContents();
    assert.deepEqual(readerToolbarLabels.slice(0, 3), ['文件地址', '纯阅读', '阅读笔记']);
    await page.getByRole('button', { name: '文件地址', exact: true }).click();
    await page.waitForFunction(expected => window.__copiedText === expected, process.env.EZREAD_TEST_PDF_PATH);
    assert.equal(await page.evaluate(() => window.__copiedText), process.env.EZREAD_TEST_PDF_PATH);
    await page.getByText('已复制 PDF 文件地址', { exact: true }).waitFor();
    assert.equal(await page.locator('#translation-scroll, .reader-mode-switch, .reader-text-view-switch, iframe').count(), 0);
    await selectText();
    for (const name of ['复制', '添加定位笔记']) assert.equal(await page.getByRole('menuitem', { name, exact: true }).count(), 1);
    await page.getByRole('button', { name: '纯阅读', exact: true }).click();
    assert.equal(await page.locator('.reader-text-menu').count(), 0);
    assert.equal(await page.getByRole('button', { name: '纯阅读', exact: true }).getAttribute('aria-pressed'), 'true');
    await selectText(false);
    const nativeSelection = await page.evaluate(() => {
      const node = document.querySelector('.pdf-text-run');
      const context = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      node.dispatchEvent(context);
      const data = new DataTransfer();
      node.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: data }));
      readerQueueSelectionMenu();
      return { nativeContext: !context.defaultPrevented, copied: data.getData('text/plain') };
    });
    assert.deepEqual(nativeSelection, { nativeContext: true, copied: 'Robot learning' });
    await page.screenshot({ path: path.join(process.env.EZREAD_TEST_ROOT, 'work/pure-reading.png') });
    await page.evaluate(() => closeReader());
    await page.reload(); await page.waitForSelector('.paper-card');
    await page.evaluate(id => openReader(id), pid); await page.waitForSelector('.pdf-text-run');
    assert.equal(await page.getByRole('button', { name: '纯阅读', exact: true }).getAttribute('aria-pressed'), 'true');
    await selectText(false);
    await page.getByRole('button', { name: '阅读笔记', exact: true }).click();
    await selectText();
    await page.getByRole('menuitem', { name: '黄色高亮', exact: true }).click();
    await page.waitForFunction(() => state.reader.text_annotations?.length === 1 && CSS.highlights.get('ezread-text-highlight').size > 0);
    await page.evaluate(() => { readerCloseTextPopup(true); window.getSelection().removeAllRanges(); });
    await selectText();
    await page.getByRole('menuitem', { name: '添加定位笔记', exact: true }).click();
    await page.getByRole('textbox', { name: '定位笔记内容', exact: true }).fill('PDF 上的测试笔记');
    await page.getByRole('button', { name: '纯阅读', exact: true }).click();
    assert.equal(await page.getByRole('textbox', { name: '定位笔记内容', exact: true }).innerText(), 'PDF 上的测试笔记');
    await page.getByRole('button', { name: '阅读笔记', exact: true }).click();
    await page.getByRole('button', { name: '保存定位笔记', exact: true }).click();
    await page.waitForSelector('.pdf-note-marker');
    await page.waitForSelector('.reader-note-view-content');
    assert.equal(await page.getByRole('textbox', { name: '定位笔记内容', exact: true }).count(), 0);
    await page.getByRole('button', { name: '收起笔记', exact: true }).click();
    await page.evaluate(() => window.getSelection().removeAllRanges());
    await selectText();
    assert.equal(await page.getByRole('menuitem', { name: /翻译/ }).count(), 0);
    await page.evaluate(async id => { readerCloseTextPopup(true); window.getSelection().removeAllRanges(); await closeReader(); await openReader(id); }, pid);
    await page.waitForSelector('.pdf-note-marker');
    assert.ok(await page.evaluate(() => CSS.highlights.get('ezread-text-highlight').size > 0));
    await page.locator('.pdf-note-marker').first().click();
    assert.equal(await page.locator('.reader-note-view-content').innerText(), 'PDF 上的测试笔记');
    assert.equal(await page.locator('.reader-rich-note').count(), 0);
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    assert.equal(await page.getByRole('textbox', { name: '定位笔记内容', exact: true }).innerText(), 'PDF 上的测试笔记');
    // Image upload follows the existing note storage API, without using the user's clipboard.
    await page.locator('.reader-note-toolbar input[type=file]').setInputFiles({ name: 'pixel.png', mimeType: 'image/png',
      buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMuoAAAAASUVORK5CYII=', 'base64') });
    await page.waitForSelector('.reader-rich-note img');
    await page.getByRole('button', { name: '保存定位笔记', exact: true }).click();
    await page.waitForFunction(() => state.reader.text_annotations.some(a => a.note_content?.some(c => c.type === 'image')));
    await page.waitForSelector('.reader-note-view-content img');
    await page.getByRole('button', { name: '收起笔记', exact: true }).click();
    await page.evaluate(async id => { await closeReader(); await openReader(id); }, pid);
    await page.waitForSelector('.pdf-note-marker');
    await page.locator('.pdf-note-marker').first().click();
    await page.waitForSelector('.reader-note-view-content img');
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    await page.getByRole('textbox', { name: '笔记标题', exact: true }).fill('不应保存的标题');
    await page.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(await page.locator('.reader-note-view h3').innerText(), '定位笔记');
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    await page.getByRole('textbox', { name: '笔记标题', exact: true }).fill('未保存的草稿标题');
    await page.getByRole('button', { name: '关闭笔记编辑', exact: true }).click();
    await page.locator('.pdf-note-marker').first().click();
    await page.getByRole('button', { name: '继续编辑草稿', exact: true }).click();
    assert.equal(await page.getByRole('textbox', { name: '笔记标题', exact: true }).inputValue(), '未保存的草稿标题');
    await page.getByRole('button', { name: '保存定位笔记', exact: true }).click();
    await page.waitForSelector('.reader-note-view-content img');
    assert.equal(await page.locator('.reader-note-view h3').innerText(), '未保存的草稿标题');
    await page.screenshot({ path: path.join(process.env.EZREAD_TEST_ROOT, 'work/note-read-view.png') });
    await page.getByRole('button', { name: '收起笔记', exact: true }).click();
    // Real pointer selection across printed lines must save one range per source paragraph.
    async function selectAcrossLines(crossParagraph = false, reverse = false) {
      await page.evaluate(() => { readerCloseTextPopup(true); window.getSelection().removeAllRanges(); });
      await page.locator('.pdf-text-block[data-source-id="p1-b3"]').scrollIntoViewIfNeeded();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const points = await page.evaluate(cross => {
        const lines = document.querySelectorAll('.pdf-text-block[data-source-id="p1-b3"] .pdf-text-run');
        if (lines.length !== 2) throw Error(`Expected two printed lines, found ${lines.length}`);
        const last = cross ? document.querySelector('.pdf-text-block[data-source-id="p1-b4"] .pdf-text-run') : lines[1];
        const point = (node, offset) => {
          const range = document.createRange(); range.setStart(node.firstChild, offset); range.collapse(true);
          const rect = range.getBoundingClientRect(); return { x: rect.x, y: rect.y + rect.height / 2 };
        };
        return [point(lines[0], 6), point(last, last.textContent.length)];
      }, crossParagraph);
      points[0].x += 1; points[1].x -= 1;
      if (reverse) points.reverse();
      const hits = await page.evaluate(points => points.map(p => {
        const hit = document.elementFromPoint(p.x, p.y);
        return { className: hit?.className, text: hit?.textContent?.slice(0, 80) };
      }), points);
      await page.mouse.move(points[0].x, points[0].y); await page.mouse.down();
      await page.mouse.move(points[1].x, points[1].y, { steps: 15 }); await page.mouse.up();
      assert.ok(await page.evaluate(() => window.getSelection().toString().length > 0), `Pointer drag at ${JSON.stringify({ points, hits })} should select PDF text`);
      await page.waitForSelector('.reader-text-menu');
      const ranges = await page.evaluate(() => readerSelectionSnapshot().ranges.map(({ block_id, quote }) => ({ block_id, quote })));
      assert.deepEqual(ranges, [
        { block_id: 'p1-b3', quote: 'perturbations affect control.' },
        ...(crossParagraph ? [{ block_id: 'p1-b4', quote: 'Another paragraph stays separate.' }] : [])
      ]);
    }
    for (const crossParagraph of [false, true]) {
      await selectAcrossLines(crossParagraph, true);
      await selectAcrossLines(crossParagraph);
      const count = await page.evaluate(() => state.reader.text_annotations.length);
      await page.getByRole('menuitem', { name: '黄色高亮', exact: true }).click();
      await page.waitForFunction(previous => state.reader.text_annotations.length === previous + 1, count);
      const saved = await page.evaluate(() => state.reader.text_annotations.at(-1));
      assert.equal(saved.ranges.length, crossParagraph ? 2 : 1);
      await page.evaluate(async id => {
        readerCloseTextPopup(true); window.getSelection().removeAllRanges(); await closeReader(); await openReader(id);
      }, pid);
      await page.waitForSelector('.pdf-text-block[data-source-id="p1-b3"] .pdf-text-run');
      await page.waitForFunction(({ id, count }) => readerTextUI.painted.filter(p => p.item.id === id).length === count,
        { id: saved.id, count: crossParagraph ? 3 : 2 });
      assert.deepEqual(await page.evaluate(id => state.reader.text_annotations.find(a => a.id === id), saved.id), saved);
    }
    await page.screenshot({ path: path.join(process.env.EZREAD_TEST_ROOT, 'work/pdf-multiline-highlight.png') });
    // DOM uses UTF-16; saved anchors use Unicode code points, including non-BMP characters.
    const unicode = await page.evaluate(() => {
      const block = document.createElement('div'); block.className = 'pdf-text-block'; block.dataset.sourceId = 'unicode-test';
      block.pdfBaseText = 'A😀B𠮷C';
      const run = document.createElement('span'); run.className = 'pdf-text-run'; run.dataset.sourceId = 'unicode-test';
      run.textContent = block.pdfBaseText; run.pdfBaseText = block.pdfBaseText; run.pdfOffsets = [0, 1, 2, 3, 4];
      block.append(run); document.querySelector('#original-scroll').append(block);
      try {
        const range = document.createRange(); range.setStart(run.firstChild, 1); range.setEnd(run.firstChild, 6);
        const snapshot = readerPdfSelectionSnapshot(range), anchor = snapshot.ranges[0];
        return { text: snapshot.text, start: anchor.start, end: anchor.end,
          restored: readerPdfAnchorRanges(anchor).map(r => r.toString()) };
      } finally { block.remove(); }
    });
    assert.deepEqual(unicode, { text: '😀B𠮷', start: 1, end: 4, restored: ['😀B𠮷'] });
    console.log('PASS: forward/reverse multiline and multi-paragraph highlights, dehyphenation, reopen persistence and Unicode anchors.');
    // A highlight comment stays beside the highlight, even when a located note shares its text.
    const noteBeforeComment = await page.evaluate(() => state.reader.text_annotations.find(a => a.kind === 'note'));
    await page.locator('.pdf-note-marker').first().click();
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    await page.getByRole('textbox', { name: '笔记标题', exact: true }).fill('独立保留的定位笔记草稿');
    await page.getByRole('button', { name: '关闭笔记编辑', exact: true }).click();
    await page.getByRole('button', { name: '收起笔记', exact: true }).click();
    const noteDraft = await page.evaluate(id => readerReadLocal('text-action', id), pid);
    const highlightId = await page.evaluate(() => state.reader.text_annotations.find(a => a.kind === 'highlight').id);
    async function clickHighlight() {
      await page.evaluate(() => { readerCloseTextPopup(true); window.getSelection().removeAllRanges(); });
      const run = page.locator('.pdf-text-block[data-source-id="p1-b0"] .pdf-text-run');
      await run.scrollIntoViewIfNeeded();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const point = await run.evaluate(node => {
        const range = document.createRange(); range.setStart(node.firstChild, 2); range.setEnd(node.firstChild, 3);
        const rect = range.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, bottom: rect.bottom };
      });
      await page.mouse.click(point.x, point.y);
      await page.locator('.reader-text-card[aria-label="文字标记"]').waitFor();
      assert.ok((await page.locator('.reader-text-card[aria-label="文字标记"]').boundingBox()).y >= point.bottom);
      assert.equal(await page.locator('#reader-notes').isVisible(), false);
      assert.equal(await page.locator('.pdf-note-marker').count(), 1);
    }
    async function dragComment(dx, dy) {
      const handle = page.getByRole('button', { name: '移动批注框', exact: true });
      const rect = await handle.boundingBox();
      await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
      await page.mouse.down();
      await page.mouse.move(rect.x + rect.width / 2 + dx, rect.y + rect.height / 2 + dy, { steps: 12 });
      await page.mouse.up();
      assert.equal(await handle.evaluate(node => node.classList.contains('dragging')), false);
      return page.locator('.reader-text-card').boundingBox();
    }
    await clickHighlight();
    const beforeDrag = await page.locator('.reader-text-card').boundingBox();
    const movedCard = await dragComment(120, 60);
    assert.ok(Math.abs(movedCard.x - beforeDrag.x - 120) < 2 && Math.abs(movedCard.y - beforeDrag.y - 60) < 2);
    await page.getByRole('button', { name: '添加批注', exact: true }).click();
    const openedEditor = await page.locator('.reader-text-editor').boundingBox();
    assert.ok(Math.abs(openedEditor.x - movedCard.x) < 2 && Math.abs(openedEditor.y - movedCard.y) < 2);
    assert.equal(await page.locator('.reader-rich-note').count(), 0);
    await page.getByRole('textbox', { name: '所选文字批注', exact: true }).fill('这只是高亮批注，不是定位笔记。');
    const movedEditor = await dragComment(80, 40);
    assert.equal(await page.getByRole('textbox', { name: '所选文字批注', exact: true }).inputValue(), '这只是高亮批注，不是定位笔记。');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByText('这只是高亮批注，不是定位笔记。', { exact: true }).waitFor();
    const savedCard = await page.locator('.reader-text-card').boundingBox();
    assert.ok(Math.abs(savedCard.x - movedEditor.x) < 2 && Math.abs(savedCard.y - movedEditor.y) < 2);
    assert.deepEqual(await page.evaluate(id => readerReadLocal('text-action', id), pid), noteDraft);
    assert.deepEqual(await page.evaluate(() => state.reader.text_annotations.find(a => a.kind === 'note')), noteBeforeComment);
    assert.equal(await page.locator('.pdf-note-marker').count(), 1);
    assert.equal(await page.evaluate(() => CSS.highlights.get('ezread-text-note').size), 1);
    await page.getByRole('button', { name: '编辑批注', exact: true }).click();
    await page.getByRole('textbox', { name: '所选文字批注', exact: true }).fill('可恢复的批注草稿');
    await page.keyboard.press('Escape');
    await page.evaluate(async id => { await closeReader(); await openReader(id); }, pid);
    await page.waitForSelector('.pdf-note-marker');
    // Reopening restores the independent located-note view; collapse it before clicking the highlight.
    const collapseNote = page.getByRole('button', { name: '收起笔记', exact: true });
    if (await collapseNote.isVisible()) await collapseNote.click();
    await clickHighlight();
    await page.getByText('这只是高亮批注，不是定位笔记。', { exact: true }).waitFor();
    await page.getByRole('button', { name: '继续编辑批注', exact: true }).click();
    assert.equal(await page.getByRole('textbox', { name: '所选文字批注', exact: true }).inputValue(), '可恢复的批注草稿');
    const commentUrl = `${origin}/api/papers/${pid}/text-actions`;
    await page.route(commentUrl, route => route.fulfill({ status: 500, json: { error: '模拟批注保存失败' } }));
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.locator('.reader-text-save-hint').getByText('模拟批注保存失败', { exact: true }).waitFor();
    assert.equal(await page.getByRole('textbox', { name: '所选文字批注', exact: true }).inputValue(), '可恢复的批注草稿');
    await page.unroute(commentUrl);
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByText('可恢复的批注草稿', { exact: true }).waitFor();
    await page.getByRole('button', { name: '编辑批注', exact: true }).click();
    await page.getByRole('textbox', { name: '所选文字批注', exact: true }).fill('取消这次改动');
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByText('可恢复的批注草稿', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(process.env.EZREAD_TEST_ROOT, 'work/highlight-comment.png') });
    await page.setViewportSize({ width: 720, height: 900 });
    await clickHighlight();
    await dragComment(900, 900);
    await page.setViewportSize({ width: 620, height: 780 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.ok(await page.locator('.reader-text-card[aria-label="文字标记"]').evaluate(node => {
      const rect = node.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
    }));
    const beforeKeyboard = await page.locator('.reader-text-card').boundingBox();
    await page.getByRole('button', { name: '移动批注框', exact: true }).focus();
    await page.keyboard.press('ArrowLeft');
    assert.ok(Math.abs((await page.locator('.reader-text-card').boundingBox()).x - beforeKeyboard.x + 10) < 2);
    await page.screenshot({ path: path.join(process.env.EZREAD_TEST_ROOT, 'work/draggable-comment.png') });
    await page.getByRole('button', { name: '取消高亮', exact: true }).click();
    await page.waitForFunction(id => !state.reader.text_annotations.some(a => a.id === id), highlightId);
    assert.deepEqual(await page.evaluate(() => state.reader.text_annotations.find(a => a.kind === 'note')), noteBeforeComment);
    assert.deepEqual(await page.evaluate(id => readerReadLocal('text-action', id), pid), noteDraft);
    assert.equal(await page.locator('.pdf-note-marker').count(), 1);
    await page.locator('.pdf-note-marker').first().click();
    await page.getByRole('button', { name: '继续编辑草稿', exact: true }).click();
    assert.equal(await page.getByRole('textbox', { name: '笔记标题', exact: true }).inputValue(), '独立保留的定位笔记草稿');
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('button', { name: '收起笔记', exact: true }).click();
    console.log('PASS: highlight comments stay below text; edit, retry, cancel, persistence, independent drafts and located notes verified.');
    console.log('PASS: comment title dragging, editor content and position preservation, viewport bounds, resize and keyboard movement.');
    for (const width of [1000, 720, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => readerSetZoom(125));
      await page.waitForFunction(() => document.querySelector('.pdf-text-run').getBoundingClientRect().width > 0);
      const geometry = await page.evaluate(() => {
        const span = document.querySelector('.pdf-text-run'), rect = span.getBoundingClientRect(), paper = span.closest('.paper-page').getBoundingClientRect();
        return { error: Math.abs(rect.left - paper.left - span.pdfBox[0] * paper.width), widthError: Math.abs(rect.width - (span.pdfBox[2] - span.pdfBox[0]) * paper.width) };
      });
      assert.ok(geometry.error < 2 && geometry.widthError < 2, JSON.stringify(geometry));
    }
    // Resize beside a live note: dragging must retain its unsaved content.
    await page.getByRole('button', { name: '笔记', exact: true }).click();
    await page.getByRole('textbox', { name: '论文笔记', exact: true }).fill('调整宽度时保留这段笔记');
    const divider = page.getByRole('separator', { name: '调整笔记栏宽度' });
    const handle = await divider.boundingBox();
    const beforeWidth = (await page.locator('#reader-notes').boundingBox()).width;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + 80);
    await page.mouse.down(); await page.mouse.move(handle.x - 120, handle.y + 80, { steps: 12 }); await page.mouse.up();
    assert.ok((await page.locator('#reader-notes').boundingBox()).width > beforeWidth + 100);
    assert.equal(await page.getByRole('textbox', { name: '论文笔记', exact: true }).inputValue(), '调整宽度时保留这段笔记');
    await divider.focus(); await page.keyboard.press('ArrowRight');
    const savedWidth = await page.evaluate(() => state.settings.reader_notes_width);
    await page.getByRole('button', { name: '设置', exact: true }).last().click();
    await page.getByRole('button', { name: '浅绿', exact: true }).click();
    await page.getByLabel('PDF 周围背景颜色', { exact: true }).fill('#ccddee');
    await page.getByRole('button', { name: '暖米色', exact: true }).click();
    for (const [name, value] of [['界面字号', '20'], ['笔记字号', '24']]) {
      await page.getByRole('slider', { name, exact: true }).fill(value);
    }
    await page.waitForFunction(() => !preferenceSaveBusy && !Object.keys(pendingPreferences).length);
    await page.screenshot({ path: path.join(process.env.EZREAD_TEST_ROOT, 'work/pdf-settings.png') });
    await page.getByRole('button', { name: '关闭设置', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => ({
      theme: document.documentElement.dataset.theme, font: getComputedStyle(document.body).fontSize,
      backdrop: getComputedStyle(document.querySelector('#original-scroll')).backgroundColor,
      paper: getComputedStyle(document.querySelector('.paper-page')).backgroundColor,
      note: getComputedStyle(document.querySelector('#reader-notes-text')).fontSize
    })), { theme: 'sage', font: '20px', backdrop: 'rgb(204, 221, 238)', paper: 'rgb(255, 248, 231)', note: '24px' });
    await page.evaluate(() => closeReader());
    await page.reload(); await page.waitForSelector('.paper-card');
    await page.evaluate(id => openReader(id), pid);
    // An earlier image-note draft is intentionally restored by the reader.
    await page.waitForSelector('.pdf-text-run');
    const closeNote = page.getByRole('button', { name: '关闭笔记编辑', exact: true });
    if (await closeNote.isVisible()) await closeNote.click();
    const notesToggle = page.getByRole('button', { name: '笔记', exact: true });
    if (await notesToggle.getAttribute('aria-expanded') !== 'true') await notesToggle.click();
    assert.equal(await page.evaluate(() => state.settings.reader_notes_width), savedWidth);
    assert.equal(await page.getByRole('textbox', { name: '论文笔记', exact: true }).inputValue(), '调整宽度时保留这段笔记');
    assert.equal(await page.evaluate(() => state.settings.pdf_background), '#ccddee');
    for (const width of [800, 620, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.ok(await page.evaluate(() => { const w = document.querySelector('.reader-workspace'), n = document.querySelector('#reader-notes'); return w.scrollWidth <= w.clientWidth + 1 && n.getBoundingClientRect().width > 200; }));
    }
    await page.screenshot({ path: path.join(process.env.EZREAD_TEST_ROOT, 'work/pdf-selection.png') });
    await page.evaluate(() => closeReader());
    await page.evaluate(async id => {
      Object.assign(state.settings, await api('/api/settings', { method: 'PATCH', body: { collections: ['RL', 'VLA', 'Agent'] } }));
      await patchPaper(id, { collections: ['RL', 'VLA'] });
      setView('collection', 'RL');
    }, pid);
    const beforeRemoval = (await (await page.request.get(`${origin}/api/papers/${pid}`)).json()).paper;
    let deleteRequests = 0;
    page.on('request', request => { if (request.method() === 'DELETE') deleteRequests++; });
    await page.locator('.paper-card').click({ button: 'right' });
    await page.getByRole('menuitem', { name: '从「RL」分组移除', exact: true }).click();
    await page.waitForFunction(() => state.papers[0].collections.join() === 'VLA');
    await page.waitForFunction(() => document.querySelectorAll('.paper-card').length === 0);
    await page.reload();
    await page.waitForFunction(() => state.papers.length === 1);
    const afterRemoval = (await (await page.request.get(`${origin}/api/papers/${pid}`)).json()).paper;
    assert.deepEqual(afterRemoval.collections, ['VLA']);
    for (const key of ['title', 'year', 'journal', 'summary', 'notes', 'text_annotations', 'blocks']) {
      assert.deepEqual(afterRemoval[key], beforeRemoval[key], `${key} survives group removal`);
    }
    await page.getByRole('button', { name: /^RL\s+0$/ }).waitFor();
    await page.evaluate(() => setView('collection', 'VLA'));
    assert.equal(await page.locator('.paper-card').count(), 1);
    await page.locator('.paper-card').click({ button: 'right' });
    await page.getByRole('menuitem', { name: '多选', exact: true }).click();
    await page.setViewportSize({ width: 800, height: 900 });
    const removeButton = page.getByRole('button', { name: '从「VLA」分组移除', exact: true });
    await removeButton.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(process.env.EZREAD_TEST_ROOT, 'work/remove-from-group.png') });
    // A failed save keeps the membership and selection for retry.
    const paperUrl = `${origin}/api/papers/${pid}`;
    await page.route(paperUrl, route => route.request().method() === 'PATCH'
      ? route.fulfill({ status: 500, json: { error: '模拟保存失败' } }) : route.continue());
    await removeButton.click();
    await page.getByText(`${pid}：模拟保存失败`, { exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => [state.papers[0].collections, [...state.selectedPapers]]), [['VLA'], [pid]]);
    await page.unroute(paperUrl);
    await removeButton.click();
    await page.waitForFunction(() => state.papers[0].collections.length === 0 && state.selectedPapers.size === 0);
    await page.reload(); await page.waitForFunction(() => state.papers.length === 1);
    await page.evaluate(() => setView('uncategorized'));
    assert.equal(await page.locator('.paper-card').count(), 1);
    const ungrouped = (await (await page.request.get(paperUrl)).json()).paper;
    assert.deepEqual(ungrouped.collections, []);
    assert.equal(ungrouped.collection, '');
    assert.deepEqual(ungrouped.text_annotations, beforeRemoval.text_annotations);
    assert.equal(ungrouped.notes, beforeRemoval.notes);
    assert.equal(deleteRequests, 0, 'Removing group membership never deletes a paper');
    console.log('PASS: context-menu and bulk group removal; other groups, notes and paper preserved; retry, reload and uncategorized verified.');
    // Import a separate record so the original reader fixture remains available to the harness.
    const pdfBytes = await (await page.request.get(`${origin}/media/${pid}/original.pdf`)).body();
    const upload = async () => {
      const response = await page.request.post(`${origin}/api/import`, { multipart: { files: { name: 'delete-reimport.pdf', mimeType: 'application/pdf', buffer: pdfBytes } } });
      const body = await response.json();
      assert.deepEqual(body.errors, []);
      return body.papers[0];
    };
    const imported = await upload();
    await page.evaluate(async ({ first, second }) => {
      await loadLibrary(); setView('all');
      localStorage.setItem('ezread-sort', 'recent'); localStorage.setItem('ezread-sort-direction', 'desc');
      await patchPaper(second, { title: 'AAA newer imported paper', year: 2026 });
      await openReader(second); await closeReader();
      await openReader(first); await closeReader();
    }, { first: pid, second: imported.id });
    const cardIds = () => page.locator('.paper-card').evaluateAll(cards => cards.map(card => card.dataset.paperId));
    assert.deepEqual(await cardIds(), [pid, imported.id]);
    await page.reload(); await page.waitForFunction(() => !state.loading);
    assert.deepEqual(await cardIds(), [pid, imported.id], 'Reading, metadata edits, old preferences and reload preserve import order');
    await page.evaluate(async id => {
      await loadLibrary(); await patchPaper(id, { notes: 'old notes to delete', collections: ['RL'] });
      readerWriteLocal('notes', id, { value: 'old draft to delete' });
      setView('all'); beginPaperSelection(id);
    }, imported.id);
    page.once('dialog', dialog => dialog.dismiss());
    await page.getByRole('button', { name: '彻底删除', exact: true }).click();
    assert.equal((await page.request.get(`${origin}/api/papers/${imported.id}`)).status(), 200);
    page.once('dialog', dialog => { assert.match(dialog.message(), /无法恢复/); return dialog.accept(); });
    await page.getByRole('button', { name: '彻底删除', exact: true }).click();
    await page.waitForFunction(id => !state.papers.some(paper => paper.id === id), imported.id);
    assert.deepEqual(await cardIds(), [pid]);
    assert.equal(await page.evaluate(id => readerReadLocal('notes', id), imported.id), null);
    assert.notEqual((await page.request.get(`${origin}/api/papers/${imported.id}`)).status(), 200);
    assert.notEqual((await page.request.get(`${origin}/media/${imported.id}/original.pdf`)).status(), 200);
    const fresh = await upload();
    assert.notEqual(fresh.id, imported.id);
    assert.equal(fresh.notes, '');
    assert.deepEqual(fresh.collections, []);
    assert.ok(!fresh.duplicate);
    assert.equal((await page.request.get(`${origin}/media/${fresh.id}/original.pdf`)).status(), 200);
    await page.reload(); await page.waitForFunction(() => !state.loading);
    assert.deepEqual(await cardIds(), [pid, fresh.id], 'Fresh imports append after existing papers');
    assert.equal(await page.evaluate(id => readerReadLocal('notes', id), imported.id), null);
    console.log('PASS: permanent deletion confirmation/cancellation, PDF removal, local draft cleanup and fresh PDF reimport.');
    assert.deepEqual(errors, []);
    assert.deepEqual(translationCalls, [], 'No automatic or selection translation requests');
    console.log('PASS: PDF selection, annotations, image notes, disabled translation; draggable notes, appearance settings, reload persistence and narrow layout. No real model calls.');
  } catch (error) {
    console.log('Browser errors:', errors);
    console.log(await page.evaluate(() => ({ selection: window.getSelection().toString(), snapshot: readerSelectionSnapshot()?.text,
      editing: !!readerTextUI.editor, placement: readerTextUI.placement, menuKey: readerTextUI.menuKey,
      annotations: state.reader?.text_annotations, content: readerTextUI.editor && readerCollectNoteContent(readerTextUI.editor.content) })));
    await page.screenshot({ path: path.join(process.env.EZREAD_TEST_ROOT, 'work/pdf-selection-failed.png') });
    throw error;
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });

async function verifyPersonalJournals(page) {
  await page.getByRole('button', { name: '设置', exact: true }).last().click();
  assert.equal(await page.getByRole('tab', { name: '翻译', exact: true }).count(), 0);
  await page.getByRole('tab', { name: '期刊信息', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.journal-catalogue-tier-trigger').disabled);
  assert.equal(await page.locator('.journal-catalogue-row').count(), 0);
  await page.getByRole('button', { name: '添加期刊', exact: true }).click();
  await page.getByRole('textbox', { name: '期刊全称', exact: true }).fill('My Robotics Journal');
  await page.getByRole('textbox', { name: '期刊别名', exact: true }).fill('MRJ');
  await page.getByRole('button', { name: '保存期刊', exact: true }).click();
  await page.waitForSelector('.journal-catalogue-row');
  await page.getByRole('button', { name: '查看期刊分区：Q1', exact: true }).click();
  await page.getByRole('menuitemradio', { name: /^Q3期刊/ }).click();
  await page.getByRole('button', { name: '添加期刊', exact: true }).click();
  await page.getByRole('textbox', { name: '期刊全称', exact: true }).fill('Second Journal');
  await page.getByRole('button', { name: '保存期刊', exact: true }).click();
  await page.getByRole('button', { name: '编辑 Second Journal', exact: true }).waitFor();
  await page.getByRole('combobox', { name: '搜索期刊名单', exact: true }).fill('MRJ');
  await page.getByRole('button', { name: '编辑 My Robotics Journal', exact: true }).click();
  await page.getByRole('textbox', { name: '分区备注（可选）', exact: true }).fill('2026 · Robotics');
  await page.getByRole('button', { name: '保存期刊', exact: true }).click();
  await page.getByText('2026 · Robotics', { exact: true }).waitFor();
  await page.setViewportSize({ width: 800, height: 700 });
  const geometry = await page.locator('.journal-catalogue-heading').evaluate(node => {
    const box = node.getBoundingClientRect(); return { left: box.left, right: box.right, width: innerWidth };
  });
  assert.ok(geometry.left >= 0 && geometry.right <= geometry.width);
  await page.screenshot({ path: path.join(process.env.EZREAD_TEST_ROOT, 'work/personal-journals-narrow.png') });
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  await page.reload(); await page.waitForSelector('.paper-card');
  await page.getByRole('button', { name: '设置', exact: true }).last().click();
  await page.getByRole('tab', { name: '期刊信息', exact: true }).click();
  await page.getByRole('button', { name: '编辑 My Robotics Journal', exact: true }).waitFor();
  assert.equal(await page.getByText('2026 · Robotics', { exact: true }).count(), 1);
  await page.getByRole('combobox', { name: '搜索期刊名单', exact: true }).fill('Second');
  await page.getByRole('button', { name: '移除 Second Journal', exact: true }).click();
  await page.getByRole('button', { name: '确认移除期刊', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.journal-catalogue-row'));
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  console.log('PASS: manual Q catalogue, add without ISSN, alias search, edit, delete, reload and narrow layout.');
}
