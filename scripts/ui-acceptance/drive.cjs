/**
 * UI kabul sürücüsü: gerçek MERGEN Rota arayüzünü tarayıcıda kullanır. Senaryo dosyası:
 *   { profile, port, appLog, conversations: [{ name, detail, turns: ["...", ...] }] }
 * Her konuşma Bilgin'de YENİ konuşmayla başlar; turlar aynı konuşmada yazılıp gönderilir. Ayrıntı ayarı Ayarlar
 * ekranındaki "Yanıt ayrıntısı" denetimiyle değiştirilir. Her tur için görünen yanıt metni, tablolar, grafikler (DOM),
 * ekran görüntüsü, sunucunun tur izi ve köprünün model kaydı saklanır.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { semanticFailures, completionFailures, modelFailures } = require('./expectations.cjs');

const [scenarioFile, outDir] = process.argv.slice(2);
const scenario = JSON.parse(fs.readFileSync(scenarioFile, 'utf8'));
// İsteğe bağlı: yalnızca adı verilen konuşmalar (yarıda kalan koşunun kalanı için).
if (process.env.UI_ONLY) scenario.conversations = scenario.conversations.filter((item) => process.env.UI_ONLY.split(',').includes(item.name));
scenario.appLog = path.resolve(process.env.UI_ACCEPTANCE_DIR || '.', scenario.appLog);
const CALLS = path.join(process.env.UI_ACCEPTANCE_DIR || path.join(__dirname, 'logs'), 'calls.jsonl');
const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);
const turnTraces = () => lines(scenario.appLog).filter((line) => line.includes('"operation":"ai.grounded.turn"'))
  .map((line) => { try { return JSON.parse(line.slice(line.indexOf('{'))).context; } catch { return null; } }).filter(Boolean);

async function setDetail(page, detail) {
  // Odak görünümündeki Bilgin paneli sayfanın üstünde kipsel bir iletişim kutusudur: ayara gitmeden önce kapatılır.
  const close = page.getByRole('button', { name: 'Bilgin’i kapat' });
  if (await close.isVisible().catch(() => false)) { await close.click(); await page.waitForTimeout(400); }
  await page.getByRole('button', { name: 'Ayarlar' }).first().click();
  const label = { short: 'Kısa', balanced: 'Dengeli', detailed: 'Ayrıntılı' }[detail];
  const group = page.getByRole('group', { name: 'Yanıt ayrıntısı' });
  await group.getByRole('button', { name: label, exact: true }).click();
  await page.waitForTimeout(400);
  const checked = await group.getByRole('button', { name: label, exact: true }).getAttribute('aria-pressed');
  if (checked !== 'true') throw new Error(`ayrıntı ayarı uygulanmadı: ${detail}`);
  await page.getByRole('button', { name: 'Özet' }).first().click();
}

async function openBilgin(page) {
  if (!(await page.locator('.rota-assistant-input').isVisible().catch(() => false))) await page.locator('.rota-assistant-launcher').click();
  await page.locator('.rota-assistant-input').waitFor({ state: 'visible', timeout: 15000 });
}

async function newConversation(page) {
  const button = page.getByRole('button', { name: 'Yeni konuşma' });
  if (await button.isVisible().catch(() => false)) await button.click();
  await page.waitForTimeout(500);
  // Odak görünümü: yanıtın tamamı geniş panelde görünür (ekran görüntüsü için).
  const focus = page.getByRole('button', { name: 'Odak görünümü' });
  if (await focus.isVisible().catch(() => false) && (await focus.getAttribute('aria-pressed')) !== 'true') await focus.click();
}

async function ask(page, text) {
  const before = await page.locator('.rota-assistant-turn').count();
  const input = page.locator('.rota-assistant-input');
  await input.fill(text);
  await input.press('Enter');
  await page.waitForFunction((count) => {
    const turns = document.querySelectorAll('.rota-assistant-turn');
    if (turns.length <= count) return false;
    const answer = turns[turns.length - 1].querySelector('.rota-assistant-answer');
    return answer && !/is-(waiting|streaming)/.test(answer.className);
  }, before, { timeout: 240000, polling: 500 });
  await page.waitForTimeout(600);
  return page.evaluate(() => {
    const turns = document.querySelectorAll('.rota-assistant-turn');
    const answer = turns[turns.length - 1].querySelector('.rota-assistant-answer');
    const charts = [...answer.querySelectorAll('figure.assistant-chart')].map((figure) => ({
      type: [...figure.classList].find((name) => name.startsWith('is-'))?.slice(3),
      title: figure.getAttribute('aria-label'),
      items: [...figure.querySelectorAll('[aria-label]')].map((node) => node.getAttribute('aria-label')).filter((label) => label && label !== figure.getAttribute('aria-label')),
      visible: figure.getBoundingClientRect().width > 0 && figure.getBoundingClientRect().height > 0
    }));
    const tables = [...answer.querySelectorAll('table')].map((table) => ({ rows: table.querySelectorAll('tbody tr').length, head: [...table.querySelectorAll('th')].map((th) => th.textContent.trim()),
      visible: table.getBoundingClientRect().width > 0 && table.getBoundingClientRect().height > 0 }));
    const status = [...answer.classList].find((name) => name.startsWith('is-'))?.slice(3);
    // Görünen düzyazı: tablo/grafik/kaynak listesi dışındaki paragraflar.
    const body = answer.cloneNode(true);
    body.querySelectorAll('table, figure, details, .rota-assistant-answer-meta, .sr-only').forEach((node) => node.remove());
    return { status, text: answer.innerText, prose: body.innerText.trim(), tables, charts };
  });
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  const page = await context.newPage();
  const resultFile = path.join(outDir, `${scenario.profile}.json`);
  const runId = process.env.UI_RUN_ID || require('crypto').randomUUID();
  // Senaryonun gerektirdiği sentetik veri (ör. Aşama G: UI_SEED=executive) bu koşuda yoksa konuşma sınanmaz. Atlanan konuşma yeniden
  // koşulmuş sayılmaz (önceki satırları silinmez) ve sonuçta eksik kapsam olarak kaydedilir: rapor tam kabul iddia etmez.
  const seedMismatch = (conversation) => Boolean(conversation.seed) && conversation.seed !== (process.env.UI_SEED || null);
  const rerun = new Set(scenario.conversations.filter((item) => !seedMismatch(item)).map((item) => item.name));
  const results = process.env.UI_ONLY && fs.existsSync(resultFile)
    ? JSON.parse(fs.readFileSync(resultFile, 'utf8')).filter((row) => !rerun.has(row.conversation) && !(row.skipped && row.runId === runId)) : [];
  try {
  await page.goto(`http://127.0.0.1:${scenario.port}/`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /Gerçek Sistemi aç/ }).click();
  await page.getByRole('button', { name: /Kapsamlı Kip/ }).click();
  await page.getByRole('button', { name: /Başlayalım/ }).click().catch(() => {});
  await page.waitForTimeout(1500);
  // İsteğe bağlı görünüm (Aşama G görsel kabulü): UI_THEME=light|dark tema (kenar çubuğundaki tema düğmesi; tema zaten istenense
  // dokunulmaz), UI_VIEWPORT=mobile dar görünüm (390×844). Ayarlar geniş görünümde değiştirilir; turlar ve ekran görüntüsü istenen görünümdedir.
  const narrow = process.env.UI_VIEWPORT === 'mobile' ? { width: 390, height: 844 } : null;
  const toggle = { dark: 'Koyu temaya geç', light: 'Açık temaya geç' }[process.env.UI_THEME];
  if (toggle && await page.getByTitle(toggle).first().isVisible().catch(() => false)) { await page.getByTitle(toggle).first().click(); await page.waitForTimeout(400); }
  let currentDetail = null;
  for (const [conversationIndex, conversation] of scenario.conversations.entries()) {
    // Yanlış veriyle sınanmaz: atlanır ve bu koşunun eksik kapsamı olarak kaydedilir (rapor başarı saymaz).
    if (seedMismatch(conversation)) {
      process.stdout.write(`atlandı: ${scenario.profile}/${conversation.name} (UI_SEED=${conversation.seed} gerekir)\n`);
      results.push({ runId, skipped: `UI_SEED=${conversation.seed} gerekir`, failures: [`kapsam eksik: UI_SEED=${conversation.seed} gerekir`], profile: scenario.profile,
        conversation: conversation.name, detail: conversation.detail, turn: 0, question: conversation.turns[0] || '', ms: 0, rendered: { status: 'skipped', tables: [], charts: [] }, server: null, calls: [] });
      fs.writeFileSync(resultFile, JSON.stringify(results, null, 2));
      continue;
    }
    if (conversation.detail !== currentDetail) {
      if (narrow) await page.setViewportSize({ width: 1500, height: 1000 });
      await setDetail(page, conversation.detail);
      currentDetail = conversation.detail;
    }
    if (narrow) await page.setViewportSize(narrow);
    await openBilgin(page);
    await newConversation(page);
    for (const [turnIndex, text] of conversation.turns.entries()) {
      const callsBefore = lines(CALLS).length;
      const tracesBefore = turnTraces().length;
      const started = Date.now();
      let rendered;
      try { rendered = await ask(page, text); } catch (error) { rendered = { status: 'driver-error', error: String(error.message).slice(0, 200) }; }
      const ms = Date.now() - started;
      const calls = lines(CALLS).slice(callsBefore).map((line) => JSON.parse(line));
      const trace = turnTraces().slice(tracesBefore).at(-1) || null;
      const variant = [process.env.UI_VIEWPORT, process.env.UI_THEME].filter(Boolean).join('-');
      const shot = path.join(outDir, `${scenario.profile}-${conversationIndex + 1}-${turnIndex + 1}${variant ? `-${variant}` : ''}.png`);
      await page.locator('.rota-assistant-thread').screenshot({ path: shot }).catch(() => {});
      const expectedChart = conversation.expectedCharts?.[turnIndex] || null;
      const expected = conversation.expectedTurns?.[turnIndex];
      // UI_SCRIPTED=1 (scriptedBridge.mjs): planlar betiklidir, model kabulü yapılmaz; çizici ve sunucu sözleşmesi denetlenir. Kip ortam
      // değişkeninden değil, bu turun çağrı kayıtlarından doğrulanır: canlı köprü kullanıldıysa (kayıtlarda `scripted` yoksa) model
      // kabulü uygulanır; değişken tek başına model denetimini kapatmaz.
      const scripted = process.env.UI_SCRIPTED === '1' && calls.length > 0 && calls.every((call) => call.scripted === true);
      const failures = [...completionFailures(rendered, trace), ...semanticFailures(expected, rendered, trace), ...(scripted ? [] : modelFailures(expected, trace, calls))];
      // "any": türü belirtilmemiş grafik isteği; görünür herhangi bir grafik yeterlidir.
      if (expectedChart && !rendered.charts?.some((chart) => (expectedChart === 'any' || chart.type === expectedChart) && chart.visible)) failures.push(`istenen grafik çizilmedi: ${expectedChart}`);
      if (!trace) failures.push('bu tura ait sunucu kanıtı yok');
      const row = { runId, ...(scripted ? { scripted: true } : {}), failures, expectedOutcome: expected?.outcome || 'grounded', serverReplay: expected?.serverReplay === true, profile: scenario.profile, conversation: conversation.name, detail: conversation.detail, turn: turnIndex + 1, question: text, ms, rendered,
        server: trace ? { outcome: trace.outcome, evidence: trace.evidence, parts: trace.parts, escalated: trace.escalated, presentation: trace.presentation, models: [...new Set((trace.rounds || []).map((round) => round.model))],
          reasoning: trace.usage?.reasoning ?? null } : null,
        calls: calls.map((call) => ({ purpose: call.purpose, toolCalls: call.toolCalls, ok: call.ok, models: call.models, thinking: call.thinking, thinkingTokens: call.thinkingTokens, ms: call.ms,
          input: call.input, cacheRead: call.cacheRead, cacheWrite: call.cacheWrite, output: call.output, error: call.error })), screenshot: path.basename(shot) };
      results.push(row);
      fs.writeFileSync(resultFile, JSON.stringify(results, null, 2));
      process.stdout.write(`${scenario.profile} ${conversation.name} #${turnIndex + 1} ${rendered.status} ${ms}ms charts=${(rendered.charts || []).map((chart) => chart.type).join(',')} tables=${(rendered.tables || []).length} pres=${trace?.presentation?.mode || '-'}${trace?.presentation?.server ? '(server:' + trace.presentation.reason + '/' + trace.presentation.issue + ')' : ''}\n`);
      if (failures.length) throw new Error(failures.join('; '));
    }
  }
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exit(1); });
