/**
 * Modül bağlama bütünlüğü ve tekrar kuralı düzenleme davranışı.
 *
 * Kapsanan konular:
 *   1. Kaynak ağacında BAĞLANMAMIŞ tanımlayıcı kalmaz.
 *      `İş Dağılım Ağacı` sayfası, `wbsSiblings` ve `createWbsDropIndex`
 *      kullanılıp içe aktarılmadığı için açılır açılmaz
 *      `ReferenceError: wbsSiblings is not defined` ile çöküyordu. Tarayıcıda
 *      görülene kadar hiçbir denetim bunu yakalamıyordu.
 *   2. Tekrar kuralı: gün seçimi serbesttir ve "N yineleme" ifadesinin ne
 *      anlama geldiği ölçülebilir biçimde tanımlıdır.
 *   3. Öncelik alanı arayüzden tanımlanabilir.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  formatRecurrenceRule,
  normalizeRecurrenceRule,
  summarizeRecurrencePlan
} from '../src/scheduling/recurrence/index.js';
import { PRIORITIES } from '../src/domain/constants/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

/* ── 1. Bağlanmamış tanımlayıcı taraması ────────────────────────── */

function sourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.(js|jsx|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Kapanış tırnağından SONRAKİ konumu döndürür (kaçış dizileri dâhil). */
function skipQuoted(source, index) {
  const quote = source[index];
  let i = index + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === quote) return i + 1;
    if (ch === '\n') return i;
    i += 1;
  }
  return i;
}

/**
 * Şablon dizgisini okur.
 *
 * METİN bölümü düşürülür, `${...}` İFADELERİ ise kod olarak korunur. Şablonun
 * tamamı silinseydi ``${wbsSiblings(nodes, parentId)}`` gibi bir çağrı taramadan
 * önce yok olur ve bu ratchet tam olarak engellemesi gereken bağlanmamış modül
 * çağrısını kaçırırdı.
 */
function readTemplate(source, index) {
  let i = index + 1;
  let code = ' `` ';
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === '`') { i += 1; break; }
    if (ch === '$' && source[i + 1] === '{') {
      i += 2;
      const start = i;
      let depth = 1;
      while (i < source.length && depth > 0) {
        const inner = source[i];
        if (inner === '\\') { i += 2; continue; }
        if (inner === "'" || inner === '"') { i = skipQuoted(source, i); continue; }
        if (inner === '`') { i = readTemplate(source, i).end; continue; }
        if (inner === '{') depth += 1;
        else if (inner === '}') { depth -= 1; if (!depth) break; }
        i += 1;
      }
      code += ` ${stripNonCode(source.slice(start, i))} `;
      i += 1;
      continue;
    }
    i += 1;
  }
  return { end: i, code };
}

/** Yorumları ve dizgi METİNLERİNİ düşürür; şablon ifadeleri kod olarak kalır. */
function stripNonCode(source) {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? source.length : end + 2;
      out += ' ';
      continue;
    }
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      i = end < 0 ? source.length : end;
      out += ' ';
      continue;
    }
    if (ch === "'" || ch === '"') {
      out += ch + ch;
      i = skipQuoted(source, i);
      continue;
    }
    if (ch === '`') {
      const parsed = readTemplate(source, i);
      out += parsed.code;
      i = parsed.end;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * İçe aktarma yan tümcesinden YEREL bağlanan adları toplar.
 *
 * Takma adlı içe aktarmada yalnızca `as` sonrasındaki ad kapsama girer.
 * Yan tümcedeki her tanımlayıcı bağlı sayılsaydı `import { useState as useState1 }`
 * yazan bir modülde yanlışlıkla yazılmış bir `useState()` çağrısı taramadan
 * kaçardı — bu kalıp görünüm dosyalarında zaten kullanılıyor.
 */
function bindImportClause(clause, bound) {
  const named = /\{([\s\S]*?)\}/.exec(clause);
  for (const part of clause.replace(/\{[\s\S]*?\}/, ' ').split(',')) {
    const namespace = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(part);
    if (namespace) { bound.add(namespace[1]); continue; }
    const name = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(part);
    if (name) bound.add(name[1]);
  }
  for (const specifier of named ? named[1].split(',') : []) {
    const alias = /([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)/.exec(specifier);
    if (alias) { bound.add(alias[2]); continue; }
    const name = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(specifier.trim());
    if (name) bound.add(name[1]);
  }
}

/** Dosyada bir ada değer bağlayan her sözdizimi. */
function boundNames(code) {
  const bound = new Set();
  for (const match of code.matchAll(/import\s+([\s\S]*?)\s+from\s+/g)) bindImportClause(match[1], bound);
  for (const match of code.matchAll(/(?:function|class)\s+([A-Za-z_$][\w$]*)/g)) bound.add(match[1]);
  for (const match of code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) bound.add(match[1]);
  for (const match of code.matchAll(/(?:const|let|var)\s*[{[]([^}\]]*)[}\]]/g)) {
    for (const identifier of match[1].matchAll(/[A-Za-z_$][\w$]*/g)) bound.add(identifier[0]);
  }
  // İşlev parametreleri: `(a, b) =>`, `(a, b) {` ve `a =>` biçimleri.
  for (const match of code.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) {
    for (const identifier of match[1].matchAll(/[A-Za-z_$][\w$]*/g)) bound.add(identifier[0]);
  }
  for (const match of code.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) bound.add(match[1]);
  return bound;
}

