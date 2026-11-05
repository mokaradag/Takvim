import assert from 'node:assert/strict';
import test from 'node:test';
import { dateMatchesFilter } from '../src/components/dateMatchesFilter.js';

for (const zone of ['Europe/Istanbul', 'America/New_York'])
  for (const [now, preset, from, to, before, after] of [
    ['2026-11-05', 'lastWeek', '2026-10-26', '2026-11-01', '2026-10-25', '2026-11-02'],
    ['2026-11-02', 'lastWeek', '2026-10-26', '2026-11-01', '2026-10-25', '2026-11-02'],
    ['2026-11-08', 'lastWeek', '2026-10-26', '2026-11-01', '2026-10-25', '2026-11-02'],
    ['2026-01-01', 'lastWeek', '2025-12-22', '2025-12-28', '2025-12-21', '2025-12-29'],
    ['2026-01-05', 'lastWeek', '2025-12-29', '2026-01-04', '2025-12-28', '2026-01-05'],
    ['2026-03-12', 'lastWeek', '2026-03-02', '2026-03-08', '2026-03-01', '2026-03-09'],
    ['2026-11-05', 'lastMonth', '2026-10-01', '2026-10-31', '2026-09-30', '2026-11-01'],
    ['2026-01-05', 'lastMonth', '2025-12-01', '2025-12-31', '2025-11-30', '2026-01-01'],
    ['2024-03-01', 'lastMonth', '2024-02-01', '2024-02-29', '2024-01-31', '2024-03-01'],
    ['2025-03-01', 'lastMonth', '2025-02-01', '2025-02-28', '2025-01-31', '2025-03-01'],
    ['2026-05-31', 'lastMonth', '2026-04-01', '2026-04-30', '2026-03-31', '2026-05-01']
  ])
    test(`${preset === 'lastWeek' ? 'Geçen hafta' : 'Geçen ay'} ${now} günü ${zone} takviminde tamamlanmış dönemi kapsar`, (t) => {
      const original = process.env.TZ;
      process.env.TZ = zone;
      t.mock.timers.enable({ apis: ['Date'], now: new Date(`${now}T12:00:00`) });
      try {
        const matches = (value) => dateMatchesFilter(value, { mode: 'preset', preset });
        for (const day of [from, to]) {
          assert.equal(matches(day), true, day);
          assert.equal(matches(new Date(`${day}T23:59:59`)), true, `${day} yerel gün sonu`);
        }
        const middle = new Date(`${from}T12:00:00`);
        middle.setDate(middle.getDate() + 2);
        assert.equal(matches(middle), true);
        for (const value of [before, after, now, null, undefined, '', 'bozuk-tarih', new Date(NaN)])
          assert.equal(matches(value), false, String(value));
      } finally {
        if (original === undefined) delete process.env.TZ;
        else process.env.TZ = original;
      }
    });

test('Geçen takvim dönemleri kayan yedi ve otuz günlük mevcut kurallardan ayrıdır', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 5, 12) });
  const matches = (day, preset) => dateMatchesFilter(day, { mode: 'preset', preset });
  assert.equal(matches('2026-10-26', 'lastWeek'), true);
  assert.equal(matches('2026-10-26', 'last7'), false);
  assert.equal(matches('2026-11-05', 'lastWeek'), false);
  assert.equal(matches('2026-11-05', 'last7'), true);
  assert.equal(matches('2026-10-01', 'lastMonth'), true);
  assert.equal(matches('2026-10-01', 'last30'), false);
  assert.equal(matches('2026-11-05', 'lastMonth'), false);
  assert.equal(matches('2026-11-05', 'last30'), true);
  assert.equal(matches('2026-11-01', 'thisWeek'), false);
  assert.equal(matches('2026-11-01', 'thisMonth'), true);
});

for (const [day, preset] of [['2026-10-32', 'lastWeek'], ['2026-09-31', 'lastMonth']])
  test(`${preset === 'lastWeek' ? 'Geçen hafta' : 'Geçen ay'} takvim dışı ISO gününü başka aya taşıyıp eşleştirmez (${day})`, () => {
    assert.equal(dateMatchesFilter(day, { mode: 'preset', preset }, new Date(2026, 10, 5)), false);
  });
