/**
 * Aşama F — bölümler arası analitik bulgular ve giriş/sonuç anlatımı (saf, belirlenimci; model çağrısı yok).
 *
 * Bulgu motoru yalnızca TAM nüfustan pay ve sıralama söyler, kesik tablodan "ilk sırada" demez, kişi tablosunu yalnızca bütün
 * atamaların temsil edildiği kanıtlanınca kullanır, sıralı listenin başını yalnızca sunucunun doğruladığı sıralamayla alır ve
 * anlatımdaki her sayıyı doğrulanmış olgudan ya da o olgulardan sunucuda hesaplanan toplam/paydan yazar.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { unsupportedNumbers } from './helpers/numericGrounding.mjs';
import { analyticalFindings, analyticalSynthesis, FINDING_INTERPRETATIONS, FINDING_KINDS, synthesisNarrative } from '../src/domain/ai/analyticalFindings.js';

const TODAY = '2026-09-30';
const fact = (evidenceId, field, value, semantic) => ({ evidenceId, fact: { field, value, semantic: { complete: true, provenance: { tool: semantic.tool, today: TODAY }, ...semantic } } });

/** Portföy proje satırları: [ad, açık, gecikmiş, yedi gün içinde]. */
function portfolio(rows, { evidenceId = 'R1', size = rows.length, complete = true } = {}) {
  return rows.flatMap(([name, open, overdue, soon], index) => {
    const semantic = { tool: 'rota_portfolio_summary', complete, row: { identity: `p${index + 1}`, collectionSize: size }, filters: { source: 'all' } };
    return [fact(evidenceId, `data.projects.${index}.name`, name, semantic), fact(evidenceId, `data.projects.${index}.tasks.open`, open, semantic),
      fact(evidenceId, `data.projects.${index}.tasks.overdue`, overdue, semantic), fact(evidenceId, `data.projects.${index}.tasks.dueNext7Days`, soon, semantic)];
  });
}

/** Görev listesi satırları: [başlık, gecikme günü ya da termin, proje adı, proje kimliği]. */
function taskList(kind, rows, { evidenceId = 'R2', total = rows.length } = {}) {
  const filters = kind === 'overdue' ? { deadline: 'overdue', statuses: [] } : { deadline: 'due_next_7_days', statuses: ['todo', 'in_progress'] };
  return [fact(evidenceId, 'totalCount', total, { tool: 'rota_task_search', filters }),
    ...rows.flatMap(([title, value, project, projectId], index) => {
      const semantic = { tool: 'rota_task_search', filters, row: { identity: `t${index}`, collectionSize: rows.length, projectId } };
      return [fact(evidenceId, `data.tasks.${index}.title`, title, semantic), fact(evidenceId, `data.tasks.${index}.${kind === 'overdue' ? 'overdueDays' : 'targetFinish'}`, value, semantic),
        fact(evidenceId, `data.tasks.${index}.project.name`, project, semantic)];
    })];
}

const part = (index, facts, ranking = null) => ({ index, presentation: { facts }, ...(ranking ? { ranking } : {}) });
const kinds = (findings) => findings.map((item) => item.kind);
const PROJECTS = [['Altyapı', 12, 5, 6], ['Mobil', 3, 1, 1], ['Siber', 3, 1, 1], ['Ambar', 3, 1, 0], ['Portal', 6, 0, 3]];

test('tam portföy tablosu: dikkat önceliği, gecikme yoğunlaşması (sunucu payı) ve eşzamanlı baskı', () => {
  const findings = analyticalFindings([part(0, portfolio(PROJECTS))]);
  assert.deepEqual(kinds(findings), ['attentionLeader', 'overdueConcentration', 'simultaneousPressure']);
  const [leader, concentration, both] = findings;
  assert.equal(leader.entity.name, 'Altyapı');
  assert.deepEqual(leader.metrics, { overdue: 5, soon: 6, open: 12 }, 'yalnızca liderin tekil en büyük olduğu göstergeler');
  assert.deepEqual(concentration.metrics, { overdue: 5, total: 8, share: 63 }, 'toplam ve pay tam satırlardan sunucuda hesaplanır');
  assert.deepEqual(both.names, ['Altyapı', 'Mobil', 'Siber']);
  for (const item of findings) {
    assert.ok(FINDING_KINDS.includes(item.kind) && FINDING_INTERPRETATIONS.includes(item.interpretation));
    assert.deepEqual(item.evidenceIds, ['R1']);
    assert.equal(item.completeness, 'complete');
  }
});