const LANGUAGE_AND_HOST_NAMES = new Set([
  'require', 'fetch', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'requestAnimationFrame', 'cancelAnimationFrame', 'Number', 'String', 'Boolean', 'Array',
  'Object', 'Math', 'Date', 'JSON', 'Map', 'Set', 'WeakMap', 'Promise', 'Error', 'TypeError',
  'RangeError', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent',
  'decodeURIComponent', 'alert', 'confirm', 'prompt', 'structuredClone', 'queueMicrotask',
  'Intl', 'RegExp', 'Symbol', 'BigInt', 'URL', 'URLSearchParams', 'Response', 'Request',
  'Headers', 'AbortController', 'TextEncoder', 'TextDecoder', 'Buffer', 'process', 'console',
  'crypto', 'btoa', 'atob', 'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof',
  'function', 'await', 'super', 'of', 'do', 'with', 'import'
]);

test('kaynak ağacında içe aktarılmamış modül işlevi çağrılmaz', () => {
  const files = sourceFiles(SRC);

  // Önce tüm modüllerin dışa aktardığı adlar toplanır.
  const exportedBy = new Map();
  for (const file of files) {
    const code = stripNonCode(fs.readFileSync(file, 'utf8'));
    for (const match of code.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) exportedBy.set(match[1], file);
    for (const match of code.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) exportedBy.set(match[1], file);
  }

  const unbound = [];
  for (const file of files) {
    const code = stripNonCode(fs.readFileSync(file, 'utf8'));
    const bound = boundNames(code);
    for (const match of code.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = match[2];
      if (LANGUAGE_AND_HOST_NAMES.has(name) || bound.has(name)) continue;
      if (!exportedBy.has(name) || exportedBy.get(name) === file) continue;
      unbound.push(`${path.relative(ROOT, file)} → ${name}() (${path.relative(ROOT, exportedBy.get(name))} içinde tanımlı, içe aktarılmamış)`);
    }
  }

  assert.deepEqual([...new Set(unbound)], []);
});

test('tarayıcı şablon dizgisi ifadelerini kod olarak korur', () => {
  // Şablonun tamamı silinseydi bu çağrı taramadan önce yok olurdu.
  const code = stripNonCode('const label = `${wbsSiblings(nodes, parentId)} kardeş`;');
  assert.match(code, /wbsSiblings\(/);
  // Metin bölümü kod sayılmaz.
  assert.doesNotMatch(code, /kardeş/);
  // İç içe şablon ve dizgiler ifadeyi bozmaz.
  const nested = stripNonCode('const x = `${format(`${inner(value)}`, "a`b")}`;');
  assert.match(nested, /format\(/);
  assert.match(nested, /inner\(/);
  // Yorumlar ve sıradan dizgiler düşer.
  assert.doesNotMatch(stripNonCode('// notImported()\nconst a = 1;'), /notImported/);
  assert.doesNotMatch(stripNonCode("const a = 'notImported()';"), /notImported/);
});

test('içe aktarma taraması yalnızca YEREL bağlanan adı kaydeder', () => {
  const bound = boundNames("import { useState as useState1, useMemo } from 'react';");
  assert.equal(bound.has('useState1'), true);
  assert.equal(bound.has('useMemo'), true);
  // Takma addan ÖNCEKİ ad kapsamda değildir.
  assert.equal(bound.has('useState'), false);

  const mixed = boundNames("import React, * as ReactAll from 'react';");
  assert.equal(mixed.has('React'), true);
  assert.equal(mixed.has('ReactAll'), true);
});

test('İş Dağılım Ağacı görünümü sürükle-bırak ilkelerini içe aktarır', () => {
  // Doğrudan gerileme koruması: bu içe aktarma eksikken sayfa açılır açılmaz
  // "Application error: a client-side exception has occurred" ile çöküyordu.
  const view = read('src/features/wbs/WbsView.jsx');
  assert.match(view, /import \{[^}]*createWbsDropIndex[^}]*\} from '\.\/wbsDragPolicy\.js'/s);
  assert.match(view, /import \{[^}]*wbsSiblingPlacement[^}]*\} from '\.\/wbsDragPolicy\.js'/s);
  assert.match(view, /import \{[^}]*wbsIndexChildren[^}]*\} from '\.\/wbsDragPolicy\.js'/s);
  // Kardeş verisi ağaç değeri başına BİR kez dizinlenir; satır çizimi O(1) okur.
  assert.match(view, /useMemo\(\(\) => createWbsDropIndex\(wbs\), \[wbs\]\)/);
  assert.match(view, /wbsSiblingPlacement\(dropIndex, node\)/);
  assert.match(view, /wbsIndexChildren\(dropIndex, node\.parentId\)/);
});

