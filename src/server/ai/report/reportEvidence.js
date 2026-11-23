import 'server-only';
import {
  formatIstanbulTimestamp,
  REPORT_EVIDENCE_LIMITS,
  REPORT_EVIDENCE_SCHEMA,
  validateExecutiveReportRequest
} from '../../../domain/ai/report/reportRequest.js';
import { canonicalActualId } from '../../../domain/identity/actualId.js';
import { businessDate } from '../../../domain/calendar/businessDate.js';
import { orgKeyFor } from '../../../domain/organization/organizationHierarchy.js';
import { getTrustedCurrentSicil } from '../../identity/currentUserProvider.js';
import { ServerPersistenceError } from '../../errors.js';
import { createAiDeadline } from '../aiDeadline.js';
import { createToolTurnContext } from '../tools/toolContext.js';
import { TOOL_ERROR_CODES, ToolError } from '../tools/toolErrors.js';
import { TOOL_LIMITS } from '../tools/toolLimits.js';
import { describeTaskScope, projectAccess } from '../tools/rota/rotaScope.js';
import {
  readDependencies,
  readProjectSearch,
  readReportScopeRoster,
  readReportTaskActivity,
  readTaskFacts,
  TEAM_ROSTER_LIMIT
} from '../tools/rota/rotaToolStore.js';
import { dataText, projectIndex } from '../tools/rota/rotaToolSupport.js';
import {
  foldText,
  isDueWithin,
  isOverdue,
  overdueDays,
  TEAM_LEVELS
} from '../tools/rota/taskFacts.js';
import { collectReportNotes, detectNoteDuplicatesAndContradictions } from './reportNotes.js';

/**
 * Bilgin Aşama 4I-A — Yetkili yönetici kanıt paketi toplayıcısı (`4i-kanit-1`).
 *
 * Güvenlik ve doğruluk ilkeleri:
 *   - Kimlik yalnızca güvenilir oturumdan (`getTrustedCurrentSicil`) gelir; istemci kapsamından
 *     veya istek alanlarından Sicil ya da yetki türetilmez.
 *   - Yetki kapsamı (FULL / PARTIAL / READ, yönetim kapsamı, silinmiş/taşınmış görev gizliliği)
 *     mevcut Rota yetki yükleyicisi ve Görev Hareketleri kurallarıyla bire bir uygulanır.
 *   - Yetkisiz kapsam seçimi sessizce boş başarılı rapora çevrilmez; kapalı reddedilir.
 *   - Toplama başında ve sonunda yetki dönemi parmak izi (`authorizationEpoch`) karşılaştırılır;
 *     toplama sırasında yetki değiştiyse bayat paket asla döndürülmez.
 *   - Rapor düzeyi not rızası (`notlar: dahil`) yoksa korunan not ve değişiklik metinleri hiç okunmaz.
 *   - Dönem ölçüleri ile anlık durum ölçüleri (`veri_ani`) kesin olarak ayrılır; bilinmeyen değerler
 *     `null` olarak korunur; kısmi görünürlükten tam nüfus yüzdesi hesaplanmaz.
 */

const STATUS_TO_CANONICAL = Object.freeze({
  done: 'tamamlandi',
  in_progress: 'devam_ediyor',
  todo: 'baslamadi'
});

const PRIORITY_IMPORTANCE = Object.freeze({
  critical: 40,
  high: 20,
  medium: 5,
  low: 0
});

const ORG_LEVEL_META = Object.freeze({
  birim: Object.freeze({ field: 'unit', orgLevel: 'unit', teamLevel: 'unit', sqlTeamLevel: TEAM_LEVELS.unit }),
  mudurluk: Object.freeze({ field: 'department', orgLevel: 'department', teamLevel: 'department', sqlTeamLevel: TEAM_LEVELS.department }),
  direktorluk: Object.freeze({ field: 'directorate', orgLevel: 'directorate', teamLevel: 'directorate', sqlTeamLevel: TEAM_LEVELS.directorate })
});

const TEAM_LEVEL_ALIASES = Object.freeze({
  unit: TEAM_LEVELS.unit,
  birim: TEAM_LEVELS.unit,
  department: TEAM_LEVELS.department,
  mudurluk: TEAM_LEVELS.department,
  'müdürlük': TEAM_LEVELS.department,
  directorate: TEAM_LEVELS.directorate,
  direktorluk: TEAM_LEVELS.directorate,
  'direktörlük': TEAM_LEVELS.directorate
});

const FULL_TEAM_ALIASES = new Set(['ekibim', 'tum_ekip', 'tüm ekip', 'team']);

