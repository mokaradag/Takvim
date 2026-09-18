import test from 'node:test';
import postcss from 'postcss';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { RichEditorSurface } from '../src/features/reminders/RichEditorSurface.js';
import {
  reduceScheduleRequestCenterOpen,
  scheduleRequestCenterViewState
} from '../src/features/schedule-change/scheduleRequestCenterState.js';

/** Bir depo dosyasını UTF-8 metni olarak okur. */
function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

/** Koşulsuz CSS kurallarını kaynak sırasıyla çıkarır. */
function parseCssRules(source) {
  const rules = [];
  const root = postcss.parse(source);
  root.walkRules((rule) => {
    if (rule.parent !== root) return;
    const declarations = {};
    rule.nodes.filter((node) => node.type === 'decl').forEach((node) => {
      declarations[node.prop] = node.value;
    });
    rules.push({ selectors: rule.selectors, declarations, order: rules.length });
  });
  return rules;
}

/** Tek bir var(...) değerini tema değişkenleri üzerinden çözer. */
function resolveCssValue(value, variables, seen = new Set()) {
  const match = value.match(/^var\((--[\w-]+)(?:,\s*(.+))?\)$/);
  if (!match) return value;
  const [, name, fallback] = match;
  if (seen.has(name)) return fallback?.trim() || value;
  const resolved = variables[name] || fallback?.trim();
  if (!resolved) return value;
  return resolveCssValue(resolved, variables, new Set([...seen, name]));
}

/** Tema ve sınıf seçicilerine göre hedef yüzeyin hesaplanmış test stilini üretir. */
function computedClassStyle(source, className, themeClass) {
  const rules = parseCssRules(source);
  const variables = {};
  const winners = new Map();
  const targetSelectors = new Map([
    [`.${className}`, 1],
    [`.${themeClass} .${className}`, 2]
  ]);

  for (const rule of rules) {
    for (const selector of rule.selectors) {
      if (selector === ':root' || selector === `.${themeClass}`) {
        for (const [property, value] of Object.entries(rule.declarations)) {
          if (property.startsWith('--')) variables[property] = value;
        }
      }

      const specificity = targetSelectors.get(selector);
      if (!specificity) continue;
      for (const [property, value] of Object.entries(rule.declarations)) {
        if (property.startsWith('--')) continue;
        const current = winners.get(property);
        if (!current || specificity > current.specificity || (specificity === current.specificity && rule.order >= current.order)) {
          winners.set(property, { value, specificity, order: rule.order });
        }
      }
    }
  }

  return Object.fromEntries(
    Array.from(winners, ([property, winner]) => [property, resolveCssValue(winner.value, variables)])
  );
}

test('zengin e-posta düzenleyicisi koyu temada hesaplanmış açık bir tuval kullanır ve devre dışı durumunu bildirir', () => {
  const markup = renderToStaticMarkup(createElement(RichEditorSurface, { ariaLabel: 'E-posta gövdesi' }));
  const className = markup.match(/class="([^"]+)"/)?.[1];
  assert.equal(className, 'rich-editor-surface');
  assert.match(markup, /contenteditable="true"/);
  assert.match(markup, /role="textbox"/);
  assert.match(markup, /aria-disabled="false"/);

  const disabledMarkup = renderToStaticMarkup(createElement(RichEditorSurface, {
    ariaLabel: 'E-posta gövdesi',
    disabled: true
  }));
  assert.match(disabledMarkup, /contenteditable="false"/);
  assert.match(disabledMarkup, /role="textbox"/);
  assert.match(disabledMarkup, /aria-disabled="true"/);

  const styles = `${read('src/app/globals.css')}\n${read('src/app/styles/features.css')}`;
  const computed = computedClassStyle(styles, className, 'theme-dark');
  assert.equal(computed.background, '#ffffff');
  assert.equal(computed.color, '#111827');
});

