import 'server-only';
import {
  formatIstanbulTimestamp,
  normalizeReportNow,
  REPORT_EVIDENCE_LIMITS,
  REPORT_EVIDENCE_SCHEMA,
  REPORT_REQUEST_LIMITS,
  ReportRequestError,
  validateExecutiveReportRequest
} from '../../../domain/ai/report/reportRequest.js';
import { canonicalActualId } from '../../../domain/identity/actualId.js';
import { businessDate } from '../../../domain/calendar/businessDate.js';
import {
  ORGANIZATION_PATH_SEPARATOR,
  orgKeyFor,
  UNASSIGNED_DIRECTORATE,
  UNASSIGNED_DIRECTORATE_LABEL
} from '../../../domain/organization/organizationHierarchy.js';
import { getTrustedCurrentSicil } from '../../identity/currentUserProvider.js';
import { ServerPersistenceError } from '../../errors.js';
import { createAiDeadline } from '../aiDeadline.js';
import { createToolTurnContext } from '../tools/toolContext.js';
import { TOOL_ERROR_CODES, ToolError } from '../tools/toolErrors.js';
import { TOOL_LIMITS } from '../tools/toolLimits.js';
import { describeTaskScope, projectAccess } from '../tools/rota/rotaScope.js';
import {
  readReportActivitySummary,
  readReportDependencies,
  readReportProjectsBySelectors,
  readReportScopeRoster,
  readTaskFacts,
  readVisibleTasks,
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
 *   - Toplama başında ve sonunda yetki dönemi parmak izi (`authorizationEpoch`) ve görev görünürlük/proje
 *     bağı doğrulanır; toplama sırasında yetki veya proje bağı değiştiyse bayat paket asla döndürülmez.
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
  birim: Object.freeze({ field: 'unit', orgLevel: 'unit', rosterMode: 'org_unit', teamLevel: 'unit', sqlTeamLevel: TEAM_LEVELS.unit }),
  mudurluk: Object.freeze({ field: 'department', orgLevel: 'department', rosterMode: 'org_department', teamLevel: 'department', sqlTeamLevel: TEAM_LEVELS.department }),
  direktorluk: Object.freeze({ field: 'directorate', orgLevel: 'directorate', rosterMode: 'org_directorate', teamLevel: 'directorate', sqlTeamLevel: TEAM_LEVELS.directorate })
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

// `foldText` Türkçe diakritikleri kaldırdığından tam ekip takma adları normalleştirilmiş biçimde tutulur.
const FULL_TEAM_ALIASES = new Set(['ekibim', 'tum_ekip', 'tum ekip', 'team']);
const REPORT_SCOPE_ROSTER_MAX_ROWS = 500;
const REPORT_DEPENDENCIES_MAX_ROWS = 1000;
const SQL_INT_MAX = 2147483647;

function compareAscii(left, right) {
  const a = String(left ?? '');
  const b = String(right ?? '');
  return a < b ? -1 : (a > b ? 1 : 0);
}

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

/** Boş müdürlük taşıyan birimlerde de farklı direktörlük dallarını ayırt eden kanonik yol anahtarı. */
function canonicalOrgDisambiguationKey(member, orgLevel) {
  const dir = (member.directorate || '').trim() || UNASSIGNED_DIRECTORATE;
  const dept = (member.department || '').trim();
  const unit = (member.unit || '').trim();
  if (orgLevel === 'directorate') return dir;
  if (orgLevel === 'department') return `${dir}${ORGANIZATION_PATH_SEPARATOR}${dept}`;
  return `${dir}${ORGANIZATION_PATH_SEPARATOR}${dept}${ORGANIZATION_PATH_SEPARATOR}${unit}`;
}

/** Model-görünür kapsamlarda kontrol karakteri (\u001F) olmadan ve paket tavanı içinde okunur kurumsal yol etiketi üretir. */
function formatModelSafeOrgLabel(raw) {
  const joined = String(raw || '')
    .split(ORGANIZATION_PATH_SEPARATOR)
    .map((part) => (part === UNASSIGNED_DIRECTORATE ? UNASSIGNED_DIRECTORATE_LABEL : part))
    .filter((part) => part.length > 0)
    .join(' > ');
  return clampModelSafeLabel(joined, REPORT_REQUEST_LIMITS.maxOrgPathLength);
}

/** Model-görünür kapsam veya sorumlu etiketini paket sözleşmesindeki kod noktası sınırına kelepçeler. */
function clampModelSafeLabel(raw, maxLen = REPORT_REQUEST_LIMITS.maxIdentifierLength) {
  const text = String(raw || '').trim();
  if (!text) return '';
  if (text.length <= maxLen) return text;
  const chars = Array.from(text);
  if (chars.length <= maxLen) return text;
  return `${chars.slice(0, Math.max(1, maxLen - 1)).join('').trimEnd()}…`;
}

/** Bütçe geçersizleştirmelerini şema tavanlarına kelepçeler. */
function clampReportLimits(rawLimits = {}) {
  const clamp = (value, ceiling) => {
    if (value === undefined) return ceiling;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return ceiling;
    return Math.min(ceiling, Math.max(0, Math.trunc(numeric)));
  };
  return {
    maxEvidenceItems: clamp(rawLimits.maxEvidenceItems, REPORT_EVIDENCE_LIMITS.maxEvidenceItems),
    maxPackageChars: clamp(rawLimits.maxPackageChars, REPORT_EVIDENCE_LIMITS.maxPackageChars),
    maxNoteChars: clamp(rawLimits.maxNoteChars, REPORT_EVIDENCE_LIMITS.maxNoteChars),
    maxNoteAuditEvents: clamp(rawLimits.maxNoteAuditEvents, REPORT_EVIDENCE_LIMITS.maxNoteAuditEvents),
    maxSelectedTasks: clamp(rawLimits.maxSelectedTasks, REPORT_EVIDENCE_LIMITS.maxSelectedTasks),
    maxSelectedNotes: clamp(rawLimits.maxSelectedNotes, REPORT_EVIDENCE_LIMITS.maxSelectedNotes)
  };
}

/**
 * İstek kapsamını güvenilir oturumun yetkili sınırları içinde çözer.
 * Yetkisiz, kesik veya belirsiz proje, kişi, ekip ya da örgüt birimi seçimini kapalı reddeder.
 */
async function resolveAuthorizedScope({ turn, auth, scope, signal, normalizedRequest }) {
  const { tur, kimlikler } = normalizedRequest.kapsam;

  if (tur === 'proje' || tur === 'projeler') {
    signal.throwIfAborted();
    // 1–25 proje seçicisi tek sınırlı SQL sorgusuyla çözülür; seri sorgu patlaması oluşmaz.
    const candidateRows = await turn.sql(signal, (executor) => readReportProjectsBySelectors(executor, scope, kimlikler));
    const bySelectorIndex = new Map();
    for (const row of candidateRows) {
      const idx = Number(row.SelectorIndex);
      if (!bySelectorIndex.has(idx)) bySelectorIndex.set(idx, []);
      bySelectorIndex.get(idx).push(row);
    }

    const resolvedProjects = [];
    const seenIds = new Set();
    for (let index = 0; index < kimlikler.length; index += 1) {
      const rawId = kimlikler[index];
      const matches = bySelectorIndex.get(index) || [];
      const guid = canonicalActualId(rawId);
      let matched = null;
      if (guid) {
        matched = matches.find((row) => canonicalActualId(row.ProjectId) === guid) || null;
      } else {
        const folded = foldText(rawId);
        const exactCode = matches.filter((row) => row.ProjectCode && foldText(row.ProjectCode) === folded);
        if (exactCode.length === 1) {
          matched = exactCode[0];
        } else if (exactCode.length > 1) {
          throw new ToolError(TOOL_ERROR_CODES.INVALID_ARGUMENTS, {
            message: 'Seçilen proje kodu birden fazla yetkili projeyle eşleşiyor; kesin proje kimliği belirtilmelidir.'
          });
        } else {
          const exactName = matches.filter((row) => row.ProjectName && foldText(row.ProjectName) === folded);
          if (exactName.length === 1) {
            matched = exactName[0];
          } else if (exactName.length > 1) {
            throw new ToolError(TOOL_ERROR_CODES.INVALID_ARGUMENTS, {
              message: 'Seçilen proje adı birden fazla yetkili projeyle eşleşiyor; proje kodu veya kimliği belirtilmelidir.'
            });
          }
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

  // Yetki ön denetimi: ekip ve kurumsal kapsamlar yetkili olmayan kullanıcılar için kadro okumadan reddedilir.
  if (tur === 'ekip' && !auth.isExecutive) {
    throw new ToolError(TOOL_ERROR_CODES.UNSUPPORTED_SCOPE, {
      message: 'Ekip kapsamı yalnızca yönetim kapsamı olan kullanıcılara açıktır.'
    });
  }
  if (ORG_LEVEL_META[tur] && !auth.isExecutive && !auth.isSystemAdmin) {
    throw new ToolError(TOOL_ERROR_CODES.UNSUPPORTED_SCOPE, {
      message: 'Kurumsal birim, müdürlük ve direktörlük raporları yalnızca yetkili yöneticilere açıktır.'
    });
  }

  const requested = kimlikler[0];
  const folded = foldText(requested);
  const numericPersonMatch = (() => {
    if (tur !== 'kisi' || !/^\d+$/u.test(requested)) return null;
    const num = Number(requested);
    if (!Number.isSafeInteger(num) || num < 1 || num > SQL_INT_MAX) {
      throw new ToolError(TOOL_ERROR_CODES.UNSUPPORTED_SCOPE, {
        message: 'Seçilen kişi yetkili kapsamınızda bulunmuyor.'
      });
    }
    return num;
  })();

  const isCanonicalOrgSelector = ORG_LEVEL_META[tur]
    ? (requested.includes(ORGANIZATION_PATH_SEPARATOR) || (tur === 'direktorluk' && requested === UNASSIGNED_DIRECTORATE))
    : false;

  const rosterQuery = (() => {
    if (tur === 'kisi') {
      return numericPersonMatch != null
        ? { mode: 'person_sicil', includeSelf: true, rosterSicil: numericPersonMatch }
        : { mode: 'person_name', includeSelf: true, text: requested };
    }
    if (tur === 'ekip') {
      const requestedLevel = Object.hasOwn(TEAM_LEVEL_ALIASES, folded) ? TEAM_LEVEL_ALIASES[folded] : null;
      if (requestedLevel) return { mode: 'team_level', includeSelf: false, scopeType: requestedLevel };
      if (FULL_TEAM_ALIASES.has(folded)) return { mode: 'all', includeSelf: false };
      return { mode: 'team_name', includeSelf: false, text: requested };
    }
    const meta = ORG_LEVEL_META[tur];
    return {
      mode: meta.rosterMode,
      includeSelf: Boolean(auth.isSystemAdmin),
      text: isCanonicalOrgSelector ? '' : requested,
      hierarchyKey: isCanonicalOrgSelector ? requested : ''
    };
  })();

  // Seçici süzgeci satır sınırından ÖNCE SQL'de uygulanır; kesik kadro üzerinden kapsam çözülmez (kapalı ret).
  const rosterResult = await turn.sql(signal, (executor) => readReportScopeRoster(executor, scope, {
    maxRows: REPORT_SCOPE_ROSTER_MAX_ROWS,
    ...rosterQuery
  }));
  if (rosterResult.truncated) {
    throw new ToolError(TOOL_ERROR_CODES.RESULT_TOO_LARGE, {
      message: 'Seçilen kapsamdaki yetkili kadro desteklenen analiz sınırını aşıyor.'
    });
  }
  const members = rosterResult.members;

  if (tur === 'kisi') {
    let target = null;
    if (numericPersonMatch != null) {
      target = members.find((member) => member.sicil === numericPersonMatch) || null;
    } else {
      const uniqueMatches = [...new Map(
        members
          .filter((member) => member.name && foldText(member.name) === folded)
          .map((member) => [member.sicil, member])
      ).values()];
      if (uniqueMatches.length > 1) {
        throw new ToolError(TOOL_ERROR_CODES.INVALID_ARGUMENTS, {
          message: 'Seçilen kişi adı yetkili kapsamda birden fazla çalışanla eşleşiyor; benzersiz seçici belirtilmelidir.'
        });
      }
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
      scopeSummary: null
    };
  }

  if (tur === 'ekip') {
    const managed = members.filter((member) => member.sicil !== Number(auth.sicil) && member.scopeType !== 'SELF');
    const requestedLevel = Object.hasOwn(TEAM_LEVEL_ALIASES, folded) ? TEAM_LEVEL_ALIASES[folded] : null;
    let matchedMembers;
    if (requestedLevel || FULL_TEAM_ALIASES.has(folded)) {
      matchedMembers = managed;
    } else {
      const teamMatches = managed.filter((member) => member.team && foldText(member.team) === folded);
      const unitMatches = managed.filter((member) => member.unit && foldText(member.unit) === folded);
      if (teamMatches.length > 0) {
        matchedMembers = teamMatches;
      } else {
        const distinctUnitKeys = new Set(unitMatches.map((member) => canonicalOrgDisambiguationKey(member, 'unit')));
        if (distinctUnitKeys.size > 1) {
          throw new ToolError(TOOL_ERROR_CODES.INVALID_ARGUMENTS, {
            message: 'Seçilen ekip/birim adı birden fazla hiyerarşik dal ile eşleşiyor; kapsam türü "birim" seçilerek tam kurumsal yol anahtarı belirtilmelidir.'
          });
        }
        matchedMembers = unitMatches;
      }
    }
    const allowedSicils = new Set(matchedMembers.map((member) => member.sicil));
    if (allowedSicils.size === 0) {
      throw new ToolError(TOOL_ERROR_CODES.UNSUPPORTED_SCOPE, {
        message: 'Seçilen ekip yetkili yönetim kapsamınızda bulunamadı.'
      });
    }
    return {
      tur,
      projectIds: [],
      resolvedProjects: [],
      assigneeMode: 'team',
      personSicil: null,
      teamLevel: requestedLevel,
      allowedAssigneeSicils: allowedSicils,
      teamLabel: requested,
      scopeSummary: null
    };
  }

  // Kurumsal kapsamlar: birim, mudurluk, direktorluk
  const meta = ORG_LEVEL_META[tur];
  const candidatePool = auth.isSystemAdmin
    ? members
    : members.filter((member) => member.sicil !== Number(auth.sicil) && member.scopeType !== 'SELF');

  const matchedMembers = candidatePool.filter((member) => {
    const hierarchyKey = orgKeyFor(formatOrgMemberForHierarchy(member), meta.orgLevel);
    const fullKey = canonicalOrgDisambiguationKey(member, meta.orgLevel);
    if (isCanonicalOrgSelector) return hierarchyKey === requested || fullKey === requested;
    const plainValue = member[meta.field] || '';
    return hierarchyKey === requested || fullKey === requested || (plainValue && foldText(plainValue) === folded);
  });
  const allowedSicils = new Set(matchedMembers.map((member) => member.sicil));
  if (allowedSicils.size === 0) {
    throw new ToolError(TOOL_ERROR_CODES.UNSUPPORTED_SCOPE, {
      message: 'Seçilen kurumsal kapsam yetkili yönetim sınırlarınızda bulunamadı.'
    });
  }

  // Aynı ada sahip farklı hiyerarşik dallar (boş müdürlüklü birimler dâhil) sessizce birleştirilmez; belirsizlik kapalı reddedilir.
  const distinctKeys = new Set(matchedMembers.map((member) => canonicalOrgDisambiguationKey(member, meta.orgLevel)));
  if (distinctKeys.size > 1) {
    throw new ToolError(TOOL_ERROR_CODES.INVALID_ARGUMENTS, {
      message: 'Seçilen kurumsal birim adı birden fazla hiyerarşik dal ile eşleşiyor; tam yol anahtarı belirtilmelidir.'
    });
  }

  return {
    tur,
    projectIds: [],
    resolvedProjects: [],
    assigneeMode: auth.isSystemAdmin ? 'any' : 'team',
    personSicil: null,
    teamLevel: null,
    allowedAssigneeSicils: allowedSicils,
    orgUnitLabel: formatModelSafeOrgLabel(requested),
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
  activeTaskLastDay = new Map(),
  auditCompletedDayByTaskId = new Map(),
  completedInPeriodIds = new Set(),
  dependencyMap
}) {
  const scored = tasks.map((task) => {
    const completedInPeriod = completedInPeriodIds.has(task.id);
    // Gelecek tarihli gerçekleşen bitişler temizlense de ham alanı doludur; tarihsiz tamamlanan önceliği almaz.
    const undatedDone = task.status === 'done' && !(task._rawActualFinish ?? task.actualFinish);
    const activeInPeriod = activeTaskIds.has(task.id);
    const openCritical = task.status !== 'done' && task.priority === 'critical';
    const overdue = isOverdue(task, today);
    const dueSoon = isDueWithin(task, today, 7);
    const deps = dependencyMap.get(task.id);
    const hasDependencies = Boolean(deps && (deps.oncul.length > 0 || deps.ardil.length > 0));

    // Katman 1: Dönem ilgisi (0..3) — açık kritik görevler belgelenmiş 1. kademede yer alır.
    const periodRelevance = completedInPeriod
      ? 3
      : (task.status !== 'done' && activeInPeriod)
        ? 2
        : (undatedDone || openCritical || overdue || dueSoon || task.milestone || activeInPeriod)
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

    // Katman 3: Yenilik (tamamlananlarda nitelikli dönem tamamlama günü; hareketlilerde son hareket günü)
    const inPeriodFinish = task.actualFinish && task.actualFinish >= period.baslangic && task.actualFinish <= period.bitis
      ? task.actualFinish
      : null;
    const recencyDay = completedInPeriod
      ? (inPeriodFinish || auditCompletedDayByTaskId.get(task.id) || activeTaskLastDay.get(task.id) || period.bitis)
      : (activeInPeriod ? (activeTaskLastDay.get(task.id) || period.bitis) : (task.targetFinish || '0000-00-00'));

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
    || compareAscii(right._recencyDay, left._recencyDay)
    || compareAscii(left.projectId, right.projectId)
    || compareAscii(left.id, right.id)
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
  period,
  limits,
  buildDerivedFindings,
  noteCompleteness,
  scopeSummary,
  activityCoverage,
  dependencyCoverage = 'complete',
  dependencyTruncated = false,
  undatedDoneCount,
  totalEligibleTasks,
  taskReadTruncated = false,
  rosterTruncated = false,
  snapshotConsistent = true,
  lastReopenAtByTaskId = new Map(),
  lastTargetFinishChangeByTaskId = new Map()
}) {
  const maxItems = limits.maxEvidenceItems ?? REPORT_EVIDENCE_LIMITS.maxEvidenceItems;
  const maxChars = limits.maxPackageChars ?? REPORT_EVIDENCE_LIMITS.maxPackageChars;

  // Çekirdek ölçüler (toplamlar ve paydalar) asla düşürülmez; diğer kanıtlar öncelik sırasıyla sığdırılır.
  const fixed = [
    ...coreMetrics,
    ...(activitySummaryItem ? [activitySummaryItem] : [])
  ];
  if (fixed.length > maxItems) {
    throw new ToolError(TOOL_ERROR_CODES.LIMIT_EXCEEDED, {
      message: 'Yapılandırılan kanıt sayısı sınırı zorunlu çekirdek ölçüleri barındırmaya yetmiyor.'
    });
  }

  // Notlar bütçe kırpılırken seçim önceliği (_selectionOrder) sırasıyla tutulur; yalnızca pakette
  // kalan notlar son montajda kronolojik sunum sırasına dizilir.
  const notesBySelectionPriority = [...noteCandidates].sort((left, right) => (
    (left._selectionOrder ?? 0) - (right._selectionOrder ?? 0)
  ));

  // Çok projeli dar bütçelerde proje kırılım ölçüleri en öncelikli görevleri tamamen aç bırakmaz.
  const reservedTopTasks = Math.min(taskCandidates.length, 5);
  const droppable = [
    ...taskCandidates.slice(0, reservedTopTasks),
    ...secondaryMetrics,
    ...taskCandidates.slice(reservedTopTasks),
    ...notesBySelectionPriority
  ];
  const allNoteTaskIds = new Set(noteCandidates.map((n) => n._taskId).filter(Boolean));

  // Paket kurulumundan önce görev seçim sınırıyla dışarıda bırakılan görevler çift sayılmadan toplama eklenir.
  const preAssemblyOmittedTasks = Math.max(0, totalEligibleTasks - taskCandidates.length);

  const initialAllowedDroppable = Math.max(0, maxItems - fixed.length);
  const retainedDroppable = droppable.slice(0, initialAllowedDroppable);
  const droppedByItemCap = Math.max(0, droppable.length - retainedDroppable.length);

  const assemble = (activeDroppable, omittedBudgetCount) => {
    // Pakette kalan öğeleri tür düzenine yerleştir: ikincil ölçüler → görevler → kronolojik notlar.
    const retainedSecondary = activeDroppable.filter((item) => item.tur === 'olcu');
    const retainedTasks = activeDroppable.filter((item) => item.tur === 'gorev');
    const retainedNotes = activeDroppable
      .filter((item) => item.tur === 'not')
      .sort((left, right) => {
        if ((left._taskPriorityRank ?? 0) !== (right._taskPriorityRank ?? 0)) {
          return (left._taskPriorityRank ?? 0) - (right._taskPriorityRank ?? 0);
        }
        if (left._taskId === right._taskId) {
          return (left.surum_sira ?? 0) - (right.surum_sira ?? 0);
        }
        return compareAscii(left._taskId, right._taskId);
      });

    const retainedNoteTaskIds = new Set(retainedNotes.map((n) => n._taskId).filter(Boolean));
    const rawItems = [...fixed, ...retainedSecondary, ...retainedTasks, ...retainedNotes];
    const taskEvidenceIdByTaskId = new Map();
    const metricIdByKey = new Map();
    const internalNotes = [];
    const publicItems = [];

    for (let index = 0; index < rawItems.length; index += 1) {
      const id = `E${index + 1}`;
      const raw = rawItems[index];
      const {
        _kind, _metricKey, _taskId, _projectId, _auditId, _dedupeKey,
        _versionIdentity, _precededByGap, _taskPriorityRank, _selectionOrder, ...clean
      } = raw;
      const item = { id, ...clean };
      if (item.tur === 'gorev' && _taskId) {
        taskEvidenceIdByTaskId.set(_taskId, id);
        if (noteCompleteness.riza && allNoteTaskIds.has(_taskId) && !retainedNoteTaskIds.has(_taskId)) {
          item.notlar_dusuruldu = true;
        }
      }
      if (_metricKey) metricIdByKey.set(_metricKey, id);
      if (item.tur === 'not') {
        internalNotes.push({ ...item, _taskId, _projectId, _auditId, _versionIdentity, _precededByGap });
      }
      publicItems.push(item);
    }

    // Çelişki ve yinelemeleri yalnızca pakette kalan kanıt kimlikleri üzerinden hesapla.
    const contradictions = detectNoteDuplicatesAndContradictions({
      noteEntries: internalNotes,
      taskById,
      taskEvidenceIdByTaskId,
      today,
      period,
      lastReopenAtByTaskId,
      lastTargetFinishChangeByTaskId
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
    const totalOmitted = omittedBudgetCount + preAssemblyOmittedTasks + noteCompleteness.disarida_kalan;
    const factsComplete = !taskReadTruncated && !rosterTruncated;
    const noteAuditIncomplete = Boolean(noteCompleteness.denetim_kesik || (noteCompleteness.riza && !factsComplete));
    const effectiveNotesWithoutTasks = factsComplete ? noteCompleteness.notsuz_gorev : null;
    const truncated = omittedBudgetCount > 0 || omittedTasks > 0 || omittedNotes > 0
      || noteAuditIncomplete || !factsComplete || dependencyTruncated;

    const pkg = {
      sema: REPORT_EVIDENCE_SCHEMA,
      istek: baseMeta.istek,
      veri_ani: baseMeta.veri_ani,
      kanitlar: publicItems,
      turetilmis: derived,
      tamlik: {
        kapsam_gorunurlugu: scopeSummary.completeProjectView && factsComplete && snapshotConsistent ? 'complete' : 'partial',
        projeler: {
          tam: scopeSummary.projects.full,
          okuma: scopeSummary.projects.read,
          kismi: scopeSummary.projects.partial
        },
        gorevler: {
          toplam_uygun: totalEligibleTasks,
          dahil: includedTasks,
          disarida_kalan: omittedTasks,
          kesildi: omittedTasks > 0 || !factsComplete
        },
        notlar: noteCompleteness.riza
          ? (omittedNotes > 0
            ? `${includedNotes > 0 ? `ilk ${includedNotes} not` : '0 not'} (${omittedNotes} not sınır nedeniyle dışarıda)${effectiveNotesWithoutTasks != null && effectiveNotesWithoutTasks > 0 ? `; ${effectiveNotesWithoutTasks} görev notsuz` : ''}${noteAuditIncomplete ? '; denetim/not okuması kesik veya eksik' : ''}`
            : noteCompleteness.metin)
          : 'hariç (rıza yok)',
        not_ozeti: {
          riza: noteCompleteness.riza,
          dahil: includedNotes,
          disarida_kalan: omittedNotes,
          notsuz_gorev: effectiveNotesWithoutTasks,
          kirpilan: publicItems.filter((item) => item.tur === 'not' && item.kirpildi).length,
          denetim_kesik: noteAuditIncomplete
        },
        hareket: activityCoverage,
        bagimliliklar: dependencyCoverage,
        ...(snapshotConsistent ? {} : { kesit_tutarli: false }),
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

    // Gerçek serileştirilmiş uzunluğu basamak artışı dâhil sabit noktaya yakınsa.
    let serialized = JSON.stringify(pkg);
    for (let attempt = 0; attempt < 8 && pkg.tamlik.karakter_sayisi !== serialized.length; attempt += 1) {
      pkg.tamlik.karakter_sayisi = serialized.length;
      serialized = JSON.stringify(pkg);
    }
    if (pkg.tamlik.karakter_sayisi !== serialized.length) {
      throw new ServerPersistenceError('MUTATION_FAILED', 'Kanıt paketi serileştirilmiş karakter sayısı tutarlılaştırılamadı.');
    }
    return { pkg, serializedLength: serialized.length };
  };

  const buildForPrefix = (keepCount) => assemble(
    retainedDroppable.slice(0, keepCount),
    droppedByItemCap + (retainedDroppable.length - keepCount)
  );

  let built = buildForPrefix(retainedDroppable.length);

  // Serileştirilmiş boyut karakter sınırını aşıyorsa sığan EN UZUN öncelikli öneki ikili aramayla bul.
  if (built.serializedLength > maxChars) {
    const emptyBuilt = buildForPrefix(0);
    if (emptyBuilt.serializedLength > maxChars) {
      throw new ToolError(TOOL_ERROR_CODES.LIMIT_EXCEEDED, {
        message: 'Yapılandırılan karakter sınırı zorunlu çekirdek kanıt paketini barındırmaya yetmiyor.'
      });
    }
    let low = 0;
    let high = retainedDroppable.length;
    let best = emptyBuilt;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      const candidate = buildForPrefix(mid);
      if (candidate.serializedLength <= maxChars) {
        low = mid;
        best = candidate;
      } else {
        high = mid - 1;
      }
    }
    built = best;
  }

  if (built.pkg.kanitlar.length > maxItems || built.serializedLength > maxChars) {
    throw new ToolError(TOOL_ERROR_CODES.LIMIT_EXCEEDED, {
      message: 'Kanıt paketi yapılandırılan boyut sınırlarına sığdırılamadı.'
    });
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
  // Önceden iptal edilmiş istek hiçbir doğrulama, kimlik veya SQL okuması başlatmaz.
  signal?.throwIfAborted?.();

  // 1. Önce veri anını doğrula ve rapor isteğini (dönem, karşılaştırma, kapsam biçimi, rıza) SQL'e gitmeden doğrula.
  const effectiveLimits = clampReportLimits(limits);
  const cutOffDate = normalizeReportNow(now);
  const cutOffMs = cutOffDate.getTime();
  const snapshotDay = businessDate(cutOffDate);
  const resolvedToday = today ?? snapshotDay;
  const normalizedRequest = validateExecutiveReportRequest(request, { now: cutOffDate, today: resolvedToday });
  const veriAni = formatIstanbulTimestamp(cutOffDate);
  const consentAtStart = normalizedRequest.notlar;

  // 2. Güvenilir oturum kimliğini yalnızca sunucu oturum sağlayıcısından çöz; uyuşmayan dış Sicil kapalı reddedilir.
  const trustedSicil = await getTrustedCurrentSicil();
  if (!Number.isSafeInteger(trustedSicil) || trustedSicil <= 0) {
    throw new ServerPersistenceError('UNAUTHORIZED', 'Geçerli oturum kimliği doğrulanamadı.');
  }
  if (sicil != null && Number(sicil) !== trustedSicil) {
    throw new ServerPersistenceError('UNAUTHORIZED', 'Oturum kimliği ile uyuşmayan Sicil parametresi reddedildi.');
  }

  const effectiveToolLimits = { ...TOOL_LIMITS, ...toolLimits };
  const deadline = createAiDeadline({
    timeoutMs: effectiveToolLimits.maxToolPhaseMs,
    parentSignal: signal,
    now: clock
  });
  const effectiveSignal = deadline.signal;

  const turn = createToolTurnContext({
    sicil: trustedSicil,
    now: cutOffDate,
    limits: effectiveToolLimits,
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

    // 4. Kapsamdaki yetkili görev olgularını seçili sorumlu kümesi ve oluşturma kesiti SQL sınırından ÖNCE uygulanarak oku.
    const needsAssignees = resolvedScope.allowedAssigneeSicils != null || ['kisi', 'ekip', 'birim', 'mudurluk', 'direktorluk'].includes(resolvedScope.tur);
    const selectedAssigneeList = resolvedScope.allowedAssigneeSicils ? [...resolvedScope.allowedAssigneeSicils] : [];
    const teamRosterLimit = resolvedScope.assigneeMode === 'team'
      ? Math.min(REPORT_SCOPE_ROSTER_MAX_ROWS, Math.max(TEAM_ROSTER_LIMIT, selectedAssigneeList.length + 1))
      : 0;
    taskFactsResult = await turn.sql(effectiveSignal, (executor) => readTaskFacts(executor, scope, {
      projectId: resolvedScope.projectIds.length === 1 ? resolvedScope.projectIds[0] : null,
      projectIds: resolvedScope.projectIds.length > 1 ? resolvedScope.projectIds : [],
      assigneeMode: resolvedScope.assigneeMode,
      personSicil: resolvedScope.personSicil,
      teamLevel: resolvedScope.teamLevel,
      assigneeSicils: selectedAssigneeList,
      // `notlar: haric` iken MR_Tasks.Description üzerinde PATINDEX taraması çalıştırılmaz.
      includeHasDescription: consentAtStart === 'dahil',
      withAssignees: needsAssignees,
      rosterRows: teamRosterLimit,
      today: snapshotDay,
      cutOffUtc: cutOffDate,
      maxRows: effectiveToolLimits.maxAnalyzedTasks
    }));
    effectiveSignal.throwIfAborted();

    // Veri kesiti (veri_ani) sonrasındaki oluşturmaları dışla; kesit sonrası güncellenen satırları işaretle.
    const dedupedTasks = new Map();
    let postCutoffModifiedCount = 0;
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
        const modifiedAfterCutoff = Boolean(fact.updatedAt && Date.parse(fact.updatedAt) > cutOffMs);
        if (modifiedAfterCutoff) postCutoffModifiedCount += 1;
        // Gelecek tarihli ActualFinish "tarihsiz tamamlanan" sayılmaz; ham değer ayrı korunur.
        const rawActualFinish = fact.actualFinish || null;
        const futureActualFinish = Boolean(rawActualFinish && rawActualFinish > snapshotDay);
        const effectiveActualFinish = rawActualFinish && !futureActualFinish
          && !(modifiedAfterCutoff && rawActualFinish === snapshotDay)
          ? rawActualFinish
          : null;
        dedupedTasks.set(fact.id, {
          ...fact,
          actualFinish: effectiveActualFinish,
          _rawActualFinish: rawActualFinish,
          _futureActualFinish: futureActualFinish,
          _postCutoffModified: modifiedAfterCutoff
        });
      }
    }
    const visibleTasks = [...dedupedTasks.values()];
    const taskById = new Map(visibleTasks.map((task) => [task.id, task]));

    // Açık proje seçiminde görevsiz yetkili projeler de korunur; proje dışı kapsamlarda yalnızca görev projeleri alınır.
    const relevantProjectRows = resolvedScope.projectIds.length > 0
      ? resolvedScope.resolvedProjects
      : (() => {
        const taskProjectIds = new Set(visibleTasks.map((task) => task.projectId));
        return taskFactsResult.projects.filter((row) => taskProjectIds.has(canonicalActualId(row.ProjectId)));
      })();
    const projects = projectIndex(relevantProjectRows);
    const effectiveScopeSummary = resolvedScope.scopeSummary
      || describeTaskScope(relevantProjectRows, { emptyComplete: scope.isAdmin || [...scope.projects.values()].every((entry) => entry.accessLevel === 'FULL' || entry.readGrant) });
    const requestedProjectIdSet = new Set(resolvedScope.projectIds);

    // 5. Dönem hareket özetini tek sınırlı toplu sorguyla oku (ham not/JSON metni dönmez; silinen görevler dâhil tekilleştirilir).
    const periodActivityAgg = await turn.sql(effectiveSignal, (executor) => readReportActivitySummary(
      executor,
      scope,
      {
        from: normalizedRequest.donem.baslangic,
        to: normalizedRequest.donem.bitis,
        projectIds: resolvedScope.projectIds,
        assigneeSicils: selectedAssigneeList,
        cutOffUtc: cutOffDate,
        analyzedActivityLimit: effectiveToolLimits.maxAnalyzedActivities
      }
    ));
    effectiveSignal.throwIfAborted();

    const activeTaskIds = new Set();
    const activeTaskLastDay = new Map();
    const auditCompletedInPeriodIds = new Set();
    const auditCompletedDayByTaskId = new Map();
    const auditCompletedProjectByTaskId = new Map();
    const movedOutCompletedInPeriod = new Map();
    const lastReopenAtByTaskId = new Map();
    const lastTargetFinishChangeByTaskId = new Map();
    const activityLiveTasksForRevalidation = new Map();
    let activityAssigneeDiverged = false;

    const recordLatestAuditEvent = (map, taskId, occurredIso, auditId = null) => {
      if (!taskId || !occurredIso) return;
      const nextMs = Date.parse(occurredIso);
      if (!Number.isFinite(nextMs)) return;
      const nextAuditId = Number.isFinite(Number(auditId)) ? Number(auditId) : null;
      const prev = map.get(taskId);
      if (!prev) {
        map.set(taskId, { occurredAt: occurredIso, auditId: nextAuditId });
        return;
      }
      const prevMs = Date.parse(prev.occurredAt);
      if (nextMs > prevMs || (nextMs === prevMs && nextAuditId != null && (prev.auditId == null || nextAuditId > prev.auditId))) {
        map.set(taskId, { occurredAt: occurredIso, auditId: nextAuditId });
      }
    };

    const hasCompletionAuditByTaskId = new Set();
    for (const transition of taskFactsResult.taskAuditTransitions || []) {
      if (!transition?.taskId) continue;
      if (transition.lastCompletedAuditAt) hasCompletionAuditByTaskId.add(transition.taskId);
      if (transition.lastReopenAt) {
        recordLatestAuditEvent(lastReopenAtByTaskId, transition.taskId, transition.lastReopenAt, transition.lastReopenAuditId);
      }
      if (transition.lastTargetFinishChangeAt) {
        recordLatestAuditEvent(lastTargetFinishChangeByTaskId, transition.taskId, transition.lastTargetFinishChangeAt, transition.lastTargetFinishChangeAuditId);
      }
    }

    const registerRevalidationTask = (taskId, projectId) => {
      if (!taskId || !projectId) return;
      const existing = activityLiveTasksForRevalidation.get(taskId);
      if (existing && existing !== projectId) {
        throw new ServerPersistenceError(
          'AUTHORIZATION_CHANGED',
          'Kanıt toplama sırasında görev proje bağı çelişkili gözlendiği için kanıt paketi geçersiz kılındı.'
        );
      }
      activityLiveTasksForRevalidation.set(taskId, projectId);
    };

    for (const ref of periodActivityAgg.liveTasks || []) {
      if (!ref?.taskId) continue;
      registerRevalidationTask(ref.taskId, ref.projectId);
      recordLatestAuditEvent(lastReopenAtByTaskId, ref.taskId, ref.lastReopenAt, ref.lastReopenAuditId);
      if (!taskById.has(ref.taskId)) {
        // Proje kapsamlı raporda seçili projeden yetkili başka projeye taşınan canlı görevler ayrışma değildir.
        const movedOutOfSelectedProjects = resolvedScope.projectIds.length > 0
          && Boolean(ref.projectId)
          && !requestedProjectIdSet.has(ref.projectId);
        const movedOutProjectCompletion = movedOutOfSelectedProjects
          && ref.completedInPeriod
          && Boolean(ref.completedProjectId && requestedProjectIdSet.has(ref.completedProjectId));
        if (movedOutProjectCompletion) {
          movedOutCompletedInPeriod.set(ref.taskId, ref.completedProjectId);
        } else if (!movedOutOfSelectedProjects && !taskFactsResult.truncated) {
          activityAssigneeDiverged = true;
        }
        continue;
      }
      activeTaskIds.add(ref.taskId);
      if (ref.lastActivityDay) {
        const prev = activeTaskLastDay.get(ref.taskId);
        if (!prev || ref.lastActivityDay > prev) activeTaskLastDay.set(ref.taskId, ref.lastActivityDay);
      }
      if (ref.completedInPeriod) {
        auditCompletedInPeriodIds.add(ref.taskId);
        if (ref.completedInPeriodDay) {
          const prevDay = auditCompletedDayByTaskId.get(ref.taskId);
          if (!prevDay || ref.completedInPeriodDay > prevDay) {
            auditCompletedDayByTaskId.set(ref.taskId, ref.completedInPeriodDay);
          }
        }
        if (ref.completedProjectId) {
          auditCompletedProjectByTaskId.set(ref.taskId, ref.completedProjectId);
        }
      }
    }

    const periodActivitySummary = {
      events: periodActivityAgg.events,
      tasks: periodActivityAgg.tasks,
      completed: periodActivityAgg.completed,
      deletedCompleted: periodActivityAgg.deletedCompleted || 0,
      created: periodActivityAgg.created,
      deleted: periodActivityAgg.deleted,
      reopened: periodActivityAgg.reopened,
      updatedOnly: periodActivityAgg.updatedOnly
    };

    // Karşılaştırma dönemi istendiyse yeniden açılmış, taşınmış ve silinmiş tarihsel tamamlamaları yakalamak için hareket özeti de okunur.
    const auditCompletedInComparisonIds = new Set();
    const movedOutCompletedInComparison = new Set();
    let comparisonDeletedCompleted = 0;
    let comparisonActivityDiverged = false;
    let compActivityAgg = null;
    if (normalizedRequest.karsilastirma !== 'yok' && normalizedRequest.karsilastirma_donemi) {
      compActivityAgg = await turn.sql(effectiveSignal, (executor) => readReportActivitySummary(
        executor,
        scope,
        {
          from: normalizedRequest.karsilastirma_donemi.baslangic,
          to: normalizedRequest.karsilastirma_donemi.bitis,
          projectIds: resolvedScope.projectIds,
          assigneeSicils: selectedAssigneeList,
          cutOffUtc: cutOffDate,
          analyzedActivityLimit: effectiveToolLimits.maxAnalyzedActivities
        }
      ));
      effectiveSignal.throwIfAborted();
      comparisonDeletedCompleted = compActivityAgg.deletedCompleted || 0;
      for (const ref of compActivityAgg.liveTasks || []) {
        if (!ref?.taskId) continue;
        registerRevalidationTask(ref.taskId, ref.projectId);
        recordLatestAuditEvent(lastReopenAtByTaskId, ref.taskId, ref.lastReopenAt, ref.lastReopenAuditId);
        if (!taskById.has(ref.taskId)) {
          const movedOutOfSelectedProjects = resolvedScope.projectIds.length > 0
            && Boolean(ref.projectId)
            && !requestedProjectIdSet.has(ref.projectId);
          const movedOutProjectCompletion = movedOutOfSelectedProjects
            && ref.completedInPeriod
            && Boolean(ref.completedProjectId && requestedProjectIdSet.has(ref.completedProjectId));
          if (movedOutProjectCompletion) {
            movedOutCompletedInComparison.add(ref.taskId);
          } else if (!movedOutOfSelectedProjects && !taskFactsResult.truncated) {
            comparisonActivityDiverged = true;
          }
          continue;
        }
        if (ref.completedInPeriod) {
          auditCompletedInComparisonIds.add(ref.taskId);
        }
      }
    }

    // Kesit sonrası silme, seçili projeden çıkma veya hareket okumasında gözlenen kesit sonrası silme anlık görüntüyü kısmi kılar.
    const hasPostCutoffScopeLoss = Boolean(
      taskFactsResult.hasPostCutoffDeletion
      || taskFactsResult.hasPostCutoffScopeMove
      || periodActivityAgg.hasPostCutoffDeletion
      || compActivityAgg?.hasPostCutoffDeletion
    );
    const snapshotConsistent = postCutoffModifiedCount === 0 && !hasPostCutoffScopeLoss;
    const rosterTruncated = taskFactsResult.roster?.truncated === true;
    const factsComplete = !taskFactsResult.truncated && !rosterTruncated;

    // 6. Bağımlılıkları YALNIZCA FULL erişimli projeler için tek toplu sorguda oku (READ ve PARTIAL projelerde asla okunmaz).
    const dependencyMap = new Map();
    const fullProjectIds = [...projects.values()]
      .filter((project) => project.accessLevel === 'FULL')
      .map((project) => project.projectId);
    const fullProjectIdSet = new Set(fullProjectIds);
    let dependencyTruncated = false;
    let droppedDependencyEdges = 0;
    if (fullProjectIds.length > 0) {
      effectiveSignal.throwIfAborted();
      // Kişi/ekip/örgüt kapsamlarında bağımlılık sorgusu satır sınırından ÖNCE görünür görevlere daraltılır.
      const scopedDependencyTaskIds = resolvedScope.projectIds.length === 0
        ? visibleTasks.filter((task) => fullProjectIdSet.has(task.projectId)).map((task) => task.id)
        : [];
      const depResult = await turn.sql(effectiveSignal, (executor) => readReportDependencies(executor, scope, {
        projectIds: fullProjectIds,
        taskIds: scopedDependencyTaskIds,
        maxRows: REPORT_DEPENDENCIES_MAX_ROWS
      }));
      dependencyTruncated = Boolean(depResult.truncated);
      for (const row of depResult.dependencies || []) {
        const taskId = canonicalActualId(row.TaskId);
        const predId = canonicalActualId(row.PredecessorTaskId);
        if (!taskId || !predId || !taskById.has(taskId) || !taskById.has(predId)) {
          droppedDependencyEdges += 1;
          continue;
        }
        if (!dependencyMap.has(taskId)) dependencyMap.set(taskId, { oncul: [], ardil: [] });
        if (!dependencyMap.has(predId)) dependencyMap.set(predId, { oncul: [], ardil: [] });
        dependencyMap.get(taskId).oncul.push(predId);
        dependencyMap.get(predId).ardil.push(taskId);
      }
    }
    const dependencyCoverage = (
      dependencyTruncated
      || droppedDependencyEdges > 0
      || Boolean(taskFactsResult.truncated)
      || rosterTruncated
      || fullProjectIds.length < projects.size
      || !effectiveScopeSummary.completeProjectView
    )
      ? 'partial'
      : 'complete';

    // 7. Dönemde tamamlanan görev kimlikleri: denetim tamamlama geçişi varsa dönem ataması yalnızca denetim olayından gelir;
    // denetim tamamlama kaydı olmayan görevlerde gerçekleşen bitiş yedek olarak kullanılır (karşılaştırma seçiminden bağımsız).
    const completedInPeriodIds = new Set();
    for (const task of visibleTasks) {
      const doneByActualFinish = !task._postCutoffModified
        && !hasCompletionAuditByTaskId.has(task.id)
        && task.status === 'done'
        && Boolean(task.actualFinish)
        && task.actualFinish >= normalizedRequest.donem.baslangic
        && task.actualFinish <= normalizedRequest.donem.bitis;
      if (doneByActualFinish || auditCompletedInPeriodIds.has(task.id)) {
        completedInPeriodIds.add(task.id);
      }
    }

    // Görevleri 3 katmanlı belirlenimci öncelik sırasıyla sırala (kesit günü üzerinden).
    const prioritizedTasks = prioritizeTasks({
      tasks: visibleTasks,
      period: normalizedRequest.donem,
      today: snapshotDay,
      activeTaskIds,
      activeTaskLastDay,
      auditCompletedDayByTaskId,
      completedInPeriodIds,
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
      cutOffUtc: cutOffDate,
      factsTruncated: !factsComplete || hasPostCutoffScopeLoss,
      limits: effectiveLimits
    });
    effectiveSignal.throwIfAborted();

    // 9. Dönem ve anlık ölçüleri doğru payda, kesiklik, tarihsel proje kapsamı ve zaman kökeniyle hesapla.
    const scopeCodes = resolvedScope.projectIds.length > 0
      ? resolvedScope.projectIds.map((id) => projectDisplayCode(projects.get(id), id))
      : [...projects.values()].map((project) => projectDisplayCode(project, project.projectId)).sort(compareAscii);

    const buildPeriodScopeCodes = (contributingProjects) => {
      if (resolvedScope.projectIds.length > 0) return scopeCodes;
      const codeSet = new Set(scopeCodes);
      for (const proj of contributingProjects || []) {
        const known = projects.get(proj.projectId);
        codeSet.add(known ? projectDisplayCode(known, proj.projectId) : (proj.code ? dataText(proj.code, 60) : proj.projectId));
      }
      return [...codeSet].sort(compareAscii);
    };
    // Hareket ve dönem tamamlanma kanıtları, silinen/taşınan görevlerin katkıda bulunduğu yetkili projeleri de yansıtır.
    const activityScopeCodes = buildPeriodScopeCodes(periodActivityAgg.contributingProjects);
    const comparisonScopeCodes = buildPeriodScopeCodes(compActivityAgg?.contributingProjects);

    const isProjectFullyReadable = (projectId) => {
      if (scope.isAdmin) return true;
      const access = projectAccess(scope, projectId);
      return Boolean(access?.accessLevel === 'FULL' || access?.readGrant);
    };
    const reportContributingComplete = (periodActivityAgg.contributingProjects || [])
      .every((proj) => !proj?.projectId || isProjectFullyReadable(proj.projectId));
    const comparisonContributingComplete = (compActivityAgg?.contributingProjects || [])
      .every((proj) => !proj?.projectId || isProjectFullyReadable(proj.projectId));

    const snapshotCompleteness = effectiveScopeSummary.completeProjectView && factsComplete && snapshotConsistent ? 'complete' : 'partial';
    const reportPeriodCompleteness = (
      effectiveScopeSummary.completeProjectView
      && reportContributingComplete
      && factsComplete
      && snapshotConsistent
      && !activityAssigneeDiverged
    ) ? 'complete' : 'partial';
    const comparisonPeriodCompleteness = (
      effectiveScopeSummary.completeProjectView
      && comparisonContributingComplete
      && factsComplete
      && snapshotConsistent
      && !comparisonActivityDiverged
    ) ? 'complete' : 'partial';
    const activityCoverage = (
      effectiveScopeSummary.completeProjectView
      && reportContributingComplete
      && !activityAssigneeDiverged
    ) ? 'complete' : 'partial';

    const completedInPeriodTasks = visibleTasks.filter((task) => completedInPeriodIds.has(task.id));
    const totalCompletedInPeriod = completedInPeriodTasks.length + movedOutCompletedInPeriod.size + periodActivitySummary.deletedCompleted;
    // Kesit sonrası değiştirilen görevlerin canlı durumu kesit anını yansıtmaz; anlık sayımlardan dışlanır.
    const snapshotConsistentTasks = visibleTasks.filter((task) => !task._postCutoffModified);
    const openTasks = snapshotConsistentTasks.filter((task) => task.status !== 'done');
    const overdueTasks = openTasks.filter((task) => isOverdue(task, snapshotDay));
    const dueSoonTasks = openTasks.filter((task) => isDueWithin(task, snapshotDay, 7));
    const undatedDoneCount = (!factsComplete || !snapshotConsistent)
      ? null
      : snapshotConsistentTasks.filter((task) => task.status === 'done' && !task._rawActualFinish).length;

    const targetPersonLabel = resolvedScope.tur === 'kisi'
      ? (clampModelSafeLabel(resolvedScope.targetPerson?.name, REPORT_REQUEST_LIMITS.maxIdentifierLength) || 'secili_kisi')
      : null;

    const buildScopeQualifier = (codes) => {
      if (resolvedScope.tur === 'kisi') {
        return { sorumlu: targetPersonLabel };
      }
      if (resolvedScope.tur === 'ekip') {
        return { ekip: resolvedScope.teamLabel, ...(codes.length ? { kapsam: codes } : {}) };
      }
      if (ORG_LEVEL_META[resolvedScope.tur]) {
        return { [resolvedScope.tur]: resolvedScope.orgUnitLabel, ...(codes.length ? { kapsam: codes } : {}) };
      }
      return { kapsam: codes };
    };
    const commonScopeFields = buildScopeQualifier(scopeCodes);
    const activityScopeFields = buildScopeQualifier(activityScopeCodes);
    const comparisonScopeFields = buildScopeQualifier(comparisonScopeCodes);

    const coreMetrics = [
      {
        _metricKey: 'period_completed',
        tur: 'olcu',
        kaynak: 'rota_task_analytics',
        olcu: 'tamamlanan',
        deger: totalCompletedInPeriod,
        ...activityScopeFields,
        donem: { baslangic: normalizedRequest.donem.baslangic, bitis: normalizedRequest.donem.bitis },
        tamlik: reportPeriodCompleteness
      },
      {
        _metricKey: 'period_activity',
        tur: 'olcu',
        kaynak: 'rota_activity_search',
        olcu: 'hareket',
        deger: periodActivitySummary.events,
        ...activityScopeFields,
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
        tamlik: snapshotCompleteness
      },
      {
        _metricKey: 'snapshot_overdue',
        tur: 'olcu',
        kaynak: 'rota_task_analytics',
        olcu: 'geciken',
        deger: overdueTasks.length,
        ...commonScopeFields,
        veri_ani: veriAni,
        tamlik: snapshotCompleteness
      },
      {
        _metricKey: 'snapshot_due_7',
        tur: 'olcu',
        kaynak: 'rota_task_analytics',
        olcu: 'yaklasan_7_gun',
        deger: dueSoonTasks.length,
        ...commonScopeFields,
        veri_ani: veriAni,
        tamlik: snapshotCompleteness
      },
      {
        _metricKey: 'snapshot_undated_done',
        tur: 'olcu',
        kaynak: 'rota_task_analytics',
        olcu: 'history.undatedDone',
        deger: undatedDoneCount,
        ...commonScopeFields,
        veri_ani: veriAni,
        kayit_kapsami: undatedDoneCount === null ? 'unknown' : snapshotCompleteness,
        tamlik: snapshotCompleteness
      }
    ];

    // Karşılaştırma dönemi istendiyse karşılaştırma dönemi tamamlanma ölçüsünü aynı yetkili nüfus ve tekilleştirme kuralıyla hesapla.
    let comparisonCompletedCount = null;
    if (normalizedRequest.karsilastirma !== 'yok' && normalizedRequest.karsilastirma_donemi) {
      const comp = normalizedRequest.karsilastirma_donemi;
      const comparisonCompletedIds = new Set();
      for (const task of visibleTasks) {
        const doneByActualFinish = !task._postCutoffModified
          && !hasCompletionAuditByTaskId.has(task.id)
          && task.status === 'done'
          && Boolean(task.actualFinish)
          && task.actualFinish >= comp.baslangic
          && task.actualFinish <= comp.bitis;
        if (doneByActualFinish || auditCompletedInComparisonIds.has(task.id)) {
          comparisonCompletedIds.add(task.id);
        }
      }
      comparisonCompletedCount = comparisonCompletedIds.size + movedOutCompletedInComparison.size + comparisonDeletedCompleted;
      coreMetrics.push({
        _metricKey: 'comparison_completed',
        tur: 'olcu',
        kaynak: 'rota_task_analytics',
        olcu: 'tamamlanan',
        deger: comparisonCompletedCount,
        ...comparisonScopeFields,
        donem: { baslangic: comp.baslangic, bitis: comp.bitis },
        tamlik: comparisonPeriodCompleteness
      });
    }

    // Çok projeli kapsamlarda proje bazlı tamamlanan kırılımı ikincil ölçü olarak eklenir.
    // Canlı görev bulunmasa bile yalnızca silinmiş veya taşınmış tamamlama katkısı olan yetkili projeler de kırılıma dâhil edilir.
    const secondaryMetrics = [];
    const deletedCompletedByProjectId = new Map();
    const contributingProjectById = new Map();
    for (const proj of periodActivityAgg?.contributingProjects || []) {
      if (!proj?.projectId) continue;
      contributingProjectById.set(proj.projectId, proj);
      if (Number(proj.deletedCompleted || 0) > 0) {
        deletedCompletedByProjectId.set(proj.projectId, Number(proj.deletedCompleted || 0));
      }
    }
    const movedOutCompletedByProjectId = new Map();
    for (const projectId of movedOutCompletedInPeriod.values()) {
      movedOutCompletedByProjectId.set(projectId, (movedOutCompletedByProjectId.get(projectId) || 0) + 1);
    }
    const breakdownProjects = new Map(projects);
    const ensureBreakdownProject = (projectId) => {
      if (!projectId || breakdownProjects.has(projectId)) return;
      const contrib = contributingProjectById.get(projectId);
      breakdownProjects.set(projectId, {
        projectId,
        code: contrib?.code ? dataText(contrib.code, 60) : null,
        name: contrib?.name ? dataText(contrib.name, 160) : null
      });
    };
    for (const projectId of deletedCompletedByProjectId.keys()) ensureBreakdownProject(projectId);
    for (const projectId of movedOutCompletedByProjectId.keys()) ensureBreakdownProject(projectId);
    for (const task of completedInPeriodTasks) {
      const attributedProjectId = auditCompletedProjectByTaskId.get(task.id) || task.projectId;
      ensureBreakdownProject(attributedProjectId);
    }

    if (breakdownProjects.size > 1) {
      const sortedProjects = [...breakdownProjects.values()].sort((a, b) => compareAscii(a.projectId, b.projectId));
      const codeCounts = new Map();
      for (const project of sortedProjects) {
        const code = projectDisplayCode(project, project.projectId);
        codeCounts.set(code, (codeCounts.get(code) || 0) + 1);
      }
      for (const project of sortedProjects) {
        // Denetim tamamlaması farklı bir projede gerçekleştiyse tamamlama kaynak projeye yazılır; taşınmış ve silinmiş tamamlamalar da eklenir.
        const projCompleted = completedInPeriodTasks.filter((task) => {
          const attributedProjectId = auditCompletedProjectByTaskId.get(task.id) || task.projectId;
          return attributedProjectId === project.projectId;
        }).length
          + (movedOutCompletedByProjectId.get(project.projectId) || 0)
          + (deletedCompletedByProjectId.get(project.projectId) || 0);
        const projComplete = isProjectFullyReadable(project.projectId)
          && factsComplete
          && snapshotConsistent
          && !activityAssigneeDiverged;
        const displayCode = projectDisplayCode(project, project.projectId);
        const hasCodeCollision = (codeCounts.get(displayCode) || 0) > 1;
        secondaryMetrics.push({
          _metricKey: `project_completed:${project.projectId}`,
          tur: 'olcu',
          kaynak: 'rota_task_analytics',
          olcu: 'tamamlanan',
          deger: projCompleted,
          kapsam: [displayCode],
          ...(hasCodeCollision ? { proje_kimligi: project.projectId } : {}),
          ...(resolvedScope.tur === 'kisi' ? { sorumlu: targetPersonLabel } : {}),
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
        ...activityScopeFields,
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
    const maxTasks = effectiveLimits.maxSelectedTasks;
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
        ...(task._overdue ? { geciken_gun: overdueDays(task, snapshotDay) } : {}),
        ...(task._completedInPeriod ? { donemde_tamamlandi: true } : {}),
        ...(task._activeInPeriod ? { donemde_hareketli: true } : {}),
        ...(task._postCutoffModified ? { kesit_sonrasi_degisti: true } : {}),
        ...(deps ? { bagimliliklar: { oncul: [...deps.oncul].sort(compareAscii), ardil: [...deps.ardil].sort(compareAscii) } } : {}),
        ...(resolvedScope.tur === 'kisi' && resolvedScope.targetPerson?.name ? { sorumlu: targetPersonLabel } : {}),
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
        _projectId: version.projectId,
        _auditId: version._auditId ?? null,
        _versionIdentity: version._versionIdentity ?? null,
        _precededByGap: Boolean(version._precededByGap),
        _taskPriorityRank: version._taskPriorityRank ?? 0,
        _selectionOrder: version._selectionOrder ?? 0,
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
        ...(resolvedScope.tur === 'kisi' && resolvedScope.targetPerson?.name ? { sorumlu: targetPersonLabel } : {}),
        ...(resolvedScope.tur === 'ekip' ? { ekip: resolvedScope.teamLabel } : {}),
        ...(ORG_LEVEL_META[resolvedScope.tur] ? { [resolvedScope.tur]: resolvedScope.orgUnitLabel } : {})
      };
    });

    // 12. Sunucu türetimleri (F#) kurucusu — yalnızca tam ve tutarlı paydalardan oran hesaplar.
    const snapshotCompletePopulation = snapshotCompleteness === 'complete';
    const comparisonCompletePopulation = reportPeriodCompleteness === 'complete' && comparisonPeriodCompleteness === 'complete';
    const distinctPartialProjectIds = new Set();
    for (const project of projects.values()) {
      if (!isProjectFullyReadable(project.projectId)) distinctPartialProjectIds.add(project.projectId);
    }
    for (const proj of periodActivityAgg?.contributingProjects || []) {
      if (proj?.projectId && !isProjectFullyReadable(proj.projectId)) distinctPartialProjectIds.add(proj.projectId);
    }
    const partialProjectCountForWarning = Math.max(effectiveScopeSummary.projects.partial, distinctPartialProjectIds.size);

    const buildDerivedFindings = ({ metricIdByKey, taskEvidenceIdByTaskId }) => {
      const findings = [];
      const curCompId = metricIdByKey.get('period_completed');
      const curActId = metricIdByKey.get('period_activity');
      const prevCompId = metricIdByKey.get('comparison_completed');
      const openId = metricIdByKey.get('snapshot_open');
      const overdueId = metricIdByKey.get('snapshot_overdue');
      const undatedId = metricIdByKey.get('snapshot_undated_done');

      if (normalizedRequest.karsilastirma !== 'yok' && curCompId && prevCompId && comparisonCompletedCount != null) {
        const diff = totalCompletedInPeriod - comparisonCompletedCount;
        const canPercent = comparisonCompletePopulation && comparisonCompletedCount > 0;
        findings.push({
          tur: 'karsilastirma',
          girdiler: [curCompId, prevCompId],
          deger: {
            mevcut: totalCompletedInPeriod,
            onceki: comparisonCompletedCount,
            fark: diff,
            yuzde_degisim: canPercent ? roundPercent(diff, comparisonCompletedCount) : null,
            ...(canPercent ? {} : { yuzde_nedeni: !comparisonCompletePopulation ? 'kismi_gorunurluk' : 'sifir_payda' })
          },
          kosul: normalizedRequest.karsilastirma === 'ozel_donem'
            ? 'eşit ve bitmiş dönem'
            : 'tamamlanmış önceki eşdeğer dönem'
        });
      }

      if (snapshotCompletePopulation && openTasks.length > 0 && overdueTasks.length > 0 && openId && overdueId) {
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

      if ((!effectiveScopeSummary.completeProjectView || !reportContributingComplete) && curCompId && openId) {
        const warningInputs = !reportContributingComplete && curActId
          ? [curCompId, curActId, openId]
          : [curCompId, openId];
        findings.push({
          tur: 'kismi_gorunurluk_uyarisi',
          girdiler: warningInputs,
          deger: { kismi_proje_sayisi: partialProjectCountForWarning },
          kosul: 'sayılar yalnızca yetkili görünür görevleri yansıtır; proje bütünü yüzdesi hesaplanmaz'
        });
      }

      // Kilometre taşı toplamları yalnızca kesit anıyla tutarlı (kesit sonrası değişmemiş) görevlerden hesaplanır.
      const snapshotMilestoneTasks = snapshotConsistentTasks.filter((task) => task.milestone);
      const periodCompletedMilestoneTasks = snapshotConsistentTasks.filter((task) => task.milestone && completedInPeriodIds.has(task.id));
      const hasPostCutoffModifiedPeriodCompletion = visibleTasks.some((task) => task._postCutoffModified && completedInPeriodIds.has(task.id));
      if (snapshotMilestoneTasks.length > 0 || periodCompletedMilestoneTasks.length > 0) {
        const milestoneInputs = [
          ...new Set([
            curCompId,
            openId,
            overdueId,
            ...[...snapshotMilestoneTasks, ...periodCompletedMilestoneTasks]
              .map((task) => taskEvidenceIdByTaskId.get(task.id))
              .filter(Boolean)
          ].filter(Boolean))
        ];
        if (milestoneInputs.length > 0) {
          findings.push({
            tur: 'kilometre_tasi_ozeti',
            girdiler: milestoneInputs,
            deger: {
              toplam: snapshotMilestoneTasks.length,
              acik: snapshotMilestoneTasks.filter((task) => task.status !== 'done').length,
              geciken: snapshotMilestoneTasks.filter((task) => isOverdue(task, snapshotDay)).length,
              donemde_tamamlanan: hasPostCutoffModifiedPeriodCompletion ? null : periodCompletedMilestoneTasks.length
            },
            kosul: snapshotCompletePopulation ? 'tam yetkili kapsam' : 'yetkili görünür görev alt kümesi'
          });
        }
      }

      return findings;
    };

    // Sayısal Sicil ve ham kontrol karakteri (\u001F) model paketine sızmaz; okunur etiketler yayımlanır.
    const modelSafeScopeIds = resolvedScope.tur === 'kisi'
      ? [targetPersonLabel]
      : ORG_LEVEL_META[resolvedScope.tur]
        ? [resolvedScope.orgUnitLabel]
        : [...normalizedRequest.kapsam.kimlikler];

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
            kimlikler: modelSafeScopeIds
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
      today: snapshotDay,
      period: normalizedRequest.donem,
      limits: effectiveLimits,
      buildDerivedFindings,
      noteCompleteness: noteCollection.completeness,
      scopeSummary: effectiveScopeSummary,
      activityCoverage,
      dependencyCoverage,
      dependencyTruncated,
      undatedDoneCount,
      totalEligibleTasks: prioritizedTasks.length,
      taskReadTruncated: Boolean(taskFactsResult.truncated),
      rosterTruncated,
      snapshotConsistent,
      lastReopenAtByTaskId,
      lastTargetFinishChangeByTaskId
    });

    // 14. Son yetki, seçili proje etkinliği ve görev görünürlüğü sınırı: her bağ okumasından SONRA
    // yetki dönemi parmak izi bir kez daha doğrulanır; bayat paket asla döndürülmez.
    const assertEpochUnchanged = async () => {
      effectiveSignal.throwIfAborted();
      const reloaded = await turn.revalidateAuthorization(effectiveSignal);
      if (turn.authorizationEpoch() !== initialEpoch) {
        throw new ServerPersistenceError(
          'AUTHORIZATION_CHANGED',
          'Kanıt toplama sırasında yetki kapsamı değiştiği için kanıt paketi geçersiz kılındı.'
        );
      }
      return reloaded.scope;
    };

    const latestScope = await assertEpochUnchanged();

    const expectedTaskProjects = new Map();
    for (const task of visibleTasks) {
      expectedTaskProjects.set(task.id, task.projectId);
    }
    for (const [taskId, projectId] of activityLiveTasksForRevalidation.entries()) {
      const existing = expectedTaskProjects.get(taskId);
      if (existing && existing !== projectId) {
        throw new ServerPersistenceError(
          'AUTHORIZATION_CHANGED',
          'Kanıt toplama sırasında görev proje bağı değiştiği için kanıt paketi geçersiz kılındı.'
        );
      }
      if (!existing) {
        expectedTaskProjects.set(taskId, projectId);
      }
    }

    const verifyExpectedSelectedProjects = async (activeScope) => {
      if (resolvedScope.projectIds.length === 0) return;
      effectiveSignal.throwIfAborted();
      const activeRows = await turn.sql(effectiveSignal, (executor) => (
        readReportProjectsBySelectors(executor, activeScope, resolvedScope.projectIds)
      ));
      const activeIds = new Set(activeRows.map((row) => canonicalActualId(row.ProjectId)).filter(Boolean));
      for (const expectedProjectId of resolvedScope.projectIds) {
        if (!activeIds.has(expectedProjectId)) {
          throw new ServerPersistenceError(
            'AUTHORIZATION_CHANGED',
            'Kanıt toplama sırasında seçili proje erişimi veya etkinlik durumu değiştiği için kanıt paketi geçersiz kılındı.'
          );
        }
      }
    };

    const verifyExpectedTaskBindings = async (activeScope) => {
      const allRevalidateTaskIds = [...expectedTaskProjects.keys()];
      if (allRevalidateTaskIds.length === 0) return;
      const currentVisible = new Map();
      const chunkSize = 2000;
      for (let offset = 0; offset < allRevalidateTaskIds.length; offset += chunkSize) {
        effectiveSignal.throwIfAborted();
        const chunk = allRevalidateTaskIds.slice(offset, offset + chunkSize);
        const found = await turn.sql(effectiveSignal, (executor) => readVisibleTasks(executor, activeScope, chunk));
        for (const [taskId, info] of found.entries()) {
          currentVisible.set(taskId, info);
        }
      }
      for (const [taskId, expectedProjectId] of expectedTaskProjects.entries()) {
        const current = currentVisible.get(taskId);
        if (!current || current.projectId !== expectedProjectId) {
          throw new ServerPersistenceError(
            'AUTHORIZATION_CHANGED',
            'Kanıt toplama sırasında görev görünürlüğü veya proje bağı değiştiği için kanıt paketi geçersiz kılındı.'
          );
        }
      }
    };

    const hasBindingsToVerify = expectedTaskProjects.size > 0 || resolvedScope.projectIds.length > 0;
    if (hasBindingsToVerify) {
      await verifyExpectedSelectedProjects(latestScope);
      await verifyExpectedTaskBindings(latestScope);
      // Görünürlük ve proje sorguları sırasında yetki kapsamı değiştiyse bayat paket döndürülmez.
      const postCheckScope = await assertEpochUnchanged();
      // Sistem yöneticisi yetki parmak izi görev/proje durumunu kapsamadığından bağlar bir kez daha doğrulanır
      // ve ardından yetki dönemi son kez teyit edilir.
      if (postCheckScope.isAdmin) {
        await verifyExpectedSelectedProjects(postCheckScope);
        await verifyExpectedTaskBindings(postCheckScope);
        await assertEpochUnchanged();
      }
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
    // Hata veya iptal yolunda korunan içerik tamponları temizlenir; ham sürücü/ayrıştırma hataları sızdırılmaz.
    taskFactsResult = null;
    noteCollection = null;
    if (error instanceof ReportRequestError
      || error instanceof ToolError
      || error instanceof ServerPersistenceError
      || error?.name === 'AbortError') {
      throw error;
    }
    throw new ServerPersistenceError(
      'QUERY_FAILED',
      'Yönetici kanıt paketi toplanırken beklenmeyen bir sunucu hatası oluştu.'
    );
  } finally {
    taskFactsResult = null;
    noteCollection = null;
    deadline.dispose();
  }
}