test('testlerden içe aktarılan ilke modülleri dizin yolu kullanmaz', () => {
  // Düz Node (`node --test`) uzantısız dizin içe aktarmasını çözemez; bir
  // ilke modülü `../../scheduling/dependencies` yazarsa test dosyası
  // ERR_UNSUPPORTED_DIR_IMPORT ile hiç başlamadan düşer.
  const policyModules = [
    'src/features/task-detail/taskSuccessorPolicy.js',
    'src/features/dashboard/planHealth.js',
    'src/features/dashboard/statusDistribution.js',
    'src/components/charts/donutGeometry.js'
  ];
  for (const file of policyModules) {
    const imports = [...read(file).matchAll(/from\s+'(\.[^']+)'/g)].map((match) => match[1]);
    for (const specifier of imports) {
      assert.match(specifier, /\.(js|jsx|mjs)$/, `${file} → ${specifier} uzantılı yol olmalı`);
    }
  }
});

/* ── 2. Tekrar kuralı düzenleme ─────────────────────────────────── */

const TEMPLATE = Object.freeze({
  // 18/08/2026 bir Salı günüdür.
  plannedStart: '2026-08-18',
  plannedFinish: '2026-08-25',
  plannedDurationDays: 6,
  targetFinish: '2026-08-27'
});

test('haftalık kuralda başlangıç günü seçimden çıkarılabilir', () => {
  // Salı başlayan bir seride kullanıcı yalnızca Pazartesi ve Perşembe
  // isteyebilmelidir; Salı zorla eklenmez.
  const rule = normalizeRecurrenceRule({ freq: 'WEEKLY', interval: 1, byWeekday: ['MO', 'TH'] });
  assert.deepEqual(rule.byWeekday, ['MO', 'TH']);
  assert.equal(formatRecurrenceRule(rule), 'FREQ=WEEKLY;BYDAY=MO,TH');

  const plan = summarizeRecurrencePlan(TEMPLATE, { ...rule, count: 3 }, { previewLimit: 8 });
  assert.equal(plan.includesTemplate, false);
  assert.equal(plan.totalCount, 3);
  // Şablonun günü seride yer almadığı için üç yinelemenin ÜÇÜ de yeni görevdir.
  assert.equal(plan.generatedCount, 3);
  assert.equal(plan.dates[0], '2026-08-20');
});

test('güvenlik tavanına dayanan UNTIL serisi TAM sayılmaz', () => {
  // Pzt–Cum takviminde GÜNLÜK bir UNTIL kuralı: hafta sonu tarihleri Pazartesiye
  // kayar ve tekilleşir, bu yüzden ham tavan (400) dolduğunda dönen plan çok
  // daha KISADIR. Kesinti yalnızca plan uzunluğundan çıkarılsaydı `truncated`
  // yanlış kalır ve arayüz, UNTIL aralığında çok daha fazla yineleme varken
  // sonlu bir toplam ile "hepsi bu" derdi.
  const workweek = { workingDays: [1, 2, 3, 4, 5], holidays: [] };
  const rule = { freq: 'DAILY', interval: 1, until: '2030-12-31' };
  const plan = summarizeRecurrencePlan(TEMPLATE, rule, { calendar: workweek });

  assert.equal(plan.truncated, true, 'ham tavana dayanan seri KESİLMİŞ sayılmalıdır');
  assert.equal(plan.hasMore, true);
  // Kesilmiş seride sayı verilmez: bilinen kısım serinin toplamı değildir.
  assert.equal(plan.totalCount, 0);
  assert.equal(plan.generatedCount, 0);

  // Tavanın ÇOK altında biten bir UNTIL serisi tam sayılmaya devam eder.
  const short = summarizeRecurrencePlan(TEMPLATE, { freq: 'WEEKLY', interval: 1, until: '2026-09-08' });
  assert.equal(short.truncated, false);
  assert.equal(short.totalCount, short.dates.length);
  assert.ok(short.totalCount > 0);
});

