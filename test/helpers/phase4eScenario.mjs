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
import { formatCount, formatFactDay } from '../../src/domain/ai/groundedPropositions.js';
import { rankedRowIndexes } from '../../src/domain/ai/requestContract.js';
import { metricPaths } from '../../src/domain/ai/claimableEvidence.js';
const { sortedBy } = await import('../../src/server/ai/tools/requestPopulation.js');
import { layerAspectLabel, layerOwner } from '../../src/domain/ai/plannerOutcome.js';

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
  overdueLeader: /Gecikmiş görevler en çok .+ üzerinde|En çok gecikmiş görev .+ proje(?:si|leri)nde/,
  overdueRateLeader: /Açık işe oranla bakıldığında tablo değişiyor/,
  completionDespiteOverdue: /tamamlanmış olsa da \*\*\d+\*\* gecikmiş görev bulunuyor/,
  volumeVsDelay: /Görev sayısı tek başına baskıyı göstermiyor/,
  levelComparison: /Açık işlerde gecikme oranı|Karşılaştırılan kapsamların hiçbirinde gecikmiş açık iş yok|Karşılaştırılan kapsamların hiçbirinde açık iş olmadığından/,
  // Kilometre taşı DURUM bulgusunun kendisi (gecikmiş sayısı, "hiçbiri gecikmiş değil" ya da sıradaki): başlık ya da liste metni yetmez.
  milestoneStatus: /kilometre taşından \*\*\d+[^*]*\*\* gecikmiş|\*\*\d+\*\* kilometre taşı gecikmiş|kilometre taşının hiçbiri gecikmiş değil|Sıradaki kilometre taşı \*\*|[Gg]österilen en yakın kilometre taşı \*\*|[Aa]ynı en yakın termindeki kilometre taşlarından biri \*\*/,
  // Örgütsel yayılım bulgusu ve tablonun zorunlu toplanmama çekincesi birlikte (sıra bulgu ile çekincenin yerleşimine bağlıdır).
  orgSpread: /^(?=[\s\S]*[İi]şler \*\*\d+\*\* (?:bölüme|birime) dağılıyor)(?=[\s\S]*(?:bölüm|birim) sayıları toplanmaz)/
});

