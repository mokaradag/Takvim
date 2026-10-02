import 'server-only';
import { canonicalActualId } from '../../../../domain/identity/actualId.js';
import { outlookFailureMessage, safeOutlookFailureCode } from '../../../../domain/outlook/outlookFailures.js';
import { PLAN_HYGIENE_CHECKS } from '../../../../features/dashboard/planHealth.js';
import { TOOL_ERROR_CODES, ToolError } from '../toolErrors.js';
import { readOutlook } from './rotaToolStore.js';
import { currentUserScope, dataText, ID_PROPERTY, LIMIT_PROPERTY, notFound, searchedScope } from './rotaToolSupport.js';
import { loadFilteredFacts } from './taskTools.js';
import { normalizeTaskFilters, sqlDay, sqlInstant } from './taskFacts.js';

/* ── rota_outlook_status ──────────────────────────────────── */

/** Arayüzdeki teslim etiketleriyle aynı öncelik (OutlookCalendarAction). */
function deliveryState(row) {
  if (row.LastFailureCode) return ['failed', 'Outlook gönderimi başarısız'];
  if (row.CompletionSuspended) return ['suspended', 'Outlook bağlantısı bekletiliyor'];
  if (row.PendingMethod) return ['pending', 'Outlook gönderimi bekliyor'];
  if (row.DeliveredSequence != null && row.DeliveredMethod !== 'CANCEL') return ['delivered', 'Outlook bağlantısı etkin'];
  return ['pending', 'Outlook gönderimi bekliyor'];
}

const outlookStatus = {
  name: 'rota_outlook_status',
  version: 1,
  topic: 'outlook',
  evidenceKind: 'outlook',
  authorization: 'Yalnızca kullanıcının KENDİ Outlook aboneliklerinin Rota tarafındaki teslim durumu; yalnızca görünür görevler ayrıntılı döner.',
  description: 'Kullanıcının Outlook takvimine eklediği görevlerin Rota tarafındaki gönderim durumunu okur (etkin, bekliyor, bekletiliyor, başarısız). Posta kutusunu ya da davetin Outlook\'ta kabul edilip edilmediğini BİLMEZ.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      taskId: ID_PROPERTY('Yalnızca bu görevin aboneliği.'),
      limit: LIMIT_PROPERTY(25, 10)
    }
  },
  async handler(args, call) {
    const limit = args.limit ?? 10;
    const { scope } = await call.authorization();
    let result;
    try {
      result = await call.sql((executor) => readOutlook(executor, scope, { taskIds: args.taskId ? [args.taskId] : [], maxRows: 500 }));
    } catch (error) {
      const message = String(error?.message || '');
      if (Number(error?.number) === 208 && /\bMR_TaskOutlookSubscriptions\b/i.test(message)) {
        throw new ToolError(TOOL_ERROR_CODES.UNSUPPORTED, { message: 'Outlook takvim tümleştirmesi bu kurulumda etkin değil.' });
      }
      throw error;
    }
    const items = result.subscriptions.map((row) => {
      const [state, stateLabel] = deliveryState(row);
      const failureCode = row.LastFailureCode ? safeOutlookFailureCode(row.LastFailureCode) : null;
      return {
        task: {
          taskId: canonicalActualId(row.TaskId),
          title: dataText(row.Title, 160),
          project: dataText(row.ProjectName, 160)
        },
        calendarDate: sqlDay(row.TargetFinish) || sqlDay(row.PlannedFinish),
        state,
        stateLabel,
        ...(sqlDay(row.DeliveredDate) ? { deliveredCalendarDate: sqlDay(row.DeliveredDate) } : {}),
        ...(sqlInstant(row.LastDeliveredAt) ? { lastDeliveredAt: sqlInstant(row.LastDeliveredAt) } : {}),
        ...(failureCode ? { failure: { code: failureCode, message: outlookFailureMessage(failureCode).slice(failureCode.length + 2) } } : {}),
        ...(Number(row.AttemptCount) > 0 ? { attempts: Number(row.AttemptCount) } : {})
      };
    });
    const counts = items.reduce((sum, item) => ({ ...sum, [item.state]: (sum[item.state] || 0) + 1 }), {});
    const page = items.slice(0, limit);
    if (args.taskId && !items.length) throw notFound();
    const distributionComplete = !result.truncated;
    return {
      data: {
        activeSubscriptions: result.truncated ? null : items.length,
        byState: distributionComplete ? counts : null,
        byStateComplete: distributionComplete,
        items: page,
        note: 'Rota yalnızca davetin gönderim durumunu bilir; Outlook\'ta kabul edilip edilmediğini ya da posta kutusu içeriğini bilmez.'
      },
      scope: currentUserScope('Yalnızca sizin Outlook abonelikleriniz.'),
      complete: page.length === items.length && distributionComplete,
      truncated: page.length < items.length || !distributionComplete,
      returnedCount: page.length,
      // Toplam yalnızca görünür görevlerin aboneliklerini kapsar.
      totalCount: distributionComplete ? items.length : null,
      nextCursor: null,
      evidence: {
        label: 'Outlook teslim durumu',
        entity: { type: 'user', id: 'me', name: 'Outlook abonelikleriniz' },
        highlights: !distributionComplete
          ? ['Durum dağılımı: sınır dışı abonelikler nedeniyle gösterilmedi']
          : Object.entries(counts).slice(0, 4).map(([state, count]) => `${deliveryLabel(state)}: ${count}`)
      }
    };
  }
};

