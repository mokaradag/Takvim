// Üretim derlemesi gerekir: npm run build.
// Tarayıcı: npm install --no-save --package-lock=false playwright@1.56.1
// Ardından npx playwright install chromium ve bu betik çalıştırılır.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const { chromium } = createRequire(import.meta.url)('playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.env.MERGEN_ROTA_FILTER_TEST_PORT || 18008);
assert.ok(Number.isInteger(port) && port > 0 && port < 65536, 'Geçerli bir sınama portu gerekir.');
const server = spawn(
  process.execPath,
  ['node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', String(port)],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }
);
let browser;
try {
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (c) => {
      if (String(c).includes('Ready in')) resolve();
    });
    server.on('exit', (code) => reject(new Error(`Sunucu: ${code}`)));
  });
  browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    headless: true
  });
  const page = await browser.newPage({
    viewport: { width: 2200, height: 1200 },
    timezoneId: 'Europe/Istanbul'
  });
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  const from = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
  const end = new Date(`${from}T12:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 15);
  const to = end.toISOString().slice(0, 10);
  await page.addInitScript(() => {
    localStorage.setItem('mergen_rota_data_mode_v1', 'demo');
    localStorage.setItem('mergen_rota_mode_selected_v1', '1');
    localStorage.setItem('mp_seen_welcome_v2', '1');
    localStorage.setItem(
      'mergen_rota_tweaks_v1',
      JSON.stringify({ appMode: 'advanced', reduceMotion: true })
    );
  });
  await page.goto(`http://127.0.0.1:${port}`);
  await page.waitForLoadState('networkidle');

  const popup = page.locator('.col-filter-pop');
  const pick = async (iso, index = 0) => {
    await popup
      .locator('.date-input-shell')
      .nth(index)
      .getByRole('button', { name: 'Takvimden tarih seç' })
      .click();
    const panel = page.locator('.date-picker-panel');
    const date = new Date(`${iso}T12:00:00`);
    const label = date.toLocaleDateString('tr-TR', {
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    });
    const month = date.toLocaleDateString('tr-TR', { month: 'long', year: 'numeric' });
    for (
      let n = 0;
      (await panel.locator('strong').innerText()).toLocaleLowerCase('tr-TR') !==
      month.toLocaleLowerCase('tr-TR');
      n++
    ) {
      assert.ok(n < 100);
      const parts = (await panel.locator('strong').innerText()).split(' ');
      const months = [
        'Ocak',
        'Şubat',
        'Mart',
        'Nisan',
        'Mayıs',
        'Haziran',
        'Temmuz',
        'Ağustos',
        'Eylül',
        'Ekim',
        'Kasım',
        'Aralık'
      ];
      const current = `${parts[1]}-${String(months.indexOf(parts[0]) + 1).padStart(2, '0')}-01`;
      await panel.getByRole('button', { name: current < iso ? 'Sonraki ay' : 'Önceki ay' }).click();
    }
    await panel.getByRole('button', { name: label, exact: true }).click();
    assert.equal(await panel.count(), 0);
    assert.equal(await popup.count(), 1);
  };
  const open = async (label, scope, mode) => {
    await scope.getByRole('button', { name: label, exact: true }).click();
    if (mode) await popup.getByRole('button', { name: mode, exact: true }).click();
  };
  const apply = async () => popup.getByRole('button', { name: 'Uygula', exact: true }).click();
  const isoDate = (text) => {
    const [d, m, y] = text.trim().split('/');
    return y ? `${y}-${m}-${d}` : null;
  };
  let checks = 0;
  await page.getByRole('button', { name: 'Görevler', exact: true }).click();
  const headers = page.locator('thead');
  for (const [label, index] of [
    ['Başlangıç', 9],
    ['Bitiş', 10],
    ['Hedef', 11]
  ]) {
    const original = await page
      .locator('tbody tr')
      .evaluateAll(
        (rows, index) =>
          rows.map((row) => ({
            name: row.children[3].textContent.trim(),
            date: row.children[index].textContent.trim()
          })),
        index
      );
    for (const mode of ['Önce', 'Sonra', 'Arası']) {
      await open(label, headers, mode);
      await pick(from);
      if (mode === 'Arası') await pick(to, 1);
      assert.equal(await page.locator('tbody tr').count(), original.length);
      await apply();
      const expected = original.filter((row) => {
        const day = isoDate(row.date);
        return (
          day &&
          (mode === 'Önce'
            ? day <= from
            : mode === 'Sonra'
              ? day >= from
              : day >= from && day <= to)
        );
      });
      assert.equal(await page.locator('tbody tr').count(), expected.length, `${label} ${mode}`);
      await open(label, headers);
      await popup.getByRole('button', { name: 'Temizle', exact: true }).click();
      assert.equal(await page.locator('tbody tr').count(), original.length);
      checks++;
    }
  }
  await page.getByRole('button', { name: 'Gantt', exact: true }).click();
  await page.locator('.gantt-task-row').first().waitFor();
  await page.getByRole('button', { name: 'Sütunları yönet', exact: true }).click();
  for (const label of [
    'Hedef',
    'Erken Başlangıç',
    'Erken Bitiş',
    'Geç Başlangıç',
    'Geç Bitiş',
    'Toplam Bolluk',
    'Serbest Bolluk',
    'Süre'
  ])
    await page
      .locator('.gantt-cols-pop label')
      .filter({ hasText: new RegExp(`^${label}$`) })
      .getByRole('checkbox')
      .check();
  await page.locator('.topbar-search input').click();
  const ganttHead = page.locator('.gantt-left-head');
  const allNames = await page.locator('.gantt-task-row .tr-name').allTextContents();
  for (const label of ['Erken Başlangıç', 'Erken Bitiş', 'Geç Başlangıç', 'Geç Bitiş']) {
    const labels = await ganttHead.locator('.col-th-btn > span:first-child').allTextContents();
    const index = labels.indexOf(label) - 1;
    const original = await page
      .locator('.gantt-task-row')
      .evaluateAll(
        (rows, index) =>
          rows.map((row) => ({
            name: row.querySelector('.tr-name').textContent,
            date: row.querySelectorAll('.tr-date')[index].textContent
          })),
        index
      );
    for (const mode of ['Önce', 'Sonra', 'Arası']) {
      await open(label, ganttHead, mode);
      await pick(from);
      if (mode === 'Arası') await pick(to, 1);
      await apply();
      const expected = original
        .filter((row) => {
          const day = isoDate(row.date);
          return (
            day &&
            (mode === 'Önce'
              ? day <= from
              : mode === 'Sonra'
                ? day >= from
                : day >= from && day <= to)
          );
        })
        .map((row) => row.name);
      assert.deepEqual(
        (await page.locator('.gantt-task-row .tr-name').allTextContents()).sort(),
        expected.sort(),
        `${label} ${mode}`
      );
      await open(label, ganttHead);
      await popup.getByRole('button', { name: 'Temizle', exact: true }).click();
      assert.equal(await page.locator('.gantt-task-row').count(), allNames.length);
      checks++;
    }
  }
  for (const label of ['Toplam Bolluk', 'Serbest Bolluk', 'Süre']) {
    const labels = await ganttHead.locator('.col-th-btn > span:first-child').allTextContents();
    const index = labels.indexOf(label) - 1;
    const original = await page
      .locator('.gantt-task-row')
      .evaluateAll(
        (rows, index) =>
          rows.map((row) => ({
            name: row.querySelector('.tr-name').textContent,
            value: row.querySelectorAll('.tr-date')[index].textContent
          })),
        index
      );
    for (const [mode, values] of [
      ['Az', [5]],
      ['Çok', [5]],
      ['Arası', [0, 5]],
      ['Eşit', [0]]
    ]) {
      await open(label, ganttHead, mode);
      for (let i = 0; i < values.length; i++)
        await popup.getByRole('spinbutton').nth(i).fill(String(values[i]));
      await apply();
      const expected = original
        .filter((row) => {
          if (row.value === '—') return false;
          const n = Number(row.value.replace('g', ''));
          return mode === 'Az'
            ? n < 5
            : mode === 'Çok'
              ? n > 5
              : mode === 'Arası'
                ? n >= 0 && n <= 5
                : n === 0;
        })
        .map((row) => row.name);
      assert.deepEqual(
        (await page.locator('.gantt-task-row .tr-name').allTextContents()).sort(),
        expected.sort(),
        `${label} ${mode}`
      );
      await open(label, ganttHead);
      await popup.getByRole('button', { name: 'Temizle', exact: true }).click();
      checks++;
    }
  }

  await open('Erken Başlangıç', ganttHead, 'Önce');
  await popup.getByRole('button', { name: 'Takvimden tarih seç' }).click();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.date-picker-panel').count(), 0);
  assert.equal(await popup.count(), 1);
  assert.equal(await page.evaluate(() => document.activeElement.tagName), 'INPUT');
  await page.keyboard.press('Escape');
  assert.equal(await popup.count(), 0);
  checks++;
  await open('Erken Başlangıç', ganttHead, 'Önce');
  await popup.getByRole('button', { name: 'Takvimden tarih seç' }).click();
  await page.locator('.gantt-range-summary').click();
  assert.equal(await popup.count(), 0);
  assert.equal(await page.locator('.date-picker-panel').count(), 0);
  checks++;
  for (const simple of [false, true]) {
    if (simple) await page.getByRole('button', { name: 'Temel Kip', exact: true }).click();
    await page.getByRole('button', { name: 'Özet', exact: true }).click();
    for (const category of ['Toplam görev', 'Tamamlanan', 'Devam eden', 'Yapılacak', 'Geciken']) {
      await page
        .locator('.stat .label')
        .filter({ hasText: new RegExp(`^${category}$`) })
        .locator('..')
        .locator('..')
        .click();
      await page.getByRole('button', { name: 'Tüm görevleri gör', exact: true }).click();
      const modal = page.locator('.kpi-task-modal');
      const original = await modal
        .locator('tbody tr')
        .evaluateAll((rows) => rows.map((row) => row.lastElementChild.textContent.trim()));
      const label = simple ? 'Termin' : 'Hedef';
      await open(label, modal.locator('thead'), 'Önce');
      await pick(from);
      await apply();
      assert.equal(
        await modal.locator('tbody tr').count(),
        original.filter((value) => {
          const day = isoDate(value);
          return day && day <= from;
        }).length,
        category
      );
      await open(label, modal.locator('thead'));
      await popup.getByRole('button', { name: 'Temizle', exact: true }).click();
      assert.equal(await modal.locator('tbody tr').count(), original.length);
      await page.keyboard.press('Escape');
      assert.equal(await modal.count(), 0);
      checks++;
    }
  }
  assert.deepEqual(errors, [], 'Tarayıcı çalışma zamanı hatası olmamalıdır.');
  console.log(`Üretim Chromium doğrulaması: ${checks} süzgeç senaryosu başarılı.`);
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
