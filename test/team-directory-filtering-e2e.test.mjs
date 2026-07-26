/**
 * Ekip sayfası süzgeç/sıralama — UÇTAN UCA davranış testleri.
 *
 * "Kurumsal ekip dizini" açılır listeleri ile tablo başlığı süzgeçlerinin TEK
 * bir durumu paylaştığı, hiyerarşinin bozulmadığı ve sıralamanın Türkçe yerel
 * ayarla çalıştığı doğrulanır. Test, görünümün kullandığı gerçek ilke modülünü
 * çalıştırır; kaynak metni yalnızca arayüz sözleşmesi için okunur.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { UNASSIGNED_DIRECTORATE } from '../src/features/team/teamDirectoryPolicy.js';
import {
  applyOrgSelection,
  createEmptyOrgFilter,
  departmentKey,
  directorateKey,
  hasOrgSelection,
  matchesOrgFilter,
  orgKeyLabel,
  orgKeyParentLabel,
  orgLevelOptions,
  pruneOrgSelection,
  sortTeamRows,
  unitKey
} from '../src/features/team/teamFilterPolicy.js';

const read = (relativePath) => readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');

/** İki farklı direktörlükte AYNI ADLI müdürlük ve birim bilinçli olarak vardır. */
const PEOPLE = [
  person('900001', 'Çiğdem Arslan', 'Yazılım Direktörlüğü', 'Planlama Müdürlüğü', 'Bütçe Birimi', 'Uzman'),
  person('900002', 'Ahmet Öztürk', 'Yazılım Direktörlüğü', 'Planlama Müdürlüğü', 'Raporlama Birimi', 'Mühendis'),
  person('900003', 'Işıl Yaman', 'Yazılım Direktörlüğü', 'Test Müdürlüğü', 'Otomasyon Birimi', 'Mühendis'),
  person('900004', 'Zeki Bulut', 'Donanım Direktörlüğü', 'Planlama Müdürlüğü', 'Bütçe Birimi', 'Uzman'),
  person('900005', 'Ömer Kaya', 'Donanım Direktörlüğü', 'Üretim Müdürlüğü', 'Montaj Birimi', 'Teknisyen'),
  person('900006', 'Bora Şen', '', '', '', 'Danışman')
];

function person(employeeNo, name, directorate, department, unit, role) {
  return {
    id: employeeNo,
    employeeNo,
    name,
    role,
    team: unit,
    organization: { sector: 'Test Sektörü', directorate, department, unit }
  };
}

function row(personRecord, overrides = {}) {
  return { person: personRecord, total: 0, active: 0, late: 0, tasks: [], upcomingSortValue: '', upcomingText: '', ...overrides };
}

const ROWS = PEOPLE.map((item) => row(item));
const keyFor = (name, level) => {
  const target = PEOPLE.find((item) => item.name === name);
  return level === 'directorate' ? directorateKey(target) : level === 'department' ? departmentKey(target) : unitKey(target);
};

/* ── Tek durum, tek seçim ───────────────────────────────── */

test('kurumsal düzeyler tek seçimlidir ve tek durumda tutulur', () => {
  const empty = createEmptyOrgFilter();
  assert.deepEqual(empty, { directorate: '', department: '', unit: '' });
  assert.equal(hasOrgSelection(empty), false);

  const selection = applyOrgSelection(empty, 'directorate', 'Yazılım Direktörlüğü');
  assert.equal(selection.directorate, 'Yazılım Direktörlüğü');
  assert.equal(typeof selection.directorate, 'string', 'düzey başına yalnızca tek değer');
  assert.equal(hasOrgSelection(selection), true);

  // İkinci bir direktörlük seçmek öncekini DEĞİŞTİRİR, eklemez.
  const replaced = applyOrgSelection(selection, 'directorate', 'Donanım Direktörlüğü');
  assert.equal(replaced.directorate, 'Donanım Direktörlüğü');
});

test('tablo başlığından müdürlük seçimi üstteki direktörlük açılır listesini de günceller', () => {
  const departmentSelection = keyFor('Işıl Yaman', 'department');
  const selection = applyOrgSelection(createEmptyOrgFilter(), 'department', departmentSelection);

  // İki yönlü eşitleme: müdürlük seçildiğinde direktörlük de yansır.
  assert.equal(selection.directorate, 'Yazılım Direktörlüğü');
  assert.equal(selection.department, departmentSelection);
  assert.equal(orgKeyLabel(selection.department, 'department'), 'Test Müdürlüğü');
});