function roundPercent(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

function projectDisplayCode(project, fallbackId) {
  return project?.code || fallbackId;
}

function formatOrgMemberForHierarchy(member) {
  return {
    organization: {
      directorate: member.directorate || '',
      department: member.department || '',
      unit: member.unit || ''
    }
  };
}

/**
 * İstek kapsamını güvenilir oturumun yetkili sınırları içinde çözer.
 * Yetkisiz proje, kişi, ekip veya örgüt birimi seçimini kapalı reddeder.
 */
async function resolveAuthorizedScope({ turn, auth, scope, signal, normalizedRequest }) {
  const { tur, kimlikler } = normalizedRequest.kapsam;

  if (tur === 'proje' || tur === 'projeler') {
    const resolvedProjects = [];
    const seenIds = new Set();
    for (const rawId of kimlikler) {
      signal.throwIfAborted();
      const guid = canonicalActualId(rawId);
      let matched = null;
      if (guid) {
        const res = await turn.sql(signal, (executor) => readProjectSearch(executor, scope, {
          projectIds: [guid],
          text: '',
          limit: 2
        }));
        matched = res.rows.find((row) => canonicalActualId(row.ProjectId) === guid) || null;
      } else {
        const res = await turn.sql(signal, (executor) => readProjectSearch(executor, scope, {
          text: rawId,
          limit: 25
        }));
        const folded = foldText(rawId);
        const exactCode = res.rows.filter((row) => row.ProjectCode && foldText(row.ProjectCode) === folded);
        if (exactCode.length === 1) {
          matched = exactCode[0];
        } else if (exactCode.length === 0) {
          const exactName = res.rows.filter((row) => row.ProjectName && foldText(row.ProjectName) === folded);
          if (exactName.length === 1) matched = exactName[0];
        }
      }
      if (!matched) {
        throw new ToolError(TOOL_ERROR_CODES.NOT_FOUND, {
          message: 'Seçilen proje yetkili kapsamınızda bulunamadı veya erişiminiz yok.'
        });
      }
      const canonicalId = canonicalActualId(matched.ProjectId);
      if (seenIds.has(canonicalId)) {
        throw new ToolError(TOOL_ERROR_CODES.INVALID_ARGUMENTS, {
          message: 'Aynı proje birden fazla kapsam kimliğiyle seçilemez.'
        });
      }
      seenIds.add(canonicalId);
      resolvedProjects.push(matched);
    }

    const projectIds = resolvedProjects.map((row) => canonicalActualId(row.ProjectId));
    const scopeSummary = describeTaskScope(resolvedProjects, { emptyComplete: false });
    return {
      tur,
      projectIds,
      resolvedProjects,
      assigneeMode: 'any',
      personSicil: null,
      teamLevel: null,
      allowedAssigneeSicils: null,
      activityScope: 'visible',
      activityPerson: null,
      activityOrgFilter: {},
      scopeSummary,
      labelById: new Map(resolvedProjects.map((row) => [
        canonicalActualId(row.ProjectId),
        {
          id: canonicalActualId(row.ProjectId),
          code: row.ProjectCode ? dataText(row.ProjectCode, 60) : canonicalActualId(row.ProjectId),
          name: dataText(row.ProjectName, 160)
        }
      ]))
    };
  }

  // Kişi, ekip ve örgütsel birim kapsamları yetkili kadro üzerinden doğrulanır.
  const rosterResult = await turn.sql(signal, (executor) => readReportScopeRoster(executor, scope, { maxRows: 500 }));
  const members = rosterResult.members;

  if (tur === 'kisi') {
    const requested = kimlikler[0];
    const numericMatch = /^\d{1,10}$/u.test(requested) ? Number(requested) : null;
    let target = null;
    if (numericMatch != null) {
      target = members.find((member) => member.sicil === numericMatch) || null;
    } else {
      const folded = foldText(requested);
      const uniqueMatches = [...new Map(
        members
          .filter((member) => member.name && foldText(member.name) === folded)
          .map((member) => [member.sicil, member])
      ).values()];
      if (uniqueMatches.length === 1) target = uniqueMatches[0];
    }
    if (!target) {
      throw new ToolError(TOOL_ERROR_CODES.UNSUPPORTED_SCOPE, {
        message: 'Seçilen kişi yetkili kapsamınızda bulunmuyor.'
      });
    }
    const isSelf = target.sicil === Number(auth.sicil);
    return {
      tur,
      projectIds: [],
      resolvedProjects: [],
      assigneeMode: isSelf ? 'me' : 'person',
      personSicil: isSelf ? null : target.sicil,
      teamLevel: null,
      allowedAssigneeSicils: new Set([target.sicil]),
      targetPerson: target,
      activityScope: isSelf ? 'mine' : (auth.isSystemAdmin && !auth.isExecutive ? 'visible' : 'team'),
      activityPerson: target.sicil,
      activityOrgFilter: {},
      scopeSummary: null
    };
  }

  if (tur === 'ekip') {
    if (!auth.isExecutive) {
      throw new ToolError(TOOL_ERROR_CODES.UNSUPPORTED_SCOPE, {
        message: 'Ekip kapsamı yalnızca yönetim kapsamı olan kullanıcılara açıktır.'
      });
    }
    const requested = kimlikler[0];
    const folded = foldText(requested);
    const managed = members.filter((member) => member.sicil !== Number(auth.sicil) && member.scopeType !== 'SELF');
    const requestedLevel = TEAM_LEVEL_ALIASES[folded] || null;
    let matchedMembers;
    if (requestedLevel) {
      matchedMembers = managed.filter((member) => member.scopeType === requestedLevel);
    } else if (FULL_TEAM_ALIASES.has(folded)) {
      matchedMembers = managed;
    } else {
      matchedMembers = managed.filter((member) => (
        (member.team && foldText(member.team) === folded)
        || (member.unit && foldText(member.unit) === folded)
      ));
    }
    const allowedSicils = new Set(matchedMembers.map((member) => member.sicil));
    if (allowedSicils.size === 0) {
      throw new ToolError(TOOL_ERROR_CODES.UNSUPPORTED_SCOPE, {
        message: 'Seçilen ekip yetkili yönetim kapsamınızda bulunamadı.'
      });
    }
    const allManagedSicils = new Set(managed.map((member) => member.sicil));
    return {
      tur,
      projectIds: [],
      resolvedProjects: [],
      assigneeMode: 'team',
      personSicil: null,
      teamLevel: requestedLevel,
      allowedAssigneeSicils: allowedSicils,
      restrictActivityToAllowedSicils: !requestedLevel && allowedSicils.size < allManagedSicils.size,
      teamLabel: requested,
      activityScope: 'team',
      activityPerson: null,
      activityOrgFilter: {},
      scopeSummary: null
    };
  }

  // Kurumsal kapsamlar: birim, mudurluk, direktorluk
  if (!auth.isExecutive && !auth.isSystemAdmin) {
    throw new ToolError(TOOL_ERROR_CODES.UNSUPPORTED_SCOPE, {
      message: 'Kurumsal birim, müdürlük ve direktörlük raporları yalnızca yetkili yöneticilere açıktır.'
    });
  }
  const meta = ORG_LEVEL_META[tur];
  const requested = kimlikler[0];
  const folded = foldText(requested);
  const candidatePool = auth.isSystemAdmin
    ? members
    : members.filter((member) => member.sicil !== Number(auth.sicil) && member.scopeType !== 'SELF');

  const matchedMembers = candidatePool.filter((member) => {
    const hierarchyKey = orgKeyFor(formatOrgMemberForHierarchy(member), meta.orgLevel);
    const plainValue = member[meta.field] || '';
    return hierarchyKey === requested || (plainValue && foldText(plainValue) === folded);
  });
  const allowedSicils = new Set(matchedMembers.map((member) => member.sicil));
  if (allowedSicils.size === 0) {
    throw new ToolError(TOOL_ERROR_CODES.UNSUPPORTED_SCOPE, {
      message: 'Seçilen kurumsal kapsam yetkili yönetim sınırlarınızda bulunamadı.'
    });
  }

  // Aynı birime/müdürlüğe ait yetkili çalışanların ortak hiyerarşi yolunu hareket raporu süzgecine geçir.
  const firstKey = orgKeyFor(formatOrgMemberForHierarchy(matchedMembers[0]), meta.orgLevel);
  const singleHierarchyKey = matchedMembers.every((member) => orgKeyFor(formatOrgMemberForHierarchy(member), meta.orgLevel) === firstKey)
    ? firstKey
    : '';

  return {
    tur,
    projectIds: [],
    resolvedProjects: [],
    assigneeMode: auth.isSystemAdmin ? 'any' : 'team',
    personSicil: null,
    teamLevel: null,
    allowedAssigneeSicils: allowedSicils,
    restrictActivityToAllowedSicils: !singleHierarchyKey,
    orgUnitLabel: requested,
    activityScope: auth.isSystemAdmin ? 'visible' : 'team',
    activityPerson: null,
    activityOrgFilter: singleHierarchyKey ? { [meta.orgLevel]: singleHierarchyKey } : {},
    scopeSummary: null
  };
}

/**
 * Görevleri 4I yol haritasının üç katmanlı belirlenimci sırasıyla önceliklendirir:
 *   1) Rapor dönemine ilgi (dönemde tamamlanan > dönemde hareket gören > tarihsiz/kritik/geciken/yaklaşan > diğer açık)
 *   2) Yönetim önemi (kritik/yüksek öncelik, gecikme, kilometre taşı, bağımlılık, dönem içi tamamlama/durum değişimi)
 *   3) Yenilik (ilgili olay/bitiş tarihi — yalnızca düzenleme sayısı veya ham UpdatedAt sıralaması kullanılmaz)
 *   4) Kararlı eşitlik bozma (projectId → taskId)
 */
function prioritizeTasks({
  tasks,
  period,
  today,
  activeTaskIds,
  dependencyMap
}) {
  const scored = tasks.map((task) => {
    const completedInPeriod = task.status === 'done'
      && Boolean(task.actualFinish)
      && task.actualFinish >= period.baslangic
      && task.actualFinish <= period.bitis;
    const undatedDone = task.status === 'done' && !task.actualFinish;
    const activeInPeriod = activeTaskIds.has(task.id);
    const overdue = isOverdue(task, today);
    const dueSoon = isDueWithin(task, today, 7);
    const deps = dependencyMap.get(task.id);
    const hasDependencies = Boolean(deps && (deps.oncul.length > 0 || deps.ardil.length > 0));

    // Katman 1: Dönem ilgisi (0..3)
    const periodRelevance = completedInPeriod
      ? 3
      : (task.status !== 'done' && activeInPeriod)
        ? 2
        : (undatedDone || overdue || dueSoon || task.milestone || activeInPeriod)
          ? 1
          : 0;

    // Katman 2: Yönetim önemi (düzenleme sayısı kesinlikle dâhil edilmez)
    let managementImportance = PRIORITY_IMPORTANCE[task.priority] ?? 0;
    if (overdue) managementImportance += 30;
    if (task.milestone) managementImportance += 25;
    if (completedInPeriod) managementImportance += 20;
    if (hasDependencies) managementImportance += 15;
    if (dueSoon) managementImportance += 10;
    if (undatedDone) managementImportance += 12;

    // Katman 3: Yenilik (tamamlanma tarihi veya termin yakınlığı)
    const recencyDay = completedInPeriod
      ? task.actualFinish
      : (activeInPeriod ? period.bitis : (task.targetFinish || '0000-00-00'));

    return {
      ...task,
      _completedInPeriod: completedInPeriod,
      _undatedDone: undatedDone,
      _activeInPeriod: activeInPeriod,
      _overdue: overdue,
      _dueSoon: dueSoon,
      _hasDependencies: hasDependencies,
      _periodRelevance: periodRelevance,
      _managementImportance: managementImportance,
      _recencyDay: recencyDay
    };
  });

  scored.sort((left, right) => (
    (right._periodRelevance - left._periodRelevance)
    || (right._managementImportance - left._managementImportance)
    || right._recencyDay.localeCompare(left._recencyDay)
    || left.projectId.localeCompare(right.projectId)
    || left.id.localeCompare(right.id)
  ));

  return scored.map((task, index) => ({ ...task, _priorityRank: index }));
}

/**
 * Kanıt kimliklerini (`E#`), türetilmiş bulguları (`F#`), çelişkileri ve serileştirilmiş
 * paket boyut sınırlarını (`maxEvidenceItems`, `maxPackageChars`) tutarlı biçimde uygular.
 */
function finalizeBoundedPackage({
  baseMeta,
  coreMetrics,
  secondaryMetrics,
  activitySummaryItem,
  taskCandidates,
  noteCandidates,
  taskById,
  today,
  limits,
  buildDerivedFindings,
  noteCompleteness,
  scopeSummary,
  activityCoverage,
  undatedDoneCount,
  totalEligibleTasks,
  taskReadTruncated = false
}) {
  const maxItems = limits.maxEvidenceItems ?? REPORT_EVIDENCE_LIMITS.maxEvidenceItems;
  const maxChars = limits.maxPackageChars ?? REPORT_EVIDENCE_LIMITS.maxPackageChars;

  // Çekirdek ölçüler (toplamlar ve paydalar) asla düşürülmez; diğer kanıtlar öncelik sırasıyla sığdırılır.
  const fixed = [
    ...coreMetrics,
    ...(activitySummaryItem ? [activitySummaryItem] : [])
  ];
  const droppable = [
    ...secondaryMetrics,
    ...taskCandidates,
    ...noteCandidates
  ];

  const initialAllowedDroppable = Math.max(0, maxItems - fixed.length);
  const retainedDroppable = droppable.slice(0, initialAllowedDroppable);
  let droppedByBudget = Math.max(0, droppable.length - retainedDroppable.length);

  const assemble = (activeDroppable, omittedExtra) => {
    const rawItems = [...fixed, ...activeDroppable];
    const taskEvidenceIdByTaskId = new Map();
    const metricIdByKey = new Map();
    const internalNotes = [];
    const publicItems = [];

    for (let index = 0; index < rawItems.length; index += 1) {
      const id = `E${index + 1}`;
      const raw = rawItems[index];
      const { _kind, _metricKey, _taskId, _auditId, _dedupeKey, _taskPriorityRank, ...clean } = raw;
      const item = { id, ...clean };
      if (_metricKey) metricIdByKey.set(_metricKey, id);
      if (item.tur === 'gorev' && _taskId) taskEvidenceIdByTaskId.set(_taskId, id);
      if (item.tur === 'not') {
        internalNotes.push({ ...item, _taskId });
      }
      publicItems.push(item);
    }

    // Çelişki ve yinelemeleri yalnızca pakette kalan kanıt kimlikleri üzerinden hesapla.
    const contradictions = detectNoteDuplicatesAndContradictions({
      noteEntries: internalNotes,
      taskById,
      taskEvidenceIdByTaskId,
      today
    });

    // Yineleme alanlarını ilgili publicItems girdilerine yansıt.
    const noteById = new Map(internalNotes.map((entry) => [entry.id, entry]));
    for (let index = 0; index < publicItems.length; index += 1) {
      if (publicItems[index].tur === 'not') {
        const enriched = noteById.get(publicItems[index].id);
        if (enriched?.yineleme_grubu) {
          publicItems[index].yineleme_grubu = enriched.yineleme_grubu;
          publicItems[index].yinelenen_kanitlar = enriched.yinelenen_kanitlar;
        }
      }
    }

    const derived = buildDerivedFindings({
      metricIdByKey,
      taskEvidenceIdByTaskId,
      publicItems
    }).map((finding, index) => ({
      id: `F${index + 1}`,
      ...finding
    }));

    const includedTasks = publicItems.filter((item) => item.tur === 'gorev').length;
    const includedNotes = publicItems.filter((item) => item.tur === 'not').length;
    const omittedTasks = Math.max(0, totalEligibleTasks - includedTasks);
    const omittedNotes = noteCompleteness.riza
      ? Math.max(0, (noteCompleteness.dahil + noteCompleteness.disarida_kalan) - includedNotes)
      : 0;
    const totalOmitted = omittedExtra + noteCompleteness.disarida_kalan;
    const truncated = omittedExtra > 0 || omittedTasks > 0 || omittedNotes > 0 || noteCompleteness.denetim_kesik || taskReadTruncated;

    const pkg = {
      sema: REPORT_EVIDENCE_SCHEMA,
      istek: baseMeta.istek,
      veri_ani: baseMeta.veri_ani,
      kanitlar: publicItems,
      turetilmis: derived,
      tamlik: {
        kapsam_gorunurlugu: scopeSummary.completeProjectView && !taskReadTruncated ? 'complete' : 'partial',
        projeler: {
          tam: scopeSummary.projects.full,
          okuma: scopeSummary.projects.read,
          kismi: scopeSummary.projects.partial
        },
        gorevler: {
          toplam_uygun: totalEligibleTasks,
          dahil: includedTasks,
          disarida_kalan: omittedTasks,
          kesildi: omittedTasks > 0 || taskReadTruncated
        },
        notlar: noteCompleteness.riza
          ? (omittedNotes > 0
            ? `ilk ${includedNotes} not (${omittedNotes} not sınır nedeniyle dışarıda)${noteCompleteness.notsuz_gorev ? `; ${noteCompleteness.notsuz_gorev} görev notsuz` : ''}`
            : noteCompleteness.metin)
          : 'hariç (rıza yok)',
        not_ozeti: {
          riza: noteCompleteness.riza,
          dahil: includedNotes,
          disarida_kalan: omittedNotes,
          notsuz_gorev: noteCompleteness.notsuz_gorev,
          kirpilan: publicItems.filter((item) => item.tur === 'not' && item.kirpildi).length,
          denetim_kesik: noteCompleteness.denetim_kesik
        },
        hareket: activityCoverage,
        tarihsiz_tamamlanan: undatedDoneCount,
        paket_kesildi: truncated,
        disarida_kalan_kanit: totalOmitted,
        karakter_sayisi: 0
      },
      celiskiler: contradictions,
      sinirlar: {
        kanit_sayisi_en_fazla: maxItems,
        karakter_en_fazla: maxChars,
        not_karakter_en_fazla: limits.maxNoteChars ?? REPORT_EVIDENCE_LIMITS.maxNoteChars
      }
    };

    // Gerçek serileştirilmiş uzunluğu iki adımda yakınsa (karakter_sayisi alanı dâhil).
    let serialized = JSON.stringify(pkg);
    pkg.tamlik.karakter_sayisi = serialized.length;
    serialized = JSON.stringify(pkg);
    if (pkg.tamlik.karakter_sayisi !== serialized.length) {
      pkg.tamlik.karakter_sayisi = serialized.length;
      serialized = JSON.stringify(pkg);
    }
    return { pkg, serializedLength: serialized.length };
  };

  let currentDroppable = [...retainedDroppable];
  let built = assemble(currentDroppable, droppedByBudget);

  // Serileştirilmiş boyut karakter sınırını aşıyorsa en düşük öncelikli sondaki kanıtları sırayla çıkar.
  while (built.serializedLength > maxChars && currentDroppable.length > 0) {
    // Büyük taşmalarda adımı güvenli biçimde hızlandır (en fazla yarısının altına inmeden).
    const excess = built.serializedLength - maxChars;
    const step = excess > 10000 && currentDroppable.length > 4 ? Math.min(currentDroppable.length, Math.max(1, Math.floor(excess / 1500))) : 1;
    currentDroppable.splice(currentDroppable.length - step, step);
    droppedByBudget += step;
    built = assemble(currentDroppable, droppedByBudget);
  }

  return built.pkg;
}

/**
 * Yetkili yönetici raporu kanıt paketini (`4i-kanit-1`) kurar.
 *
 * Döndürülen `{ evidencePackage, serverContext }` ikilisi bilinçli olarak ayrıdır:
 * `evidencePackage` yalnızca yetkili kanıtları ve kapsam/tamlık açıklamalarını içerir;
 * `Sicil`, `authorizationEpoch` ve proje erişim kararları `serverContext` içinde sunucuda kalır.
 *
 * @param {object} params - İstek ve yürütme bağımlılıkları.
 * @returns {Promise<{ evidencePackage: object, serverContext: object }>} Kanıt paketi ve sunucu bağlamı.
 */
export async function buildExecutiveReportEvidence({
  request,
  sicil = null,
  now = new Date(),
  today = null,
  signal = null,
  limits = REPORT_EVIDENCE_LIMITS,
  toolLimits = TOOL_LIMITS,
  getPool,
  loadAuthorization,
  gate,
  clock = Date.now
}) {
  // 1. Önce rapor isteğini (dönem, karşılaştırma, kapsam biçimi, rıza) SQL'e gitmeden doğrula.
  const resolvedToday = today ?? businessDate(now);
  const normalizedRequest = validateExecutiveReportRequest(request, { now, today: resolvedToday });
  const veriAni = formatIstanbulTimestamp(now);
  const cutOffMs = (now instanceof Date ? now : new Date(now)).getTime();
  const consentAtStart = normalizedRequest.notlar;

  // 2. Güvenilir oturum kimliğini çöz (istemci isteğinden asla alınmaz).
  const trustedSicil = sicil != null ? Number(sicil) : await getTrustedCurrentSicil();
  if (!Number.isSafeInteger(trustedSicil) || trustedSicil <= 0) {
    throw new ServerPersistenceError('UNAUTHORIZED', 'Geçerli oturum kimliği doğrulanamadı.');
  }

  const deadline = createAiDeadline({
    timeoutMs: toolLimits.maxToolPhaseMs ?? TOOL_LIMITS.maxToolPhaseMs,
    parentSignal: signal,
    now: clock
  });
  const effectiveSignal = deadline.signal;

  const turn = createToolTurnContext({
    sicil: trustedSicil,
    now,
    limits: toolLimits,
    clock,
    ...(getPool ? { getPool } : {}),
    ...(loadAuthorization ? { loadAuthorization } : {}),
    ...(gate ? { gate } : {})
  });

  // Geçici tamponlar iptal veya yetki hatasında temizlenecektir.
  let taskFactsResult = null;
  let noteCollection = null;

  try {
    effectiveSignal.throwIfAborted();
    turn.beginRound();
    const { auth, scope } = await turn.authorization(effectiveSignal);
    const initialEpoch = turn.authorizationEpoch();

    // 3. İstenen kapsamı yetkili sınırlar içinde çöz (yetkisiz kapsam kapalı reddedilir).
    const resolvedScope = await resolveAuthorizedScope({
      turn,
      auth,
      scope,
      signal: effectiveSignal,
      normalizedRequest
    });
    effectiveSignal.throwIfAborted();

    // 4. Kapsamdaki yetkili görev olgularını tek sınırlı sorguyla oku.
    const needsAssignees = resolvedScope.allowedAssigneeSicils != null || ['kisi', 'ekip', 'birim', 'mudurluk', 'direktorluk'].includes(resolvedScope.tur);
    taskFactsResult = await turn.sql(effectiveSignal, (executor) => readTaskFacts(executor, scope, {
      projectId: resolvedScope.projectIds.length === 1 ? resolvedScope.projectIds[0] : null,
      projectIds: resolvedScope.projectIds.length > 1 ? resolvedScope.projectIds : [],
      assigneeMode: resolvedScope.assigneeMode,
      personSicil: resolvedScope.personSicil,
      teamLevel: resolvedScope.teamLevel,
      withAssignees: needsAssignees,
      rosterRows: resolvedScope.assigneeMode === 'team' ? TEAM_ROSTER_LIMIT : 0,
      today: resolvedToday,
      maxRows: toolLimits.maxAnalyzedTasks ?? TOOL_LIMITS.maxAnalyzedTasks
    }));
    effectiveSignal.throwIfAborted();

    // Veri kesiti (veri_ani) sonrasındaki kayıtları dışla; ekip/örgütsel kapsamda tekil görev kimliğiyle çift sayımı önle.
    const dedupedTasks = new Map();
    for (const fact of taskFactsResult.facts) {
      if (fact.createdAt && Date.parse(fact.createdAt) > cutOffMs) continue;
      if (resolvedScope.allowedAssigneeSicils) {
        const assignees = taskFactsResult.assignees.get(fact.id) || [];
        const hasAuthorizedMember = assignees.some((person) => (
          person.identityVisible
          && person.sicil != null
          && resolvedScope.allowedAssigneeSicils.has(Number(person.sicil))
        ));
        if (!hasAuthorizedMember) continue;
      }
      if (!dedupedTasks.has(fact.id)) {
        // Kesit sonrası gerçekleşen bitiş tarihi henüz gerçekleşmemiş sayılır.
        const effectiveActualFinish = fact.actualFinish && fact.actualFinish <= resolvedToday ? fact.actualFinish : null;
        dedupedTasks.set(fact.id, {
          ...fact,
          actualFinish: effectiveActualFinish
        });
      }
    }
    const visibleTasks = [...dedupedTasks.values()];
    const taskById = new Map(visibleTasks.map((task) => [task.id, task]));

    // Proje dışı kapsamlarda (kişi/ekip/birim/müdürlük/direktörlük) proje kümesi yalnızca kapsama giren görevlerin projeleridir.
    const relevantProjectRows = resolvedScope.projectIds.length > 0
      ? taskFactsResult.projects
      : (() => {
        const taskProjectIds = new Set(visibleTasks.map((task) => task.projectId));
        return taskFactsResult.projects.filter((row) => taskProjectIds.has(canonicalActualId(row.ProjectId)));
      })();
    const projects = projectIndex(relevantProjectRows);
    const effectiveScopeSummary = resolvedScope.scopeSummary
      || describeTaskScope(relevantProjectRows, { emptyComplete: scope.isAdmin || [...scope.projects.values()].every((entry) => entry.accessLevel === 'FULL' || entry.readGrant) });

    // 5. Dönem hareket geçmişini Görev Hareketleri gizlilik kuralıyla oku (rıza yoksa değişiklik metni okunmaz!).
    const readActivitySlice = async ({ projectId = null, person = null } = {}) => turn.sql(effectiveSignal, (executor) => readReportTaskActivity(
      executor,
      auth,
      {
        period: 'custom',
        from: normalizedRequest.donem.baslangic,
        to: normalizedRequest.donem.bitis,
        scope: resolvedScope.activityScope,
        projectId,
        person,
        ...resolvedScope.activityOrgFilter,
        page: 0,
        pageSize: 1
      },
      now,
      {
        includeStructuredChanges: false,
        includeChangeText: false,
        analyzedActivityLimit: toolLimits.maxAnalyzedActivities ?? TOOL_LIMITS.maxAnalyzedActivities,
        aggregate: true,
        teamLevel: resolvedScope.teamLevel
      }
    ));

    const activeTaskIds = new Set();
    let periodActivitySummary;
    const sumActivitySlices = (slices) => {
      const aggTotals = { events: 0, tasks: new Set(), completed: 0, created: 0, deleted: 0, reopened: 0, updatedOnly: 0 };
      for (const slice of slices) {
        aggTotals.events += slice.total;
        aggTotals.completed += slice.summary.completed;
        aggTotals.created += slice.aggregate?.created || 0;
        aggTotals.deleted += slice.aggregate?.deleted || 0;
        aggTotals.reopened += slice.aggregate?.reopened || 0;
        aggTotals.updatedOnly += slice.aggregate?.updatedOnly || 0;
        for (const ref of slice.aggregate?.population || []) {
          if (ref?.taskId) {
            aggTotals.tasks.add(ref.taskId);
            if (taskById.has(ref.taskId)) activeTaskIds.add(ref.taskId);
          }
        }
      }
      return {
        events: aggTotals.events,
        tasks: Math.max(aggTotals.tasks.size, slices.reduce((max, slice) => Math.max(max, slice.summary.tasks || 0), 0)),
        completed: aggTotals.completed,
        created: aggTotals.created,
        deleted: aggTotals.deleted,
        reopened: aggTotals.reopened,
        updatedOnly: aggTotals.updatedOnly
      };
    };

    if (resolvedScope.projectIds.length > 1) {
      // Çok projeli istekte her yetkili proje için daraltılmış tekil okuma yapılır (fazladan genel okuma yapılmaz).
      const slices = [];
      for (const projectId of resolvedScope.projectIds) {
        effectiveSignal.throwIfAborted();
        slices.push(await readActivitySlice({ projectId }));
      }
      periodActivitySummary = sumActivitySlices(slices);
    } else if (resolvedScope.restrictActivityToAllowedSicils && resolvedScope.allowedAssigneeSicils && resolvedScope.allowedAssigneeSicils.size <= 15) {
      // Daraltılmış ekip/örgüt alt kümesinde başka ekibin hareketlerini karıştırmamak için yalnızca seçili yetkili Siciller okunur.
      const slices = [];
      for (const memberSicil of [...resolvedScope.allowedAssigneeSicils].sort((a, b) => a - b)) {
        effectiveSignal.throwIfAborted();
        slices.push(await readActivitySlice({ person: memberSicil }));
      }
      periodActivitySummary = sumActivitySlices(slices);
    } else {
      const singleProjectId = resolvedScope.projectIds.length === 1 ? resolvedScope.projectIds[0] : null;
      const periodActivityAgg = await readActivitySlice({
        projectId: singleProjectId,
        person: resolvedScope.activityPerson
      });
      effectiveSignal.throwIfAborted();
      for (const ref of periodActivityAgg.aggregate?.population || []) {
        if (ref?.taskId && taskById.has(ref.taskId)) activeTaskIds.add(ref.taskId);
      }
      periodActivitySummary = {
        events: periodActivityAgg.total,
        tasks: periodActivityAgg.summary.tasks,
        completed: periodActivityAgg.summary.completed,
        created: periodActivityAgg.aggregate?.created || 0,
        deleted: periodActivityAgg.aggregate?.deleted || 0,
        reopened: periodActivityAgg.aggregate?.reopened || 0,
        updatedOnly: periodActivityAgg.aggregate?.updatedOnly || 0
      };
    }

    // 6. Bağımlılıkları YALNIZCA FULL erişimli projeler için oku (READ ve PARTIAL projelerde asla okunmaz).
    const dependencyMap = new Map();
    const fullProjectIds = [...projects.values()]
      .filter((project) => project.accessLevel === 'FULL')
      .map((project) => project.projectId)
      .slice(0, 10);
    for (const projectId of fullProjectIds) {
      effectiveSignal.throwIfAborted();
      const depResult = await turn.sql(effectiveSignal, (executor) => readDependencies(executor, scope, {
        projectId,
        maxRows: 200
      }));
      for (const row of depResult.dependencies || []) {
        const taskId = canonicalActualId(row.TaskId);
        const predId = canonicalActualId(row.PredecessorTaskId);
        if (!taskId || !predId || !taskById.has(taskId) || !taskById.has(predId)) continue;
        if (!dependencyMap.has(taskId)) dependencyMap.set(taskId, { oncul: [], ardil: [] });
        if (!dependencyMap.has(predId)) dependencyMap.set(predId, { oncul: [], ardil: [] });
        dependencyMap.get(taskId).oncul.push(predId);
        dependencyMap.get(predId).ardil.push(taskId);
      }
    }

    // 7. Görevleri 3 katmanlı belirlenimci öncelik sırasıyla sırala.
    const prioritizedTasks = prioritizeTasks({
      tasks: visibleTasks,
      period: normalizedRequest.donem,
      today: resolvedToday,
      activeTaskIds,
      dependencyMap
    });

    // 8. Açık `notlar: dahil` rızası varsa zengin görev notlarını ve MR_AuditLog sürümlerini oku.
    noteCollection = await collectReportNotes({
      turn,
      scope,
      signal: effectiveSignal,
      consent: consentAtStart,
      prioritizedTasks,
      period: normalizedRequest.donem,
      cutOffUtc: now,
      limits
    });
    effectiveSignal.throwIfAborted();

    // 9. Dönem ve anlık ölçüleri doğru payda ve zaman kökeniyle hesapla.
    const scopeCodes = resolvedScope.projectIds.length > 0
      ? resolvedScope.projectIds.map((id) => projectDisplayCode(projects.get(id), id))
      : [...projects.values()].map((project) => projectDisplayCode(project, project.projectId)).sort();

    const completedInPeriodTasks = visibleTasks.filter((task) => task.status === 'done'
      && Boolean(task.actualFinish)
      && task.actualFinish >= normalizedRequest.donem.baslangic
      && task.actualFinish <= normalizedRequest.donem.bitis);
    const openTasks = visibleTasks.filter((task) => task.status !== 'done');
    const overdueTasks = openTasks.filter((task) => isOverdue(task, resolvedToday));
    const dueSoonTasks = openTasks.filter((task) => isDueWithin(task, resolvedToday, 7));
    const undatedDoneCount = taskFactsResult.truncated
      ? null
      : visibleTasks.filter((task) => task.status === 'done' && !task.actualFinish).length;

    const metricCompleteness = effectiveScopeSummary.completeProjectView && !taskFactsResult.truncated ? 'complete' : 'partial';
    const activityCoverage = !effectiveScopeSummary.completeProjectView
      ? 'partial'
      : 'complete';

    const scopeQualifier = () => {
      if (resolvedScope.tur === 'kisi' && resolvedScope.targetPerson?.name) {
        return { sorumlu: resolvedScope.targetPerson.name };
      }
      if (resolvedScope.tur === 'ekip') {
        return { ekip: resolvedScope.teamLabel, ...(scopeCodes.length ? { kapsam: scopeCodes } : {}) };
      }
      if (ORG_LEVEL_META[resolvedScope.tur]) {
        return { [resolvedScope.tur]: resolvedScope.orgUnitLabel, ...(scopeCodes.length ? { kapsam: scopeCodes } : {}) };
      }
      return { kapsam: scopeCodes };
    };
    const commonScopeFields = scopeQualifier();

    const coreMetrics = [
      {
        _metricKey: 'period_completed',
        tur: 'olcu',
        kaynak: 'rota_task_analytics',
        olcu: 'tamamlanan',
        deger: completedInPeriodTasks.length,
        ...commonScopeFields,
        donem: { baslangic: normalizedRequest.donem.baslangic, bitis: normalizedRequest.donem.bitis },
        tamlik: metricCompleteness
      },
      {
        _metricKey: 'period_activity',
        tur: 'olcu',
        kaynak: 'rota_activity_search',
        olcu: 'hareket',
        deger: periodActivitySummary.events,
        ...commonScopeFields,
        donem: { baslangic: normalizedRequest.donem.baslangic, bitis: normalizedRequest.donem.bitis },
        kayit_kapsami: activityCoverage,
        tamlik: activityCoverage
      },
      {
        _metricKey: 'snapshot_open',
        tur: 'olcu',
        kaynak: 'rota_task_analytics',
        olcu: 'acik',
        deger: openTasks.length,
        ...commonScopeFields,
        veri_ani: veriAni,
        tamlik: metricCompleteness
      },
      {
        _metricKey: 'snapshot_overdue',
        tur: 'olcu',
        kaynak: 'rota_task_analytics',
        olcu: 'geciken',
        deger: overdueTasks.length,
        ...commonScopeFields,
        veri_ani: veriAni,
        tamlik: metricCompleteness
      },
      {
        _metricKey: 'snapshot_due_7',
        tur: 'olcu',
        kaynak: 'rota_task_analytics',
        olcu: 'yaklasan_7_gun',
        deger: dueSoonTasks.length,
        ...commonScopeFields,
        veri_ani: veriAni,
        tamlik: metricCompleteness
      },
      {
        _metricKey: 'snapshot_undated_done',
        tur: 'olcu',
        kaynak: 'rota_task_analytics',
        olcu: 'history.undatedDone',
        deger: undatedDoneCount,
        ...commonScopeFields,
        veri_ani: veriAni,
        kayit_kapsami: undatedDoneCount === null ? 'unknown' : metricCompleteness,
        tamlik: metricCompleteness
      }
    ];

    // Karşılaştırma dönemi istendiyse karşılaştırma dönemi tamamlanma ölçüsünü aynı yetkili nüfustan hesapla.
    let comparisonCompletedCount = null;
    if (normalizedRequest.karsilastirma !== 'yok' && normalizedRequest.karsilastirma_donemi) {
      const comp = normalizedRequest.karsilastirma_donemi;
      comparisonCompletedCount = visibleTasks.filter((task) => task.status === 'done'
        && Boolean(task.actualFinish)
        && task.actualFinish >= comp.baslangic
        && task.actualFinish <= comp.bitis).length;
      coreMetrics.push({
        _metricKey: 'comparison_completed',
        tur: 'olcu',
        kaynak: 'rota_task_analytics',
        olcu: 'tamamlanan',
        deger: comparisonCompletedCount,
        ...commonScopeFields,
        donem: { baslangic: comp.baslangic, bitis: comp.bitis },
        tamlik: metricCompleteness
      });
    }

    // Çok projeli kapsamlarda proje bazlı tamamlanan kırılımı ikincil ölçü olarak eklenir.
    const secondaryMetrics = [];
    if (scopeCodes.length > 1) {
      const sortedProjects = [...projects.values()].sort((a, b) => a.projectId.localeCompare(b.projectId));
      for (const project of sortedProjects) {
        const projCompleted = completedInPeriodTasks.filter((task) => task.projectId === project.projectId).length;
        const projAccess = projectAccess(scope, project.projectId);
        const projComplete = Boolean(scope.isAdmin || projAccess?.accessLevel === 'FULL' || projAccess?.readGrant);
        secondaryMetrics.push({
          _metricKey: `project_completed:${project.projectId}`,
          tur: 'olcu',
          kaynak: 'rota_task_analytics',
          olcu: 'tamamlanan',
          deger: projCompleted,
          kapsam: [projectDisplayCode(project, project.projectId)],
          ...(resolvedScope.tur === 'ekip' ? { ekip: resolvedScope.teamLabel } : {}),
          ...(ORG_LEVEL_META[resolvedScope.tur] ? { [resolvedScope.tur]: resolvedScope.orgUnitLabel } : {}),
          donem: { baslangic: normalizedRequest.donem.baslangic, bitis: normalizedRequest.donem.bitis },
          tamlik: projComplete ? 'complete' : 'partial'
        });
      }
    }

    const activitySummaryItem = periodActivitySummary.events > 0
      ? {
        _metricKey: 'period_activity_summary',
        tur: 'hareket',
        kaynak: 'rota_activity_search',
        ...commonScopeFields,
        donem: { baslangic: normalizedRequest.donem.baslangic, bitis: normalizedRequest.donem.bitis },
        kayit_kapsami: activityCoverage,
        donem_ozeti: {
          toplam_hareket: periodActivitySummary.events,
          etkilenen_gorev: periodActivitySummary.tasks,
          tamamlanan_gorev: periodActivitySummary.completed,
          olusturulan_gorev: periodActivitySummary.created,
          silinen_gorev: periodActivitySummary.deleted,
          yeniden_acilan_gorev: periodActivitySummary.reopened,
          yalnizca_guncellenen_gorev: periodActivitySummary.updatedOnly
        }
      }
      : null;

    // 10. Önceliklendirilmiş görev kanıtlarını kur.
    const maxTasks = limits.maxSelectedTasks ?? REPORT_EVIDENCE_LIMITS.maxSelectedTasks;
    const selectedTasks = prioritizedTasks.slice(0, maxTasks);
    const taskCandidates = selectedTasks.map((task) => {
      const project = projects.get(task.projectId);
      const deps = dependencyMap.get(task.id);
      const taskItemObj = {
        _taskId: task.id,
        tur: 'gorev',
        kaynak: 'rota_task_search',
        gorev: task.id,
        proje: projectDisplayCode(project, task.projectId),
        ...(project?.name ? { proje_adi: project.name } : {}),
        baslik: dataText(task.title, 160),
        durum: STATUS_TO_CANONICAL[task.status] || 'baslamadi',
        oncelik: task.priority,
        kilometre_tasi: task.milestone,
        hedef_bitis: task.targetFinish || null,
        gerceklesen_bitis: task.actualFinish || null,
        ...(task._overdue ? { geciken_gun: overdueDays(task, resolvedToday) } : {}),
        ...(task._completedInPeriod ? { donemde_tamamlandi: true } : {}),
        ...(task._activeInPeriod ? { donemde_hareketli: true } : {}),
        ...(deps ? { bagimliliklar: { oncul: [...deps.oncul].sort(), ardil: [...deps.ardil].sort() } } : {}),
        ...(resolvedScope.tur === 'kisi' && resolvedScope.targetPerson?.name ? { sorumlu: resolvedScope.targetPerson.name } : {}),
        ...(resolvedScope.tur === 'ekip' ? { ekip: resolvedScope.teamLabel } : {}),
        ...(ORG_LEVEL_META[resolvedScope.tur] ? { [resolvedScope.tur]: resolvedScope.orgUnitLabel } : {})
      };
      return taskItemObj;
    });

    // 11. Zenginleştirilmiş not kanıtlarını kur (yalnızca rıza varsa dolu olur).
    const noteCandidates = (noteCollection.versions || []).map((version) => {
      const project = projects.get(version.projectId);
      return {
        _taskId: version.taskId,
        tur: 'not',
        kaynak: version.kaynak,
        gorev: version.taskId,
        proje: projectDisplayCode(project, version.projectId),
        kayit_zamani: version.kayit_zamani,
        kayit_zamani_durumu: version.kayit_zamani_durumu,
        surum_tipi: version.surum_tipi,
        surum_sira: version.surum_sira,
        toplam_surum: version.toplam_surum,
        donem_ici: version.donem_ici,
        ...(version.sonraki_degisiklik_zamani ? { sonraki_degisiklik_zamani: version.sonraki_degisiklik_zamani } : {}),
        metin: version.metin,
        kirpildi: version.kirpildi,
        guvenilmez_veri: true,
        metin_turu: 'kayitli_kullanici_metni',
        olay_tarihi_ayri: true,
        ...(version.guvenilmez_yonerge_iceriyor ? { guvenilmez_yonerge_iceriyor: true } : {}),
        ...(resolvedScope.tur === 'kisi' && resolvedScope.targetPerson?.name ? { sorumlu: resolvedScope.targetPerson.name } : {}),
        ...(resolvedScope.tur === 'ekip' ? { ekip: resolvedScope.teamLabel } : {}),
        ...(ORG_LEVEL_META[resolvedScope.tur] ? { [resolvedScope.tur]: resolvedScope.orgUnitLabel } : {})
      };
    });

    // 12. Sunucu türetimleri (F#) kurucusu — yalnızca tam ve geçerli paydalardan oran hesaplar.
    const completePopulation = effectiveScopeSummary.completeProjectView && !taskFactsResult.truncated;
    const buildDerivedFindings = ({ metricIdByKey }) => {
      const findings = [];
      const curCompId = metricIdByKey.get('period_completed');
      const prevCompId = metricIdByKey.get('comparison_completed');
      const openId = metricIdByKey.get('snapshot_open');
      const overdueId = metricIdByKey.get('snapshot_overdue');
      const undatedId = metricIdByKey.get('snapshot_undated_done');

      if (normalizedRequest.karsilastirma !== 'yok' && curCompId && prevCompId && comparisonCompletedCount != null) {
        const diff = completedInPeriodTasks.length - comparisonCompletedCount;
        const canPercent = completePopulation && comparisonCompletedCount > 0;
        findings.push({
          tur: 'karsilastirma',
          girdiler: [curCompId, prevCompId],
          deger: {
            mevcut: completedInPeriodTasks.length,
            onceki: comparisonCompletedCount,
            fark: diff,
            yuzde_degisim: canPercent ? roundPercent(diff, comparisonCompletedCount) : null,
            ...(canPercent ? {} : { yuzde_nedeni: !completePopulation ? 'kismi_gorunurluk' : 'sifir_payda' })
          },
          kosul: normalizedRequest.karsilastirma === 'ozel_donem'
            ? 'eşit ve bitmiş dönem'
            : 'tamamlanmış önceki eşdeğer dönem'
        });
      }

      if (completePopulation && openTasks.length > 0 && overdueTasks.length > 0 && openId && overdueId) {
        findings.push({
          tur: 'gecikme_payi',
          girdiler: [overdueId, openId],
          deger: {
            geciken: overdueTasks.length,
            acik: openTasks.length,
            oran_yuzde: roundPercent(overdueTasks.length, openTasks.length)
          },
          kosul: 'tam yetkili açık görev nüfusu'
        });
      }

      if (undatedDoneCount != null && undatedDoneCount > 0 && undatedId) {
        findings.push({
          tur: 'tarihsiz_tamamlanma_uyarisi',
          girdiler: [undatedId],
          deger: { tarihsiz_tamamlanan: undatedDoneCount },
          kosul: 'gerçekleşen bitiş tarihi kayıtlı olmadığından dönem veya gecikme çıkarımı yapılmaz'
        });
      }

      if (!effectiveScopeSummary.completeProjectView && curCompId && openId) {
        findings.push({
          tur: 'kismi_gorunurluk_uyarisi',
          girdiler: [curCompId, openId],
          deger: { kismi_proje_sayisi: effectiveScopeSummary.projects.partial },
          kosul: 'sayılar yalnızca yetkili görünür görevleri yansıtır; proje bütünü yüzdesi hesaplanmaz'
        });
      }

      const milestoneTasks = visibleTasks.filter((task) => task.milestone);
      if (milestoneTasks.length > 0 && openId) {
        findings.push({
          tur: 'kilometre_tasi_ozeti',
          girdiler: [openId],
          deger: {
            toplam: milestoneTasks.length,
            acik: milestoneTasks.filter((task) => task.status !== 'done').length,
            geciken: milestoneTasks.filter((task) => isOverdue(task, resolvedToday)).length,
            donemde_tamamlanan: milestoneTasks.filter((task) => task.status === 'done'
              && Boolean(task.actualFinish)
              && task.actualFinish >= normalizedRequest.donem.baslangic
              && task.actualFinish <= normalizedRequest.donem.bitis).length
          },
          kosul: completePopulation ? 'tam yetkili kapsam' : 'yetkili görünür görev alt kümesi'
        });
      }

      return findings;
    };

    // 13. Kanonik paketi sınırlar içinde oluştur.
    const evidencePackage = finalizeBoundedPackage({
      baseMeta: {
        istek: {
          rapor_turu: normalizedRequest.rapor_turu,
          donem: {
            baslangic: normalizedRequest.donem.baslangic,
            bitis: normalizedRequest.donem.bitis,
            ad: normalizedRequest.donem.ad
          },
          kapsam: {
            tur: normalizedRequest.kapsam.tur,
            kimlikler: [...normalizedRequest.kapsam.kimlikler]
          },
          ayrinti: normalizedRequest.ayrinti,
          odak: normalizedRequest.odak,
          notlar: normalizedRequest.notlar,
          karsilastirma: normalizedRequest.karsilastirma,
          ...(normalizedRequest.karsilastirma_donemi
            ? {
              karsilastirma_donemi: {
                baslangic: normalizedRequest.karsilastirma_donemi.baslangic,
                bitis: normalizedRequest.karsilastirma_donemi.bitis,
                ad: normalizedRequest.karsilastirma_donemi.ad
              }
            }
            : {})
        },
        veri_ani: veriAni
      },
      coreMetrics,
      secondaryMetrics,
      activitySummaryItem,
      taskCandidates,
      noteCandidates,
      taskById,
      today: resolvedToday,
      limits,
      buildDerivedFindings,
      noteCompleteness: noteCollection.completeness,
      scopeSummary: effectiveScopeSummary,
      activityCoverage,
      undatedDoneCount,
      totalEligibleTasks: prioritizedTasks.length,
      taskReadTruncated: Boolean(taskFactsResult.truncated)
    });

    // 14. Son yetki sınırı: toplama sırasında yetki değiştiyse bayat paketi reddet (kapalı ret).
    effectiveSignal.throwIfAborted();
    await turn.revalidateAuthorization(effectiveSignal);
    if (turn.authorizationEpoch() !== initialEpoch) {
      throw new ServerPersistenceError(
        'AUTHORIZATION_CHANGED',
        'Kanıt toplama sırasında yetki kapsamı değiştiği için kanıt paketi geçersiz kılındı.'
      );
    }

    // Sunucuya ait yetki ve ölçüm bağlamı model girdisinden ayrı döndürülür (Mimari §5).
    const serverContext = Object.freeze({
      sicil: trustedSicil,
      authorizationEpoch: initialEpoch,
      consent: consentAtStart,
      projectAccessLevels: Object.freeze(
        [...projects.values()].map((project) => Object.freeze({
          projectId: project.projectId,
          level: project.accessLevel === 'FULL' ? 'FULL' : (project.readGrant ? 'READ' : 'PARTIAL')
        }))
      ),
      stats: Object.freeze(turn.stats())
    });

    return { evidencePackage, serverContext };
  } catch (error) {
    // Hata veya iptal yolunda korunan içerik tamponları temizlenir ve hata iletisine sızmaz.
    taskFactsResult = null;
    noteCollection = null;
    throw error;
  } finally {
    taskFactsResult = null;
    noteCollection = null;
    deadline.dispose();
  }
}
