import { inlineText, parseAssistantMarkdown, parseInline } from '../../src/features/ai/assistant/assistantMarkdown.js';
import { parseAnswerChart } from '../../src/domain/ai/answerChart.js';
/**
 * Aşama 4E senaryo koşucusu: konuşmayı ÜRETİMDEKİ asistan hizmetinden geçirir (konuşma kaydı, takip bağlamı, yetki,
 * salt okunur araçlar, kalıcı kanıt) ve her turun araç düzeyindeki kapsamını sınama veri kümesinin SQL günlüğünden
 * okur. Planlayıcı ve düzen turları çağıranın verdiği işlevlerle yanıtlanır: deterministik sınamada altın plan,
 * canlı nitelendirmede gerçek model.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createAiStack, sendTurn } from './aiStack.mjs';
import { AYSE, NOW, rotaToolSeed } from './aiToolFixtures.mjs';
import { createFakeAiProvider } from './fakeAiProvider.mjs';
import { composer, coveringBlocks, isCompositionCall, compositionView } from './compositionScenario.mjs';
import { answerQuality } from './answerQuality.mjs';
import { formatCount } from '../../src/domain/ai/groundedPropositions.js';

const planCall = (plan) => ({ type: 'tool-calls', calls: [{ name: 'rota_plan', arguments: plan }] });

/**
 * `planner(input, turn)` → model davranışı (sahte sağlayıcı biçimi) ya da `null` (davranış kuyrukta değil);
 * `compose(input)` → düzen davranışı. Varsayılan: altın plan ve sunucunun kapsayan düzeni.
 */
export function phase4eConversation(t, { sicil = AYSE, seed = rotaToolSeed(), env = {}, composition = true, planner = null, compose = null, now = NOW, provider: external = null } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now });
  const fake = createFakeAiProvider({ semanticQueue: false });
  let current = null;
  const inputs = [];
  const compositionViews = [];
  // Dış sağlayıcı (canlı nitelendirme): planlayıcı ve düzen turlarını kendisi yanıtlar; altın plan kuyruğa konmaz.
  const recorded = external ? { ...external, get pendingCount() { return external.pendingCount; }, streamToolCompletion(input) {
    if (!isCompositionCall(input)) inputs.push(input);
    else compositionViews.push(compositionView(input));
    return external.streamToolCompletion(input);
  } } : null;
  const provider = recorded || { ...fake, get pendingCount() { return fake.pendingCount; }, streamToolCompletion(input) {
    if (!fake.pendingCount) {
      const behavior = isCompositionCall(input) ? (compose ? compose(input) : composer(coveringBlocks)) : planner?.(input, current);
      if (behavior != null) fake.enqueue(behavior);
    }
    if (!isCompositionCall(input)) inputs.push(input);
    else compositionViews.push(compositionView(input));
    return fake.streamToolCompletion(input);
  } };
  const stack = createAiStack(t, { provider, sicil, seed, env: { MERGEN_ROTA_AI_TOOLS_ENABLED: 'true', ...(composition ? { MERGEN_ROTA_AI_ANSWER_COMPOSITION: 'true' } : {}), ...env } });
  const state = { id: null, turns: 0 };
  // `mode`: asistan kipi (varsayılan standart; derin kipte Derin devri yoktur ve planlama onarım hakları o kipte kullanılır).
  async function ask(turn, { detail = null, mode = 'standard' } = {}) {
    current = turn;
    const before = (stack.db.aiToolLog || []).length;
    const evidenceBefore = (stack.db.aiMessageEvidence || []).length;
    const inputBefore = inputs.length;
    const viewBefore = compositionViews.length;
    if (!external && !planner && turn.plan) stack.provider.enqueue(planCall(turn.plan));
    if (external && turn.scripted && turn.plan) stack.provider.enqueue(planCall(turn.plan));
    const response = await sendTurn({ turnId: randomUUID(), message: turn.text, mode, ...(detail ? { detail } : {}),
      ...(state.id ? { conversationId: state.id, expectedSequence: state.turns * 2 } : {}) });
    const done = response.events.find((event) => event.event === 'done')?.data;
    assert.ok(done, `done olayı yok: ${response.text}`);
    state.id = done.conversation.id;
    state.turns += 1;
    const log = (stack.db.aiToolLog || []).slice(before);
    const evidence = (stack.db.aiMessageEvidence || []).slice(evidenceBefore).map((row) => JSON.parse(row.EvidenceJson));
    const views = compositionViews.slice(viewBefore);
    return { done, answer: done.assistantMessage, log, evidence, locale: views.at(-1)?.language || turn.plan?.language || 'tr', compositionViews: views, inputs: inputs.slice(inputBefore), analysisContext: evidence.find((row) => row.analysisContext)?.analysisContext || null };
  }
  return { stack, ask };
}