test('tablo başlığından birim seçimi müdürlük ve direktörlüğü birlikte doldurur', () => {
  const unitSelection = keyFor('Ömer Kaya', 'unit');
  const selection = applyOrgSelection(createEmptyOrgFilter(), 'unit', unitSelection);

  assert.equal(selection.directorate, 'Donanım Direktörlüğü');
  assert.equal(orgKeyLabel(selection.department, 'department'), 'Üretim Müdürlüğü');
  assert.equal(orgKeyLabel(selection.unit, 'unit'), 'Montaj Birimi');
});

test('bir düzeyi temizlemek diğer konumda da temizler', () => {
  let selection = applyOrgSelection(createEmptyOrgFilter(), 'unit', keyFor('Ömer Kaya', 'unit'));
  selection = applyOrgSelection(selection, 'department', '');
  assert.equal(selection.department, '');
  assert.equal(selection.unit, '', 'geçersiz kalan birim de temizlenmelidir');

  selection = applyOrgSelection(selection, 'directorate', '');
  assert.deepEqual(selection, createEmptyOrgFilter());
});

/* ── Hiyerarşik bütünlük ────────────────────────────────── */

test('direktörlük değişince geçersiz kalan müdürlük ve birim temizlenir', () => {
  const yazilim = applyOrgSelection(createEmptyOrgFilter(), 'unit', keyFor('Işıl Yaman', 'unit'));
  assert.equal(yazilim.directorate, 'Yazılım Direktörlüğü');

  const donanim = applyOrgSelection(yazilim, 'directorate', 'Donanım Direktörlüğü');
  assert.equal(donanim.directorate, 'Donanım Direktörlüğü');
  assert.equal(donanim.department, '', 'başka dala ait müdürlük açık kalmamalıdır');
  assert.equal(donanim.unit, '', 'başka dala ait birim açık kalmamalıdır');
});

test('müdürlük değişince geçersiz birim temizlenir', () => {
  const planlama = applyOrgSelection(createEmptyOrgFilter(), 'unit', keyFor('Çiğdem Arslan', 'unit'));
  const test_ = applyOrgSelection(planlama, 'department', keyFor('Işıl Yaman', 'department'));
  assert.equal(test_.unit, '');
  assert.equal(orgKeyLabel(test_.department, 'department'), 'Test Müdürlüğü');
});

test('gizli kalmış tutarsız seçim temizlenir', () => {
  const inconsistent = {
    directorate: 'Donanım Direktörlüğü',
    department: keyFor('Işıl Yaman', 'department'),
    unit: keyFor('Işıl Yaman', 'unit')
  };
  assert.deepEqual(pruneOrgSelection(inconsistent), {
    directorate: 'Donanım Direktörlüğü',
    department: '',
    unit: ''
  });
});

test('aynı adlı müdürlükler farklı direktörlüklerde karışmaz', () => {
  const yazilimPlanlama = keyFor('Çiğdem Arslan', 'department');
  const donanimPlanlama = keyFor('Zeki Bulut', 'department');
  assert.notEqual(yazilimPlanlama, donanimPlanlama, 'yol anahtarı üst kırılımı taşımalıdır');
  assert.equal(orgKeyLabel(yazilimPlanlama, 'department'), orgKeyLabel(donanimPlanlama, 'department'));

  const selection = applyOrgSelection(createEmptyOrgFilter(), 'department', yazilimPlanlama);
  const matched = PEOPLE.filter((item) => matchesOrgFilter(item, selection)).map((item) => item.name);
  assert.deepEqual(matched, ['Çiğdem Arslan', 'Ahmet Öztürk']);
  assert.equal(orgKeyParentLabel(yazilimPlanlama, 'department'), 'Yazılım Direktörlüğü');
});

test('seçenek listeleri üst seçime göre daralır', () => {
  const empty = createEmptyOrgFilter();
  assert.deepEqual(
    orgLevelOptions(PEOPLE, 'directorate', empty).map((option) => option.label),
    ['Direktörlük tanımsız', 'Donanım Direktörlüğü', 'Yazılım Direktörlüğü']
  );

  const yazilim = applyOrgSelection(empty, 'directorate', 'Yazılım Direktörlüğü');
  assert.deepEqual(
    orgLevelOptions(PEOPLE, 'department', yazilim).map((option) => option.label),
    ['Planlama Müdürlüğü', 'Test Müdürlüğü']
  );

  const planlama = applyOrgSelection(yazilim, 'department', keyFor('Çiğdem Arslan', 'department'));
  assert.deepEqual(
    orgLevelOptions(PEOPLE, 'unit', planlama).map((option) => option.label),
    ['Bütçe Birimi', 'Raporlama Birimi']
  );
});

