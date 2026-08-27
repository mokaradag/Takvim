import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('Takvim araçları masaüstünde tek ortak ve kompakt çubukta sıralanır', () => {
  const calendar = read('src/features/calendar/CalendarView.jsx');
  assert.equal((calendar.match(/className="calendar-toolbar"/g) || []).length, 1);
  assert.match(calendar, /\{leadingControls\}[\s\S]*?goPrev[\s\S]*?goNext[\s\S]*?aria-label="Ay"[\s\S]*?aria-label="Yıl"[\s\S]*?Tarihe git[\s\S]*?>Bugün</);
  assert.match(calendar, /calendar-toolbar-end[\s\S]*?>Normal<[\s\S]*?>Büyük<[\s\S]*?resmi tatil/);
  assert.doesNotMatch(calendar, /className="cal-legend"/);
});

test('Basit ve Gelişmiş Mod aynı Takvim araç çubuğunu kullanır', () => {
  const shell = read('src/components/shell/AppShell.jsx');
  assert.match(shell, /leadingControls=\{<SimpleCalendarTabs/);
  assert.match(shell, /\) : <CalendarView t=\{t\} setTweak=\{setTweak\} \/>/);
  assert.equal((shell.match(/<CalendarView/g) || []).length, 2);
});

test('Basit Mod Takvim sekmeleri erişilebilir ve seçili ay sekme geçişinde korunur', () => {
  const shell = read('src/components/shell/AppShell.jsx');
  const calendar = read('src/features/calendar/CalendarView.jsx');
  assert.match(shell, /onKeyDown=\{onKeyDown\}/);
  assert.match(shell, /aria-controls=\{simpleCalendarPanelId\('calendar'\)\}/);
  assert.match(shell, /aria-controls=\{simpleCalendarPanelId\('entry'\)\}/);
  assert.match(shell, /month=\{simpleCalendarMonth\}/);
  assert.match(shell, /onMonthChange=\{setSimpleCalendarMonth\}/);
  assert.match(shell, /role="tabpanel"[\s\S]*?aria-labelledby=\{simpleCalendarTabId\('entry'\)\}/);
  assert.match(calendar, /const month = controlledMonth \?\? localMonth;/);
  assert.match(calendar, /role=\{panelId \? 'tabpanel' : undefined\}/);
});

test('takvim içerik kaydırması araç çubuğunu ve hafta başlığını görünür tutar', () => {
  const calendar = read('src/features/calendar/CalendarView.jsx');
  const css = read('src/app/globals.css');
  assert.match(calendar, /calendar-scroll[\s\S]*?className="cal-head"[\s\S]*?TR_DAYS/);
  assert.match(css, /\.content\.calendar-content-active\s*\{[^}]*overflow:\s*hidden;/s);
  assert.match(css, /\.calendar-view\s*\{[^}]*height:\s*100%;[^}]*min-height:\s*0;/s);
  assert.match(css, /\.calendar-scroll\s*\{[^}]*overflow:\s*auto;[^}]*background:\s*var\(--bg-elev\);/s);
  assert.match(css, /\.cal-head\s*\{[^}]*position:\s*sticky;[^}]*top:\s*0;[^}]*z-index:\s*var\(--z-sticky\);[^}]*background:\s*var\(--bg-elev\);/s);
  assert.match(css, /@media \(max-width: 1180px\)[\s\S]*?\.calendar-toolbar \{ flex-wrap: wrap; \}/);
});