/** Aşama G bulgularının sunucu cümlelerinin ayırt edici kalıpları (yalnızca varlığı denetlenir; sayılar kanıttandır). */
export const G_FINDING_TEXT = Object.freeze({
  workloadSpread: /kişinin açık görev sayısı \*\*\d+\*\* ile \*\*\d+\*\* arasında değişiyor/,
  overdueLeader: /Gecikmiş görevler en çok .+ üzerinde|En çok gecikmiş görev .+ projeleri?nde/,
  overdueRateLeader: /Açık işe oranla bakıldığında tablo değişiyor/,
  completionDespiteOverdue: /tamamlanmış olsa da \*\*\d+\*\* gecikmiş görev bulunuyor/,
  volumeVsDelay: /Görev sayısı tek başına baskıyı göstermiyor/,
  levelComparison: /Açık işlerde gecikme oranı|Karşılaştırılan kapsamların hiçbirinde gecikmiş açık iş yok/,
  // Kilometre taşı DURUM bulgusunun kendisi (gecikmiş sayısı, "hiçbiri gecikmiş değil" ya da sıradaki): başlık ya da liste metni yetmez.
  milestoneStatus: /kilometre taşından \*\*\d+[^*]*\*\* gecikmiş|\*\*\d+\*\* kilometre taşı gecikmiş|kilometre taşının hiçbiri gecikmiş değil|Sıradaki kilometre taşı \*\*/,
  orgSpread: /[İi]şler \*\*\d+\*\* (?:bölüme|birime) dağılıyor[\s\S]+sayıları toplanmaz/
});

/** Görev nüfusu okumaları (sayfa sorumlu okumaları değil). */
export const populationReads = (log) => log.filter((row) => row.query === 'task-facts' && !String(row.params.taskIds || ''));

/** Yalnızca istemcinin kabul ettiği çitli grafik tanımları teslim edilmiş grafik sayılır. */
export function renderedCharts(content) {
  const extract = (blocks) => blocks.flatMap((block) => block.type === 'code' && block.language === 'rota-chart'
    ? [parseAnswerChart(block.text)].filter(Boolean) : block.type === 'quote' ? extract(block.children) : block.type === 'list' ? block.items.flatMap(extract) : []);
  return extract(parseAssistantMarkdown(content, { rotaData: true }));
}

/**
 * Turun araç düzeyindeki beklentileri; ihlal listesi döner (boş: geçti). `live`: canlı modelin seçtiği yön tek satırlık
 * kanıt verdiyse grafik adayı yoktur ve sunucunun kısa açıklaması kabul edilir (deterministik sınamada grafik zorunlu).
 */
