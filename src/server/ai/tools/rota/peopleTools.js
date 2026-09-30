import 'server-only';
import { searchCorporateDirectory } from '../../../directory/directorySearch.js';
import { dataText, ID_PROPERTY, LIMIT_PROPERTY, PERSON_SICIL_PROPERTY, searchedScope } from './rotaToolSupport.js';
import { loadFilteredFacts } from './taskTools.js';
import { foldText, isDueWithin, isOverdue, normalizeTaskFilters, DUE_SOON_DAYS } from './taskFacts.js';

/* ── rota_workload_summary ────────────────────────────────── */

const WORKLOAD_NOTE = 'Rota kişi kapasitesi ya da çalışma saati müsaitliği tutmaz: bu sayılar görev dağılımıdır, aşırı yük ya da verimlilik değerlendirmesi değildir.';

const workloadSummary = {
  name: 'rota_workload_summary',
  version: 1,
  topic: 'workload',
  evidenceKind: 'workload',
  authorization: 'Yalnızca görünür AÇIK görevler; kişiye atıf yalnızca kimliği kullanıcıya açık sorumluluklarla yapılır (gizli eş sorumlular kişi olarak sayılmaz).',
  description: 'Açık görevlerin kişilere dağılımı: kişi başına açık, devam eden, gecikmiş ve 7 gün içinde terminli görev sayısı ile atandığı görevlerin planlanan saat toplamı. Bu saat task düzeyindedir, kişi-saat tahsisi değildir. "Kimde kaç iş var", "en yoğun kişi kim" gibi sorularda kullanın. Kapasite ya da aşırı yük yargısı üretmez.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      projectId: ID_PROPERTY('Yalnızca bu proje.'),
      personSicil: PERSON_SICIL_PROPERTY,
      limit: LIMIT_PROPERTY(25, 10)
    }
  },
  async handler(args, call) {
    const limit = args.limit ?? 10;
    const filters = normalizeTaskFilters({ projectId: args.projectId, status: ['todo', 'in_progress'], personSicil: args.personSicil });
    const { scope } = await call.authorization();
    const { facts, assignees } = await loadFilteredFacts(call, scope, filters, { withAssignees: true });
    const people = new Map();
    let unassigned = 0;
    let unattributed = 0;
    for (const fact of facts) {
      if (fact.assigneeCount === 0) {
        unassigned += 1;
        continue;
      }
      const visible = (assignees.get(fact.id) || []).filter((person) => person.identityVisible && person.sicil != null);
      if (!visible.length) {
        unattributed += 1;
        continue;
      }
      for (const person of visible) {
        if (args.personSicil != null && person.sicil !== args.personSicil) continue;
        if (!people.has(person.sicil)) {
          people.set(person.sicil, {
            sicil: person.sicil,
            name: dataText(person.name || String(person.sicil), 120),
            openTasks: 0,
            inProgress: 0,
            overdue: 0,
            dueNext7Days: 0,
            plannedHoursOnAssignedTasks: 0,
            tasksWithPlannedHours: 0
          });
        }
        const entry = people.get(person.sicil);
        entry.openTasks += 1;
        if (fact.status === 'in_progress') entry.inProgress += 1;
        if (isOverdue(fact, call.today)) entry.overdue += 1;
        if (isDueWithin(fact, call.today, DUE_SOON_DAYS)) entry.dueNext7Days += 1;
        if (fact.plannedHours != null) {
          entry.plannedHoursOnAssignedTasks = Math.round((entry.plannedHoursOnAssignedTasks + fact.plannedHours) * 100) / 100;
          entry.tasksWithPlannedHours += 1;
        }
      }
    }
    const ordered = [...people.values()].sort((left, right) => right.openTasks - left.openTasks
      || right.overdue - left.overdue || left.name.localeCompare(right.name, 'tr') || left.sicil - right.sicil);
    const page = ordered.slice(0, limit);
    const descriptor = searchedScope(scope, filters.projectId);
    return {
      data: {
        openTaskCount: facts.length,
        people: page,
        unassignedOpenTasks: unassigned,
        openTasksWithOnlyHiddenAssignees: unattributed,
        notes: [
          WORKLOAD_NOTE,
          'Birden çok sorumlusu olan görev her sorumluda ayrı sayılır.',
          'plannedHoursOnAssignedTasks, kişinin atandığı görevlerin task düzeyindeki planlanan saat toplamıdır; kişi-saat tahsisi değildir. Yalnızca değeri girilmiş görevler (tasksWithPlannedHours) toplanır; boş değer sıfır sayılmaz.'
        ]
      },
      scope: descriptor,
      complete: page.length === ordered.length,
      truncated: page.length < ordered.length,
      returnedCount: page.length,
      totalCount: ordered.length,
      nextCursor: null,
      evidence: {
        label: `İş yükü dağılımı · ${ordered.length} kişi`,
        entity: args.projectId ? { type: 'project', id: args.projectId, name: null } : null,
        highlights: page.slice(0, 3).map((person) => `${person.name}: ${person.openTasks} açık`)
      }
    };
  }
};

