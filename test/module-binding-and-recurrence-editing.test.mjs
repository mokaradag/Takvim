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
import { Linter } from 'eslint';
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
const RUNTIME_GLOBALS = new Set([
  'AbortController', 'AbortSignal', 'Blob', 'Buffer', 'clearImmediate', 'clearInterval', 'clearTimeout',
  'console', 'crypto', 'document', 'fetch', 'File', 'FormData', 'global', 'globalThis', 'Headers',
  'history', 'Intl', 'location', 'MessageChannel', 'navigator', 'performance', 'process', 'queueMicrotask',
  'ReadableStream', 'Request', 'requestAnimationFrame', 'Response', 'setImmediate', 'setInterval',
  'setTimeout', 'structuredClone', 'TextDecoder', 'TextEncoder', 'URL', 'URLSearchParams', 'WebSocket', 'window'
]);

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

function collectPatternNames(pattern, names) {
  if (!pattern) return;
  if (pattern.type === 'Identifier') {
    names.add(pattern.name);
    return;
  }
  if (pattern.type === 'AssignmentPattern') {
    collectPatternNames(pattern.left, names);
    return;
  }
  if (pattern.type === 'RestElement') {
    collectPatternNames(pattern.argument, names);
    return;
  }
  if (pattern.type === 'ArrayPattern') {
    for (const element of pattern.elements) collectPatternNames(element, names);
    return;
  }
  if (pattern.type === 'ObjectPattern') {
    for (const property of pattern.properties) {
      if (property.type === 'Property') collectPatternNames(property.value, names);
      else if (property.type === 'RestElement') collectPatternNames(property.argument, names);
    }
  }
}

function jsxRootName(node) {
  let current = node;
  while (current?.type === 'JSXMemberExpression') current = current.object;
  return current?.type === 'JSXIdentifier' ? current.name : null;
}

function scopeHasBinding(scope, name) {
  for (let current = scope; current; current = current.upper) {
    if (current.set?.has(name)) return true;
  }
  return false;
}

function isUnboundCalleeRoot(identifier) {
  let expression = identifier;
  while (expression.parent?.type === 'MemberExpression' && expression.parent.object === expression) {
    expression = expression.parent;
  }
  if (expression.parent?.type === 'ChainExpression' && expression.parent.expression === expression) {
    expression = expression.parent;
  }
  const parent = expression.parent;
  return (parent?.type === 'CallExpression' || parent?.type === 'NewExpression') && parent.callee === expression;
}

function inspectModule(source) {
  const exported = new Set();
  const unboundCalls = [];
  const linter = new Linter();
  linter.defineRule('module-bindings', {
    create(context) {
      return {
        ExportNamedDeclaration(node) {
          for (const specifier of node.specifiers || []) {
            const name = specifier.exported?.name ?? specifier.exported?.value;
            if (typeof name === 'string') exported.add(name);
          }
          const declaration = node.declaration;
          collectPatternNames(declaration?.id, exported);
          for (const item of declaration?.declarations || []) collectPatternNames(item.id, exported);
        },
        ExportDefaultDeclaration(node) {
          collectPatternNames(node.declaration?.id, exported);
        },
        JSXOpeningElement(node) {
          const name = jsxRootName(node.name);
          if (!name || !/^[A-Z]/.test(name) || RUNTIME_GLOBALS.has(name)) return;
          if (!scopeHasBinding(context.getScope(), name)) unboundCalls.push(name);
        },
        'Program:exit'() {
          for (const reference of context.getSourceCode().scopeManager.globalScope.through) {
            const identifier = reference.identifier;
            if (RUNTIME_GLOBALS.has(identifier.name)) continue;
            if (isUnboundCalleeRoot(identifier)) unboundCalls.push(identifier.name);
          }
        }
      };
    }
  });
  const messages = linter.verify(source, {
    parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } },
    rules: { 'module-bindings': 'error' }
  }, { allowInlineConfig: false });
  assert.deepEqual(messages, [], 'Kaynak JavaScript/JSX olarak ayrıştırılabilmeli.');
  return { exported, unboundCalls };
}

test('nesne ve sınıf yöntemleri çağrı sayılmaz; bağımsız çağrılar korunur', () => {
  const methods = [
    'register() {}', 'async register() {}', 'get register() {}',
    'set register(value) {}', '*register() {}', 'async *register() {}',
    'register(callback = () => {}) {}', String.raw`register(pattern = /\)/) {}`,
    'register(value = factory(nested())) {}',
    'register({ callback = (value = factory()) => value } = {}) {}',
    'register(value = "(\\\" )", /* ) */ pattern = /[()]/) {}',
    'register(value = `text ) ${factory(`${nested()}`)}`) {}'
  ];
  for (const method of methods) {
    for (const source of [`const registry = { ${method} };`, `class Registry { other() {} ${method} }`]) {
      assert.equal(inspectModule(source).unboundCalls.includes('register'), false, source);
      assert.equal(inspectModule(`${source} register();`).unboundCalls.filter((name) => name === 'register').length, 1, source);
    }
  }
  assert.deepEqual(inspectModule('const values = [other(), register(factory())];').unboundCalls, ['other', 'register', 'factory']);
  assert.deepEqual(inspectModule('const obj = { register(value = missing()) { register(); } };').unboundCalls, ['missing', 'register']);
});