test('tarih talebi merkezi boş liste geçişinde paneli kapatır ve boşken yeniden açılmaz', () => {
  const request = { id: 'request-1', status: 'PENDING', isDecisionOwner: true };
  let requests = [request];
  let open = false;

  let view = scheduleRequestCenterViewState(requests, open);
  assert.equal(view.disabled, false);
  open = reduceScheduleRequestCenterOpen(open, { type: 'toggle', hasRequests: view.hasRequests });
  view = scheduleRequestCenterViewState(requests, open);
  assert.equal(view.isOpen, true, 'dolu listede zil paneli açılmalıdır');

  requests = [];
  view = scheduleRequestCenterViewState(requests, open);
  assert.equal(view.disabled, true, 'boş listede zil devre dışı olmalıdır');
  assert.equal(view.isOpen, false, 'liste boşalır boşalmaz panel görünmez olmalıdır');

  open = reduceScheduleRequestCenterOpen(open, { type: 'sync', hasRequests: view.hasRequests });
  assert.equal(open, false, 'yenileme sonrası iç açık durumu da kapanmalıdır');
  open = reduceScheduleRequestCenterOpen(open, { type: 'toggle', hasRequests: view.hasRequests });
  assert.equal(open, false, 'boş listedeki zil tıklaması paneli açmamalıdır');

  requests = [request];
  view = scheduleRequestCenterViewState(requests, open);
  open = reduceScheduleRequestCenterOpen(open, { type: 'toggle', hasRequests: view.hasRequests });
  assert.equal(open, true, 'istek geri geldiğinde zil yeniden açılabilmelidir');
  open = reduceScheduleRequestCenterOpen(open, { type: 'toggle', hasRequests: view.hasRequests });
  assert.equal(open, false, 'dolu listedeki ikinci tıklama paneli kapatmalıdır');
});

/* ── Yapışkan çalışma alanı şeritleri ──────────────────────────── */

/** Tek bir seçicinin bildirimlerini kaynak sırasına göre birleştirir. */
function declarationsFor(source, selector) {
  const merged = {};
  for (const rule of parseCssRules(source)) {
    if (!rule.selectors.includes(selector)) continue;
    Object.assign(merged, rule.declarations);
  }
  return merged;
}

test('yapışkan çalışma alanı şeridi uygulama katmanındadır ve kaydırılan içerik üstüne binmez', () => {
  const features = read('src/app/styles/features.css');
  const sticky = declarationsFor(features, '.workspace-sticky');
  assert.equal(sticky.position, 'sticky');
  assert.equal(sticky.top, '0');
  // Şerit içerik katmanının ÜSTÜNDEDİR: kart, grafik ve tablo üstüne binemez.
  assert.equal(sticky['z-index'], 'var(--z-chrome)');
  assert.equal(sticky.background, 'var(--bg-elev)');

  // Tam genişlikli zemin `.content` yatay dolgusunu kapatır; alt/üst nefes payı
  // kaydırılan içeriğin şeride yapışmasını önler.
  const backdrop = declarationsFor(features, '.workspace-sticky::before');
  // `content` OLMADAN sözde öğe hiç oluşturulmaz: öteki bildirimler doğru olsa
  // bile zemin çizilmez ve kaydırılan içerik şeridin altından görünür.
  assert.equal(backdrop.content, "''");
  assert.equal(backdrop.position, 'absolute');
  // Yığılma bağlamında bu zemin şeridin üstüne boyanır; yükseltilmiş tonu korur.
  assert.equal(backdrop.background, 'var(--bg-elev)');
  assert.equal(backdrop['z-index'], '-1');
  assert.equal(backdrop.inset, 'calc(-1 * var(--workspace-padding-top, 24px)) calc(-1 * var(--workspace-padding-inline, 28px)) -10px');
  // Üst kenar 1 px bindirilir; ölçeklemede saç teli boşluğu kalmaz.
  assert.equal(backdrop.top, 'calc(-1 * var(--workspace-padding-top, 24px) - 1px)');
  const content = declarationsFor(read('src/app/globals.css'), '.content');
  assert.equal(content['--workspace-padding-top'], '24px');
  assert.equal(content['--workspace-padding-inline'], '28px');
  assert.match(content.padding, /var\(--workspace-padding-top\) var\(--workspace-padding-inline\)/);
});

test('açık dışa aktar menüsü yapışkan çalışma alanı şeritlerinin üstünde kalır', () => {
  const shell = read('src/app/styles/shell.css');
  assert.equal(declarationsFor(shell, '.topbar')['z-index'], 'var(--z-chrome)');
  assert.equal(declarationsFor(shell, '.topbar:has(.export-menu[open])')['z-index'], 'var(--z-popover)');
  assert.equal(declarationsFor(shell, '.export-menu-pop')['z-index'], 'var(--z-popover)');
});