function deliveryLabel(state) {
  return { failed: 'Başarısız', suspended: 'Bekletiliyor', pending: 'Bekliyor', delivered: 'Etkin' }[state] || state;
}

/* ── rota_data_quality ────────────────────────────────────── */

const CHECK_BY_ID = new Map(PLAN_HYGIENE_CHECKS.map((check) => [check.id, check]));

/** Ürünün plan bütünlüğü kuralları (planHealth); sorumlu kuralı dizinde çözülen Sicil sayısıyla uygulanır. */
function missing(checkId, fact) {
  const planTask = { targetFinish: fact.targetFinish, plannedStart: fact.plannedStart, plannedFinish: fact.plannedFinish, wbsId: fact.wbsId };
  if (checkId === 'assignee') return fact.resolvedAssigneeCount === 0;
  return CHECK_BY_ID.get(checkId).isMissing(planTask, {});
}

const dataQuality = {
  name: 'rota_data_quality',
  version: 1,
  topic: 'quality',
  evidenceKind: 'data-quality',
  authorization: 'Yalnızca görünür görevler; kısmi projede proje bütününü temsil etmez.',
  description: 'Plan veri kalitesini ürünün kendi kurallarıyla denetler: açık görevlerde sorumlusuz, terminsiz, planlanan tarihi eksik ve iş dağılım ağacına bağlanmamış görevler; tamamlanmış ama gerçekleşen bitişi girilmemiş görevler. Kural dışı yorum üretmez.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      projectId: ID_PROPERTY('Yalnızca bu proje.'),
      limit: { type: 'integer', minimum: 1, maximum: 5, description: 'Denetim başına örnek görev sayısı (1–5, varsayılan 3).' }
    }
  },
  async handler(args, call) {
    const examplesPerCheck = args.limit ?? 3;
    const filters = normalizeTaskFilters({ projectId: args.projectId });
    const { scope } = await call.authorization();
    const { facts, projects } = await loadFilteredFacts(call, scope, filters);
    const open = facts.filter((fact) => fact.status !== 'done');
    const flagged = new Set();
    const example = (fact) => ({ taskId: fact.id, title: dataText(fact.title, 160), project: projects.get(fact.projectId)?.name || null });
    const checks = PLAN_HYGIENE_CHECKS.map((check) => {
      const items = open.filter((fact) => missing(check.id, fact));
      items.forEach((fact) => flagged.add(fact.id));
      return {
        id: check.id,
        label: check.label,
        explain: check.explain,
        count: items.length,
        examples: items.slice(0, examplesPerCheck).map(example)
      };
    });
    const doneWithoutActual = facts.filter((fact) => fact.status === 'done' && !fact.actualFinish);
    const examplesTruncated = checks.some((check) => check.examples.length < check.count) || doneWithoutActual.length > examplesPerCheck;
    const descriptor = searchedScope(scope, filters.projectId);
    return {
      data: {
        openTaskCount: open.length,
        cleanOpenTaskCount: open.length - flagged.size,
        checks,
        completedWithoutActualFinish: {
          count: doneWithoutActual.length,
          explain: 'Gerçekleşen bitişi olmayan tamamlanmış görevin ne zaman bittiği bilinmez; kronolojik ölçümlere girmez.',
          examples: doneWithoutActual.slice(0, examplesPerCheck).map(example)
        },
        notes: [
          'Denetimler yalnızca tamamlanmamış görevlere uygulanır (son madde hariç).',
          'Sorumlu denetimi atanmış Sicil’in kurumsal personel dizininde çözülebilmesini arar; çözülemeyen eski referanslar sorumlu sayılmaz.'
        ]
      },
      scope: descriptor,
      complete: !examplesTruncated,
      truncated: examplesTruncated,
      returnedCount: facts.length,
      totalCount: facts.length,
      nextCursor: null,
      evidence: {
        label: `Plan veri kalitesi · ${open.length} açık görev`,
        entity: args.projectId ? { type: 'project', id: args.projectId, name: null } : null,
        highlights: checks.filter((check) => check.count > 0).slice(0, 4).map((check) => `${check.label}: ${check.count}`)
      }
    };
  }
};

export const INTEGRITY_TOOLS = Object.freeze([outlookStatus, dataQuality]);