test('direktörlüğü tanımsız personel birinci sınıf seçenek olarak kalır', () => {
  const selection = applyOrgSelection(createEmptyOrgFilter(), 'directorate', UNASSIGNED_DIRECTORATE);
  const matched = PEOPLE.filter((item) => matchesOrgFilter(item, selection)).map((item) => item.name);
  assert.deepEqual(matched, ['Bora Şen']);
});

/* ── Sıralama ───────────────────────────────────────────── */

test('personel adı Türkçe yerel ayarla sıralanır', () => {
  const sorted = sortTeamRows(ROWS, { key: 'name', dir: 'asc' }).map((item) => item.person.name);
  assert.deepEqual(sorted, ['Ahmet Öztürk', 'Bora Şen', 'Çiğdem Arslan', 'Işıl Yaman', 'Ömer Kaya', 'Zeki Bulut']);

  const descending = sortTeamRows(ROWS, { key: 'name', dir: 'desc' }).map((item) => item.person.name);
  assert.deepEqual(descending, [...sorted].reverse());
});

test('sayısal sütunlar sayısal olarak sıralanır', () => {
  const rows = [
    row(PEOPLE[0], { total: 9 }),
    row(PEOPLE[1], { total: 10 }),
    row(PEOPLE[2], { total: 2 })
  ];
  assert.deepEqual(sortTeamRows(rows, { key: 'total', dir: 'asc' }).map((item) => item.total), [2, 9, 10]);
  assert.deepEqual(sortTeamRows(rows, { key: 'total', dir: 'desc' }).map((item) => item.total), [10, 9, 2]);
});

test('eksik değerler yön ne olursa olsun sona gider', () => {
  const rows = [
    row(PEOPLE[0], { upcomingSortValue: '' }),
    row(PEOPLE[1], { upcomingSortValue: '2026-01-10|Görev' }),
    row(PEOPLE[2], { upcomingSortValue: '2026-02-01|Görev' })
  ];
  for (const dir of ['asc', 'desc']) {
    const sorted = sortTeamRows(rows, { key: 'upcoming', dir });
    assert.equal(sorted[sorted.length - 1].person.name, 'Çiğdem Arslan', `eksik değer sonda kalmalı (${dir})`);
  }
});

test('eşit değerlerde ad ve sicil ile kararlı ikincil sıralama uygulanır', () => {
  const duplicated = [
    row(person('900101', 'Aynı Ad', 'D', 'M', 'B', 'Uzman'), { total: 5 }),
    row(person('900100', 'Aynı Ad', 'D', 'M', 'B', 'Uzman'), { total: 5 }),
    row(person('900099', 'Başka Ad', 'D', 'M', 'B', 'Uzman'), { total: 5 })
  ];
  const first = sortTeamRows(duplicated, { key: 'total', dir: 'asc' }).map((item) => item.person.employeeNo);
  const second = sortTeamRows([...duplicated].reverse(), { key: 'total', dir: 'asc' }).map((item) => item.person.employeeNo);
  assert.deepEqual(first, second, 'aynı değere sahip satırlar sıçramamalıdır');
  assert.deepEqual(first, ['900100', '900101', '900099']);
});

test('sıralama kaynak veriyi değiştirmez', () => {
  const original = ROWS.map((item) => item.person.name);
  sortTeamRows(ROWS, { key: 'name', dir: 'desc' });
  assert.deepEqual(ROWS.map((item) => item.person.name), original);
});

test('süzgeçleme kaynak kişi verisini değiştirmez', () => {
  const snapshot = JSON.stringify(PEOPLE);
  const selection = applyOrgSelection(createEmptyOrgFilter(), 'directorate', 'Yazılım Direktörlüğü');
  PEOPLE.filter((item) => matchesOrgFilter(item, selection));
  orgLevelOptions(PEOPLE, 'department', selection);
  assert.equal(JSON.stringify(PEOPLE), snapshot);
});

/* ── Görünüm sözleşmesi ─────────────────────────────────── */