test('kesik ya da eksik tablo bulgu üretmez; eşitlikte lider seçilmez', () => {
  assert.deepEqual(analyticalFindings([part(0, portfolio(PROJECTS, { size: 8 }))]), [], 'sayfa nüfusun tamamı değilse pay ve sıralama söylenmez');
  assert.deepEqual(analyticalFindings([part(0, portfolio(PROJECTS, { complete: false }))]), [], 'kesilmiş kanıt');
  const tied = analyticalFindings([part(0, portfolio([['A', 4, 2, 1], ['B', 4, 2, 1], ['C', 1, 0, 0]]))]);
  assert.equal(tied.some((item) => item.kind === 'attentionLeader' || item.kind === 'overdueConcentration'), false, 'eşit gecikmede tek lider yoktur');
});

test('kişi tablosu yalnızca bütün atamalar temsil edildiğinde kullanılır; aksi hâlde kişi bulgusu yok', () => {
  const people = (complete) => [
    ...[['Ayşe', 8, 3, 3], ['Burak', 5, 0, 4], ['Can', 4, 1, 1]].flatMap(([name, open, overdue, soon], index) => {
      const semantic = { tool: 'rota_workload_summary', row: { identity: 900 + index, collectionSize: 3 }, filters: { assignee: 'team' } };
      return [fact('R1', `data.people.${index}.name`, name, semantic), fact('R1', `data.people.${index}.openTasks`, open, semantic),
        fact('R1', `data.people.${index}.overdue`, overdue, semantic), fact('R1', `data.people.${index}.dueNext7Days`, soon, semantic)];
    }),
    fact('R1', 'data.populationComplete', complete, { tool: 'rota_workload_summary', filters: { assignee: 'team' } })];
  assert.deepEqual(analyticalFindings([part(0, people(false))]), [], 'eksik kadro: denge, lider ya da yoğunlaşma söylenmez');
  const findings = analyticalFindings([part(0, people(true))]);
  assert.ok(findings.length && findings.every((item) => item.kind !== 'overdueConcentration'), 'kişi yoğunlaşması bölümün kendi analist önermesidir');
  const narrative = synthesisNarrative(findings, { locale: 'tr' });
  assert.match(narrative.intro.markdown, /atama dağılımıdır; performans yargısı değildir/);
});

test('sıralı listenin başı yalnızca tam liste ya da sunucunun doğruladığı sıralamayla kullanılır', () => {
  const rows = [['Yük testi', 21, 'Altyapı', 'p1'], ['Göç provası', 11, 'Altyapı', 'p1'], ['Arayüz', 4, 'Mobil', 'p2']];
  const unranked = analyticalFindings([part(0, taskList('overdue', rows, { total: 9 }))]);
  assert.equal(unranked.some((item) => item.kind === 'longestOverdue'), false, 'kesik ve sırası doğrulanmamış listenin başı en uzun değildir');
  const ranked = analyticalFindings([part(0, taskList('overdue', rows, { total: 9 }), { metric: 'task.overdueDays', order: 'desc' })]);
  const longest = ranked.find((item) => item.kind === 'longestOverdue');
  assert.deepEqual([longest.entity.name, longest.metrics.days, longest.project, longest.completeness], ['Yük testi', 21, 'Altyapı', 'ranking-head']);
  // Tam listede proje payı proje KİMLİĞİYLE hesaplanır (aynı adlı projeler karışmaz).
  const share = analyticalFindings([part(0, taskList('overdue', [...rows, ['Rapor', 2, 'Altyapı', 'p3']]))]).find((item) => item.kind === 'overdueProjectShare');
  assert.equal(share, undefined, 'aynı adlı ayrı projelerin adıyla pay bulgusu belirsizleşmez');
});

test('yaklaşan listenin en yakın teslimatı: tekil değilse "dahil" biçimiyle, aynı gün tekilse adıyla', () => {
  const ranking = { metric: 'task.targetFinish', order: 'asc' };
  const tied = analyticalFindings([part(0, taskList('upcoming', [['Ağ', '2026-10-01', 'Portal', 'p5'], ['Kapasite', '2026-10-01', 'Altyapı', 'p1']], { total: 11 }), ranking)]);
  const nearest = tied.find((item) => item.kind === 'nearestDelivery');
  assert.deepEqual([nearest.metrics.due, nearest.metrics.sole], ['2026-10-01', false]);
  const sole = analyticalFindings([part(0, taskList('upcoming', [['Ağ', '2026-10-01', 'Portal', 'p5'], ['Test', '2026-10-03', 'Portal', 'p5']]), ranking)]);
  assert.equal(sole.find((item) => item.kind === 'nearestDelivery').metrics.sole, true);
});

