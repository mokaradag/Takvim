/**
 * MERGEN Rota · uçtan uca testler için bellek içi SQL Server ikizi.
 *
 * Amaç, kalıcılaştırma zincirinin GERÇEK kodunu (rota gövdesi → sıralı/sertleştirilmiş
 * depo sarmalayıcıları → `sqlAppRepository` → SQL) çalıştırmak. Bu yüzden ikiz,
 * `mssql` sürücüsünün yalnızca kullanılan yüzeyini taklit eder:
 *   - `new driver.ConnectionPool(config).connect()` → havuz
 *   - `pool.request().input(...).query(sql)` → `{ recordset, recordsets }`
 *   - `new driver.Transaction(pool)` → begin/commit/rollback
 *
 * Kritik davranış: GUID değerleri SQL Server gibi BÜYÜK HARF metin olarak
 * döndürülür ve karşılaştırmalar harf büyüklüğünden bağımsızdır. Kurumsal
 * kaynaktan gelen `...-F111-...` biçimli (RFC 4122 sürüm biti taşımayan)
 * kimlikler de aynen saklanır. Uygulamadaki büyük/küçük harf ve UUID deseni
 * hataları böylece testte görünür olur.
 */

function guid(value) {
  return value == null ? null : String(value).toUpperCase();
}

function sameGuid(left, right) {
  if (left == null || right == null) return left == null && right == null;
  return String(left).toUpperCase() === String(right).toUpperCase();
}

function isoDate(value) {
  return value == null || value === '' ? null : String(value).slice(0, 10);
}

let guidCounter = 0;
function newGuid() {
  guidCounter += 1;
  const hex = guidCounter.toString(16).padStart(12, '0');
  return `A0000000-0000-4000-8000-${hex}`.toUpperCase();
}

let versionCounter = 0;
function nextVersion() {
  versionCounter += 1;
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(versionCounter, 4);
  return buffer;
}

function sameVersion(left, right) {
  if (!Buffer.isBuffer(left) || !Buffer.isBuffer(right)) return false;
  return left.equals(right);
}

function result(recordsets) {
  const normalized = recordsets.map((rows) => rows || []);
  return {
    recordset: normalized[0] || [],
    recordsets: normalized,
    rowsAffected: normalized.map((rows) => rows.length)
  };
}

export function createFakeDatabase(seed = {}) {
  return {
    projects: (seed.projects || []).map((project) => ({
      ProjectId: guid(project.ProjectId),
      SourceType: project.SourceType || 'MANUAL',
      ProjectCode: project.ProjectCode ?? null,
      ProjectName: project.ProjectName,
      ProjectTypeCode: project.ProjectTypeCode ?? null,
      ProjectTypeName: project.ProjectTypeName ?? null,
      LeadSicil: project.LeadSicil ?? null,
      DataDate: project.DataDate ?? null,
      ColorToken: project.ColorToken ?? 'blue',
      CalendarId: guid(project.CalendarId),
      IsActive: project.IsActive ?? 1,
      RowVersion: nextVersion()
    })),
    projectTags: (seed.projectTags || []).map((tag) => ({ ...tag, ProjectId: guid(tag.ProjectId) })),
    projectAccess: (seed.projectAccess || []).map((entry) => ({
      ProjectId: guid(entry.ProjectId),
      Sicil: entry.Sicil,
      AccessLevel: entry.AccessLevel || 'FULL',
      GrantSource: entry.GrantSource || 'OWNER',
      IsActive: entry.IsActive ?? 1
    })),
    wbs: (seed.wbs || []).map((node) => ({
      WbsId: guid(node.WbsId),
      ProjectId: guid(node.ProjectId),
      ParentWbsId: guid(node.ParentWbsId),
      Code: node.Code,
      Name: node.Name,
      SortOrder: node.SortOrder ?? null,
      SourceType: node.SourceType || 'MANUAL',
      SourceKey: node.SourceKey ?? null,
      OutlineCode: node.OutlineCode ?? null,
      WbsLevel: node.WbsLevel ?? null,
      StatusCode: node.StatusCode ?? null,
      ElementTypeCode: node.ElementTypeCode ?? null,
      RowVersion: nextVersion()
    })),
    tasks: (seed.tasks || []).map((task) => ({
      TaskId: guid(task.TaskId),
      ProjectId: guid(task.ProjectId),
      WbsId: guid(task.WbsId),
      CalendarId: guid(task.CalendarId),
      Title: task.Title,
      Description: task.Description ?? null,
      Keyword: task.Keyword ?? null,
      Status: task.Status || 'planned',
      Priority: task.Priority || 'normal',
      IsMilestone: task.IsMilestone ?? 0,
      PlannedStart: task.PlannedStart ?? null,
      PlannedFinish: task.PlannedFinish ?? null,
      PlannedDurationDays: task.PlannedDurationDays ?? null,
      TargetFinish: task.TargetFinish ?? null,
      ActualStart: task.ActualStart ?? null,
      ActualFinish: task.ActualFinish ?? null,
      RemainingDurationDays: task.RemainingDurationDays ?? null,
      Progress: task.Progress ?? null,
      PlannedHours: task.PlannedHours ?? null,
      ActualHours: task.ActualHours ?? null,
      Budget: task.Budget ?? null,
      Spent: task.Spent ?? null,
      // Tekrar serisi alanları tohumdan da taşınır: seri bağı yalnızca commit
      // yolundan kurulabilseydi, var olan bir seriyle başlayan senaryolar
      // (silme sırasında yinelemelerin ayrılması gibi) sınanamazdı.
      RecurrenceRule: task.RecurrenceRule ?? null,
      RecurrenceParentTaskId: guid(task.RecurrenceParentTaskId),
      RecurrenceOccurrenceDate: task.RecurrenceOccurrenceDate ?? null,
      SortOrder: task.SortOrder ?? null,
      RowVersion: nextVersion()
    })),
    taskAssignees: (seed.taskAssignees || []).map((entry) => ({ TaskId: guid(entry.TaskId), Sicil: entry.Sicil })),
    taskDependencies: (seed.taskDependencies || []).map((entry) => ({
      TaskDependencyId: guid(entry.TaskDependencyId || newGuid()),
      ProjectId: guid(entry.ProjectId),
      TaskId: guid(entry.TaskId),
      PredecessorTaskId: guid(entry.PredecessorTaskId),
      DependencyType: entry.DependencyType || 'FS',
      LagDays: entry.LagDays ?? 0,
      LagValue: entry.LagValue ?? null,
      LagUnit: entry.LagUnit ?? null
    })),
    baselines: seed.baselines || [],
    taskBaselineSnapshots: seed.taskBaselineSnapshots || [],
    calendars: (seed.calendars || []).map((calendar) => ({
      CalendarId: guid(calendar.CalendarId),
      Name: calendar.Name,
      TimeZone: calendar.TimeZone || 'Europe/Istanbul',
      IsDefault: calendar.IsDefault ?? 0,
      IsActive: calendar.IsActive ?? 1,
      WorkingDays: calendar.WorkingDays || [1, 2, 3, 4, 5],
      Holidays: calendar.Holidays || []
    })),
    auditLog: [],
    people: seed.people || [],
    systemAdminSicils: seed.systemAdminSicils || [],
    corporateProjects: seed.corporateProjects || [],
    corporateProjectAccess: seed.corporateProjectAccess || [],
    executiveScope: seed.executiveScope || [],
    corporateWbsRows: seed.corporateWbsRows || [],
    // Uçtan uca başarım savlarının kanıtı: her deyim ve her işlem yalıtım
    // düzeyi kaydedilir; testler kaç kez birleştirme yapıldığını sayabilir.
    statements: [],
    transactions: [],
    corporateWbsSyncState: (seed.corporateWbsSyncState || []).map((entry) => ({
      ProjectCode: String(entry.ProjectCode || '').toUpperCase(),
      ContentHash: entry.ContentHash,
      NodeCount: entry.NodeCount ?? 0,
      SyncedBySicil: entry.SyncedBySicil ?? null
    })),
    // Kurumsal kullanıcı dizini (DC01_userr). MERGEN Rota tarafından
    // OLUŞTURULMAZ; yalnızca okunur.
    corporateUsers: (seed.corporateUsers || []).map((entry) => ({
      Name: entry.Name,
      EmailAddress: entry.EmailAddress ?? null
    })),
    // Hatırlatma yapılandırması ve KALICI gönderim geçmişi.
    reminderSettings: seed.reminderSettings === null
      ? null
      : (seed.reminderSettings ? { RowVersion: nextVersion(), ...seed.reminderSettings } : undefined),
    taskReminderLog: (seed.taskReminderLog || []).map((entry, index) => ({
      TaskReminderLogId: index + 1,
      TaskId: guid(entry.TaskId),
      ProjectId: guid(entry.ProjectId),
      ReminderKind: entry.ReminderKind || 'AUTOMATIC',
      SlotKey: entry.SlotKey,
      Status: entry.Status || 'SENT',
      RecipientCount: entry.RecipientCount ?? 0,
      RecipientDigest: entry.RecipientDigest ?? null,
      FailureCode: entry.FailureCode ?? null,
      RequestedBySicil: entry.RequestedBySicil ?? null,
      CreatedAt: entry.CreatedAt || new Date().toISOString(),
      CompletedAt: entry.CompletedAt || null
    })),
    // `reminderSchemaMissing: true` ile 0005 göçü çalıştırılmamış bir kurulum
    // taklit edilir.
    reminderSchemaMissing: Boolean(seed.reminderSchemaMissing)
  };
}