test('Ekip görünümü açılır listeler ile başlık süzgeçlerini aynı duruma bağlar', () => {
  const view = read('src/features/team/TeamView.jsx');

  // Tek durum: her iki konum da aynı seçiciyi çağırır.
  assert.match(view, /const \[orgFilter, setOrgFilter\] = useState\(createEmptyOrgFilter\)/);
  assert.match(view, /const selectOrgLevel = \(level\) => \(value\) => \{/);
  assert.match(view, /setOrgFilter\(\(current\) => applyOrgSelection\(current, level, value\)\)/);

  for (const level of ['directorate', 'department', 'unit']) {
    const uses = view.match(new RegExp(`selectOrgLevel\\('${level}'\\)`, 'g')) || [];
    assert.ok(uses.length >= 2, `${level} hem açılır listede hem tablo başlığında kullanılmalıdır`);
    assert.match(view, new RegExp(`value=\\{orgFilter\\.${level}\\}`));
    assert.match(view, new RegExp(`filter=\\{orgFilter\\.${level}\\}`));
  }

  // Kurumsal düzeyler tek seçimlidir.
  assert.equal((view.match(/filterType="single"/g) || []).length, 3);
  assert.doesNotMatch(view, /filterType="multi" filterOptions=\{orgOptionList/);
});

test('Ekip tablosunun tüm anlamlı sütunları sıralanabilir ve süzgeçlenebilir', () => {
  const view = read('src/features/team/TeamView.jsx');
  const columns = [
    ['Personel', 'name'],
    ['Unvan', 'role'],
    ['Direktörlük', 'directorate'],
    ['Müdürlük', 'department'],
    ['Birim', 'unit'],
    ['Toplam', 'total'],
    ['Devam', 'active'],
    ['Geciken', 'late'],
    ['Yakın görevler', 'upcoming']
  ];
  for (const [label, key] of columns) {
    assert.match(view, new RegExp(`FilterableTH label="${label}"`), `${label} sütunu FilterableTH kullanmalıdır`);
    assert.match(view, new RegExp(`sortDirFor\\('${key}'\\)`), `${label} sıralanabilir olmalıdır`);
    assert.match(view, new RegExp(`setSortFor\\('${key}'\\)`), `${label} sıralama işleyicisi bağlanmalıdır`);
  }
  // Müdürlük ve Birim ayrı sütunlara bölündü.
  assert.doesNotMatch(view, /Müdürlük \/ Birim/);
  // Sicil personel adının altında görünmeye devam eder.
  assert.match(view, /member\.person\.employeeNo \|\| member\.person\.id/);
});

test('süzgeçleme ve sıralama sayfalamadan önce uygulanır', () => {
  const view = read('src/features/team/TeamView.jsx');
  const filteredIndex = view.indexOf('const filtered = useMemo(');
  const sortIndex = view.indexOf('return sortTeamRows(rows, sort);');
  const sliceIndex = view.indexOf('const visiblePeople = filtered.slice(0, limit);');

  assert.ok(filteredIndex > 0 && sortIndex > filteredIndex, 'sıralama süzgeçten sonra yapılır');
  assert.ok(sliceIndex > sortIndex, 'sayfalama sıralamadan sonra yapılır');
  // Süzgeç değiştiğinde görünür satır sınırı sıfırlanır.
  assert.match(view, /setLimit\(PERSON_PAGE_SIZE\);/);
});

test('genel arama başlık süzgeçleriyle birlikte çalışır', () => {
  const view = read('src/features/team/TeamView.jsx');
  assert.match(view, /personSearchText\(person\)\.includes\(needle\)/);
  assert.match(view, /matchesOrgFilter\(person, orgFilter\)/);
  assert.match(view, /numericMatchesFilter\(row\.total, colFilter\.total\)/);
  assert.match(view, /numericMatchesFilter\(row\.active, colFilter\.active\)/);
  assert.match(view, /numericMatchesFilter\(row\.late, colFilter\.late\)/);
});

test('temizleme düğmesi "Filtreleri temizle" metnini kullanır ve tüm durumu sıfırlar', () => {
  const view = read('src/features/team/TeamView.jsx');
  assert.match(view, /Filtreleri temizle/);
  assert.doesNotMatch(view, /Süzgeçleri temizle/);

  const clear = view.slice(view.indexOf('const clearAllFilters'), view.indexOf('return (\n'));
  assert.match(clear, /setQuery\(''\)/);
  assert.match(clear, /setOrgFilter\(createEmptyOrgFilter\(\)\)/);
  assert.match(clear, /setColFilter\(createEmptyColumnFilter\(\)\)/);
  assert.match(clear, /setLimit\(PERSON_PAGE_SIZE\)/);
});

test('paylaşılan sütun süzgeci tek seçimli türü destekler ve erişilebilir kalır', () => {
  const extras = read('src/components/ui-extras.jsx');
  assert.match(extras, /type === 'single'/);
  assert.match(extras, /role="radiogroup"/);
  assert.match(extras, /type="radio"/);
  // Tek seçimli süzgeç etkin göstergesi.
  assert.match(extras, /\(filterType === 'text' \|\| filterType === 'single'\)/);
});