test('rapor sekmeleri donar ve tarih şeridi sekmelerin altına yapışır', () => {
  const features = read('src/app/styles/features.css');
  const tabs = declarationsFor(features, '.reports-module > .request-tabs.workspace-sticky');
  assert.equal(tabs.top, '0');
  assert.equal(tabs['z-index'], 'calc(var(--z-chrome) + 1)');

  const strip = declarationsFor(features, '.reports-module .workspace-sticky:not(.request-tabs)');
  assert.equal(strip.top, 'calc(var(--reports-tabs-height) + 12px)');
  assert.equal(declarationsFor(features, '.reports-module .workspace-sticky:not(.request-tabs)::before').top, '-12px');
  assert.equal(declarationsFor(features, '.reports-module')['--reports-tabs-height'] != null, true);

  // Sekme yüksekliği yazı ölçeğiyle değişir; sabit değer yerine ölçülür.
  const view = read('src/features/reports/ReportsView.jsx');
  assert.match(view, /className="request-tabs workspace-sticky"/);
  assert.match(view, /new ResizeObserver\(apply\)/);
  assert.match(view, /--reports-tabs-height/);
});

test('hatırlatma sonucu satır akışına girmez; görev satırının yüksekliği değişmez', () => {
  const features = read('src/app/styles/features.css');
  const action = declarationsFor(features, '.task-reminder-action');
  const result = declarationsFor(features, '.task-reminder-result');
  assert.equal(action.position, 'relative');
  // Balon MUTLAK konumlanır: dar eylem hücresinde harf harf sarılıp satırı
  // uzatan eski yerleşim geri gelmemelidir.
  assert.equal(result.position, 'absolute');
  assert.equal(result.width, 'max-content');
  assert.equal(result['white-space'], 'normal');
  assert.equal(result['z-index'], 'var(--z-popover)');
  const cell = declarationsFor(features, '.tasks-actions-cell:has(.task-reminder-result)');
  const ordinaryCell = declarationsFor(read('src/app/styles/components.css'), '.tasks-actions-cell');
  assert.ok(Number(cell['z-index']) > Number(ordinaryCell['z-index']));
  assert.equal(declarationsFor(features, '.simple-tasks-table .tasks-actions-cell:has(.task-reminder-result)').position, 'relative');
});

test('Sistem Yönetimi şeridi ve sekmeleri kaydırma alanının dışında kalır', () => {
  const styles = read('src/app/styles/system-admin.css');
  assert.equal(declarationsFor(styles, '.content-sistem').overflow, 'hidden');
  assert.equal(declarationsFor(styles, '.sysadmin-page').height, '100%');
  assert.equal(declarationsFor(styles, '.sysadmin-page > :not(.sysadmin-panel)').flex, '0 0 auto');
  const panel = declarationsFor(styles, '.sysadmin-panel');
  assert.equal(panel.flex, '1 1 0');
  assert.equal(panel['min-height'], '0');
  assert.equal(panel.overflow, 'auto');
});

test('hatırlatma gönderim geçmişi kendi kaydırma sınırında durur', () => {
  const features = read('src/app/styles/features.css');
  const scroll = declarationsFor(features, '.reminder-history-scroll');
  assert.equal(scroll.overflow, 'auto');
  // Üst sınır `clamp` ile POZİTİF bir tabana bağlanır: kısa ekranda çıkarma
  // negatife düşünce CSS sonucu `0px`e kırpar ve kaydırma kutusu yok olurdu.
  assert.match(scroll['max-height'], /^clamp\(\s*\d+px\s*,/);
  assert.match(scroll['max-height'], /,\s*380px\s*\)$/);
  assert.match(read('src/features/reminders/ReminderSettingsView.jsx'), /className="reminder-history-scroll"/);
});


test('koşullu CSS bildirimi genel yerleşim testini yanlış geçirmez', () => {
  const source = '.workspace-sticky { position: static; } @media (max-width: 600px) { .workspace-sticky { position: sticky; } }';
  assert.equal(declarationsFor(source, '.workspace-sticky').position, 'static');
  assert.equal(declarationsFor('@supports (display: grid) { .workspace-sticky { position: sticky; } }', '.workspace-sticky').position, undefined);
});