function projectById(db, value) {
  return db.projects.find((project) => sameGuid(project.ProjectId, value)) || null;
}
function wbsById(db, value) {
  return db.wbs.find((node) => sameGuid(node.WbsId, value)) || null;
}
function taskById(db, value) {
  return db.tasks.find((task) => sameGuid(task.TaskId, value)) || null;
}

function calendarRows(db) {
  const rows = [];
  for (const calendar of db.calendars.filter((entry) => entry.IsActive)) {
    const weekdays = calendar.WorkingDays.length ? calendar.WorkingDays : [null];
    const holidays = calendar.Holidays.length ? calendar.Holidays : [null];
    for (const weekday of weekdays) {
      for (const holiday of holidays) {
        rows.push({
          CalendarId: calendar.CalendarId,
          Name: calendar.Name,
          TimeZone: calendar.TimeZone,
          Weekday: weekday,
          HolidayDate: holiday?.date ?? null,
          HolidayName: holiday?.name ?? null,
          ShortName: holiday?.short ?? null
        });
      }
    }
  }
  return rows;
}

/** Görev, kullanıcıya ya da astlarından birine atanmış mı? */
function visibleAssignee(db, taskId, sicil) {
  return db.taskAssignees.some((entry) => sameGuid(entry.TaskId, taskId)
    && (entry.Sicil === sicil
      || db.executiveScope.some((scope) => scope.ManagerSicil === sicil && scope.EmployeeSicil === entry.Sicil)));
}

function snapshotRecordsets(db, sicil, isAdmin, canAssignAllCorporate = false) {
  const visible = new Map();
  if (isAdmin) {
    for (const project of db.projects.filter((entry) => entry.IsActive)) {
      visible.set(project.ProjectId, 'FULL');
    }
  } else {
    for (const project of db.projects.filter((entry) => entry.IsActive)) {
      const corporateAccess = project.SourceType === 'CORPORATE' && db.corporateProjectAccess
        .some((entry) => entry.Sicil === sicil && String(entry.ProjectCode).toUpperCase() === String(project.ProjectCode || '').toUpperCase());
      const grant = db.projectAccess.find((entry) => entry.IsActive && entry.Sicil === sicil && sameGuid(entry.ProjectId, project.ProjectId));
      // Kendi görevi ya da astının görevi bulunan proje KISMİ görünür olur;
      // gerçek sorgu da aynı üç kaynağın birleşimini kullanır.
      const scopedTask = db.tasks.some((task) => sameGuid(task.ProjectId, project.ProjectId)
        && visibleAssignee(db, task.TaskId, sicil));
      if (corporateAccess || grant?.AccessLevel === 'FULL') visible.set(project.ProjectId, 'FULL');
      else if (grant || scopedTask) visible.set(project.ProjectId, 'PARTIAL');
    }
  }

  const projects = db.projects
    .filter((project) => project.IsActive && visible.has(project.ProjectId))
    .map((project) => ({ ...project, AccessLevel: visible.get(project.ProjectId) }))
    .sort((left, right) => String(left.ProjectName).localeCompare(String(right.ProjectName)));

  const tags = db.projectTags.filter((tag) => visible.has(guid(tag.ProjectId)));
  const wbs = db.wbs
    .filter((node) => visible.get(guid(node.ProjectId)) === 'FULL')
    .sort((left, right) => (left.SortOrder ?? 0) - (right.SortOrder ?? 0) || String(left.Code).localeCompare(String(right.Code)));
  // KISMİ projelerde yalnızca kendi/astının görevleri döner.
  const tasks = db.tasks
    .filter((task) => {
      const level = visible.get(guid(task.ProjectId));
      if (!level) return false;
      if (level === 'FULL') return true;
      const readGranted = db.projectAccess.some((entry) => entry.IsActive
        && entry.Sicil === sicil
        && entry.AccessLevel === 'READ'
        && sameGuid(entry.ProjectId, task.ProjectId));
      return readGranted || visibleAssignee(db, task.TaskId, sicil);
    })
    .map((task) => ({
      ...task,
      AccessLevel: visible.get(guid(task.ProjectId)),
      // YETKİLİ sorumlu sayısı: görünen satırlarla farkı, gizlenmiş bir eş
      // sorumlu olduğunu söyler (kimlik taşımaz).
      AssigneeCount: db.taskAssignees.filter((entry) => sameGuid(entry.TaskId, task.TaskId)).length
    }));
  // Sorumlu satırları da süzülür: KISMİ projede yalnızca kullanıcının kendisi
  // ve kapsamındaki çalışanlar görünür. Süzgeç olmadan kapsam dışı eş sorumlu
  // istemciye sızıyor ve panelin salt okunur açılma kuralı sınanamıyordu.
  const assignees = db.taskAssignees.filter((entry) => {
    const task = tasks.find((row) => sameGuid(row.TaskId, entry.TaskId));
    if (!task) return false;
    if (task.AccessLevel === 'FULL') return true;
    const readGranted = db.projectAccess.some((grant) => grant.IsActive
      && grant.Sicil === sicil
      && grant.AccessLevel === 'READ'
      && sameGuid(grant.ProjectId, task.ProjectId));
    if (readGranted) return true;
    return entry.Sicil === sicil
      || db.executiveScope.some((scope) => scope.ManagerSicil === sicil && scope.EmployeeSicil === entry.Sicil);
  });
  const dependencies = db.taskDependencies.filter((entry) => visible.get(guid(entry.ProjectId)) === 'FULL');
  const people = db.people.map((person) => ({ ...person }));

  // Görev ATAMA kapsamı: seçilebilir kurumsal projeler. Görünür proje/görev
  // kümesine hiçbir şey eklemez.
  const assignable = canAssignAllCorporate
    ? db.projects
      .filter((project) => project.IsActive && project.SourceType === 'CORPORATE')
      .map((project) => ({
        ProjectId: project.ProjectId,
        ProjectCode: project.ProjectCode,
        ProjectName: project.ProjectName,
        ProjectTypeCode: project.ProjectTypeCode ?? null,
        ProjectTypeName: project.ProjectTypeName ?? null,
        ColorToken: project.ColorToken ?? null,
        CalendarId: project.CalendarId ?? null,
        RootWbsId: db.wbs.find((node) => sameGuid(node.ProjectId, project.ProjectId) && node.ParentWbsId == null)?.WbsId ?? null
      }))
      .sort((left, right) => String(left.ProjectCode || '').localeCompare(String(right.ProjectCode || '')))
    : [];

  // Atama kapsamındaki çalışanlar: seçiciler bu kümeyle sınırlanır.
  const assignmentScope = canAssignAllCorporate
    ? db.executiveScope
      .filter((entry) => entry.ManagerSicil === sicil)
      .map((entry) => ({ EmployeeSicil: entry.EmployeeSicil }))
      .sort((left, right) => left.EmployeeSicil - right.EmployeeSicil)
    : [];

  return [
    projects,
    tags,
    wbs,
    tasks,
    assignees,
    dependencies,
    db.baselines,
    db.taskBaselineSnapshots,
    calendarRows(db),
    people,
    assignable,
    assignmentScope
  ];
}

