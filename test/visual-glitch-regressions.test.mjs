import test from 'node:test';
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

/** Basit bir CSS bildirim gövdesini özellik-değer çiftlerine ayırır. */
function parseDeclarations(body) {
  const declarations = {};
  for (const declaration of body.split(';')) {
    const separator = declaration.indexOf(':');
    if (separator < 0) continue;
    const property = declaration.slice(0, separator).trim();
    const value = declaration.slice(separator + 1).trim();
    if (property && value) declarations[property] = value;
  }
  return declarations;
}

/** Testte gereken düz CSS kurallarını kaynak sırasıyla çıkarır. */
function parseCssRules(source) {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
  return Array.from(withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g), (match, order) => ({
    selectors: match[1].split(',').map((selector) => selector.trim()),
    declarations: parseDeclarations(match[2]),
    order
  }));
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
  assert.equal(backdrop.position, 'absolute');
  assert.equal(backdrop.background, 'var(--bg)');
  assert.equal(backdrop['z-index'], '-1');
  assert.match(backdrop.inset, /^-\d+px\s+-\d+px$/);
});

test('rapor sekmeleri donar ve tarih şeridi sekmelerin altına yapışır', () => {
  const features = read('src/app/styles/features.css');
  const tabs = declarationsFor(features, '.reports-module > .request-tabs.workspace-sticky');
  assert.equal(tabs.top, '0');
  assert.equal(tabs['z-index'], 'calc(var(--z-chrome) + 1)');

  const strip = declarationsFor(features, '.reports-module .workspace-sticky:not(.request-tabs)');
  assert.equal(strip.top, 'var(--reports-tabs-height)');
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
});

test('hatırlatma gönderim geçmişi kendi kaydırma sınırında durur', () => {
  const features = read('src/app/styles/features.css');
  const scroll = declarationsFor(features, '.reminder-history-scroll');
  assert.equal(scroll.overflow, 'auto');
  assert.match(scroll['max-height'], /^min\(/);
  assert.match(read('src/features/reminders/ReminderSettingsView.jsx'), /className="reminder-history-scroll"/);
});