test('gecikme payı listede görünmeyen adaş projeden doğrulanmış kodla ayrılır; kod yoksa yorumlanmaz', () => {
  const facts = taskList('overdue', [['Birinci iş', 8, 'Ortak', 'p1'], ['İkinci iş', 4, 'Ortak', 'p1'], ['Diğer iş', 2, 'Başka', 'p2']]);
  const shareOf = (items) => analyticalFindings([part(0, items)]).find((item) => item.kind === 'overdueProjectShare');
  // Gecikmesi olmayan adaş proje bu listede bulunamaz; adın tekilliği buradan kanıtlanamaz.
  assert.equal(shareOf(facts), undefined);
  const coded = facts.map((item) => item.fact.semantic.row ? { ...item, fact: { ...item.fact,
    semantic: { ...item.fact.semantic, row: { ...item.fact.semantic.row, projectCode: item.fact.semantic.row.projectId === 'p1' ? 'ORT-A' : 'BAS' } } } } : item);
  const share = shareOf(coded);
  assert.equal(share.entity.name, 'ORT-A · Ortak');
  assert.deepEqual(share.metrics, { overdue: 2, total: 3, share: 67 });
  assert.ok(synthesisNarrative([share], { locale: 'tr' }).intro.plain.includes('ORT-A · Ortak'));
});

test('iki öznenin karşılaştırması yalnızca aynı nüfus tanımında; dönemli toplam karşılaştırılmaz', () => {
  const totals = (evidenceId, person, sicil, values, extra = {}) => Object.entries(values).map(([key, value]) => fact(evidenceId, `data.totals.${key}`, value,
    { tool: 'rota_task_analytics', filters: { assignee: 'person', personSicil: sicil, person, statuses: [], priorities: [], deadline: null, ...extra } }));
  const pair = analyticalFindings([part(0, [...totals('R3', 'Ayşe', 1, { overdue: 3, open: 8, dueNext7Days: 3 }), ...totals('R4', 'Burak', 2, { overdue: 0, open: 5, dueNext7Days: 4 })])]);
  assert.deepEqual(kinds(pair), ['subjectComparison']);
  assert.deepEqual(pair[0].metrics, { overdue: [3, 0], open: [8, 5], dueNext7Days: [3, 4] });
  const text = synthesisNarrative(pair, { locale: 'tr' }).intro.markdown;
  // Fark tam cümleyle ve özne yeriyle söylenir (ada ek getirilmez); "(3 / 4)" gibi eğik çizgi gösterimi yoktur.
  assert.match(text, /^İki kişi arasındaki en belirgin fark gecikmiş görevlerde: \*\*Ayşe\*\* sorumluluğunda \*\*3\*\*, \*\*Burak\*\* sorumluluğunda \*\*0\*\* gecikmiş görev var\./);
  assert.match(text, /Açık görevlerde de fark belirgin: \*\*Ayşe\*\* sorumluluğunda \*\*8\*\*, \*\*Burak\*\* sorumluluğunda \*\*5\*\* açık görev var\. Önümüzdeki yedi günde terminli \(\*\*3\*\* ve \*\*4\*\*\) görev sayıları ise birbirine yakın\.$/);
  assert.doesNotMatch(text, / \/ /);
  const windowed = analyticalFindings([part(0, [...totals('R3', 'Ayşe', 1, { overdue: 3 }, { dateFrom: '2026-10-01' }), ...totals('R4', 'Burak', 2, { overdue: 0 }, { dateFrom: '2026-10-01' })])]);
  assert.deepEqual(windowed, [], 'etiketi kesin olmayan dönemli toplam karşılaştırma konusu değildir');
});

