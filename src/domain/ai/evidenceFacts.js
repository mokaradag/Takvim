import { claimableField, evidenceSemantic } from './claimableEvidence.js';

export const FACT_LIMITS = Object.freeze({ maxFacts: 256, maxClaims: 64, maxDepth: 12, maxAnswerChars: 24000 });

const LABELS = Object.freeze({
  returnedCount: ['Dönen kayıt', 'Returned records'], totalCount: ['Eşleşen kayıt', 'Matching records'],
  total: ['Toplam', 'Total'],
  totals: ['Özet', 'Summary'], task: ['Görev', 'Task'],
  counts: ['Sayılar', 'Counts'], project: ['Proje', 'Project'], projects: ['Proje', 'Projects'],
  cost: ['Maliyet', 'Cost'], dates: ['Tarihler', 'Dates'],
  hours: ['Saat ve bütçe', 'Hours and budget'], plannedHoursOnAssignedTasks: ['Atanmış görevlerin planlanan saati', 'Planned hours on assigned tasks'],
  actualHoursOnAssignedTasks: ['Atanmış görevlerin gerçekleşen saati', 'Actual hours on assigned tasks'],
  tasksWithValue: ['Değeri bilinen görev', 'Tasks with a known value'], tasksWithoutValue: ['Değeri bilinmeyen görev', 'Tasks without a value'],
  structuredChanges: ['Alan değişikliği', 'Field change'], activities: ['Hareketler', 'Activities'], items: ['Kayıt', 'Record'],
  predecessorCount: ['Öncül sayısı', 'Predecessor count'], successorCount: ['Ardıl sayısı', 'Successor count'],
  dependencyCount: ['Bağımlılık sayısı', 'Dependency count'], occurrenceCount: ['Tekrar sayısı', 'Occurrence count'],
  workingDayCount: ['Çalışma günü sayısı', 'Working day count'], activityEventCount: ['Hareket sayısı', 'Activity event count'],
  coverage: ['Kapsama', 'Coverage'],
  baseline: ['Baz plan', 'Baseline'], snapshotTasks: ['Baz plandaki görev', 'Baseline tasks'],
  compared: ['Karşılaştırılan görev', 'Compared tasks'], finishEarlier: ['Bitişi öne alınan görev', 'Tasks with earlier finish'],
  finishUnchanged: ['Bitişi değişmeyen görev', 'Tasks with unchanged finish'], missingDates: ['Tarihi eksik görev', 'Tasks with missing dates'],
  removedSinceBaseline: ['Baz plandan sonra kaldırılan görev', 'Tasks removed since baseline'],
  finishVariance: ['Bitiş sapması', 'Finish variance'], averageDays: ['Ortalama (gün)', 'Average (days)'],
  maxSlipDays: ['En büyük kayma (gün)', 'Maximum slip (days)'], maxEarlierDays: ['En büyük öne alma (gün)', 'Maximum advance (days)'],
  baselineFinish: ['Baz plan bitişi', 'Baseline finish'], varianceDays: ['Sapma (gün)', 'Variance (days)'],
  isPrimary: ['Birincil baz plan', 'Primary baseline'], taskCount: ['Görev sayısı', 'Task count'],
  relationCount: ['İlişki sayısı', 'Relation count'], predecessors: ['Öncüller', 'Predecessors'], successors: ['Ardıllar', 'Successors'],
  tasksWithPredecessor: ['Öncülü olan görev', 'Tasks with predecessors'], tasksWithSuccessor: ['Ardılı olan görev', 'Tasks with successors'],
  tasksWithoutAnyDependency: ['Bağımsız görev', 'Independent tasks'], withPositiveLag: ['Pozitif gecikmeli ilişki', 'Relations with positive lag'],
  withNegativeLag: ['Negatif gecikmeli ilişki', 'Relations with negative lag'], byType: ['Tür dağılımı', 'By type'],
  FS: ['Bitiş-başlangıç', 'Finish-start'], SS: ['Başlangıç-başlangıç', 'Start-start'],
  FF: ['Bitiş-bitiş', 'Finish-finish'], SF: ['Başlangıç-bitiş', 'Start-finish'],
  type: ['Tür', 'Type'], lag: ['Gecikme', 'Lag'], value: ['Değer', 'Value'], unit: ['Birim', 'Unit'],
  series: ['Tekrar serisi', 'Recurrence series'], seriesCount: ['Seri sayısı', 'Series count'],
  visibleOccurrences: ['Görünür yineleme', 'Visible occurrences'], upcomingCount: ['Yaklaşan yineleme', 'Upcoming occurrences'],
  occurrenceDate: ['Yineleme tarihi', 'Occurrence date'], recurring: ['Tekrarlayan görev', 'Recurring task'],
  templateVisible: ['Şablon görünür', 'Template visible'], next: ['Sonraki yineleme', 'Next occurrence'],
  lastCompleted: ['Son tamamlanan yineleme', 'Last completed occurrence'],
  calendarSource: ['Takvim kaynağı', 'Calendar source'], completionDatesComplete: ['Gerçek bitiş tarihleri tam', 'Actual finish dates complete'],
  calendar: ['Takvim', 'Calendar'], range: ['Tarih aralığı', 'Date range'], from: ['Başlangıç', 'From'], to: ['Bitiş', 'To'],
  workingWeekdays: ['Çalışılan haftanın günü', 'Working weekday'], holidays: ['Tatiller', 'Holidays'], date: ['Tarih', 'Date'],
  openTasks: ['Açık görev', 'Open tasks'], unassignedOpenTasks: ['Görünür sorumlusu olmayan açık görev', 'Open tasks without a visible assignee'],
  tasksWithPlannedHours: ['Planlanan saati bilinen görev', 'Tasks with known planned hours'],
  directorate: ['Başkanlık', 'Directorate'], department: ['Müdürlük', 'Department'], organization: ['Organizasyon', 'Organization'],
  awaitingYourDecision: ['Kararınızı bekleyen', 'Awaiting your decision'], actionRequired: ['İşlem bekleyen', 'Action required'],
  sent: ['Gönderilen', 'Sent'], history: ['Geçmiş', 'History'], unread: ['Okunmamış', 'Unread'],
  proposedChanges: ['Önerilen değişiklikler', 'Proposed changes'], requester: ['Talep eden', 'Requester'],
  requesterMessage: ['Talep iletisi', 'Requester message'], decisionOwner: ['Karar sahibi', 'Decision owner'],
  byState: ['Teslim durumu dağılımı', 'Delivery state distribution'], byStateComplete: ['Teslim durumu dağılımı tam', 'Delivery state distribution complete'],
  subscriptionsForTasksNoLongerVisible: ['Görünmeyen görev aboneliği var', 'Has subscriptions for non-visible tasks'],
  active: ['Etkin', 'Active'], pending: ['Bekleyen', 'Pending'], paused: ['Bekletilen', 'Paused'], failed: ['Başarısız', 'Failed'],
  checks: ['Kalite denetimi', 'Quality check'], examples: ['Örnek', 'Example'],
  completedWithoutActualFinish: ['Gerçekleşen bitişi eksik tamamlanan görev', 'Completed tasks without actual finish'],
  access: ['Erişim', 'Access'], level: ['Erişim düzeyi', 'Access level'], reasons: ['Erişim nedeni', 'Access reason'],
  completeTaskView: ['Tam görev görünümü', 'Complete task view'],
  dependenciesAndBaselines: ['Bağımlılık ve baz plan erişimi', 'Dependency and baseline access'],
  title: ['Başlık', 'Title'], name: ['Ad', 'Name'], code: ['Kod', 'Code'], description: ['Açıklama', 'Description'],
  keyword: ['Etiket', 'Label'], status: ['Durum', 'Status'], priority: ['Öncelik', 'Priority'],
  milestone: ['Kilometre taşı', 'Milestone'], progress: ['İlerleme (%)', 'Progress (%)'],
  targetFinish: ['Termin', 'Deadline'], plannedFinish: ['Planlanan bitiş', 'Planned finish'],
  calendarDate: ['Takvim tarihi', 'Calendar date'], plannedStart: ['Planlanan başlangıç', 'Planned start'],
  actualStart: ['Gerçekleşen başlangıç', 'Actual start'], actualFinish: ['Gerçekleşen bitiş', 'Actual finish'],
  plannedDurationDays: ['Planlanan süre (gün)', 'Planned duration (days)'],
  remainingDurationDays: ['Kalan süre (gün)', 'Remaining duration (days)'],
  plannedHours: ['Planlanan saat', 'Planned hours'], actualHours: ['Gerçekleşen saat', 'Actual hours'],
  budget: ['Bütçe', 'Budget'], spent: ['Harcama', 'Spent'],
  todo: ['Yapılacak görev', 'Tasks to do'], inProgress: ['Devam eden görev', 'Tasks in progress'],
  done: ['Tamamlanan görev', 'Completed tasks'], open: ['Açık görev', 'Open tasks'],
  overdue: ['Gecikmiş görev', 'Overdue tasks'], overdueDays: ['Gecikme (gün)', 'Overdue days'],
  completionRatePercent: ['Tamamlanma oranı (%)', 'Completion rate (%)'],
  dueToday: ['Bugün terminli görev', 'Tasks due today'], dueNext7Days: ['Yedi gün içinde terminli görev', 'Tasks due within seven days'],
  openWithoutTargetFinish: ['Terminsiz açık görev', 'Open tasks without a deadline'],
  doneWithoutActualFinish: ['Gerçekleşen bitişi eksik tamamlanan görev', 'Completed tasks without actual finish'],
  milestonesOpen: ['Açık kilometre taşı', 'Open milestones'], count: ['Kayıt sayısı', 'Record count'],
  sourceType: ['Kaynak türü', 'Source type'], source: ['Kaynak', 'Source'], lead: ['Proje lideri', 'Project lead'],
  before: ['Önceki değer', 'Before'], after: ['Sonraki değer', 'After'], field: ['Değişen alan', 'Changed field'],
  changes: ['Değişiklik metni', 'Change text'], actor: ['İşlemi yapan', 'Actor'], kind: ['İşlem türü', 'Event type'],
  occurredAt: ['İşlem zamanı', 'Event time'], createdAt: ['Oluşturma zamanı', 'Created at'], updatedAt: ['Güncelleme zamanı', 'Updated at'],
  events: ['Hareket sayısı', 'Event count'], tasks: ['Görev sayısı', 'Task count'], people: ['Kişi sayısı', 'Person count'],
  completedTasks: ['Tamamlanan görev sayısı', 'Completed task count'],
  finishSlipped: ['Bitişi kayan görev', 'Tasks with slipped finish'], startSlipped: ['Başlangıcı kayan görev', 'Tasks with slipped start'],
  addedSinceBaseline: ['Baz plandan sonra eklenen görev', 'Tasks added since baseline'],
  missingTasks: ['Artık bulunmayan baz plan görevi', 'Missing baseline tasks'],
  workingDays: ['Çalışma günü', 'Working days'], calendarDays: ['Takvim günü', 'Calendar days'],
  unreadCount: ['Okunmamış bildirim', 'Unread notifications'], actionRequiredCount: ['İşlem bekleyen bildirim', 'Notifications requiring action'],
  activeSubscriptions: ['Görünür görev aboneliği', 'Visible task subscriptions'],
  available: ['Kayıt kullanılabilir', 'Record available'], complete: ['Sonuç tam', 'Result complete'], truncated: ['Sonuç kısaltıldı', 'Result truncated'],
  unassigned: ['Görünür sorumlusu olmayan görev', 'Tasks without a visible assignee'],
  rule: ['Tekrar kuralı', 'Recurrence rule'], recurrenceRule: ['Tekrar kuralı', 'Recurrence rule'],
  state: ['Teslim durumu', 'Delivery state'], attempts: ['Gönderim denemesi', 'Delivery attempts'],
  openTaskCount: ['Açık görev sayısı', 'Open task count'], cleanOpenTaskCount: ['Eksiksiz açık görev', 'Clean open tasks'],
  label: ['Etiket metni', 'Label text'], note: ['Kaynak notu', 'Source note'], guidance: ['Kaynak açıklaması', 'Source guidance'],
  wbsPath: ['İş dağılım yolu', 'WBS path'],
  statusLabel: ['Durum', 'Status'],
  priorityLabel: ['Öncelik', 'Priority'],
  kindLabel: ['Hareket türü', 'Event kind'],
  progressPercent: ['İlerleme (%)', 'Progress (%)'],
  planned: ['Planlanan saat', 'Planned hours'],
  actual: ['Gerçekleşen saat', 'Actual hours'],
  directTasks: ['Doğrudan görev', 'Direct tasks'],
  subtreeTasks: ['Alt ağaç görevleri', 'Subtree tasks'],
  subtreeOpen: ['Alt ağaç açık görevleri', 'Subtree open tasks'],
  subtreeOverdue: ['Alt ağaç gecikmiş görevleri', 'Subtree overdue tasks'],
  childCount: ['Alt düğüm', 'Child nodes'],
  visibleEntryCount: ['Görünür tekrar kaydı', 'Visible recurrence entries'],
  ambiguous: ['Aday seçimi gerekli', 'Candidate selection required'],
  availableBaselinesTruncated: ['Baz plan listesi kısaltıldı', 'Baseline list truncated'],
  groupCount: ['Grup sayısı', 'Group count'],
  key: ['Grup anahtarı', 'Group key'],
  nodeCount: ['Düğüm sayısı', 'Node count'],
  tasksWithoutWbs: ['İş dağılımı olmayan görev', 'Tasks without WBS'],
  depth: ['Derinlik', 'Depth'],
  worstOverdueDays: ['En büyük gecikme (gün)', 'Worst overdue days'],
  jobTitle: ['Unvan', 'Job title'],
  projectsWithOverdue: ['Gecikmiş görevi olan proje', 'Projects with overdue tasks'],
  tags: ['Proje etiketleri', 'Project tags'],
  dataDate: ['Veri tarihi', 'Data date'],
  tagCount: ['Etiket sayısı', 'Tag count'],
  wbsNodeCount: ['İş dağılım düğümü', 'WBS nodes'],
  baselineCount: ['Baz plan sayısı', 'Baseline count'],
  decisionMessage: ['Karar iletisi', 'Decision message'],
  requestedAssignee: ['Talep edilen sorumlu', 'Requested assignee'],
  requestedAssigneeOrganization: ['Talep edilen kişinin birimi', 'Requested assignee organization'],
  suggestedAssignee: ['Önerilen sorumlu', 'Suggested assignee'],
  decidedBy: ['Karar veren', 'Decided by'],
  decidedAt: ['Karar zamanı', 'Decision time'],
  yourRole: ['Talepteki rolünüz', 'Your request role'],
  actionRequiredFromYou: ['İşleminiz bekleniyor', 'Your action required'],
  mode: ['Talep kipi', 'Request mode'],
  modeLabel: ['Talep kipi', 'Request mode'],
  canDecide: ['Karar yetkiniz var', 'Can decide'],
  ruleDescription: ['Tekrar kuralı açıklaması', 'Recurrence rule description'],
  nextTruncated: ['Sonraki kayıtlar kısaltıldı', 'Upcoming records truncated'],
  typeLabel: ['İlişki türü', 'Relationship type'],
  timeZone: ['Saat dilimi', 'Time zone'],
  short: ['Kısa ad', 'Short name'],
  suspended: ['Bekletilen', 'Suspended'],
  delivered: ['Gönderilen', 'Delivered'],
  stateLabel: ['Teslim durumu', 'Delivery state'],
  by: ['İşlemi yapan', 'Actor'],
  at: ['Zaman', 'Time'],
  deliveredCalendarDate: ['Son gönderilen takvim tarihi', 'Last delivered calendar date'],
  lastDeliveredAt: ['Son gönderim zamanı', 'Last delivery time'],
  message: ['Hizmet iletisi', 'Service message']
});
const CANONICAL_FIELDS = new Set(Object.keys(LABELS).filter((key) => !['note', 'guidance', 'field'].includes(key)));