/* ── rota_person_search ───────────────────────────────────── */

const personSearch = {
  name: 'rota_person_search',
  version: 1,
  topic: 'people',
  evidenceKind: 'people',
  authorization: 'Rota\'nın mevcut sınırlı kurumsal personel araması (en az 2 karakter, en fazla 25 satır, oturum başına hız sınırı). Kimlik Sicil\'dir; ad eşleşmesi kimlik ya da yetki kanıtı değildir.',
  description: 'Kişiyi adı ya da Sicil\'i ile kurumsal personel dizininde arar ve Sicil\'ini çözer (görev/iş yükü süzgeçleri için). Aynı adlı birden çok kişi dönebilir: bu durumda tahmin etmeyin, kullanıcıya birimini sorun.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['text'],
    properties: {
      text: { type: 'string', minLength: 2, maxLength: 80, description: 'Ad-soyad parçası ya da Sicil.' },
      limit: LIMIT_PROPERTY(25, 10)
    }
  },
  async handler(args, call) {
    const limit = args.limit ?? 10;
    const result = await call.sql((executor) => searchCorporateDirectory({ query: args.text }, executor));
    const people = result.items.map((person) => ({
      sicil: Number(person.sicil),
      name: dataText(person.name, 120),
      ...(person.jobTitle ? { jobTitle: dataText(person.jobTitle, 120) } : {}),
      organization: {
        directorate: person.organization?.directorate ? dataText(person.organization.directorate, 120) : null,
        department: person.organization?.department ? dataText(person.organization.department, 120) : null,
        unit: person.organization?.unit ? dataText(person.organization.unit, 120) : null
      }
    }));
    const byName = new Map();
    for (const person of people) {
      const key = foldText(person.name);
      byName.set(key, (byName.get(key) || 0) + 1);
    }
    const sameName = [...byName.entries()].filter(([, count]) => count > 1).map(([name]) => name);
    const directoryCapped = people.length >= result.limit;
    const page = people.slice(0, limit);
    return {
      data: {
        people: page,
        ambiguous: people.length > 1,
        sameNameCount: sameName.length,
        guidance: people.length > 1
          ? 'Birden çok kişi eşleşti. Kişiyi Sicil ile ayırın; aynı adlı kişilerde kullanıcıya birimini sorun.'
          : (people.length === 0 ? 'Eşleşen kişi bulunamadı.' : null)
      },
      scope: { kind: 'directory', completeProjectView: false, note: `Dizin araması en fazla ${result.limit} satır döndürür.` },
      complete: !directoryCapped && page.length === people.length,
      truncated: directoryCapped || page.length < people.length,
      returnedCount: page.length,
      totalCount: directoryCapped ? null : people.length,
      nextCursor: null,
      evidence: {
        label: directoryCapped ? `Personel araması · en az ${people.length} kişi` : `Personel araması · ${people.length} kişi`,
        entity: null,
        highlights: page.slice(0, 3).map((person) => person.name)
      }
    };
  }
};

export const PEOPLE_TOOLS = Object.freeze([workloadSummary, personSearch]);