function authorizationRecordsets(db, sicil) {
  const person = db.people.find((entry) => entry.Sicil === sicil) || null;
  const isAdmin = db.systemAdminSicils.includes(sicil);
  const isExecutive = db.executiveScope.some((entry) => entry.ManagerSicil === sicil);
  const grants = [];

  if (isAdmin) {
    for (const project of db.projects.filter((entry) => entry.IsActive)) {
      grants.push({ ProjectId: project.ProjectId, AccessLevel: 'FULL', Reason: 'SYSTEM_ADMIN' });
    }
  }
  for (const project of db.projects.filter((entry) => entry.IsActive && entry.SourceType === 'CORPORATE')) {
    const hasRole = db.corporateProjectAccess.some((entry) => entry.Sicil === sicil
      && String(entry.ProjectCode).toUpperCase() === String(project.ProjectCode || '').toUpperCase());
    if (hasRole) grants.push({ ProjectId: project.ProjectId, AccessLevel: 'FULL', Reason: 'CORPORATE_PROJECT_ROLE' });
  }
  for (const entry of db.projectAccess.filter((row) => row.IsActive && row.Sicil === sicil)) {
    const project = projectById(db, entry.ProjectId);
    if (!project?.IsActive) continue;
    grants.push({
      ProjectId: entry.ProjectId,
      AccessLevel: entry.AccessLevel,
      Reason: entry.GrantSource === 'OWNER' ? 'MANUAL_OWNER' : 'MANUAL_GRANT'
    });
  }

  const partialTasks = db.taskAssignees
    .filter((entry) => entry.Sicil === sicil)
    .map((entry) => {
      const task = taskById(db, entry.TaskId);
      return task ? { ProjectId: task.ProjectId, TaskId: task.TaskId, Reason: 'ASSIGNEE' } : null;
    })
    .filter(Boolean);

  return [
    person ? [person] : [],
    [{ IsSystemAdmin: isAdmin }],
    [{ IsExecutive: isExecutive }],
    grants,
    partialTasks
  ];
}

function synchronizeCorporateProjects(db, actorSicil) {
  const defaultCalendar = db.calendars.find((calendar) => calendar.IsDefault && calendar.IsActive);
  if (!defaultCalendar) throw new Error('An active default calendar is required before corporate project synchronization.');

  for (const source of db.corporateProjects) {
    const code = String(source.ProjectCode).toUpperCase();
    const existing = db.projects.find((project) => project.SourceType === 'CORPORATE'
      && String(project.ProjectCode || '').toUpperCase() === code);
    const manager = db.corporateProjectAccess
      .filter((entry) => String(entry.ProjectCode).toUpperCase() === code && entry.RoleCode === 'PROJECT_MANAGER')
      .map((entry) => entry.Sicil)
      .sort((left, right) => left - right)[0] ?? null;

    if (existing) {
      existing.ProjectName = source.ProjectName;
      existing.ProjectTypeCode = source.ProjectTypeCode ?? null;
      existing.ProjectTypeName = source.ProjectTypeName ?? null;
      existing.LeadSicil = manager;
      existing.IsActive = 1;
      continue;
    }

    const projectId = newGuid();
    db.projects.push({
      ProjectId: projectId,
      SourceType: 'CORPORATE',
      ProjectCode: code,
      ProjectName: source.ProjectName,
      ProjectTypeCode: source.ProjectTypeCode ?? null,
      ProjectTypeName: source.ProjectTypeName ?? null,
      LeadSicil: manager,
      DataDate: null,
      ColorToken: 'blue',
      CalendarId: defaultCalendar.CalendarId,
      IsActive: 1,
      RowVersion: nextVersion()
    });
    db.wbs.push({
      WbsId: newGuid(),
      ProjectId: projectId,
      ParentWbsId: null,
      Code: code,
      Name: source.ProjectName,
      SortOrder: 0,
      SourceType: 'CORPORATE',
      SourceKey: null,
      OutlineCode: null,
      WbsLevel: null,
      StatusCode: null,
      ElementTypeCode: null,
      RowVersion: nextVersion()
    });
  }
}

function mergeCorporateWbs(db, params) {
  const projectId = guid(params.projectId);
  const nodes = JSON.parse(params.payload);
  let root = db.wbs.find((node) => sameGuid(node.ProjectId, projectId) && node.ParentWbsId == null) || null;
  if (!root) {
    root = {
      WbsId: newGuid(),
      ProjectId: projectId,
      ParentWbsId: null,
      Code: params.projectCode,
      Name: params.projectName,
      SortOrder: 0,
      SourceType: 'CORPORATE',
      SourceKey: null,
      OutlineCode: null,
      WbsLevel: null,
      StatusCode: null,
      ElementTypeCode: null,
      RowVersion: nextVersion()
    };
    db.wbs.push(root);
  }

  for (const node of nodes) {
    const existing = db.wbs.find((row) => sameGuid(row.ProjectId, projectId) && row.SourceKey === node.sourceKey);
    const values = {
      Code: node.sourceKey,
      Name: node.name,
      SortOrder: node.sortOrder ?? null,
      SourceType: 'CORPORATE',
      SourceKey: node.sourceKey,
      OutlineCode: node.outlineCode ?? null,
      WbsLevel: node.level ?? null,
      StatusCode: node.statusCode ?? null,
      ElementTypeCode: node.elementTypeCode ?? null
    };
    if (existing) Object.assign(existing, values, { RowVersion: nextVersion() });
    else db.wbs.push({ WbsId: newGuid(), ProjectId: projectId, ParentWbsId: root.WbsId, ...values, RowVersion: nextVersion() });
  }

  for (const node of nodes) {
    const target = db.wbs.find((row) => sameGuid(row.ProjectId, projectId) && row.SourceKey === node.sourceKey);
    const parent = node.parentSourceKey
      ? db.wbs.find((row) => sameGuid(row.ProjectId, projectId) && row.SourceKey === node.parentSourceKey)
      : null;
    const nextParentId = parent ? parent.WbsId : root.WbsId;
    if (target && !sameGuid(target.ParentWbsId, nextParentId)) {
      target.ParentWbsId = nextParentId;
      target.RowVersion = nextVersion();
    }
  }

  const keptKeys = new Set(nodes.map((node) => node.sourceKey));
  db.wbs = db.wbs.filter((row) => {
    if (!sameGuid(row.ProjectId, projectId) || row.SourceType !== 'CORPORATE' || row.SourceKey == null) return true;
    if (keptKeys.has(row.SourceKey)) return true;
    const hasChildren = db.wbs.some((child) => sameGuid(child.ParentWbsId, row.WbsId));
    const hasTasks = db.tasks.some((task) => sameGuid(task.WbsId, row.WbsId));
    return hasChildren || hasTasks;
  });
}