test('gün seçilmezse seri planlanan başlangıcın gününü kullanır', () => {
  const rule = normalizeRecurrenceRule({ freq: 'WEEKLY', interval: 1, byWeekday: [], count: 3 });
  assert.deepEqual(rule.byWeekday, []);
  const plan = summarizeRecurrencePlan(TEMPLATE, rule);
  assert.deepEqual(plan.dates, ['2026-08-18', '2026-08-25', '2026-09-01']);
  assert.equal(plan.includesTemplate, true);
});

test('"N yineleme" TOPLAM yineleme sayısıdır; şablonun kendisi de sayılır', () => {
  // Kullanıcının "3 yineleme mantıklı gelmiyor" dediği durum: kural
  // Pzt–Cum arası her günü kapsıyor ve seri Salı başlıyorsa üç yineleme aynı
  // haftanın Salı/Çarşamba/Perşembe günleridir; bunlardan biri şablondur.
  const rule = { freq: 'WEEKLY', interval: 2, byWeekday: ['MO', 'TU', 'WE', 'TH', 'FR'], count: 3 };
  const plan = summarizeRecurrencePlan(TEMPLATE, rule);

  assert.deepEqual(plan.dates, ['2026-08-18', '2026-08-19', '2026-08-20']);
  assert.equal(plan.totalCount, 3);
  assert.equal(plan.includesTemplate, true);
  assert.equal(plan.generatedCount, 2, 'şablon dışında yalnızca iki yeni görev oluşur');
});

test('önizleme sekiz yinelemeye kadar listelenir ve kalan sayı bildirilir', () => {
  const rule = { freq: 'DAILY', interval: 1, count: 12 };
  const plan = summarizeRecurrencePlan(TEMPLATE, rule, { previewLimit: 8 });
  assert.equal(plan.preview.length, 8);
  assert.equal(plan.hiddenCount, 4);
  assert.equal(plan.totalCount, 12);
});

test('sınırsız kural toplam sayı uydurmaz', () => {
  const plan = summarizeRecurrencePlan(TEMPLATE, { freq: 'WEEKLY', interval: 1 }, { previewLimit: 4 });
  assert.equal(plan.unbounded, true);
  assert.equal(plan.totalCount, 0);
  assert.equal(plan.generatedCount, 0);
  assert.equal(plan.preview.length, 4);
});

test('geçersiz kural ya da başlangıçsız şablon boş özet verir', () => {
  assert.deepEqual(summarizeRecurrencePlan(TEMPLATE, null).dates, []);
  assert.deepEqual(summarizeRecurrencePlan({}, { freq: 'DAILY' }).dates, []);
  assert.deepEqual(summarizeRecurrencePlan(TEMPLATE, { freq: 'SAATLIK' }).dates, []);
});

test('UNTIL sınırı özetteki toplam sayıyı belirler', () => {
  const plan = summarizeRecurrencePlan(TEMPLATE, { freq: 'DAILY', interval: 7, until: '2026-09-15' });
  assert.equal(plan.unbounded, false);
  assert.deepEqual(plan.dates, ['2026-08-18', '2026-08-25', '2026-09-01', '2026-09-08', '2026-09-15']);
  assert.equal(plan.totalCount, 5);
  assert.equal(plan.generatedCount, 4);
});