test('gelecek dönem baskısı: dönemle okunan proje grupları ile tam gecikmiş liste proje kimliğiyle eşlenir', () => {
  const groups = (dateFrom, dateTo) => [['p1', 'ALT · Altyapı', 7], ['p2', 'MOB · Mobil', 2], ['p5', 'MPO · Portal', 3]].flatMap(([key, label, open], index) => {
    const semantic = { tool: 'rota_task_analytics', groupBy: 'project', group: { key, label }, row: { identity: key, collectionSize: 3 }, filters: { dateFrom, dateTo, statuses: [] } };
    return [fact('R1', `data.groups.${index}.label`, label, semantic), fact('R1', `data.groups.${index}.open`, open, semantic), fact('R1', `data.groups.${index}.done`, 0, semantic)];
  });
  const overdue = taskList('overdue', [['Yük testi', 21, 'Altyapı', 'p1'], ['Arayüz', 7, 'Mobil', 'p2'], ['Kontrol', 2, 'Altyapı', 'p1']]);
  const future = analyticalFindings([part(0, groups('2026-09-30', '2026-10-13')), part(1, overdue)]).find((item) => item.kind === 'windowPressure');
  assert.deepEqual([future.metrics.entities, future.metrics.population, future.names], [2, 3, ['Altyapı', 'Mobil']], 'görev satırındaki kodsuz proje adı kullanılır');
  assert.deepEqual(future.evidenceIds, ['R1', 'R2']);
  const past = analyticalFindings([part(0, groups('2026-09-01', '2026-09-29')), part(1, overdue)]);
  assert.equal(past.some((item) => item.kind === 'windowPressure'), false, 'geçmiş dönemin açık sayısı yakın teslimat değildir');
  assert.match(synthesisNarrative([future], { locale: 'tr' }).intro.markdown, / ile \*\*13 Ekim 2026\*\* arasında teslimatı olan \*\*3\*\* projenin \*\*2'sinde\*\* bugün gecikmiş iş de var/);
});

test('gelecek dönem baskısı kişi nüfusunu ve adaş projelerin doğrulanmış kodlarını korur', () => {
  for (const population of [{ assignee: 'me' }, { assignee: 'person', personSicil: 1, person: 'Ayşe' }, { assignee: 'team', teamLevel: 'department' }]) {
    const groups = ['ORT-A', 'ORT-B'].flatMap((projectCode, index) => {
      const label = 'Ortak';
      const key = `p${index + 1}`;
      const semantic = { tool: 'rota_task_analytics', groupBy: 'project', group: { key, label }, row: { identity: key, collectionSize: 2, projectCode },
        filters: { ...population, dateFrom: TODAY, dateTo: '2026-10-06', statuses: [] } };
      return [fact('R1', `data.groups.${index}.label`, label, semantic), fact('R1', `data.groups.${index}.open`, 2, semantic)];
    });
    const overdue = taskList('overdue', [['A işi', 3, 'Ortak', 'p1'], ['B işi', 2, 'Ortak', 'p2']]).map((item) => ({ ...item,
      fact: { ...item.fact, semantic: { ...item.fact.semantic, filters: { ...item.fact.semantic.filters, ...population } } } }));
    const finding = analyticalFindings([part(0, groups), part(1, overdue)]).find((item) => item.kind === 'windowPressure');
    assert.ok(finding);
    assert.deepEqual(finding.names, ['ORT-A · Ortak', 'ORT-B · Ortak']);
    assert.deepEqual(finding.filters, { ...population, dateFrom: TODAY, dateTo: '2026-10-06', statuses: [] });
    const text = synthesisNarrative([finding]).intro.plain;
    assert.match(text, population.assignee === 'me' ? /kendi işleriniz/ : population.assignee === 'person' ? /Ayşe/ : /bölümünüzün işleri/);
    assert.match(text, /ORT-A · Ortak/);
    assert.match(text, /ORT-B · Ortak/);
  }
});

test('anlatım: giriş gövdenin sayılarını yinelemez, tek kanıtlı öncelik de sonuçtur, kısa yanıtta en önemli öncelik korunur, söylenen değer yinelenmez', () => {
  const parts = [part(0, portfolio(PROJECTS)), part(1, taskList('overdue', [['Yük testi', 21, 'Altyapı', 'p1'], ['Arayüz', 4, 'Mobil', 'p2']], { total: 8 }), { metric: 'task.overdueDays', order: 'desc' }),
    part(2, taskList('upcoming', [['Ağ', '2026-10-01', 'Portal', 'p5'], ['Test', '2026-10-03', 'Portal', 'p5']], { evidenceId: 'R3', total: 11 }), { metric: 'task.targetFinish', order: 'asc' })];
  const { findings, intro, conclusion } = analyticalSynthesis(parts, { locale: 'tr' });
  assert.match(intro.markdown, /^Mevcut göstergelere göre yönetim dikkatini en çok \*\*Altyapı\*\* projesi gerektiriyor: gecikmiş, önümüzdeki yedi günde terminli ve açık iş sayılarının üçünde de projeler arasında ilk sırada\./);
  assert.equal(/\*\*12\*\*|\*\*6\*\*/.test(intro.markdown), false, 'liderin değerleri girişte yinelenmez');
  // Sonuç taranabilir bir öncelik listesidir: "konu — gerekçe"; her madde kendi kaynağını taşır.
  assert.match(conclusion.markdown, /^\*\*Öncelikli konular\*\*\n\n1\. \*\*Yük testi\*\* — en uzun süredir geciken görev \(\*\*21\*\* gün, \*\*Altyapı\*\*\)\n2\. /);
  assert.deepEqual(conclusion.items.map((item) => item.evidenceIds), [['R2'], ['R1'], ['R3']]);
  assert.deepEqual(conclusion.evidenceIds, ['R1', 'R2', 'R3'], 'kaynaklar sıralı ve yalnızca kullanılan kanıtlar');
  // Kısa yanıt yalnızca en önemli tek öncelikle kapanır.
  assert.deepEqual(synthesisNarrative(findings, { locale: 'tr', detail: 'short' }).conclusion.items.map((item) => [item.markdown, item.evidenceIds]),
    [['**Yük testi** — en uzun süredir geciken görev (**21** gün, **Altyapı**)', ['R2']]]);
  const recalled = synthesisNarrative(findings, { locale: 'tr', said: (item) => item.kind === 'longestOverdue' }).conclusion.markdown;
  assert.match(recalled, /1\. \*\*Yük testi\*\* — en uzun süredir geciken görev\n/);
  assert.equal(recalled.includes('**21**'), false, 'gövdede söylenen gecikme günü sonuçta yinelenmez');
  // Aşama F: tek kanıtlı öncelik de sonuçtur; liste değil "Öne çıkan konu" satırıdır.
  const single = synthesisNarrative(findings.filter((item) => item.kind === 'nearestDelivery'), { locale: 'tr' }).conclusion;
  assert.equal(single.heading, 'Öne çıkan konu');
  assert.deepEqual(single.items.map((item) => [item.markdown, item.evidenceIds]), [['**Ağ** — en yakın teslim (**1 Ekim 2026**)', ['R3']]]);
  assert.ok(synthesisNarrative(findings, { locale: 'en' }).intro.markdown.startsWith('On the current indicators, **Altyapı** needs management attention first'));
});

test('anlatımdaki her sayı doğrulanmış olgudan ya da o olgulardan hesaplanan toplam/paydan gelir', () => {
  const parts = [part(0, portfolio(PROJECTS)), part(1, taskList('overdue', [['Yük testi', 21, 'Altyapı', 'p1'], ['Arayüz', 4, 'Mobil', 'p2']], { total: 8 }), { metric: 'task.overdueDays', order: 'desc' }),
    part(2, taskList('upcoming', [['Ağ', '2026-10-01', 'Portal', 'p5']], { evidenceId: 'R3' }))];
  const { findings, intro, conclusion } = analyticalSynthesis(parts, { locale: 'tr' });
  const facts = parts.flatMap((item) => item.presentation.facts.map((entry) => entry.fact.value));
  const derived = findings.flatMap((item) => Object.values(item.metrics).flat()).filter((value) => typeof value === 'number');
  const allowed = [...facts, ...derived];
  for (const text of [intro.markdown, conclusion.markdown]) {
    assert.deepEqual(unsupportedNumbers(text, allowed), []);
  }
});

test('sayısal kanıt denetimi vurgusuz sayıyı ve biçimlenmiş tarihin uydurma yılını yakalar', () => {
  assert.deepEqual(unsupportedNumbers('999 görev; **1 Ekim 2088**. 【R3】', [3, '2026-10-01']), ['999', '2088']);
  assert.deepEqual(unsupportedNumbers('**1 Ekim 2026**; 3 görev. 【R3】', [3, '2026-10-01']), []);
});

test('İngilizce bulgu listesinin kalan tek projesi tekil söylenir', () => {
  const finding = { kind: 'simultaneousPressure', entityType: 'project', names: ['A', 'B', 'C', 'D'], metrics: { entities: 5, population: 6 }, evidenceIds: ['R1'] };
  const text = synthesisNarrative([finding], { locale: 'en' }).intro.markdown;
  assert.match(text, /and \*\*1\*\* more project\./);
  assert.doesNotMatch(text, /1\*\* more projects/);
});