function corporateWbsSourceRows(db, params) {
  const codes = new Set(Object.entries(params)
    .filter(([name]) => /^code\d+$/.test(name))
    .map(([, value]) => String(value).toUpperCase()));
  return db.corporateWbsRows
    .filter((row) => codes.has(String(row['Proje tanımı'] || '').trim().toUpperCase()))
    .map((row) => ({
      ProjectCode: String(row['Proje tanımı'] || '').trim(),
      WbsElement: String(row['WBS element'] || '').trim(),
      Name: String(row.Name || '').trim(),
      WbsLevel: row.Level ?? null,
      StatusCode: row.Status ?? null,
      OutlineCode: row['PYP kodu'] ?? null,
      ElementTypeCode: row['Proj.type'] ?? null
    }));
}

function nullableDate(value) {
  return value == null || value === '' ? null : isoDate(value);
}

function runQuery(db, statement, params, { database }) {
  const sqlText = String(statement);
  const sicil = params.sicil;

  // ── Kurumsal WBS kaynağı (ikinci veritabanı) ───────────────
  if (/FROM \[\w+\]\.\[\w+\]/.test(sqlText) && sqlText.includes('WBS element')) {
    return result([corporateWbsSourceRows(db, params)]);
  }

  if (sqlText.includes('MAX(s.SyncedAt) AS LastSyncedAt')) {
    const syncedAt = db.corporateWbsSyncState.length ? new Date().toISOString() : null;
    return result([[{ LastSyncedAt: syncedAt, ProjectCount: db.corporateWbsSyncState.length }]]);
  }

  if (sqlText.includes('FROM dbo.MR_CorporateWbsSyncState s')) {
    return result([db.corporateWbsSyncState.map((entry) => ({
      ProjectCode: entry.ProjectCode,
      ContentHash: entry.ContentHash,
      NodeCount: entry.NodeCount,
      StoredNodeCount: db.wbs.filter((node) => {
        const project = db.projects.find((row) => sameGuid(row.ProjectId, node.ProjectId));
        return project?.SourceType === 'CORPORATE'
          && project.IsActive
          && String(project.ProjectCode || '').toUpperCase() === entry.ProjectCode
          && node.SourceType === 'CORPORATE'
          && node.SourceKey != null;
      }).length
    }))]);
  }

  if (sqlText.includes('dbo.MR_CorporateWbsSyncState')) {
    const code = String(params.projectCode || '').toUpperCase();
    const existing = db.corporateWbsSyncState.find((entry) => entry.ProjectCode === code);
    if (existing) Object.assign(existing, { ContentHash: params.contentHash, NodeCount: params.nodeCount, SyncedBySicil: params.actorSicil ?? null });
    else db.corporateWbsSyncState.push({ ProjectCode: code, ContentHash: params.contentHash, NodeCount: params.nodeCount, SyncedBySicil: params.actorSicil ?? null });
    return result([[]]);
  }

  if (sqlText.includes('OPENJSON(@payload)')) {
    mergeCorporateWbs(db, params);
    return result([[]]);
  }

  if (sqlText.includes('SELECT ProjectId, ProjectCode, ProjectName')) {
    return result([db.projects
      .filter((project) => project.SourceType === 'CORPORATE' && project.IsActive && project.ProjectCode)
      .map((project) => ({
        ProjectId: project.ProjectId,
        ProjectCode: project.ProjectCode,
        ProjectName: project.ProjectName
      }))]);
  }

  // ── Yetkilendirme ve anlık görüntü ─────────────────────────
  if (sqlText.includes('FROM dbo.MR_V_PeopleDirectory WHERE Sicil = @sicil')) {
    return result(authorizationRecordsets(db, sicil));
  }
  if (sqlText.includes('DECLARE @VisibleProjects TABLE')) {
    return result(snapshotRecordsets(db, sicil, Boolean(params.isAdmin), Boolean(params.canAssignAllCorporate)));
  }
  if (sqlText.includes("THROW 51001")) {
    synchronizeCorporateProjects(db, params.actorSicil);
    return result([[]]);
  }
  if (sqlText.includes('JOIN STRING_SPLIT(@taskIds')) {
    const ids = new Set(String(params.taskIds || '').split(',').map((value) => value.trim().toUpperCase()).filter(Boolean));
    // Tamamlama, anlık görüntüyle AYNI görünürlük kuralına uyar: kapsam dışı eş
    // sorumlu geri getirilmez.
    return result([db.taskAssignees.filter((entry) => {
      if (!ids.has(String(entry.TaskId).toUpperCase())) return false;
      if (params.isAdmin) return true;
      const task = db.tasks.find((row) => sameGuid(row.TaskId, entry.TaskId));
      if (!task) return false;
      const project = projectById(db, task.ProjectId);
      const corporate = project?.SourceType === 'CORPORATE' && db.corporateProjectAccess
        .some((row) => row.Sicil === params.sicil
          && String(row.ProjectCode).toUpperCase() === String(project.ProjectCode || '').toUpperCase());
      const granted = db.projectAccess.some((row) => row.IsActive
        && row.Sicil === params.sicil
        && ['FULL', 'READ'].includes(row.AccessLevel)
        && sameGuid(row.ProjectId, task.ProjectId));
      return corporate || granted || entry.Sicil === params.sicil
        || db.executiveScope.some((scope) => scope.ManagerSicil === params.sicil && scope.EmployeeSicil === entry.Sicil);
    })]);
  }
  if (sqlText.includes('SELECT TOP (1) CalendarId') && sqlText.includes('IsDefault = 1 AND IsActive = 1') && !sqlText.includes('@calendarId')) {
    const calendar = db.calendars.find((entry) => entry.IsDefault && entry.IsActive) || null;
    return result([calendar ? [{ CalendarId: calendar.CalendarId }] : []]);
  }
  if (sqlText.includes('FROM dbo.MR_Calendars WITH (UPDLOCK, HOLDLOCK)') && sqlText.includes('@calendarId')) {
    const calendar = db.calendars.find((entry) => sameGuid(entry.CalendarId, params.calendarId) && entry.IsActive);
    return result([calendar ? [{ CalendarId: calendar.CalendarId }] : []]);
  }
  // Hatırlatma gönderme yetkisi: kullanıcı görevi GÖRÜYOR mu?
  if (sqlText.includes('SELECT TOP (1) t.TaskId') && sqlText.includes('MR_V_CorporateProjectAccess')) {
    const task = db.tasks.find((entry) => sameGuid(entry.TaskId, params.taskId)) || null;
    const project = task ? projectById(db, task.ProjectId) : null;
    if (!task || !project?.IsActive) return result([[]]);
    const code = String(project.ProjectCode || '').toUpperCase();
    const corporate = db.corporateProjectAccess.some((entry) => entry.Sicil === params.sicil
      && String(entry.ProjectCode).toUpperCase() === code);
    const granted = db.projectAccess.some((entry) => entry.IsActive
      && entry.Sicil === params.sicil
      && sameGuid(entry.ProjectId, task.ProjectId));
    const assigned = db.taskAssignees.some((entry) => sameGuid(entry.TaskId, task.TaskId)
      && (entry.Sicil === params.sicil
        || db.executiveScope.some((scope) => scope.ManagerSicil === params.sicil && scope.EmployeeSicil === entry.Sicil)));
    return result([corporate || granted || assigned ? [{ TaskId: task.TaskId }] : []]);
  }

  /* ── Görev hatırlatma e-postaları ─────────────────────────── */
  // Yazma dalı ÖNCE denenir: upsert metni de `FROM dbo.MR_ReminderSettings`
  // içerdiği için okuma dalı sırada önde olsaydı kaydı sessizce yutardı.
  if (sqlText.includes('UPDATE dbo.MR_ReminderSettings')) {
    if (db.reminderSchemaMissing) {
      const error = new Error("Invalid object name 'dbo.MR_ReminderSettings'.");
      error.number = 208;
      throw error;
    }
    // İyimser kilit: satır sürümü verilmişse ve eşleşmiyorsa hiçbir alan yazılmaz.
    if (db.reminderSettings && params.rowVersion != null
      && !sameVersion(db.reminderSettings.RowVersion, params.rowVersion)) {
      return result([[{ AffectedRows: 0 }]]);
    }
    db.reminderSettings = {
      AutomaticEnabled: params.automaticEnabled ? 1 : 0,
      WindowValue: params.windowValue,
      WindowUnit: params.windowUnit,
      FrequencyValue: params.frequencyValue,
      FrequencyUnit: params.frequencyUnit,
      SubjectTemplate: params.subjectTemplate,
      BodyTemplate: params.bodyTemplate,
      UpdatedAt: new Date().toISOString(),
      UpdatedBySicil: params.actorSicil ?? null,
      RowVersion: nextVersion()
    };
    return result([[{ AffectedRows: 1 }]]);
  }
  if (sqlText.includes('FROM dbo.MR_ReminderSettings')) {
    if (db.reminderSchemaMissing) {
      const error = new Error("Invalid object name 'dbo.MR_ReminderSettings'.");
      error.number = 208;
      throw error;
    }
    return result([db.reminderSettings ? [db.reminderSettings] : []]);
  }
  if (sqlText.includes('FROM dbo.MR_Tasks t') && sqlText.includes('p.ProjectCode, p.ProjectName') && sqlText.includes('WHERE t.TaskId = @taskId')) {
    const task = db.tasks.find((entry) => sameGuid(entry.TaskId, params.taskId));
    if (!task) return result([[]]);
    const project = projectById(db, task.ProjectId);
    return result([[{
      TaskId: task.TaskId,
      ProjectId: task.ProjectId,
      Title: task.Title,
      Description: task.Description,
      Keyword: task.Keyword,
      Status: task.Status,
      Priority: task.Priority,
      TargetFinish: task.TargetFinish,
      PlannedStart: task.PlannedStart,
      PlannedFinish: task.PlannedFinish,
      ProjectCode: project?.ProjectCode ?? null,
      ProjectName: project?.ProjectName ?? null
    }]]);
  }
  if (sqlText.includes('directory.EmailAddress AS Email')) {
    // Sorumlu → HR02 kullanıcı adı → DC01_userr.Name → EmailAddress zinciri.
    const rows = db.taskAssignees
      .filter((entry) => sameGuid(entry.TaskId, params.taskId))
      .map((entry) => {
        const person = db.people.find((candidate) => candidate.Sicil === entry.Sicil) || null;
        const username = person?.Username ? String(person.Username).trim() : '';
        const directory = username
          ? db.corporateUsers.find((candidate) => String(candidate.Name || '').trim() === username
            && String(candidate.EmailAddress || '').trim() !== '')
          : null;
        return {
          Sicil: entry.Sicil,
          Name: person?.DisplayName ?? null,
          Username: person?.Username ?? null,
          Email: directory ? String(directory.EmailAddress).trim() : null
        };
      });
    return result([rows]);
  }
  if (sqlText.includes('FROM dbo.MR_Tasks t') && sqlText.includes('@horizonDays')) {
    const horizon = new Date();
    horizon.setHours(0, 0, 0, 0);
    const start = new Date(horizon);
    horizon.setDate(horizon.getDate() + Number(params.horizonDays || 7));
    const rows = db.tasks.filter((task) => {
      const project = projectById(db, task.ProjectId);
      if (!project?.IsActive) return false;
      if (!task.TargetFinish) return false;
      if (['done', 'completed', 'cancelled'].includes(String(task.Status || '').toLowerCase())) return false;
      const due = new Date(`${task.TargetFinish}T00:00:00`);
      if (due < start || due > horizon) return false;
      return db.taskAssignees.some((entry) => sameGuid(entry.TaskId, task.TaskId));
    }).map((task) => ({
      TaskId: task.TaskId,
      ProjectId: task.ProjectId,
      Title: task.Title,
      Status: task.Status,
      TargetFinish: task.TargetFinish
    }));
    return result([rows]);
  }
  if (sqlText.includes("ReminderKind = 'AUTOMATIC'") && sqlText.includes('INSERT dbo.MR_TaskReminderLog')) {
    // Benzersiz dizin taklidi: aynı (TaskId, SlotKey) ikinci kez sahiplenilemez.
    const taken = db.taskReminderLog.some((entry) => sameGuid(entry.TaskId, params.taskId)
      && entry.SlotKey === params.slotKey
      && entry.ReminderKind === 'AUTOMATIC');
    if (taken) return result([[{ TaskReminderLogId: null }]]);
    const logId = db.taskReminderLog.length + 1;
    db.taskReminderLog.push({
      TaskReminderLogId: logId,
      TaskId: guid(params.taskId),
      ProjectId: guid(params.projectId),
      ReminderKind: 'AUTOMATIC',
      SlotKey: params.slotKey,
      Status: 'PENDING',
      RecipientCount: 0,
      RecipientDigest: null,
      FailureCode: null,
      RequestedBySicil: params.actorSicil ?? null,
      CreatedAt: new Date().toISOString(),
      CompletedAt: null
    });
    return result([[{ TaskReminderLogId: logId }]]);
  }
  if (sqlText.includes("VALUES(@taskId, @projectId, 'MANUAL'")) {
    const logId = db.taskReminderLog.length + 1;
    db.taskReminderLog.push({
      TaskReminderLogId: logId,
      TaskId: guid(params.taskId),
      ProjectId: guid(params.projectId),
      ReminderKind: 'MANUAL',
      SlotKey: params.slotKey,
      Status: 'PENDING',
      RecipientCount: 0,
      RecipientDigest: null,
      FailureCode: null,
      RequestedBySicil: params.actorSicil ?? null,
      CreatedAt: new Date().toISOString(),
      CompletedAt: null
    });
    return result([[{ TaskReminderLogId: logId }]]);
  }
  if (sqlText.includes('UPDATE dbo.MR_TaskReminderLog')) {
    const entry = db.taskReminderLog.find((row) => row.TaskReminderLogId === Number(params.logId));
    if (entry) {
      entry.Status = params.status;
      entry.RecipientCount = params.recipientCount ?? 0;
      entry.RecipientDigest = params.recipientDigest ?? null;
      entry.FailureCode = params.failureCode ?? null;
      entry.CompletedAt = new Date().toISOString();
    }
    return result([[]]);
  }
  if (sqlText.includes('FROM dbo.MR_TaskReminderLog') && sqlText.includes('ORDER BY TaskReminderLogId DESC')) {
    if (db.reminderSchemaMissing) {
      const error = new Error("Invalid object name 'dbo.MR_TaskReminderLog'.");
      error.number = 208;
      throw error;
    }
    return result([[...db.taskReminderLog].reverse().slice(0, Number(params.limit || 20))]);
  }

  // Görev atama kapsamı denetimleri.
  if (sqlText.includes('SELECT TOP (1) ProjectId FROM dbo.MR_Projects WHERE ProjectId = @projectId AND IsActive = 1')) {
    const project = projectById(db, params.projectId);
    return result([project && project.IsActive ? [{ ProjectId: project.ProjectId }] : []]);
  }
  if (sqlText.includes('SELECT TOP (1) WbsId FROM dbo.MR_WBS')
    && sqlText.includes('ParentWbsId IS NULL')
    && sqlText.includes('@projectId')) {
    const root = db.wbs
      .filter((node) => sameGuid(node.ProjectId, params.projectId) && node.ParentWbsId == null)
      .sort((left, right) => (left.SortOrder ?? 0) - (right.SortOrder ?? 0)
        || String(left.Code || '').localeCompare(String(right.Code || '')))[0];
    return result([root ? [{ WbsId: root.WbsId }] : []]);
  }
  // Silmenin KAPSAM DIŞI görevlere yazıp yazmadığı denetimi.
  if (sqlText.includes('SELECT TOP (1) related.TaskId')) {
    const relatedIds = new Set();
    for (const task of db.tasks) {
      if (sameGuid(task.RecurrenceParentTaskId, params.taskId)) relatedIds.add(String(task.TaskId).toLowerCase());
    }
    for (const dependency of db.taskDependencies || []) {
      if (sameGuid(dependency.PredecessorTaskId, params.taskId)) relatedIds.add(String(dependency.TaskId).toLowerCase());
    }
    relatedIds.delete(String(params.taskId).toLowerCase());
    const outside = [...relatedIds].find((relatedId) => {
      const assignees = db.taskAssignees.filter((entry) => sameGuid(entry.TaskId, relatedId));
      if (!assignees.length) return true;
      return assignees.some((entry) => !db.executiveScope.some((scope) => scope.ManagerSicil === params.managerSicil
        && scope.EmployeeSicil === entry.Sicil));
    });
    return result([outside ? [{ TaskId: outside }] : []]);
  }
  if (sqlText.includes("WHERE ProjectId = @projectId AND SourceType = 'CORPORATE' AND IsActive = 1")) {
    const project = projectById(db, params.projectId);
    return result([project && project.SourceType === 'CORPORATE' && project.IsActive
      ? [{ ProjectId: project.ProjectId }]
      : []]);
  }
  if (sqlText.includes('FROM STRING_SPLIT(@sicils') && sqlText.includes('dbo.MR_V_ExecutiveScope')) {
    const sicils = String(params.sicils || '').split(',').map((value) => Number(value.trim())).filter(Boolean);
    const outside = sicils.filter((employee) => !db.executiveScope.some((entry) => entry.ManagerSicil === params.managerSicil
      && entry.EmployeeSicil === employee));
    return result([outside.map((value) => ({ Sicil: value }))]);
  }
  if (sqlText.includes('SELECT Sicil FROM dbo.MR_TaskAssignees WHERE TaskId = @taskId')) {
    return result([db.taskAssignees
      .filter((entry) => sameGuid(entry.TaskId, params.taskId))
      .map((entry) => ({ Sicil: entry.Sicil }))]);
  }

  if (sqlText.includes('SELECT TOP (1) Sicil FROM dbo.MR_V_PeopleDirectory WHERE Sicil = @sicil')) {
    const person = db.people.find((entry) => entry.Sicil === params.sicil);
    return result([person ? [{ Sicil: person.Sicil }] : []]);
  }
  if (sqlText.includes('SELECT TOP (1) reserved.ProjectCode')) {
    const code = String(params.projectCode || '').toUpperCase();
    const reserved = db.corporateProjects.some((entry) => String(entry.ProjectCode).toUpperCase() === code)
      || db.projects.some((project) => project.SourceType === 'CORPORATE'
        && String(project.ProjectCode || '').toUpperCase() === code);
    return result([reserved ? [{ ProjectCode: code }] : []]);
  }
  if (sqlText.includes('SELECT TOP (1) SourceType')) {
    const project = projectById(db, params.projectId);
    const code = String(params.projectCode || '').toUpperCase();
    return result([
      project ? [{ SourceType: project.SourceType }] : [],
      db.corporateProjects.some((entry) => String(entry.ProjectCode).toUpperCase() === code) ? [{ ProjectCode: code }] : [],
      db.projects
        .filter((entry) => !sameGuid(entry.ProjectId, params.projectId)
          && String(entry.ProjectCode || '').toUpperCase() === code)
        .map((entry) => ({ ProjectId: entry.ProjectId }))
    ]);
  }

  // ── Kilitli tek satır okumaları ────────────────────────────
  const lockedIdSelect = sqlText.match(/SELECT TOP \(1\) (\w+)\s+FROM dbo\.(\w+) WITH \(UPDLOCK, HOLDLOCK\)\s+WHERE (\w+) = @(entityId|taskId)/);
  if (lockedIdSelect) {
    const [, column, table, whereColumn, parameter] = lockedIdSelect;
    const rows = tableRows(db, table).filter((row) => sameGuid(row[whereColumn], params[parameter]));
    return result([rows.slice(0, 1).map((row) => ({ [column]: row[column] }))]);
  }
  const lockedRowSelect = sqlText.match(/SELECT TOP \(1\)\s+\*\s+FROM dbo\.(\w+) WITH \(UPDLOCK, HOLDLOCK\)\s+WHERE (\w+) = @(entityId|id)/);
  if (lockedRowSelect) {
    const [, table, column, parameter] = lockedRowSelect;
    const rows = tableRows(db, table).filter((row) => sameGuid(row[column], params[parameter]));
    return result([rows.slice(0, 1).map((row) => ({ ...row }))]);
  }
  const plainRowSelect = sqlText.match(/SELECT TOP \(1\) \* FROM dbo\.(\w+) WHERE (\w+) = @id;/);
  if (plainRowSelect) {
    const [, table, column] = plainRowSelect;
    const rows = tableRows(db, table).filter((row) => sameGuid(row[column], params.id));
    return result([rows.slice(0, 1).map((row) => ({ ...row }))]);
  }
  if (sqlText.includes('SELECT WbsId, ProjectId, ParentWbsId')) {
    return result([db.wbs
      .filter((node) => sameGuid(node.ProjectId, params.projectId))
      .map((node) => ({ WbsId: node.WbsId, ProjectId: node.ProjectId, ParentWbsId: node.ParentWbsId }))]);
  }
  if (sqlText.includes('SELECT TaskId, PredecessorTaskId')) {
    return result([db.taskDependencies
      .filter((entry) => sameGuid(entry.ProjectId, params.projectId))
      .map((entry) => ({ TaskId: entry.TaskId, PredecessorTaskId: entry.PredecessorTaskId }))]);
  }
  if (sqlText.includes('SELECT DISTINCT dependency.TaskId')) {
    return result([db.taskDependencies
      .filter((entry) => sameGuid(entry.PredecessorTaskId, params.predecessorId))
      .map((entry) => ({ TaskId: entry.TaskId }))]);
  }
  if (sqlText.includes('SELECT TOP (1) 1 AS Found FROM dbo.MR_WBS WHERE ParentWbsId = @wbsId')) {
    const referenced = db.wbs.some((node) => sameGuid(node.ParentWbsId, params.wbsId))
      || db.tasks.some((task) => sameGuid(task.WbsId, params.wbsId));
    return result([referenced ? [{ Found: 1 }] : []]);
  }

  // ── Yazma işlemleri ────────────────────────────────────────
  if (sqlText.includes('INSERT dbo.MR_Projects(')) {
    db.projects.push({
      ProjectId: guid(params.projectId),
      SourceType: 'MANUAL',
      ProjectCode: params.projectCode ?? null,
      ProjectName: params.projectName,
      ProjectTypeCode: null,
      ProjectTypeName: null,
      LeadSicil: params.leadSicil ?? null,
      DataDate: nullableDate(params.dataDate),
      ColorToken: params.colorToken ?? null,
      CalendarId: guid(params.calendarId),
      IsActive: 1,
      RowVersion: nextVersion()
    });
    db.wbs.push({
      WbsId: guid(params.rootWbsId),
      ProjectId: guid(params.projectId),
      ParentWbsId: null,
      Code: params.rootCode,
      Name: params.rootName,
      SortOrder: params.rootSort ?? null,
      SourceType: 'MANUAL',
      SourceKey: null,
      OutlineCode: null,
      WbsLevel: null,
      StatusCode: null,
      ElementTypeCode: null,
      RowVersion: nextVersion()
    });
    db.projectAccess.push({
      ProjectId: guid(params.projectId),
      Sicil: params.actorSicil,
      AccessLevel: 'FULL',
      GrantSource: 'OWNER',
      IsActive: 1
    });
    return result([[]]);
  }
  if (sqlText.includes('UPDATE dbo.MR_Projects')) {
    const project = projectById(db, params.projectId);
    if (!project || !sameVersion(project.RowVersion, params.version)) return result([[{ Affected: 0 }]]);
    if (project.SourceType === 'MANUAL') {
      project.ProjectName = params.projectName;
      project.ProjectCode = params.projectCode ?? null;
      project.LeadSicil = params.leadSicil ?? null;
    }
    project.DataDate = nullableDate(params.dataDate);
    project.ColorToken = params.colorToken ?? null;
    project.CalendarId = guid(params.calendarId);
    project.RowVersion = nextVersion();
    return result([[{ Affected: 1 }]]);
  }
  if (sqlText.includes('SELECT TagName, ColorToken, IconKey')) {
    return result([db.projectTags
      .filter((tag) => sameGuid(tag.ProjectId, params.projectId))
      .slice()
      .sort((left, right) => (left.SortOrder ?? 0) - (right.SortOrder ?? 0))
      .map((tag) => ({ TagName: tag.TagName, ColorToken: tag.ColorToken ?? null, IconKey: tag.IconKey ?? null }))]);
  }
  if (sqlText.includes('DELETE dbo.MR_ProjectTags WHERE ProjectId = @projectId;')) {
    db.projectTags = db.projectTags.filter((tag) => !sameGuid(tag.ProjectId, params.projectId));
    return result([[]]);
  }
  if (sqlText.includes('INSERT dbo.MR_ProjectTags(')) {
    db.projectTags.push({
      ProjectId: guid(params.projectId),
      TagName: params.tagName,
      ColorToken: params.colorToken ?? null,
      IconKey: params.iconKey ?? null,
      SortOrder: params.sortOrder
    });
    return result([[]]);
  }
  if (sqlText.includes('INSERT dbo.MR_WBS(WbsId, ProjectId, ParentWbsId, Code, Name, SortOrder,')) {
    db.wbs.push({
      WbsId: guid(params.wbsId),
      ProjectId: guid(params.projectId),
      ParentWbsId: guid(params.parentWbsId),
      Code: params.code,
      Name: params.name,
      SortOrder: params.sortOrder ?? null,
      SourceType: 'MANUAL',
      SourceKey: null,
      OutlineCode: null,
      WbsLevel: null,
      StatusCode: null,
      ElementTypeCode: null,
      RowVersion: nextVersion()
    });
    return result([[]]);
  }
  if (sqlText.includes('UPDATE dbo.MR_WBS')) {
    const node = wbsById(db, params.wbsId);
    if (!node || !sameVersion(node.RowVersion, params.version)) return result([[{ Affected: 0 }]]);
    node.ParentWbsId = guid(params.parentWbsId);
    node.Code = params.code;
    node.Name = params.name;
    node.SortOrder = params.sortOrder ?? null;
    node.RowVersion = nextVersion();
    return result([[{ Affected: 1 }]]);
  }
  if (sqlText.includes('DELETE dbo.MR_WBS WHERE WbsId = @wbsId AND RowVersion = @version;')) {
    const node = wbsById(db, params.wbsId);
    if (!node || !sameVersion(node.RowVersion, params.version)) return result([[{ Affected: 0 }]]);
    db.wbs = db.wbs.filter((row) => !sameGuid(row.WbsId, params.wbsId));
    return result([[{ Affected: 1 }]]);
  }
  if (sqlText.includes('IF NOT EXISTS (SELECT 1 FROM dbo.MR_Tasks WHERE TaskId = @taskId AND RowVersion = @version)')) {
    const task = taskById(db, params.taskId);
    if (!task || !sameVersion(task.RowVersion, params.version)) {
      throw new Error("STALE_TASK");
    }
    // Seri şablonu silinirken yinelemeler ayrılır, silinmez.
    for (const entry of db.tasks) {
      if (!sameGuid(entry.RecurrenceParentTaskId, params.taskId)) continue;
      entry.RecurrenceParentTaskId = null;
      entry.RecurrenceOccurrenceDate = null;
      entry.RowVersion = nextVersion();
    }
    db.taskDependencies = db.taskDependencies
      .filter((entry) => !sameGuid(entry.TaskId, params.taskId) && !sameGuid(entry.PredecessorTaskId, params.taskId));
    db.taskAssignees = db.taskAssignees.filter((entry) => !sameGuid(entry.TaskId, params.taskId));
    db.tasks = db.tasks.filter((entry) => !sameGuid(entry.TaskId, params.taskId));
    return result([[{ Affected: 1 }]]);
  }
  if (sqlText.includes('COUNT_BIG(*) AS ChildCount')) {
    const childCount = db.tasks.filter((task) => sameGuid(task.RecurrenceParentTaskId, params.parentId)).length;
    return result([[{ ChildCount: childCount }]]);
  }
  if (sqlText.includes('WHERE RecurrenceParentTaskId = @parentId') && sqlText.includes('RecurrenceOccurrenceDate = @occurrenceDate')) {
    const duplicate = db.tasks.find((task) => sameGuid(task.RecurrenceParentTaskId, params.parentId)
      && task.RecurrenceOccurrenceDate === nullableDate(params.occurrenceDate)
      && !sameGuid(task.TaskId, params.taskId));
    return result([duplicate ? [{ TaskId: duplicate.TaskId }] : []]);
  }
  if (sqlText.includes('UPDATE dbo.MR_Tasks') && sqlText.includes('SET Keyword = @to')) {
    // Ad eşleşmesi harf duyarsızdır (veritabanı harmanlaması); yalnızca birebir
    // aynı olan satırlar elenir.
    const from = String(params.from ?? '');
    const to = params.to ?? null;
    const touched = [];
    for (const task of db.tasks) {
      if (!sameGuid(task.ProjectId, params.projectId)) continue;
      if (String(task.Keyword ?? '').toLocaleLowerCase('tr-TR') !== from.toLocaleLowerCase('tr-TR')) continue;
      if (to != null && task.Keyword === to) continue;
      task.Keyword = to;
      task.RowVersion = nextVersion();
      touched.push({ TaskId: task.TaskId });
    }
    return result([touched]);
  }
  if (sqlText.includes('INSERT dbo.MR_Tasks(')) {
    db.tasks.push({
      TaskId: guid(params.taskId),
      ProjectId: guid(params.projectId),
      WbsId: guid(params.wbsId),
      CalendarId: guid(params.calendarId),
      Title: params.title,
      Description: params.description ?? null,
      Keyword: params.keyword ?? null,
      Status: params.status,
      Priority: params.priority,
      IsMilestone: params.isMilestone ? 1 : 0,
      PlannedStart: nullableDate(params.plannedStart),
      PlannedFinish: nullableDate(params.plannedFinish),
      PlannedDurationDays: params.plannedDuration ?? null,
      TargetFinish: nullableDate(params.targetFinish),
      ActualStart: nullableDate(params.actualStart),
      ActualFinish: nullableDate(params.actualFinish),
      RemainingDurationDays: params.remainingDuration ?? null,
      Progress: params.progress ?? null,
      PlannedHours: params.plannedHours ?? null,
      ActualHours: params.actualHours ?? null,
      Budget: params.budget ?? null,
      Spent: params.spent ?? null,
      RecurrenceRule: params.recurrenceRule ?? null,
      RecurrenceParentTaskId: guid(params.recurrenceParentId),
      RecurrenceOccurrenceDate: nullableDate(params.recurrenceOccurrenceDate),
      SortOrder: params.sortOrder ?? null,
      RowVersion: nextVersion()
    });
    return result([[]]);
  }
  if (sqlText.includes('UPDATE dbo.MR_Tasks')) {
    const task = taskById(db, params.taskId);
    if (!task || !sameVersion(task.RowVersion, params.version)) return result([[{ Affected: 0 }]]);
    Object.assign(task, {
      ProjectId: guid(params.projectId),
      WbsId: guid(params.wbsId),
      CalendarId: guid(params.calendarId),
      Title: params.title,
      Description: params.description ?? null,
      Keyword: params.keyword ?? null,
      Status: params.status,
      Priority: params.priority,
      IsMilestone: params.isMilestone ? 1 : 0,
      PlannedStart: nullableDate(params.plannedStart),
      PlannedFinish: nullableDate(params.plannedFinish),
      PlannedDurationDays: params.plannedDuration ?? null,
      TargetFinish: nullableDate(params.targetFinish),
      ActualStart: nullableDate(params.actualStart),
      ActualFinish: nullableDate(params.actualFinish),
      RemainingDurationDays: params.remainingDuration ?? null,
      Progress: params.progress ?? null,
      PlannedHours: params.plannedHours ?? null,
      ActualHours: params.actualHours ?? null,
      Budget: params.budget ?? null,
      Spent: params.spent ?? null,
      RecurrenceRule: params.recurrenceRule ?? null,
      RecurrenceParentTaskId: guid(params.recurrenceParentId),
      RecurrenceOccurrenceDate: nullableDate(params.recurrenceOccurrenceDate),
      SortOrder: params.sortOrder ?? null,
      RowVersion: nextVersion()
    });
    return result([[{ Affected: 1 }]]);
  }
  if (sqlText.includes('DELETE dbo.MR_TaskDependencies WHERE TaskId = @taskId;')) {
    db.taskDependencies = db.taskDependencies.filter((entry) => !sameGuid(entry.TaskId, params.taskId));
    db.taskAssignees = db.taskAssignees.filter((entry) => !sameGuid(entry.TaskId, params.taskId));
    return result([[]]);
  }
  // Tam yetkisi olmayan yazmada bağımlılık satırları KORUNUR; yalnızca
  // sorumlular yeniden yazılır (bkz. commitTask · fullProjectWrite).
  if (sqlText.trim() === 'DELETE dbo.MR_TaskAssignees WHERE TaskId = @taskId;') {
    db.taskAssignees = db.taskAssignees.filter((entry) => !sameGuid(entry.TaskId, params.taskId));
    return result([[]]);
  }
  if (sqlText.includes('DELETE dbo.MR_TaskDependencies')) {
    db.taskDependencies = db.taskDependencies
      .filter((entry) => !sameGuid(entry.TaskId, params.taskId) && !sameGuid(entry.PredecessorTaskId, params.taskId));
    return result([[]]);
  }
  if (sqlText.includes('INSERT dbo.MR_TaskAssignees(')) {
    db.taskAssignees.push({ TaskId: guid(params.taskId), Sicil: params.sicil });
    return result([[]]);
  }
  if (sqlText.includes('INSERT dbo.MR_TaskDependencies(')) {
    db.taskDependencies.push({
      TaskDependencyId: guid(params.dependencyId),
      ProjectId: guid(params.projectId),
      TaskId: guid(params.taskId),
      PredecessorTaskId: guid(params.predecessorId),
      DependencyType: params.type,
      LagDays: params.lagDays ?? 0,
      LagValue: params.lagValue ?? null,
      LagUnit: params.lagUnit ?? null
    });
    return result([[]]);
  }
  if (sqlText.includes('INSERT dbo.MR_AuditLog(')) {
    db.auditLog.push({
      ActorSicil: params.actorSicil,
      ActionCode: params.actionCode,
      EntityType: params.entityType,
      EntityId: params.entityId,
      ProjectId: guid(params.projectId)
    });
    return result([[]]);
  }

  throw new Error(`Fake SQL Server received an unsupported statement for ${database}: ${sqlText.trim().slice(0, 160)}`);
}