/** İngilizce yanıtta aynı sunucu bulgularının yerelleştirilmiş kalıpları. */
const EN_FINDING_TEXT = Object.freeze({
  attentionLeader: /needs (?:management )?attention first|management attention.*(?:first|most)/i,
  windowPressure: /with deliveries between/i,
  subjectComparison: /(?:clearest|largest|main|most notable) difference|task counts.*(?:close|same)|same.*task counts/i,
  overdueConcentration: /overdue[\s\S]+(?:concentrated|sits|sit)/i,
  workloadSpread: /open tasks per person range from \*\*\d+\*\* to \*\*\d+\*\*/i,
  overdueLeader: /overdue work sits most with|most overdue work is in/i,
  overdueRateLeader: /relative to open work the picture changes/i,
  completionDespiteOverdue: /has completed[\s\S]+of its tasks yet still has/i,
  volumeVsDelay: /task volume alone does not show pressure/i,
  levelComparison: /share of open work that is overdue|none of the compared scopes has (?:overdue )?open work/i,
  milestoneStatus: /open milestones? (?:is|are) overdue|milestones? (?:is|are) overdue|next milestones?(?: date)? is|earliest shown milestone is|none of the[\s\S]+open milestones/i,
  orgSpread: /^(?=[\s\S]*work is spread across \*\*\d+\*\* (?:departments|units))(?=[\s\S]*(?:department|unit).*counts.*(?:not|never).*(?:sum|added together))/i
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
  const english = result.locale === 'en';
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
  if (expect.portfolio && !result.log.some((row) => row.query === 'portfolio' && row.ok === true)) problems.push('portföy okunmadı');
  // Ufuk: beklenen aralıkla örtüşen bir termin penceresi okunmuş olmalı (uçlarda en çok bir günlük yorum farkı kabul edilir).
  const day = (value) => Date.parse(`${String(value).slice(0, 10)}T00:00:00Z`) / 86400000;
  const bounded = reads.filter((row) => row.params.dateFrom || row.params.dateTo);
  // Gelecek dönemin (ör. önümüzdeki 14 gün) kendi okuması zorunludur: yalnızca dönemsiz gecikme okuması bunu karşılamaz.
  // Dönem, beklenen kapsamın (sorumlu koşulu ve düzey) okumasında olmalıdır: başka kapsamın dönemli okuması karşılamaz.
  // Yalnızca BAŞARILI okuma dönemi karşılar (başarısız 14 günlük okuma teslim edilmiş dönem değildir).
  if (expect.windowDays && !bounded.some((row) => row.ok === true && row.params.dateFrom && row.params.dateTo
    && (!expect.assignee || row.params.assigneeMode === expect.assignee)
    && (!expect.level || row.params.teamLevel === expect.level.toUpperCase())
    && Math.abs(day(row.params.dateFrom) - day(row.params.today || new Date(NOW).toISOString().slice(0, 10))) <= 1
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
    // Kendi ve ekip kapsamının proje kısıtı imzanın parçasıdır: tek projeyle daraltılmış okuma kısıtsız kapsamın okuması sayılmaz.
    const signature = (row) => {
      const mode = row.params.assigneeMode || 'any';
      const project = row.params.projectId ? `|project:${String(row.params.projectId).toLowerCase()}` : '';
      if (mode === 'me' || mode === 'team') return `${mode}|${row.params.teamLevel || ''}${project}`;
      if (mode === 'person') return `person|${row.params.personSicil ?? ''}${project}`;
      return row.params.projectId ? `project|${String(row.params.projectId).toLowerCase()}` : 'all|';
    };
    const matches = (layer, key) => {
      if (layer.scope === 'self') return key === 'me|';
      if (layer.scope === 'team') return key === `team|${level(layer)}`;
      if (layer.scope === 'person') return layer.sicil != null ? key === `person|${layer.sicil}` : key.startsWith('person|');
      if (layer.scope === 'project') return layer.projectId != null ? key === `project|${String(layer.projectId).toLowerCase()}` : key.startsWith('project|');
      return key === 'all|';
    };
    // Gerekli kapsam yalnızca BAŞARILI okumayla karşılanır (başarısız okuma kapsamı okunmuş saymaz); bildirilmemiş kapsam denetimi
    // ise denenen her okumayı (başarısız olanlar ve portföy dahil) inceler.
    const keys = reads.map(signature);
    const okKeys = reads.filter((row) => row.ok === true && !(row.params.assigneeMode === 'unassigned')).map(signature);
    const portfolioRead = result.log.some((row) => row.query === 'portfolio' && row.ok === true);
    for (const layer of expect.layers.filter((layer) => !layer.optional)) {
      const portfolio = ['projects', 'all'].includes(layer.scope) && portfolioRead;
      if (!okKeys.some((key) => matches(layer, key)) && !portfolio) problems.push(`kapsam okunmadı: ${layer.scope}${layer.level ? `/${layer.level}` : ''}`);
    }
    const portfolioAttempted = result.log.some((row) => row.query === 'portfolio');
    if (keys.some((key) => !expect.layers.some((layer) => matches(layer, key)))
      || (portfolioAttempted && !expect.layers.some((layer) => ['projects', 'all'].includes(layer.scope)))) problems.push('bildirilmeyen kapsam okundu');
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
    // Her kapsamın KENDİ yönleri o kapsamın kanıtıyla karşılanmalıdır: bir kapsamın yönü başka kapsamın okumasıyla ya da özet okumasıyla
    // geçmez. Okuma bütçesine sığmayan yön yalnızca adıyla bildirildiyse (atlanan yön notu) kabul edilir.
    // Atlanan yön notu yalnızca ADINI verdiği kapsamın adını verdiği yönünü mazur gösterir: başka kapsamın notu eksik yönü örtmez.
    const omissionStated = (layer, focus) => omissionNoted(content, expect.layers, layer, focus, result.locale);
    const layerKeyOf = (row) => evidenceKey(row) || 'all|';
    for (const layer of expect.layers.filter((layer) => !layer.optional && Array.isArray(layer.focus))) {
      const owned = (result.evidence || []).filter((row) => matches(layer, layerKeyOf(row)) && row.data?.filters?.assignee !== 'unassigned');
      for (const focus of layer.focus) {
        const shape = LAYER_FOCUS_SHAPES[focus];
        if (!shape || owned.some((row) => shape(row, layer))) continue;
        if (!omissionStated(layer, focus)) problems.push(`kapsamın yönü okunmadı: ${layer.scope}${layer.level ? `/${layer.level}` : ''}/${focus}`);
      }
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
  // Okunan yönler: bildirilen yönler ile sunucunun kapsam gereği kendiliğinden eklediği okumalar (portföy kapsamında proje satırları;
  // bölüm ve direktörlük düzeyindeki ekipte alt birim kırılımı). Beklenen her yön gerçekten okunmuş olmalıdır.
  const context = result.analysisContext;
  // Sunucunun kendiliğinden eklediği alt birim kırılımı yalnızca okuması gerçekten kanıtlandıysa yön sayılır (okuma bütçesi dolunca düşer).
  const orgRead = (result.evidence || []).some((row) => row.tool === 'rota_task_analytics' && ['department', 'unit'].includes(row.data?.groupBy));
  const readFocus = context ? new Set([...(context.focus || []), ...(context.scope === 'projects' ? ['projects'] : []),
    ...(context.scope === 'team' && ['department', 'directorate'].includes(context.level) && orgRead ? ['org'] : [])]) : null;
  if (expect.focus && (!readFocus || expect.focus.some((focus) => !readFocus.has(focus)))) problems.push('analitik yönler eksik');
  // Tek kapsamlı turun yönleri de kanıtla karşılanır (kapsam katmanlarındaki denetimin aynısı): genel görünüm istenen iş yükünün yerine geçmez.
  if (expect.scopeFocus) {
    const layer = { scope: expect.scope, level: expect.level || null };
    // Adlı projelerin kıyasında her yön her projenin kendi kanıtıyla karşılanmalıdır: tek projenin okuması ikisini birden karşılamaz.
    // Kıyasta gecikme ve yakın termin, projenin süzgeçsiz toplamlarının değeri olarak da okunur (liste biçimi zorunlu değildir).
    const compared = expect.scope === 'project' && expect.projectIds?.length > 1;
    const owners = compared ? expect.projectIds.map((id) => ({ ...expect, projectIds: [id] }))
      : expect.scope === 'person' && expect.people?.length > 1 ? expect.people.map((id) => ({ ...expect, people: [id] })) : [expect];
    for (const focus of expect.scopeFocus) {
      const shape = LAYER_FOCUS_SHAPES[focus];
      const valueShape = compared ? COMPARISON_VALUE_SHAPES[focus] : null;
      if (shape && owners.some((owner) => !(result.evidence || []).some((row) => scopeEvidence(row, owner) && (shape(row, layer) || Boolean(valueShape?.(row))))))
        problems.push(`yön kanıtı yok: ${focus}`);
    }
  }
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
  const localized = result.locale === 'en' ? EN_FINDING_TEXT : findings;
  for (const kind of expect.findings || []) if (!localized[kind]?.test(content)) problems.push(`${kind} bulgusu yok`);
  const incompleteCaveat = english ? /cannot be stated with certainty|cannot be established/ : /kesin olarak söylenemez/;
  if (expect.caveat && !incompleteCaveat.test(content)) problems.push('zorunlu tamlık çekincesi yok');
  // Aşama G: tam kadroda kişi sayıları için kapasite çekincesi zorunludur; tamlık çekincesi (eksik kadro) o zaman yazılmaz.
  if (expect.capacityCaveat && !(english ? /task counts: they do not measure task size, effort or spare capacity/ : /görev adedidir; işin büyüklüğünü, harcanan emeği ya da boş kapasiteyi göstermez/).test(content)) problems.push('kapasite çekincesi yok');
  // Eksik kadro çekincesi yalnızca İŞ YÜKÜ (kadro) kanıtına bağlıysa ihlaldir: kişilere göre görev kırılımının kendi tamlık çekincesi
  // aynı yanıtta bulunabilir.
  const workloadIds = (result.evidence || []).filter((row) => row.tool === 'rota_workload_summary').map((row) => row.evidenceId);
  if (expect.capacityCaveat && content.split('\n\n').some((block) => incompleteCaveat.test(block)
    && workloadIds.some((id) => block.includes(`【${id}】`)))) problems.push('tam kadroda eksik kadro çekincesi');
  if (expect.overlapNote && !(english ? /counts overlap[\s\S]*stacking them would show a wrong total/ : /birbirini kapsar[\s\S]*yığıldığında toplam yanlış/).test(content)) problems.push('örtüşen seri notu yok');
  // Yalnızca birbirini kapsayan seriler (açık ile onun parçası gecikmiş/yakın terminli) yığılırsa ihlaldir; açık + tamamlanan gibi
  // ayrık durum bölümlerinin yığılması doğrudur.
  const overlapping = (series = []) => series.includes(english ? 'Open tasks' : 'Açık görev') && series.some((name) => (english ? ['Overdue tasks', 'Due within seven days'] : ['Gecikmiş görev', 'Yedi gün içinde terminli görev']).includes(name));
  if (expect.overlapNote && renderedCharts(content).some((chart) => chart.type === 'stacked' && overlapping(chart.series))) problems.push('örtüşen seriler yığıldı');
  if (expect.omissionNote && !(english ? /did not fit within one answer's read limit/ : /tek yanıtın okuma sınırına sığmadığı için ayrıca gösterilmedi/).test(content)) problems.push('okunmayan yön notu yok');
  for (const pattern of expect.mustNot || []) if (new RegExp(pattern).test(content)) problems.push(`yasak ifade: ${pattern}`);
  for (const pattern of expect.must || []) if (!new RegExp(pattern).test(content)) problems.push(`zorunlu ifade yok: ${pattern}`);
  if (expect.conclusion && !answerQuality(content).ending) problems.push('son blokta sonuç yok');
  if (expect.priorities) {
    const ending = content.split('\n\n').filter((block) => block.trim() && !/^_(?:Not:|Note:)/.test(block)).at(-1) || '';
    // Öncelik kapanışı kaynaklı tek paragraftır: sıra bağlacıyla açılan her bölüm bir önceliktir.
    const closing = /^(?:Özetle öncelik sırası şöyle|In short, the order of priority is): (.+)\. (?:【R\d+】\s*)+$/.exec(ending);
    const priorities = closing ? closing[1].split('; ').filter((item) => /^(?:önce|ardından|son olarak|first|then|finally) \S/.test(item)) : [];
    if (priorities.length !== expect.priorities) problems.push('istenen kanıtlı öncelik sayısı eksik');
  }
  if (expect.overdueUnwindowed && !reads.some((row) => row.ok === true && row.params.deadline === 'overdue' && !row.params.dateFrom && !row.params.dateTo)) problems.push('mevcut gecikme ayrı okunmadı');
  // Veri okumayan tur hiçbir Rota sorgusu çalıştırmaz (görev kimliğiyle ya da portföy okuması dâhil; süzülmüş alt küme değil).
  if (expect.noData && result.log.length) problems.push(`veri okundu: ${[...new Set(result.log.map((row) => row.query))].join(',')}`);
  if (expect.table && !/^\|.+\|\n\|[- :|]+\|/m.test(content)) problems.push('istenen tablo yok');
  if (expect.detail && (!result.compositionViews?.length || !result.compositionViews.every((view) => view.detail === expect.detail))) problems.push('yanıt ayrıntısı beklenenle aynı değil');
  if (expect.finish === 'stop' && (!reads.length && !result.log.some((row) => row.query === 'portfolio'))) problems.push('araç okuması yok');
  // Açıklama vakası görev nüfusunu okumadan sorar: kişi/proje adı çözümü serbesttir; başarılı nüfus ya da portföy okuması ve görev
  // kanıtı açıklama bitişiyle örtülmez.
  if (expect.noPopulation && (result.log.some((row) => ['task-facts', 'task-detail'].includes(row.query) && row.ok === true) || result.log.some((row) => row.query === 'portfolio' && row.ok === true)
    || (result.evidence || []).some((row) => POPULATION_TOOLS.has(row.tool)))) problems.push('açıklama vakasında görev nüfusu okundu');
  // Özetin yanındaki açık istek: kendi süzgeçleriyle okunmuş ve satırları yanıtta kaynağıyla teslim edilmiş olmalıdır (özetin
  // başka bir tablosu ya da kapsam okumaları istenen listenin yerine geçmez).
  // Kanıtın ek daraltması (ör. tek proje) istenen tam listeyi karşılamaz; sıralamalı istekte okumanın sırası ve satır sınırı da
  // beklenendir. Atıf tek başına teslim değildir: kanıtın satırları yanıtta görünmelidir.
  for (const wanted of expect.explicitRequests || []) {
    const delivered = (result.evidence || []).some((row) => row.tool === wanted.tool && explicitFiltersMatch(row.data?.filters || {}, wanted.filters)
      && explicitRankMatch(row, wanted.rank) && (wanted.operation !== 'list' || row.complete === true && row.truncated !== true)
      && content.includes(`【${row.evidenceId}】`) && rowsDelivered(row, content, wanted));
    if (!delivered) problems.push(`açık istek teslim edilmedi: ${wanted.tool}`);
  }
  return problems;
}

/** Görev nüfusu okuyan araçlar (ad çözümü değil). */
const POPULATION_TOOLS = new Set(['rota_task_search', 'rota_task_analytics', 'rota_workload_summary', 'rota_portfolio_summary']);

/** Nüfusu daraltan görev süzgeci alanları (kapsam alanları — sorumlu, ekip düzeyi, kişi — hariç). */
const NARROWING_FILTERS = Object.freeze(['projectId', 'statuses', 'priorities', 'deadline', 'dateFrom', 'dateTo', 'milestone', 'text', 'wbsId', 'createdByMe']);
const neutralFilter = (value) => value == null || value === '' || value === false || (Array.isArray(value) && !value.length);

/**
 * Açık isteğin süzgeçleri kanıtın süzgeçlerinde aynen var mı (istek alanı → araç alanı; değer sırası önemsizdir) ve kanıtta istenmeyen
 * ek daraltma yok mu (ör. tam birim listesi yerine tek projenin listesi).
 */
function explicitFiltersMatch(actual, wanted) {
  const names = { status: 'statuses', priority: 'priorities' };
  const norm = (value) => (Array.isArray(value) ? [...value].map((item) => String(item).toLowerCase()).sort() : String(value ?? '').toLowerCase());
  const asked = new Set(Object.keys(wanted || {}).map((key) => names[key] || key));
  const scopeKeys = ['assignee', 'teamLevel', 'personSicil'];
  const scopeValue = (key, value) => key === 'assignee' && (value == null || value === 'any') ? 'any' : neutralFilter(value) ? null : norm(value);
  return Object.entries(wanted || {}).every(([key, value]) => JSON.stringify(norm(actual[names[key] || key] ?? (key === 'dateField' ? 'targetFinish' : undefined))) === JSON.stringify(norm(value)))
    && scopeKeys.every((key) => JSON.stringify(scopeValue(key, actual[key])) === JSON.stringify(scopeValue(key, wanted?.[key])))
    && (!actual.dateField || actual.dateField === (wanted?.dateField || 'targetFinish'))
    && NARROWING_FILTERS.every((key) => asked.has(key) || (key === 'milestone' ? actual[key] == null : neutralFilter(actual[key])));
}

/** Tam koleksiyon ya da kanıtlı ilk sıralama sayfası: görev, proje ve kişi için aynı kayıtlı ölçü yollarını kullan. */
function explicitRankRows(row, rank) {
  const collection = row.data?.tasks ? 'tasks' : row.data?.people ? 'people' : row.data?.projects ? 'projects' : null;
  if (!collection) return null;
  const rows = row.data[collection];
  if (!rank) return rows;
  const total = row.totalCount ?? row.counts?.total;
  const complete = row.complete === true && row.truncated !== true && Number.isSafeInteger(total) && total === rows.length;
  const proof = row.rankingBoundary;
  // Son devam sayfası `complete` olsa da bütün nüfus değildir; eksik sayfada yalnızca ilk sayfanın sınır kanıtı geçerlidir.
  const order = sortedBy(row.tool, { sort: row.data.sort });
  if (!complete && !(row.complete !== true && row.truncated !== true && order?.metric === rank.metric && order.order === rank.order
    && proof?.collection === collection && proof.metric === rank.metric && proof.order === rank.order && proof.returnedCount === rows.length)) return null;
  const indexes = rankedRowIndexes({ rank, fields: [] }, row.tool, row, collection, collection);
  if (!indexes?.length) return rows.length === 0 && complete ? [] : null;
  const selected = indexes.map((index) => rows[index]);
  if (!complete) {
    const path = metricPaths(row.tool, rank.metric).find((item) => item.startsWith(`data.${collection}.*.`))?.split('.*.')[1];
    const value = (item) => path?.split('.').reduce((current, key) => current?.[key], item);
    const boundary = value(selected.at(-1));
    if (selected.length < (rank.limit || 1) || proof.nextValue !== null && !(rank.order === 'asc' ? proof.nextValue > boundary : proof.nextValue < boundary)) return null;
  }
  return selected;
}

/** Sıralamalı açık isteğin sırası, sınırı ve ilk sayfa kökeni birlikte doğrulanır. */
function explicitRankMatch(row, rank) {
  return !rank || explicitRankRows(row, rank) !== null;
}

/** Her kanıt satırı ayrı yanıt satırına eşlenir; sıralamasız listede eşleşme önceki seçimini düzeltebilir. */
function rowsDelivered(row, content, wanted = {}) {
  // Tablo hücresi kendi başlığıyla eşlenir; başka sütundaki tarih termin kanıtı olamaz. Liste ve düz yazıda başlık değeri çıkarılır.
  const deliveredLines = (blocks) => blocks.flatMap((block) => {
    if (block.type === 'table') {
      const column = block.header.map((cell) => inlineText(cell).trim()).findIndex((label) => /^(?:termini?(?: tarihi)?|hedef(?: bitiş|\/termin)?|deadline|target(?: finish| date)?|due date)$/iu.test(label));
      return block.rows.map((cells) => ({ text: cells.map((cell) => inlineText(cell)).join(' | '), table: true,
        ...(column >= 0 ? { deadline: inlineText(cells[column] || []) } : {}) }));
    }
    if (block.type === 'quote') return deliveredLines(block.children);
    if (block.type === 'list') return block.items.flatMap(deliveredLines);
    return (block.source || '').split('\n').filter((line) => line.trim()).map((line) => ({ text: inlineText(parseInline(line)) }));
  });
  const lines = deliveredLines(parseAssistantMarkdown(content, { rotaData: true }));
  const rows = explicitRankRows(row, wanted.rank);
  if (!rows) return false;
  const names = rows.map((item) => item.title || item.name);
  const choices = rows.map((item, at) => {
    const name = names[at];
    if (typeof name !== 'string' || !name.trim()) return [];
    return lines.flatMap((record, index) => {
      const line = record.text;
      if (!line.includes(name) || names.some((other) => other !== name && other?.includes(name) && line.includes(other))) return [];
      if ((wanted.metrics || []).includes('task.targetFinish')) {
        if (record.table && record.deadline == null) return [];
        const withoutTitle = line.split(name).join('');
        const labelled = /\b(?:termini?|deadline|target (?:finish|date)|due date)\s*(?:is\s+|:\s*)?([\s\S]*?)(?=\s+(?:ve|and)\s+|\.\s+|$)/iu.exec(withoutTitle);
        const deadline = record.table ? record.deadline : labelled ? labelled[1] : withoutTitle;
        const date = item.targetFinish;
        if (date == null ? /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[./]\d{1,2}[./]\d{4}\b|\b\d{1,2} \p{L}+ \d{4}\b/u.test(deadline)
          : ![date, formatFactDay(date, 'tr'), formatFactDay(date, 'en'), ...['.', '/'].map((separator) => date.slice(0, 10).split('-').reverse().join(separator))].some((value) => deadline.includes(value))) return [];
      }
      return [index];
    });
  });
  if (wanted.rank) {
    let previous = -1;
    return choices.every((matches) => { const next = matches.find((index) => index > previous); if (next == null) return false; previous = next; return true; });
  }
  const owners = new Map();
  const assign = (slot, visited) => choices[slot].some((line) => {
    if (visited.has(line)) return false;
    visited.add(line);
    if (owners.has(line) && !assign(owners.get(line), visited)) return false;
    owners.set(line, slot);
    return true;
  });
  return choices.every((_, slot) => assign(slot, new Set()));
}

/** Tek kapsamlı yön yalnızca aynı kimliğin ve aynı nüfusun kanıtıyla karşılanır. */
function scopeEvidence(row, expect) {
  const f = row.data?.filters || {};
  if (expect.scope === 'self') return f.assignee === 'me' && !f.projectId;
  if (expect.scope === 'team') return f.assignee === 'team' && !f.projectId && (!expect.level || f.teamLevel === expect.level);
  if (expect.scope === 'project') return expect.projectIds?.includes(f.projectId) && !['me', 'team', 'person', 'unassigned'].includes(f.assignee);
  if (expect.scope === 'person') return f.assignee === 'person' && expect.people?.map(Number).includes(Number(f.personSicil))
    && (expect.projectIds?.length ? expect.projectIds.includes(f.projectId) : !f.projectId);
  if (expect.scope === 'projects' && row.tool === 'rota_portfolio_summary') return true;
  return !f.projectId && !['me', 'team', 'person', 'unassigned'].includes(f.assignee);
}

/**
 * Atlanan yön notu bu kapsamın bu yönünü adlandırıyor mu. Not "<kapsam> için <yönler>" (İngilizcede "<yönler> for <kapsam>")
 * parçalarından oluşur; kapsam adları sunucunun kendi adlarıdır. Her kapsamın parçası kendi adından bir sonrakine (ya da notun
 * sonuna) kadardır; yön yalnızca kendi kapsamının parçasında aranır.
 */
function omissionNoted(content, layers, layer, focus, locale = 'tr') {
  const english = locale === 'en';
  const note = content.split('\n').find((line) => /tek yanıtın okuma sınırına sığmadığı için ayrıca gösterilmedi|did not fit within one answer's read limit/.test(line));
  const aspect = layerAspectLabel(focus, english ? 'en' : 'tr');
  if (!note || !aspect) return false;
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const ownerPattern = (item) => (['person', 'project'].includes(item.scope) && !item.names?.length
    ? (english ? (item.scope === 'person' ? "\\*\\*[^*]+\\*\\*'s work" : 'the work in \\*\\*[^*]+\\*\\*') : `\\*\\*[^*]+\\*\\* ${item.scope === 'person' ? 'sorumluluğundaki' : 'projesindeki'} işler`)
    : escape(layerOwner({ scope: item.scope, ...(item.level ? { level: item.level } : {}), ...(item.names ? { names: item.names } : {}) }, english ? 'en' : 'tr')));
  const at = (item) => { const match = new RegExp(ownerPattern(item), 'i').exec(note); return match ? { index: match.index, end: match.index + match[0].length } : null; };
  const own = at(layer);
  if (!own) return false;
  const others = layers.filter((item) => item !== layer).map(at).filter(Boolean);
  if (english) {
    const start = note.lastIndexOf('; ', own.index) + 2;
    return note.slice(start, own.index).includes(aspect);
  }
  const end = Math.min(note.indexOf(' tek yanıtın'), ...others.filter((item) => item.index > own.end).map((item) => item.index));
  return note.slice(own.end, end).includes(aspect);
}

/** Kapsam yönünün kanıt biçimi (yön → okumanın aracı/gruplaması/süzgeci); özetle karşılanan yönler (genel, durum) denetlenmez. */
const openPopulation = (f) => Array.isArray(f.statuses) && f.statuses.length === 2 && ['todo', 'in_progress'].every((status) => f.statuses.includes(status));
const wholePopulation = (row) => { const f = row.data?.filters || {}; return (neutralFilter(f.statuses) || openPopulation(f)) && unrestricted(f, ['statuses', 'dateFrom', 'dateTo']); };
const unrestricted = (f, allowed = []) => NARROWING_FILTERS.filter((key) => !['projectId', ...allowed].includes(key)).every((key) => key === 'milestone' ? f[key] == null : neutralFilter(f[key]));
/** Adlı iki projenin kıyasında değer biçimli yön kanıtı: projenin süzgeçsiz toplamları ilgili sayıyı taşır. */
const totalsRow = (row, key) => row.tool === 'rota_task_analytics' && !row.data?.groupBy && Number.isSafeInteger(row.data?.totals?.[key]) && unrestricted(row.data?.filters || {});
const COMPARISON_VALUE_SHAPES = Object.freeze({ overdue: (row) => totalsRow(row, 'overdue'), upcoming: (row) => totalsRow(row, 'dueNext7Days') });
const LAYER_FOCUS_SHAPES = Object.freeze({
  overdue: (row) => row.tool === 'rota_task_search' && row.data?.filters?.deadline === 'overdue'
    && (!(row.data.filters.statuses || []).length || openPopulation(row.data.filters)) && unrestricted(row.data.filters, ['statuses', 'deadline']),
  // Yaklaşan termin ya yaklaşan kova (`due_…`) ya da kovasız bir dönemle okunur: gecikmiş/terminsiz kovası yaklaşan işleri karşılamaz.
  upcoming: (row) => row.tool === 'rota_task_search' && openPopulation(row.data?.filters || {}) && row.data?.filters?.milestone !== true
    && (String(row.data?.filters?.deadline || '').startsWith('due_') || Boolean(row.data?.filters?.dateFrom) && neutralFilter(row.data.filters.deadline))
    && unrestricted(row.data.filters, ['statuses', 'deadline', 'dateFrom', 'dateTo']),
  critical: (row) => row.tool === 'rota_task_search' && openPopulation(row.data?.filters || {})
    && row.data.filters.priorities?.length === 2 && ['critical', 'high'].every((priority) => row.data.filters.priorities.includes(priority))
    && unrestricted(row.data.filters, ['statuses', 'priorities', 'dateFrom', 'dateTo']),
  milestones: (row) => row.tool === 'rota_task_search' && row.data?.filters?.milestone === true && openPopulation(row.data.filters)
    && unrestricted(row.data.filters, ['statuses', 'milestone']),
  // İş yükü ve örgütsel kırılım kapsamın açık (ya da bütün) işlerinin dağılımıdır: tamamlanmış, öncelikli, terminli ya da başka biçimde
  // daraltılmış nüfus bu yönü karşılamaz (yalnızca dönem kabul edilir).
  workload: (row, layer) => wholePopulation(row) && (row.tool === 'rota_workload_summary'
    || (row.tool === 'rota_task_analytics' && row.data?.groupBy === (['self', 'person'].includes(layer.scope) ? 'project' : 'assignee'))),
  org: (row, layer) => wholePopulation(row) && (row.tool === 'rota_task_analytics' && row.data?.groupBy === (layer.level === 'department' ? 'unit' : 'department')
    || (layer.scope === 'team' && layer.level === 'unit' && row.tool === 'rota_workload_summary')),
  projects: (row) => row.tool === 'rota_portfolio_summary' ? Array.isArray(row.data?.projects) : row.tool === 'rota_task_analytics' && row.data?.groupBy === 'project'
    && unrestricted(row.data?.filters || {}, ['dateFrom', 'dateTo']),
  priority: (row) => wholePopulation(row) && row.tool === 'rota_task_analytics' && row.data?.groupBy === 'priority',
  deadlines: (row) => wholePopulation(row) && row.tool === 'rota_task_analytics' && row.data?.groupBy === 'deadline',
  schedule: (row) => wholePopulation(row) && row.tool === 'rota_task_analytics' && row.data?.groupBy === 'target_month'
});