test('tekrar düzenleyicisi gün seçimini kullanıcıya bırakır, kuralı ise üretimden sonra kilitler', () => {
  const drawer = read('src/features/task-detail/TaskDrawer.jsx');
  assert.match(drawer, /className=\{`recurrence-day\$\{active \? ' active' : ''\}/);
  // Yineleme ÜRETİLDİKTEN sonra kural alanları kilitlenir: aksi hâlde tek seri
  // eski ve yeni takvimin karışımına dönüşüyordu.
  assert.match(drawer, /const ruleLocked = occurrenceCount > 0;/);
  assert.match(drawer, /disabled=\{ruleLocked\}/);
  // Kaç yinelemenin KALDIĞI ve tek işlemin toplu sınırı açıkça yazılır.
  assert.match(drawer, /recurrence-count-note/);
  assert.match(drawer, /const pendingOccurrences = plan\.occurrences\.filter/);
  assert.match(drawer, /TASK_SERIES_BATCH_LIMIT/);
});

/* ── 3. Öncelik alanı ───────────────────────────────────────────── */

test('görev paneli öncelik seçimi sunar', () => {
  // Öncelik Görevler, Gantt, Kanban ve Raporlar sayfalarında GÖSTERİLİYOR ama
  // hiçbir ekrandan TANIMLANAMIYORDU; değer her görevde varsayılan kalıyordu.
  const drawer = read('src/features/task-detail/TaskDrawer.jsx');
  assert.match(drawer, /import \{ PRIORITIES, TASK_SERIES_BATCH_LIMIT, resolvePriority \} from '\.\.\/\.\.\/domain\/constants\/index\.js'/);
  // Zaten seçili öncelik yeniden yazma üretmez: anlamsız bir tıklama görev
  // sürümünü ilerletip başka bir kullanıcıya çakışma olarak dönüyordu.
  assert.match(drawer, /if \(!isActive\) save\(\{ priority: priority\.id \}\);/);
  assert.match(drawer, /aria-label="Görev önceliği"/);
  for (const priority of Object.values(PRIORITIES)) {
    assert.ok(priority.label.length > 0);
  }
});

/* ── 4. Başlıklar ve arayüz dili ────────────────────────────────── */

test('arayüz başlıkları büyük harfe zorlanmaz', () => {
  const files = ['src/app/globals.css', 'src/app/styles/features.css', 'src/app/styles/dashboard.css',
    'src/app/styles/shell.css', 'src/app/styles/experience.css', 'src/app/styles/components.css'];
  for (const file of files) {
    assert.doesNotMatch(read(file), /text-transform:\s*uppercase/, `${file} büyük harfe zorlamamalı`);
  }
  for (const file of ['src/features/team/TeamView.jsx', 'src/features/reports/ReportsView.jsx',
    'src/features/task-detail/TaskDrawer.jsx', 'src/components/ui-extras.jsx']) {
    assert.doesNotMatch(read(file), /textTransform: 'uppercase'/, `${file} büyük harfe zorlamamalı`);
  }
});

test('sayfa başlıkları degrade doldurulmuş metin kullanmaz', () => {
  // Degrade metin küçük puntoda kontrastı düşürüyor ve açık temada soluk
  // görünüyordu; ayrıca `-webkit-text-fill-color` seçim rengini bozuyordu.
  const css = read('src/app/globals.css');
  assert.doesNotMatch(css, /-webkit-text-fill-color:\s*transparent/);
  assert.match(css, /\.hero-title\s*\{[^}]*color:\s*var\(--text\);/s);
});

test('arayüz metinlerinde yabancı sözcük kullanılmaz', () => {
  const views = ['src/features/dashboard/DashboardView.jsx', 'src/features/reports/ReportsView.jsx',
    'src/components/shell/WelcomeScreen.jsx'];
  for (const file of views) {
    const source = read(file);
    // Kullanıcıya görünen metinler: `title`, `subtitle`, `label`, `desc`.
    const visible = [...source.matchAll(/(?:title|subtitle|label|desc)[=:]\s*['"]([^'"]+)['"]/g)].map((match) => match[1]);
    for (const text of visible) {
      assert.doesNotMatch(text, /\btrend\w*/i, `${file}: "${text}" Türkçe karşılığını kullanmalı (eğilim)`);
    }
  }
});

test('grafik eksen etiketleri SVG dışında, sabit boyutlu metin olarak çizilir', () => {
  // SVG kart genişliğine göre ölçeklendiği için içerideki `font-size` de
  // ölçekleniyor, geniş kartlarda etiketler devasa görünüyordu.
  const ui = read('src/components/ui.jsx');
  const reports = read('src/features/reports/ReportsView.jsx');
  assert.match(ui, /className="chart-axis-labels"/);
  assert.match(reports, /className="chart-axis-labels"/);
  assert.doesNotMatch(ui, /<text key=\{i\} x=\{pts\[i\]\[0\]\}/);
  assert.match(read('src/app/styles/components.css'), /\.chart-axis-labels > span\s*\{[^}]*font-size:\s*11px;/s);
});

test('kenar çubuğundaki kullanıcı adı tek satıra sıkıştırılıp kırpılmaz', () => {
  const css = read('src/app/globals.css');
  assert.match(css, /\.user-chip \.name\s*\{[^}]*white-space:\s*normal;[^}]*-webkit-line-clamp:\s*2;/s);
});