function tableRows(db, table) {
  return {
    MR_Projects: db.projects,
    MR_WBS: db.wbs,
    MR_Tasks: db.tasks,
    MR_Calendars: db.calendars
  }[table] || [];
}

/**
 * `mssql` sürücüsü yerine geçen ikizi üretir. `database` alanı, MERGEN Rota
 * veritabanı ile CN43N kaynağının aynı ikiz üzerinden ayrışmasını sağlar.
 */
export function createFakeSqlServerDriver(db) {
  class FakeRequest {
    constructor(pool) {
      this.pool = pool;
      this.params = {};
    }

    input(name, type, value) {
      // İmza `input(name, value)` biçiminde de çağrılabilir.
      this.params[name] = arguments.length >= 3 ? value : type;
      return this;
    }

    async query(statement) {
      const database = this.pool.config?.database || 'MERGEN_Rota';
      db.statements.push({ sql: String(statement), database });
      return runQuery(db, statement, this.params, { database });
    }
  }

  class FakeConnectionPool {
    constructor(config) {
      this.config = config;
      this.listeners = new Map();
    }

    on(event, handler) {
      this.listeners.set(event, handler);
      return this;
    }

    async connect() {
      this.connected = true;
      return this;
    }

    request() {
      return new FakeRequest(this);
    }
  }

  class FakeTransaction {
    constructor(pool) {
      this.pool = pool;
      this.config = pool.config;
      this._aborted = false;
    }

    async begin(isolationLevel) {
      this.began = true;
      db.transactions.push({ isolationLevel, statementIndex: db.statements.length });
    }
    async commit() { this.committed = true; }
    async rollback() { this.rolledBack = true; }

    request() {
      return new FakeRequest(this.pool);
    }
  }

  return { ConnectionPool: FakeConnectionPool, Transaction: FakeTransaction, db };
}