test('kurucu çağrıları taranır; çalışma zamanı globalleri dışa aktarım adlarıyla çakışmaz', () => {
  assert.deepEqual(inspectModule('new MissingWorker();').unboundCalls, ['MissingWorker']);
  assert.deepEqual(inspectModule('MissingWorker(); new MissingWorker();').unboundCalls, ['MissingWorker', 'MissingWorker']);
  assert.deepEqual(inspectModule("fetch('/api'); setTimeout(() => {}, 0); requestAnimationFrame(() => {}); new URL('https://example.test');").unboundCalls, []);
  assert.deepEqual([...inspectModule('export function fetch() {}').exported], ['fetch']);
});

test('üye çağrılarının bağlanmamış kökleri de taranır', () => {
  assert.deepEqual(inspectModule('MissingService.run();').unboundCalls, ['MissingService']);
  assert.deepEqual(inspectModule('new MissingNamespace.Worker();').unboundCalls, ['MissingNamespace']);
  assert.deepEqual(inspectModule('MissingNamespace.Tools.Worker();').unboundCalls, ['MissingNamespace']);
  assert.deepEqual(inspectModule('const MissingService = { run() {} }; MissingService.run();').unboundCalls, []);
});

test('JSX bileşen bağları açıkça taranır ve mevcut kapsamlar korunur', () => {
  assert.deepEqual(inspectModule('const view = <MissingView />;').unboundCalls, ['MissingView']);
  assert.deepEqual(inspectModule('const view = <Missing.View />;').unboundCalls, ['Missing']);
  assert.deepEqual(inspectModule("import MissingView from './view.js'; const view = <MissingView />;").unboundCalls, []);
  assert.deepEqual(inspectModule('function LocalView() { return null; } const view = <LocalView />;').unboundCalls, []);
  assert.deepEqual(inspectModule('const view = <div />;').unboundCalls, []);
});

test('adlandırılmış ihracatlar ve parçalanmış değişken bağları eksiksiz toplanır', () => {
  assert.deepEqual([...inspectModule('const local = () => {}; export { local as publicName };').exported], ['publicName']);
  assert.deepEqual([...inspectModule("export { external as reExported } from './module.js';").exported], ['reExported']);
  assert.deepEqual([...inspectModule('export default function defaultWorker() {}').exported], ['defaultWorker']);
  assert.deepEqual([...inspectModule('export default class DefaultRunner {}').exported], ['DefaultRunner']);
  assert.deepEqual([...inspectModule('export default function () {}').exported], []);
  assert.deepEqual(
    [...inspectModule('export const { first: renamed, nested: { inner }, ...rest } = source;').exported].sort(),
    ['inner', 'renamed', 'rest']
  );
});

test('kaynak ağacında içe aktarılmamış modül işlevi çağrılmaz', () => {
  const modules = sourceFiles(SRC).map((file) => ({ file, ...inspectModule(fs.readFileSync(file, 'utf8')) }));
  const exportedBy = new Map(modules.flatMap(({ file, exported }) => [...exported].map((name) => [name, file])));
  const unbound = modules.flatMap(({ file, unboundCalls }) => unboundCalls
    .filter((name) => exportedBy.has(name))
    .map((name) => `${path.relative(ROOT, file)} → ${name}() (${path.relative(ROOT, exportedBy.get(name))} içinde tanımlı, içe aktarılmamış)`));
  assert.deepEqual([...new Set(unbound)], []);
});

test('tarayıcı şablon ifadelerini korur; yorum, dizgi ve regex metnini çağrı saymaz', () => {
  assert.deepEqual(inspectModule('const label = `${wbsSiblings(nodes, parentId)} kardeş`;').unboundCalls, ['wbsSiblings']);
  assert.deepEqual(inspectModule('const x = `${format(`${inner(value)}`, "a`b")}`;').unboundCalls, ['format', 'inner']);
  assert.deepEqual(inspectModule('// missing()\nconst a = "missing()"; const re = /missing()/;').unboundCalls, []);
  assert.deepEqual(inspectModule('const x = `${(() => { /* } */ return /}/.test(missing()); })()}`;').unboundCalls, ['missing']);
});

test('içe aktarma taraması yalnızca yerel bağlanan adı kaydeder ve kapsamları ayırır', () => {
  assert.deepEqual(inspectModule("import { useState as useState1, useMemo } from 'react'; useState1(); useMemo(); useState();").unboundCalls, ['useState']);
  assert.deepEqual(inspectModule("import React, * as ReactAll from 'react'; React(); ReactAll();").unboundCalls, []);
  assert.deepEqual(inspectModule('function one(register) { register(); } register();').unboundCalls, ['register']);
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