function scalar(value) {
  return value === null || typeof value === 'string' || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value));
}

function subjectName(value, inherited) {
  return [value?.title, value?.name, value?.code, value?.task?.title, value?.person?.name, value?.label]
    .find((item) => typeof item === 'string' && item.trim()) || inherited;
}

export function createEvidenceFacts(envelope, { prefix, subject = 'Rota', fields = null } = {}) {
  if (typeof prefix !== 'string' || !/^[a-f0-9]{16}_R\d+$/.test(prefix)) return [];
  const facts = [];
  const selected = fields ? [...new Set(fields)].filter((field) => typeof field === 'string') : null;
  const visit = (value, path, name, depth, changeField = null) => {
    if (depth > FACT_LIMITS.maxDepth || facts.length >= FACT_LIMITS.maxFacts) return;
    if (selected && !selected.some((field) => field === path || field.startsWith(`${path}.`))) return;
    if (scalar(value)) {
      if (!claimableField(envelope, path, CANONICAL_FIELDS, changeField)) return;
      facts.push({ semantic: evidenceSemantic(envelope, path, value, factLabel(path)), factId: `${prefix}:${path}`, subjectId: path.includes('.') ? path.slice(0, path.lastIndexOf('.')) : 'result',
        subject: name, field: path, ...(changeField ? { changeField } : {}), type: value === null ? 'null' : typeof value, value });
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}.${index}`, subjectName(item, name), depth + 1));
    } else if (value && typeof value === 'object') {
      const named = subjectName(value, null);
      for (const [key, item] of Object.entries(value)) {
        visit(item, `${path}.${key}`, named || name, depth + 1, Object.hasOwn(LABELS, value.field) ? value.field : null);
      }
    }
  };
  for (const key of ['returnedCount', 'totalCount', 'complete', 'truncated']) {
    if (scalar(envelope[key])) visit(envelope[key], key, subject, 0);
  }
  visit(envelope.data, 'data', subjectName(envelope.data, subject), 0);
  return facts;
}

export function factLabel(field, locale = 'tr') {
  const keys = String(field).split('.').filter((key) => key !== 'data' && !/^\d+$/.test(key));
  const names = keys.map((key) => LABELS[key]?.[locale === 'en' ? 1 : 0] || (locale === 'en' ? 'Value' : 'Değer'));
  return names.join(' / ');
}

export function escapedFactText(value) {
  return String(value).replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/[【】]/g, (mark) => mark === '【' ? '(' : ')')
    .replace(/([\\`*_{}\[\]()#+.!|<>~:/\-])/g, '\\$1');
}

export function renderEvidenceFact(fact, evidenceId, locale = 'tr') {
  const leaf = fact.field.split('.').filter((part) => !/^\d+$/.test(part)).at(-1);
  const values = {
    status: { todo: ['Yapılacak', 'To do'], in_progress: ['Devam ediyor', 'In progress'], done: ['Tamamlandı', 'Done'] },
    priority: { low: ['Düşük', 'Low'], medium: ['Orta', 'Medium'], high: ['Yüksek', 'High'], critical: ['Kritik', 'Critical'] },
    sourceType: { corporate: ['Kurumsal', 'Corporate'], manual: ['Manuel', 'Manual'] },
    source: { project: ['Proje takvimi', 'Project calendar'], default: ['Varsayılan takvim', 'Default calendar'] },
    kind: { created: ['Oluşturuldu', 'Created'], updated: ['Güncellendi', 'Updated'], completed: ['Tamamlandı', 'Completed'], deleted: ['Silindi', 'Deleted'] },
    mode: { REQUEST: ['Onay talebi', 'Approval request'], NOTICE: ['Bildirim', 'Notice'] },
    state: { failed: ['Başarısız', 'Failed'], suspended: ['Bekletiliyor', 'Suspended'], pending: ['Bekliyor', 'Pending'], delivered: ['Etkin', 'Delivered'] },
    unit: { day: ['Gün', 'Days'], week: ['Hafta', 'Weeks'], month: ['Ay', 'Months'], hour: ['Saat', 'Hours'], unknown: ['Bilinmeyen birim', 'Unknown unit'] },
    level: { FULL: ['Tam erişim', 'Full access'], PARTIAL: ['Kısmi erişim', 'Partial access'], READ: ['Okuma erişimi', 'Read access'] },
    yourRole: { requester: ['Talep eden', 'Requester'], 'decision-owner': ['Karar sahibi', 'Decision owner'], 'requester-and-decision-owner': ['Talep eden ve karar sahibi', 'Requester and decision owner'] },
    reasons: { SYSTEM_ADMIN: ['Sistem yöneticisi', 'System administrator'], CORPORATE_PROJECT_ROLE: ['Kurumsal proje rolü', 'Corporate project role'], MANUAL_OWNER: ['Manuel proje sahibi', 'Manual project owner'], MANUAL_PROJECT_LEAD: ['Proje lideri', 'Project lead'], MANUAL_GRANT: ['Proje erişim hibesi', 'Project access grant'], EXECUTIVE_SCOPE: ['Yönetim kapsamındaki çalışanın görevi', 'Task of an employee in management scope'], ASSIGNEE: ['Görev sorumlusu', 'Task assignee'], TASK_CREATOR: ['Görevi oluşturan', 'Task creator'], OTHER: ['Diğer', 'Other'] }

  };
  for (const labels of Object.values(values.reasons)) values.reasons[labels[0]] = labels;
  // Takvim aracı çalışılan günleri Türkçe adlarıyla döndürür; sayısal gün kimliği de desteklenir.
  const weekdays = [['Pazar', 'Sunday'], ['Pazartesi', 'Monday'], ['Salı', 'Tuesday'], ['Çarşamba', 'Wednesday'], ['Perşembe', 'Thursday'], ['Cuma', 'Friday'], ['Cumartesi', 'Saturday']];
  values.workingWeekdays = Object.fromEntries(weekdays.flatMap((label, index) => [[index, label], [label[0], label]]));
  values.calendarSource = { ...values.source, task: ['Görev takvimi', 'Task calendar'] };
  // Aynı durum kodu iş akışına göre farklı anlam taşır (ör. APPROVED: tarih talebinde
  // "Onaylandı", atama koordinasyonunda "Atandı"); tablo kanıtın aracından seçilir.
  const scheduleStatuses = { PENDING: ['Bekliyor', 'Pending'], ACCEPTED: ['Kabul edildi', 'Accepted'], APPROVED: ['Onaylandı', 'Approved'], REJECTED: ['Reddedildi', 'Rejected'], CANCELLED: ['Değiştirildi', 'Superseded'], STALE: ['Güncelliğini yitirdi', 'Stale'] };
  const coordinationStatuses = { PENDING: ['Onay bekliyor', 'Awaiting approval'], APPROVED: ['Atandı', 'Assigned'], REJECTED: ['Reddedildi', 'Rejected'], CANCELLED: ['İptal edildi', 'Cancelled'], STALE: ['Güncelliğini yitirdi', 'Stale'], CHANGE_REQUESTED: ['Değişiklik istendi', 'Change requested'], CANCELLATION_REQUESTED: ['Kaldırılması istendi', 'Cancellation requested'] };
  const tool = fact.semantic?.provenance?.tool;
  const statusDomain = tool === 'rota_schedule_requests' || (tool === 'rota_notifications' && fact.field.startsWith('data.scheduleRequests.')) ? 'schedule'
    : tool === 'rota_assignment_requests' || (tool === 'rota_notifications' && fact.field.startsWith('data.assignmentCoordination.')) ? 'coordination' : null;
  const workflowStatuses = statusDomain === 'schedule' ? scheduleStatuses : statusDomain === 'coordination' ? coordinationStatuses
    : { ...scheduleStatuses, ...coordinationStatuses, PENDING: ['Bekliyor', 'Pending'] };
  Object.assign(values.status, workflowStatuses);
  const semanticLeaf = fact.changeField || (leaf === 'key' ? fact.semantic?.groupBy : leaf);
  const enumValues = semanticLeaf === 'source' && !fact.field.startsWith('data.calendar.') ? null : values[semanticLeaf] || (semanticLeaf === 'access' ? values.level : null);
  let value = fact.value;
  if (value === null) value = fact.semantic?.nullMeaning === 'undefined-cycle'
    ? (locale === 'en' ? 'Undefined because of a WBS cycle' : 'WBS döngüsü nedeniyle tanımsız')
    : (locale === 'en' ? 'Not specified' : 'Belirtilmemiş');
  else if (enumValues && leaf !== 'key') value = enumValues[value]?.[locale === 'en' ? 1 : 0] || (locale === 'en' ? 'Unknown value' : 'Bilinmeyen değer');
  else if (fact.semantic?.displayValue != null) value = fact.semantic.displayValue;
  else if (typeof value === 'boolean') value = value ? (locale === 'en' ? 'Yes' : 'Evet') : (locale === 'en' ? 'No' : 'Hayır');
  else if (typeof value === 'number') value = new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'tr-TR', { maximumFractionDigits: 20 }).format(value);
  else if (fact.semantic?.decimalScale != null && /^-?\d+\.\d+$/.test(String(value))) {
    const [whole, fraction] = String(value).split('.');
    value = `${new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'tr-TR').format(BigInt(whole))}${locale === 'en' ? '.' : ','}${fraction}`;
  } else if (leaf === 'key' && fact.semantic?.group) value = fact.semantic.group.label;
  else if (enumValues) value = enumValues[value]?.[locale === 'en' ? 1 : 0] || (locale === 'en' ? 'Unknown value' : 'Bilinmeyen değer');
  const language = locale === 'en' ? 1 : 0;
  // Sayımın nüfusunu belirleyen her süzgeç niteleyici olarak yazılır: farklı
  // süzgeçlerle elde edilen eşit sayılar ayırt edilebilir kalır.
  // Görev süzgecindeki proje, olgunun öznesinde (proje adı) zaten görünür; talep süzgecinin kimlikleri ayrıca yazılır.
  const filterNames = { text: ['Arama metni', 'Search text'], requestProjectId: ['Proje kimliği', 'Project ID'], requestTaskId: ['Görev kimliği', 'Task ID'],
    wbsId: ['İş dağılımı düğümü', 'WBS node'], tab: ['Sekme', 'Tab'], workflowStatus: ['Talep durumu', 'Request status'],
    source: ['Proje kaynağı', 'Project source'], includeEmpty: ['Görünür görevi olmayan projeler', 'Projects without visible tasks'],
    statuses: ['Durum', 'Status'], priorities: ['Öncelik', 'Priority'], deadline: ['Termin', 'Deadline'],
    dateField: ['Tarih alanı', 'Date field'], dateFrom: ['İlk tarih', 'First date'], dateTo: ['Son tarih', 'Last date'],
    assignee: ['Sorumlu', 'Assignee'], personSicil: ['Kişi (Sicil)', 'Person (Sicil)'], createdByMe: ['Oluşturduklarım', 'Created by me'], milestone: ['Kilometre taşı', 'Milestone'] };
  const filterValues = { ...values.status, ...values.priority, overdue: ['Gecikmiş', 'Overdue'],
    due_today: ['Bugün', 'Today'], due_next_7_days: ['Bugün dahil yedi gün', 'Seven days including today'],
    due_next_30_days: ['Bugün dahil otuz gün', 'Thirty days including today'], no_target_finish: ['Terminsiz', 'No deadline'],
    me: ['Ben', 'Me'], person: ['Seçilen kişi', 'Selected person'], unassigned: ['Görünür sorumlu yok', 'No visible assignee'] };
  const tabValues = { pending: ['Bekleyen', 'Pending'], sent: ['Gönderilen', 'Sent'], history: ['Geçmiş', 'History'], all: ['Tümü', 'All'] };
  const filterValue = (value) => typeof value === 'boolean' ? (value ? ['Evet', 'Yes'] : ['Hayır', 'No'])[language]
    : filterValues[value]?.[language] || LABELS[value]?.[language] || (/^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? value : null);
  const qualifierValue = (key, value) => {
    if (value == null || value === '' || value === 'any' || (Array.isArray(value) && !value.length)) return null;
    switch (key) {
      case 'text': return `"${String(value)}"`;
      case 'requestProjectId': case 'requestTaskId': case 'wbsId': case 'personSicil': return String(value);
      case 'tab': return tabValues[value]?.[language] || null;
      case 'workflowStatus': return workflowStatuses[value]?.[language] || null;
      case 'source': return value === 'all' ? null : values.sourceType[value]?.[language] || null;
      case 'includeEmpty': return value === false ? ['Hariç', 'Excluded'][language] : null;
      case 'createdByMe': return value === true ? filterValue(true) : null;
      default: return (Array.isArray(value) ? value : [value]).map(filterValue).filter(Boolean).join(', ') || null;
    }
  };
  const qualifiers = Object.entries(fact.semantic?.filters || {}).filter(([key]) => filterNames[key])
    .map(([key, value]) => [filterNames[key][language], qualifierValue(key, value)])
    .filter(([, value]) => value).map(([key, value]) => `${key}: ${value}`).join('; ');
  if (fact.semantic?.countScope === 'selected-tab' && fact.field.startsWith('data.counts.')) value = `${value} (${locale === 'en' ? 'selected tab' : 'seçilen sekme'})`;
  const units = { hours: ['saat', 'hours'], tasks: ['görev', 'tasks'], 'unspecified-currency': ['para birimi belirtilmemiş', 'currency unspecified'],
    day: ['gün', 'days'], week: ['hafta', 'weeks'], month: ['ay', 'months'], hour: ['saat', 'hours'], unknown: ['birimi bilinmiyor', 'unit unknown'], 'unknown-lag': ['birimi bilinmiyor', 'unit unknown'] };
  if (fact.value != null && units[fact.semantic?.unit]) value = `${value} ${units[fact.semantic.unit][language]}`;
  return `- “${escapedFactText(fact.subject)}”${qualifiers ? ` (${escapedFactText(qualifiers)})` : ''} · ${fact.changeField ? factLabel(fact.changeField, locale) + ' / ' : ''}${factLabel(fact.field, locale)}: ${escapedFactText(value)}. 【${evidenceId}】`;
}