export function turnViolations(result, expect, { live = false } = {}) {
  const problems = [];
  const reads = populationReads(result.log);
  const content = String(result.answer?.content || '');
  if (expect.finish && result.answer?.finishReason !== expect.finish) problems.push(`finish ${result.answer?.finishReason} ≠ ${expect.finish}`);
  // Kapsam beklentileri HER nüfus okumasında geçerlidir: bir bölüm kapsamı korurken başka bir bölümün genişlemesi kabul edilmez.
  const every = (predicate) => reads.length > 0 && reads.every(predicate);
  if (expect.assignee && !every((row) => row.params.assigneeMode === expect.assignee)) problems.push(`assignee ${expect.assignee} her okumada değil`);
  if (expect.notAssignee && reads.some((row) => row.params.assigneeMode === expect.notAssignee)) problems.push(`assignee ${expect.notAssignee} taşındı`);
  if (expect.project && !every((row) => row.params.projectId)) problems.push('proje kapsamı her okumada değil');
  if (expect.noProject && reads.some((row) => row.params.projectId)) problems.push('eski proje kapsamı taşındı');
  if (expect.person && !every((row) => row.params.personSicil != null && row.params.assigneeMode === 'person')) problems.push('kişi kapsamı her okumada değil');
  if (expect.people && JSON.stringify([...new Set(reads.map((row) => Number(row.params.personSicil)))].sort((a, b) => a - b))
    !== JSON.stringify([...new Set(expect.people.map(Number))].sort((a, b) => a - b))) problems.push('kişi kümesi beklenenle aynı değil');
  if (expect.workload && !reads.some((row) => Number(row.params.withAssignees) === 1)) problems.push('iş yükü okunmadı');
  if (expect.portfolio && !result.log.some((row) => row.query === 'portfolio')) problems.push('portföy okunmadı');
  // Ufuk: beklenen aralıkla örtüşen bir termin penceresi okunmuş olmalı (uçlarda en çok bir günlük yorum farkı kabul edilir).
  const day = (value) => Date.parse(`${String(value).slice(0, 10)}T00:00:00Z`) / 86400000;
  const bounded = reads.filter((row) => row.params.dateFrom || row.params.dateTo);
  // Gelecek dönemin (ör. önümüzdeki 14 gün) kendi okuması zorunludur: yalnızca dönemsiz gecikme okuması bunu karşılamaz.
  // Dönem, beklenen kapsamın (sorumlu koşulu ve düzey) okumasında olmalıdır: başka kapsamın dönemli okuması karşılamaz.
  if (expect.windowDays && !bounded.some((row) => row.params.dateFrom && row.params.dateTo
    && (!expect.assignee || row.params.assigneeMode === expect.assignee)
    && (!expect.level || row.params.teamLevel === expect.level.toUpperCase())
    && day(row.params.dateTo) - day(row.params.dateFrom) + 1 === expect.windowDays)) {
    problems.push(`${expect.windowDays} günlük dönem okunmadı`);
  }
  if (expect.window && (!bounded.length || !bounded.every((row) => row.params.dateFrom && row.params.dateTo
    && Math.abs(day(row.params.dateFrom) - day(expect.window[0])) <= 1 && Math.abs(day(row.params.dateTo) - day(expect.window[1])) <= 1))) {
    problems.push(`ufuk ${expect.window.join('..')} okunmadı`);
  }
  const charts = renderedCharts(content);
  if (expect.chart && !charts.length && !(live && /güvenle grafik çizilemedi|could not be drawn safely/.test(content))) problems.push('grafik yok');
  if (expect.chartUnavailable && (content.includes('```rota-chart') || !/güvenle grafik çizilemedi|could not be drawn safely/.test(content))) problems.push('çizilemeyen grafik açıkça belirtilmedi');
  if (expect.scopeDenied && !/yönetim kapsamınız bulunmuyor|management scope/.test(content)) problems.push('kapsam reddi metni yok');
  if (expect.level && !every((row) => row.params.teamLevel === expect.level.toUpperCase())) problems.push('örgütsel düzey her okumada korunmadı');
  // Aşama G: çok kapsamlı planda her kapsamın KENDİ nüfusu okunur; beklenmeyen kapsam okunmaz. Yetkisi olmadığı sunucuca
  // okumadan önce bilinen kapsam (`optional`) okunmak zorunda değildir; okunursa da yetki reddiyle sonuçlanır.
  // Her kapsam türü kendi okuma imzasıyla eşlenir: kendi (me), ekip (team + düzey), adlı kişi (person + Sicil), adlı proje (proje
  // kimliği, sorumlu koşulu yok), görünür bütün işler/projeler (koşulsuz görev okuması ya da portföy). Yetkisiz kapsam (`optional`)
  // okunmak zorunda değildir; okunduysa kanıt üretmemelidir (yetki reddi).
  if (expect.layers) {
    const level = (layer) => (layer.level ? layer.level.toUpperCase() : '');
    const signature = (row) => {
      const mode = row.params.assigneeMode || 'any';
      if (mode === 'me' || mode === 'team') return `${mode}|${row.params.teamLevel || ''}`;
      if (mode === 'person') return `person|${row.params.personSicil ?? ''}`;
      return row.params.projectId ? `project|${String(row.params.projectId).toLowerCase()}` : 'all|';
    };
    const matches = (layer, key) => {
      if (layer.scope === 'self') return key === 'me|';
      if (layer.scope === 'team') return key === `team|${level(layer)}`;
      if (layer.scope === 'person') return layer.sicil != null ? key === `person|${layer.sicil}` : key.startsWith('person|');
      if (layer.scope === 'project') return layer.projectId != null ? key === `project|${String(layer.projectId).toLowerCase()}` : key.startsWith('project|');
      return key === 'all|';
    };
    const keys = reads.map(signature);
    for (const layer of expect.layers.filter((layer) => !layer.optional)) {
      const portfolio = ['projects', 'all'].includes(layer.scope) && result.log.some((row) => row.query === 'portfolio');
      if (!keys.some((key) => matches(layer, key)) && !portfolio) problems.push(`kapsam okunmadı: ${layer.scope}${layer.level ? `/${layer.level}` : ''}`);
    }
    if (keys.some((key) => !expect.layers.some((layer) => matches(layer, key)))) problems.push('bildirilmeyen kapsam okundu');
    // Kanıtın kapsam imzası okumanınkiyle aynıdır (adlı kişi ve proje dahil): yetkisiz adlı kapsamın kanıtı da yakalanır.
    const evidenceKey = (row) => {
      const filters = row.data?.filters || {};
      if (filters.assignee === 'team') return `team|${String(filters.teamLevel || '').toUpperCase()}`;
      if (filters.assignee === 'me') return 'me|';
      if (filters.assignee === 'person' && filters.personSicil != null) return `person|${filters.personSicil}`;
      if (filters.projectId != null) return `project|${String(filters.projectId).toLowerCase()}`;
      return null;
    };
    for (const layer of expect.layers.filter((layer) => layer.optional)) {
      if ((result.evidence || []).some((row) => evidenceKey(row) && matches(layer, evidenceKey(row)))) problems.push(`yetkisiz kapsamın kanıtı var: ${layer.scope}${layer.level ? `/${layer.level}` : ''}`);
    }
  }
  // Yetkisiz kapsam (ekip ya da bölüm) hiçbir koşulda kanıt olarak kaydedilmez ve onun nüfus okuması başarılı olmaz. Okuma kayda
  // yetki denetiminden önce düşebilir: yalnızca başarıyla tamamlanan (`ok`) okuma ihlaldir. Canlı ve belirlenimci puan aynıdır.
  const teamEvidence = (level) => (result.evidence || []).some((row) => row.data?.filters?.assignee === 'team' && (!level || String(row.data.filters.teamLevel || '').toUpperCase() === level));
  const teamRead = (level) => reads.some((row) => row.ok === true && row.params.assigneeMode === 'team' && (!level || String(row.params.teamLevel || '') === level));
  if (expect.noTeamRead && (teamEvidence() || teamRead())) problems.push('yetkisiz ekip kapsamı okundu ya da kanıtlandı');
  if (expect.noDepartmentRead && (teamEvidence('DEPARTMENT') || teamRead('DEPARTMENT'))) problems.push('yetkisiz bölüm kapsamı okundu ya da kanıtlandı');
  // Canlı modelde eşdeğer açık istek (ör. "X'in bütün görevlerini göster" için liste isteği) özet bağlamı üretmez; kapsamı yine
  // okuma düzeyindeki denetimler (sorumlu, kişi kümesi, proje kimlikleri, portföy) sınar. Özet bağlamı varsa kapsamı beklenendir.
  // Belirlenimci sınamada altın plan özettir: bağlamın yokluğu da ihlaldir.
  if (expect.scope && (live && !result.analysisContext ? false : result.analysisContext?.scope !== expect.scope)) problems.push('analiz kapsamı beklenenle aynı değil');
  if (expect.scope === 'all' && !expect.project && !expect.projectIds?.length && (reads.length ? !every((row) =>
    !row.params.projectId && (!row.params.assigneeMode || row.params.assigneeMode === 'any') && !row.params.personSicil && !row.params.teamLevel)
    : !result.log.some((row) => row.query === 'portfolio'))) problems.push('tüm kapsam okumada daraltıldı');
  if (expect.projectIds && JSON.stringify([...new Set(reads.map((row) => row.params.projectId).filter(Boolean))].sort()) !== JSON.stringify([...expect.projectIds].sort())) problems.push('proje kimliği kümesi beklenenle aynı değil');
  if (expect.focus && (!result.analysisContext || expect.focus.some((focus) => !result.analysisContext.focus.includes(focus)))) problems.push('analitik yönler eksik');
  const status = result.evidence?.filter((row) => row.tool === 'rota_task_analytics' && row.data?.groupBy === 'status') || [];
  // Dağılım istenmişse kişi/proje kıyası da teslim edilen sayıları kanıtlamalıdır; bağlam ve araç okuması yetmez.
  if (expect.focus?.includes('status') && (!['person', 'project'].includes(expect.scope) || status.length || expect.chartTypes?.includes('donut'))) {
    if (!status.length) problems.push('durum grubu kanıtı yok');
    for (const projectId of expect.projectIds || []) if (!status.some((row) => row.data.filters?.projectId === projectId)) problems.push('projenin durum grubu kanıtı yok');
    const lines = content.replaceAll('**', '').split('\n');
    const blocks = parseAssistantMarkdown(content, { rotaData: true });
    const labels = { todo: ['Yapılacak', 'To do'], in_progress: ['Devam ediyor', 'In progress'], done: ['Tamamlandı', 'Done'] };
    const projectNames = new Map(status.filter((row) => row.data.filters?.projectId && row.data.filters.project)
      .map((row) => [row.data.filters.projectId, row.data.filters.project]));
    const projectIn = (source, markdown = true) => {
      const text = markdown ? inlineText(parseInline(source)) : source;
      const named = [...projectNames].filter(([, name]) => text.includes(name));
      // Biri diğerinin öneki olan adlar aynı proje değildir; tam uzun adın içindeki kısa eşleşme elenir.
      const distinct = named.filter(([, name]) => !named.some(([, other]) => other !== name && other.includes(name)));
      return distinct.length === 1 ? distinct[0][0] : null;
    };
    const headingScope = (inherited = null) => {
      const parents = [];
      return (level, named) => {
        while (parents.length && parents.at(-1).level >= level) parents.pop();
        if (named) parents.push({ level, project: named });
        return parents.at(-1)?.project || inherited;
      };
    };
    let project = null;
    let section = null;
    const sectionAt = headingScope();
    const lineProjects = lines.map((line) => {
      const named = projectIn(line);
      const heading = /^(#{1,6})\s/.exec(line);
      if (heading) { section = sectionAt(heading[1].length, named); project = section; }
      else if (named) project = named;
      return { project, section };
    });
    const chartProjects = [];
    const scopedCharts = (items, inherited = null, inheritedSection = null) => {
      let owner = inherited;
      let section = inheritedSection;
      const sectionAt = headingScope(inheritedSection);
      for (const block of items) {
        const named = projectIn(block.source || '');
        if (block.type === 'heading') { section = sectionAt(block.level, named); owner = section; }
        else if (block.type === 'paragraph' && named) owner = named;
        if (block.type === 'code' && block.language === 'rota-chart') {
          const chart = parseAnswerChart(block.text);
          // Genel veya kısaltılmış grafik başlığı bölümün projesini devralır; açıkça farklı proje adı bunu örtemez.
          if (chart) chartProjects.push({ chart, project: projectIn(chart.title, false) || owner, section });
        } else if (block.type === 'quote') scopedCharts(block.children, owner, section);
        else if (block.type === 'list') for (const item of block.items) scopedCharts(item, owner, section);
      }
    };
    scopedCharts(blocks);
    for (const row of status) {
      if (expect.scope === 'project' && expect.projectIds?.length) {
        const projectId = row.data.filters?.projectId;
        const wrongText = lines.some((line, index) => line.includes(`【${row.evidenceId}】`)
          && (lineProjects[index].project !== projectId || lineProjects[index].section != null && lineProjects[index].section !== projectId));
        const wrongChart = chartProjects.some(({ chart, project, section }) => chart.evidence.includes(row.evidenceId)
          && (project !== projectId || section != null && section !== projectId));
        if (!expect.projectIds.includes(projectId) || wrongText || wrongChart) problems.push('durum dağılımında proje atfı uyuşmuyor');
      }
      const groups = (row.data.groups || []).map((group) => ({ ...group, label: labels[group.key]?.[result.locale === 'en' ? 1 : 0] || group.label }));
      const delivered = groups.length === 0 ? lines.some((line) => line.includes(`【${row.evidenceId}】`) && /görev(?:iniz)? yok|no (?:matching )?tasks/i.test(line))
        : groups.every((group) => lines.some((line) => {
          const after = line.slice(line.indexOf(group.label) + group.label.length);
          const count = after.match(/^[^\d%]*([\d.,]+)\s+(?:görev|tasks?)\b/)?.[1];
          return line.includes(group.label) && line.includes(`【${row.evidenceId}】`) && count === formatCount(group.count, result.locale);
        })
        || blocks.some((block, index) => block.type === 'table' && blocks[index + 1]?.source.includes(`【${row.evidenceId}】`)
          && block.source.split('\n').some((line) => line.split('|').map((cell) => cell.trim()).some((cell) => cell === group.label)
            && line.split('|').map((cell) => cell.trim()).includes(formatCount(group.count, result.locale))))
        || charts.some((chart) => chart.evidence.includes(row.evidenceId) && chart.items?.some((item) => item.label === group.label && item.value === group.count)));
      if (!delivered) problems.push('durum dağılımı yanıtta eksik');
    }
  }
  for (const type of expect.chartTypes || []) if (!charts.some((chart) => chart.type === type)) problems.push(`${type} grafiği yok`);
  if (expect.horizonLimitation && !/birikimli teslimat sayıları burada karşılaştırılmıyor|does not compare cumulative delivery counts/.test(content)) problems.push('çoklu ufuk sınırlılığı açıklanmadı');
  const findings = { attentionLeader: /yönetim dikkatini en çok/, windowPressure: /arasında teslimatı olan/, subjectComparison: /arasındaki en belirgin fark|sayıları birbirine yakın|görev sayıları iki (?:kişide|projede) aynı/,
    overdueConcentration: /gecikmiş[\s\S]+toplanıyor/i, ...G_FINDING_TEXT };
  for (const kind of expect.findings || []) if (!findings[kind]?.test(content)) problems.push(`${kind} bulgusu yok`);
  if (expect.caveat && !/kesin olarak söylenemez/.test(content)) problems.push('zorunlu tamlık çekincesi yok');
  // Aşama G: tam kadroda kişi sayıları için kapasite çekincesi zorunludur; tamlık çekincesi (eksik kadro) o zaman yazılmaz.
  if (expect.capacityCaveat && !/görev adedidir; işin büyüklüğünü, harcanan emeği ya da boş kapasiteyi göstermez/.test(content)) problems.push('kapasite çekincesi yok');
  if (expect.capacityCaveat && /kesin olarak söylenemez/.test(content)) problems.push('tam kadroda eksik kadro çekincesi');
  if (expect.overlapNote && !/birbirini kapsar[\s\S]*yığıldığında toplam yanlış/.test(content)) problems.push('örtüşen seri notu yok');
  // Yalnızca birbirini kapsayan seriler (açık ile onun parçası gecikmiş/yakın terminli) yığılırsa ihlaldir; açık + tamamlanan gibi
  // ayrık durum bölümlerinin yığılması doğrudur.
  const overlapping = (series = []) => series.includes('Açık görev') && series.some((name) => ['Gecikmiş görev', 'Yedi gün içinde terminli görev'].includes(name));
  if (expect.overlapNote && renderedCharts(content).some((chart) => chart.type === 'stacked' && overlapping(chart.series))) problems.push('örtüşen seriler yığıldı');
  if (expect.omissionNote && !/tek yanıtın okuma sınırına sığmadığı için ayrıca gösterilmedi/.test(content)) problems.push('okunmayan yön notu yok');
  for (const pattern of expect.mustNot || []) if (new RegExp(pattern).test(content)) problems.push(`yasak ifade: ${pattern}`);
  for (const pattern of expect.must || []) if (!new RegExp(pattern).test(content)) problems.push(`zorunlu ifade yok: ${pattern}`);
  if (expect.conclusion && !answerQuality(content).ending) problems.push('son blokta sonuç yok');
  if (expect.priorities) {
    const ending = content.split('\n\n').filter((block) => block.trim() && !/^_Not:/.test(block)).at(-1) || '';
    // Öncelik kapanışı kaynaklı tek paragraftır: sıra bağlacıyla açılan her bölüm bir önceliktir.
    const closing = /^(?:Özetle öncelik sırası şöyle|In short, the order of priority is): (.+)\. (?:【R\d+】)+$/.exec(ending);
    const priorities = closing ? closing[1].split('; ').filter((item) => /^(?:önce|ardından|son olarak|first|then|finally) \S/.test(item)) : [];
    if (priorities.length !== expect.priorities) problems.push('istenen kanıtlı öncelik sayısı eksik');
  }
  if (expect.overdueUnwindowed && !reads.some((row) => row.params.deadline === 'overdue' && !row.params.dateFrom && !row.params.dateTo)) problems.push('mevcut gecikme ayrı okunmadı');
  // Veri okumayan tur hiçbir Rota sorgusu çalıştırmaz (görev kimliğiyle ya da portföy okuması dâhil; süzülmüş alt küme değil).
  if (expect.noData && result.log.length) problems.push(`veri okundu: ${[...new Set(result.log.map((row) => row.query))].join(',')}`);
  if (expect.table && !/^\|.+\|\n\|[- :|]+\|/m.test(content)) problems.push('istenen tablo yok');
  if (expect.detail && (!result.compositionViews?.length || !result.compositionViews.every((view) => view.detail === expect.detail))) problems.push('yanıt ayrıntısı beklenenle aynı değil');
  if (expect.finish === 'stop' && (!reads.length && !result.log.some((row) => row.query === 'portfolio'))) problems.push('araç okuması yok');
  return problems;
}
