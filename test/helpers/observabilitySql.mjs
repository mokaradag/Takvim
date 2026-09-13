/**
 * Bellek içi SQL Server ikizinin gözlemlenebilirlik yüzeyi.
 *
 * Sistem Yönetimi uçları yeni tablolara (telemetri toplamları, işletim
 * olayları, uyarılar) ve birkaç yeni yoklama sorgusuna dayanır. Bu modül aynı
 * ikizin içinde o sorguları karşılar; böylece testler GERÇEK sunucu kodunu
 * (rota → servis → depo → SQL) çalıştırmaya devam eder.
 *
 * `db.observabilitySchemaMissing = true` verildiğinde yeni tablolar YOK sayılır
 * ve SQL Server'ın "Invalid object name" hatası taklit edilir: uygulamanın
 * 0012 yükseltmesi uygulanmadan da ayakta kalması sınanabilir.
 */

function missingObject(name) {
  const error = new Error(`Invalid object name 'dbo.${name}'.`);
  error.number = 208;
  return error;
}

function toMs(value) {
  if (value == null) return null;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function iso(value) {
  const time = toMs(value);
  return time == null ? null : new Date(time).toISOString();
}

/** Tohumlanmış satırlardaki en yüksek kimlik; SQL Server `IDENTITY` davranışı. */
function seededSequence(rows, key) {
  return rows.reduce((max, row) => Math.max(max, Number(row[key]) || 0), 0);
}

function ensureCollections(db) {
  db.telemetryOperationSamples ||= [];
  db.telemetryGaugeSamples ||= [];
  db.operationalEvents ||= [];
  db.operationalAlerts ||= [];
  // Sayaç, TOHUMLANMIŞ en yüksek kimlikten başlar. Sıfırdan başlarsa ilk ekleme
  // var olan bir kimliği yeniden üretir; onaylama ve sayfalama sınamaları
  // yanlış satırı hedefler ve gerçek sunucu davranışından ayrışır.
  db.operationalEventSequence ??= seededSequence(db.operationalEvents, 'OperationalEventId');
  db.operationalAlertSequence ??= seededSequence(db.operationalAlerts, 'OperationalAlertId');
}

/**
 * `DELETE TOP (@batchSize)` sınırı.
 *
 * Gerçek sunucu bir turda en çok `@batchSize` satır siler. İkiz hepsini
 * silerse, saklama sınırının parça parça ilerlemesi hiç sınanmaz.
 */
function deleteBounded(rows, matches, batchSize) {
  const limit = Math.max(0, Math.trunc(Number(batchSize) || 0));
  const kept = [];
  let removed = 0;
  for (const row of rows) {
    if (removed < limit && matches(row)) {
      removed += 1;
      continue;
    }
    kept.push(row);
  }
  return { kept, removed };
}

function guard(db, name) {
  if (db.observabilitySchemaMissing) throw missingObject(name);
}

function bucketKey(value) {
  const time = toMs(value);
  return time == null ? null : Math.floor(time / 300000) * 300000;
}

function groupSeries(rows, params, project) {
  const since = toMs(params.since);
  const until = toMs(params.until);
  const bucketSeconds = Math.max(60, Number(params.bucketSeconds) || 300);
  const grouped = new Map();
  for (const row of rows) {
    const at = toMs(row.BucketStart);
    if (at == null || at < since || at >= until) continue;
    const offset = Math.floor((at - since) / 1000 / bucketSeconds) * bucketSeconds * 1000;
    const key = since + offset;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  return [...grouped.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([key, entries]) => project(new Date(key).toISOString(), entries));
}

function operationSeriesRow(bucketStart, rows) {
  const sampleCount = rows.reduce((sum, row) => sum + row.SampleCount, 0);
  // Ölçülemeyen (NULL) yüzdelikler paya da paydaya da GİRMEZ; gerçek sorgu da
  // böyle davranır (bkz. telemetryQueries.js).
  const weighted = (key) => rows.reduce((sum, row) => sum + (row[key] == null ? 0 : row[key] * row.SampleCount), 0);
  const samplesFor = (key) => rows.reduce((sum, row) => sum + (row[key] == null ? 0 : row.SampleCount), 0);
  return {
    BucketStart: bucketStart,
    SampleCount: sampleCount,
    ErrorCount: rows.reduce((sum, row) => sum + row.ErrorCount, 0),
    DurationSumMs: rows.reduce((sum, row) => sum + row.DurationSumMs, 0),
    DurationMaxMs: rows.reduce((max, row) => Math.max(max, row.DurationMaxMs), 0),
    SourceRowCount: rows.length,
    P50Weighted: weighted('P50Ms'),
    P50Samples: samplesFor('P50Ms'),
    P95Weighted: weighted('P95Ms'),
    P95Samples: samplesFor('P95Ms'),
    P99Weighted: weighted('P99Ms'),
    P99Samples: samplesFor('P99Ms')
  };
}

/**
 * Üretimle AYNI arama normalleştirmesi.
 *
 * Depo katmanı metakarakterleri ATMAZ, `\` ile KAÇIRIR ve sorgular kalıbı
 * `ESCAPE '\'` ile okur. İkiz de aynı kalıbı çözer: yalnızca çevreleyen `%`
 * işaretleri atılır, kaçırılmış metakarakterler harfi harfine aranır. Aksi
 * halde `HTTP_500` araması ikizde ve üretimde farklı sonuç verirdi.
 */
function normalizedSearch(value) {
  const raw = String(value ?? '');
  const inner = raw.length >= 2 && raw.startsWith('%') && raw.endsWith('%') ? raw.slice(1, -1) : raw;
  return inner.replace(/\\([\\%_[])/g, '$1').toLowerCase();
}

function matchesEventFilters(event, params) {
  const since = toMs(params.since);
  if (since != null && toMs(event.OccurredAt) < since) return false;
  if (params.severity && event.Severity !== params.severity) return false;
  if (params.component && event.Component !== params.component) return false;
  if (params.eventCode && event.EventCode !== params.eventCode) return false;
  if (params.search) {
    const needle = normalizedSearch(params.search);
    const haystack = `${event.Summary} ${event.EventCode}`.toLowerCase();
    if (needle && !haystack.includes(needle)) return false;
  }
  return true;
}

/**
 * @returns {Array[]|null} kayıt kümeleri ya da sorgu tanınmadıysa `null`
 */
export function runObservabilityQuery(db, sqlText, params) {
  ensureCollections(db);

  /* ── Yoklamalar ─────────────────────────────────────────── */
  if (sqlText.includes('SELECT 1 AS DatabaseProbe')) {
    if (db.databaseProbeFails) {
      const error = new Error('Connection is closed.');
      error.code = 'ECONNCLOSED';
      throw error;
    }
    return [[{ DatabaseProbe: 1 }]];
  }
  if (sqlText.includes('AS DirectoryProbe')) {
    return [db.people.length ? [{ DirectoryProbe: 1 }] : []];
  }
  if (sqlText.includes('AS CorporateProjectProbe')) {
    return [db.corporateProjects.length ? [{ CorporateProjectProbe: 1 }] : []];
  }
  if (sqlText.includes('AS ResponsibilityProbe')) {
    return [db.corporateProjectAccess.length ? [{ ResponsibilityProbe: 1 }] : []];
  }
  if (sqlText.includes('MAX(SyncedAt) AS LastSyncedAt')) {
    const rows = db.corporateWbsSyncState;
    // Saklanan EN YENİ damga döner. Her okumada "şimdi" uydurulursa eşitlemenin
    // bayatlaması hiçbir zaman gözlenemez.
    const stored = rows.map((row) => toMs(row.SyncedAt)).filter((value) => value != null);
    const fallback = db.corporateWbsSyncedAt || new Date().toISOString();
    return [[{
      LastSyncedAt: stored.length ? new Date(Math.max(...stored)).toISOString() : (rows.length ? fallback : null),
      ProjectCount: rows.length,
      NodeCount: rows.reduce((sum, row) => sum + Number(row.NodeCount || 0), 0)
    }]];
  }
  if (sqlText.includes('SELECT TOP (1) Status, CreatedAt, CompletedAt, FailureCode')) {
    if (db.reminderSchemaMissing) throw missingObject('MR_TaskReminderLog');
    const row = [...db.taskReminderLog].reverse().find((entry) => entry.ReminderKind === 'AUTOMATIC');
    return [row ? [{ Status: row.Status, CreatedAt: row.CreatedAt, CompletedAt: row.CompletedAt, FailureCode: row.FailureCode }] : []];
  }

  /* ── Outlook kuyruk yaşı ve ayrıntısı ───────────────────── */
  if (sqlText.includes('AS OldestUnattemptedAt')) {
    const pending = db.taskOutlookSubscriptions.filter((row) => row.PendingMethod);
    const unattempted = pending.filter((row) => Number(row.AttemptCount || 0) === 0);
    const minOf = (rows, key) => rows.map((row) => toMs(row[key])).filter((value) => value != null).sort((a, b) => a - b)[0] ?? null;
    const maxOf = (rows, key) => rows.map((row) => toMs(row[key])).filter((value) => value != null).sort((a, b) => b - a)[0] ?? null;
    return [[{
      OldestUnattemptedAt: unattempted.length ? new Date(minOf(unattempted, 'UpdatedAt')).toISOString() : null,
      OldestPendingChangeAt: pending.length && minOf(pending, 'UpdatedAt') != null ? new Date(minOf(pending, 'UpdatedAt')).toISOString() : null,
      MaxAttemptCount: pending.reduce((max, row) => Math.max(max, Number(row.AttemptCount || 0)), 0),
      NextAttemptAt: pending.length && minOf(pending, 'NextAttemptAt') != null ? new Date(minOf(pending, 'NextAttemptAt')).toISOString() : null,
      LastDeliveredAt: maxOf(db.taskOutlookSubscriptions, 'LastDeliveredAt') != null
        ? new Date(maxOf(db.taskOutlookSubscriptions, 'LastDeliveredAt')).toISOString() : null,
      LastFailureAt: maxOf(db.taskOutlookSubscriptions.filter((row) => row.LastFailureCode), 'UpdatedAt') != null
        ? new Date(maxOf(db.taskOutlookSubscriptions.filter((row) => row.LastFailureCode), 'UpdatedAt')).toISOString() : null
    }]];
  }
  if (sqlText.includes('SELECT TOP (@limit) SubscriptionId, TaskId, PendingMethod')) {
    const rows = db.taskOutlookSubscriptions
      .filter((row) => row.PendingMethod)
      // Üretim eşit deneme sayısını `UpdatedAt ASC` ile ayırır; ikiz ekleme
      // sırasını korursa API sınamaları üretimden başka bir ilk satır görür.
      .sort((left, right) => (
        Number(right.AttemptCount || 0) - Number(left.AttemptCount || 0)
        || (toMs(left.UpdatedAt) ?? 0) - (toMs(right.UpdatedAt) ?? 0)
      ))
      .slice(0, Number(params.limit || 50))
      .map((row) => ({
        SubscriptionId: row.SubscriptionId,
        TaskId: row.TaskId,
        PendingMethod: row.PendingMethod,
        AttemptCount: Number(row.AttemptCount || 0),
        UpdatedAt: row.UpdatedAt,
        NextAttemptAt: row.NextAttemptAt,
        LastFailureCode: row.LastFailureCode,
        LeaseExpiresAt: row.LeaseExpiresAt,
        LastDeliveredAt: row.LastDeliveredAt
      }));
    return [rows];
  }
  if (sqlText.includes('SET AttemptCount = 0,') && sqlText.includes('LastFailureCode = NULL')
    && sqlText.includes('NextAttemptAt = NULL')) {
    const now = Date.now();
    const retried = db.taskOutlookSubscriptions.filter((row) => row.PendingMethod && row.LastFailureCode
      && (row.LeaseExpiresAt == null || toMs(row.LeaseExpiresAt) <= now));
    for (const row of retried) {
      row.AttemptCount = 0;
      row.NextAttemptAt = null;
      // Kayıt yeniden kuyruğa alındı: hata kodu TEMİZLENİR, aksi halde kuyruk
      // durumu onu hâlâ başarısız sayar ve aynı satır tekrar seçilir.
      row.LastFailureCode = null;
      row.UpdatedAt = new Date(now).toISOString();
    }
    return [retried.map((row) => ({ SubscriptionId: row.SubscriptionId }))];
  }

  /* ── Telemetri toplamları ───────────────────────────────── */
  if (sqlText.includes('MERGE dbo.MR_TelemetryOperationSamples')) {
    guard(db, 'MR_TelemetryOperationSamples');
    const key = bucketKey(params.bucketStart);
    const instanceId = params.instanceId ?? 'default';
    const existing = db.telemetryOperationSamples.find((row) => bucketKey(row.BucketStart) === key
      && row.Operation === params.operation && (row.InstanceId ?? 'default') === instanceId);
    if (existing) {
      // Aynı boşaltma İKİNCİ kez uygulanmaz; belirsiz hata sonrası yeniden
      // gönderilen satır sayıları tekrar toplamaz.
      if (existing.LastFlushId != null && existing.LastFlushId === params.flushId) return [[]];
      existing.SampleCount += Number(params.sampleCount || 0);
      existing.ErrorCount += Number(params.errorCount || 0);
      existing.DurationSumMs += Number(params.durationSumMs || 0);
      existing.DurationMaxMs = Math.max(existing.DurationMaxMs, Number(params.durationMaxMs || 0));
      existing.P50Ms = params.p50Ms ?? existing.P50Ms;
      existing.P95Ms = params.p95Ms ?? existing.P95Ms;
      existing.P99Ms = params.p99Ms ?? existing.P99Ms;
      // `COALESCE(@topFailureCode, target.TopFailureCode)` — ikiz bu alanı
      // güncellemezse ikinci boşaltmadan sonra bayat veri kalırdı.
      existing.TopFailureCode = params.topFailureCode ?? existing.TopFailureCode;
      existing.LastFlushId = params.flushId ?? existing.LastFlushId;
    } else {
      db.telemetryOperationSamples.push({
        BucketStart: iso(params.bucketStart),
        Operation: params.operation,
        InstanceId: instanceId,
        SampleCount: Number(params.sampleCount || 0),
        ErrorCount: Number(params.errorCount || 0),
        DurationSumMs: Number(params.durationSumMs || 0),
        DurationMaxMs: Number(params.durationMaxMs || 0),
        P50Ms: params.p50Ms ?? null,
        P95Ms: params.p95Ms ?? null,
        P99Ms: params.p99Ms ?? null,
        TopFailureCode: params.topFailureCode ?? null,
        LastFlushId: params.flushId ?? null
      });
    }
    return [[]];
  }
  if (sqlText.includes('MERGE dbo.MR_TelemetryGaugeSamples')) {
    guard(db, 'MR_TelemetryGaugeSamples');
    const key = bucketKey(params.bucketStart);
    const instanceId = params.instanceId ?? 'default';
    const existing = db.telemetryGaugeSamples.find((row) => bucketKey(row.BucketStart) === key
      && row.MetricKey === params.metricKey && (row.InstanceId ?? 'default') === instanceId);
    if (existing) {
      if (existing.LastFlushId != null && existing.LastFlushId === params.flushId) return [[]];
      const total = existing.SampleCount + Number(params.sampleCount || 0);
      existing.ValueAvg = ((existing.ValueAvg * existing.SampleCount) + (Number(params.valueAvg || 0) * Number(params.sampleCount || 0))) / (total || 1);
      existing.ValueMin = Math.min(existing.ValueMin, Number(params.valueMin || 0));
      existing.ValueMax = Math.max(existing.ValueMax, Number(params.valueMax || 0));
      existing.SampleCount = total;
      existing.LastFlushId = params.flushId ?? existing.LastFlushId;
    } else {
      db.telemetryGaugeSamples.push({
        BucketStart: iso(params.bucketStart),
        MetricKey: params.metricKey,
        InstanceId: instanceId,
        SampleCount: Number(params.sampleCount || 0),
        ValueAvg: Number(params.valueAvg || 0),
        ValueMin: Number(params.valueMin || 0),
        ValueMax: Number(params.valueMax || 0),
        LastFlushId: params.flushId ?? null
      });
    }
    return [[]];
  }
  if (sqlText.includes('FROM dbo.MR_TelemetryOperationSamples') && sqlText.includes('GROUP BY (DATEDIFF_BIG')) {
    guard(db, 'MR_TelemetryOperationSamples');
    const rows = db.telemetryOperationSamples.filter((row) => !params.operation || row.Operation === params.operation);
    return [groupSeries(rows, params, operationSeriesRow)];
  }
  if (sqlText.includes('FROM dbo.MR_TelemetryOperationSamples') && sqlText.includes('GROUP BY Operation')) {
    guard(db, 'MR_TelemetryOperationSamples');
    const since = toMs(params.since);
    const until = toMs(params.until);
    const grouped = new Map();
    for (const row of db.telemetryOperationSamples) {
      const at = toMs(row.BucketStart);
      if (at == null || at < since || at >= until) continue;
      if (!grouped.has(row.Operation)) grouped.set(row.Operation, []);
      grouped.get(row.Operation).push(row);
    }
    // Üretim ORTALAMA gecikmeye göre sıralar (bkz. telemetryQueries.js); ikiz
    // toplam süreye göre sıralarsa sınamalar başka bir "yavaş işlem" görür.
    const averageMs = (row) => (row.SampleCount > 0 ? row.DurationSumMs / row.SampleCount : 0);
    const rows = [...grouped.entries()].map(([operation, entries]) => ({
      Operation: operation,
      ...operationSeriesRow(null, entries),
      LastSeenAt: entries.map((entry) => entry.BucketStart).sort().slice(-1)[0] || null
    })).sort((left, right) => (averageMs(right) - averageMs(left))
      || (right.DurationSumMs - left.DurationSumMs));
    return [rows.slice(0, Number(params.limit || 25))];
  }
  if (sqlText.includes('FROM dbo.MR_TelemetryGaugeSamples') && sqlText.includes('GROUP BY MetricKey')) {
    guard(db, 'MR_TelemetryGaugeSamples');
    const keys = String(params.metricKeys || '').split(',').map((value) => value.trim()).filter(Boolean);
    const rows = db.telemetryGaugeSamples.filter((row) => keys.includes(row.MetricKey));
    const output = [];
    for (const key of keys) {
      const series = groupSeries(rows.filter((row) => row.MetricKey === key), params, (bucketStart, entries) => ({
        MetricKey: key,
        BucketStart: bucketStart,
        SampleCount: entries.reduce((sum, entry) => sum + entry.SampleCount, 0),
        ValueWeighted: entries.reduce((sum, entry) => sum + entry.ValueAvg * entry.SampleCount, 0),
        ValueMin: Math.min(...entries.map((entry) => entry.ValueMin)),
        ValueMax: Math.max(...entries.map((entry) => entry.ValueMax)),
        InstanceCount: new Set(entries.map((entry) => entry.InstanceId ?? 'default')).size
      }));
      output.push(...series);
    }
    return [output];
  }
  if (sqlText.includes('DELETE TOP (@batchSize) FROM dbo.MR_TelemetryOperationSamples')) {
    guard(db, 'MR_TelemetryOperationSamples');
    const cutoff = toMs(params.cutoff);
    const { kept, removed } = deleteBounded(db.telemetryOperationSamples,
      (row) => toMs(row.BucketStart) < cutoff, params.batchSize);
    db.telemetryOperationSamples = kept;
    return [Array.from({ length: removed }, () => ({}))];
  }
  if (sqlText.includes('DELETE TOP (@batchSize) FROM dbo.MR_TelemetryGaugeSamples')) {
    guard(db, 'MR_TelemetryGaugeSamples');
    const cutoff = toMs(params.cutoff);
    const { kept, removed } = deleteBounded(db.telemetryGaugeSamples,
      (row) => toMs(row.BucketStart) < cutoff, params.batchSize);
    db.telemetryGaugeSamples = kept;
    return [Array.from({ length: removed }, () => ({}))];
  }

  /* ── İşletim olayları ───────────────────────────────────── */
  if (sqlText.includes('INSERT dbo.MR_OperationalEvents')) {
    guard(db, 'MR_OperationalEvents');
    // Pencere içindeki aynı parmak izi TOPLANIR: bellekteki birleştirme
    // yalnızca tek turu kapsadığı için tur sınırında bölünen yineleme kalıcı
    // tarafta da tek satırda toplanmalıdır.
    const since = toMs(params.aggregateSince);
    const existing = params.aggregationKey == null ? null : [...db.operationalEvents]
      .filter((event) => event.AggregationKey === params.aggregationKey
        && (since == null || toMs(event.OccurredAt) >= since)
        && toMs(event.OccurredAt) <= toMs(params.occurredAt))
      .sort((left, right) => toMs(right.OccurredAt) - toMs(left.OccurredAt)
        || right.OperationalEventId - left.OperationalEventId)[0];
    if (existing) {
      existing.OccurrenceCount += Number(params.occurrenceCount || 1);
      const occurredAt = toMs(params.occurredAt);
      if (occurredAt != null && occurredAt > toMs(existing.OccurredAt)) existing.OccurredAt = iso(params.occurredAt);
      existing.Detail = params.detail ?? existing.Detail;
      existing.CorrelationId = params.correlationId ?? existing.CorrelationId;
      existing.ContextJson = params.contextJson ?? existing.ContextJson;
      return [[{ OperationalEventId: existing.OperationalEventId }]];
    }
    db.operationalEventSequence += 1;
    db.operationalEvents.push({
      OperationalEventId: db.operationalEventSequence,
      OccurredAt: iso(params.occurredAt),
      Severity: params.severity,
      Component: params.component,
      EventCode: params.eventCode,
      Summary: params.summary,
      Detail: params.detail ?? null,
      CorrelationId: params.correlationId ?? null,
      OccurrenceCount: Number(params.occurrenceCount || 1),
      ContextJson: params.contextJson ?? null,
      AggregationKey: params.aggregationKey ?? null
    });
    return [[{ OperationalEventId: db.operationalEventSequence }]];
  }
  if (sqlText.includes('FROM dbo.MR_OperationalEvents') && sqlText.includes('OFFSET @offset ROWS')) {
    guard(db, 'MR_OperationalEvents');
    const matching = db.operationalEvents
      .filter((event) => matchesEventFilters(event, params))
      .sort((left, right) => toMs(right.OccurredAt) - toMs(left.OccurredAt) || right.OperationalEventId - left.OperationalEventId);
    const page = matching.slice(Number(params.offset || 0), Number(params.offset || 0) + Number(params.limit || 25));
    // Sayfa boşken bile TOPLAM döner: gerçek sorgu sayımı sayfadan ayrı
    // hesaplar ve alan boş bir satırla taşır.
    if (!page.length) return [[{ OperationalEventId: null, TotalCount: matching.length }]];
    return [page.map((event) => ({ ...event, TotalCount: matching.length }))];
  }
  if (sqlText.includes('DELETE TOP (@batchSize) FROM dbo.MR_OperationalEvents')) {
    guard(db, 'MR_OperationalEvents');
    const cutoff = toMs(params.cutoff);
    const { kept, removed } = deleteBounded(db.operationalEvents,
      (event) => toMs(event.OccurredAt) < cutoff, params.batchSize);
    db.operationalEvents = kept;
    return [Array.from({ length: removed }, () => ({}))];
  }

  /* ── Uyarılar ───────────────────────────────────────────── */
  if (sqlText.includes('MERGE dbo.MR_OperationalAlerts')) {
    guard(db, 'MR_OperationalAlerts');
    const active = db.operationalAlerts.find((alert) => alert.AlertKey === params.alertKey && alert.State !== 'RESOLVED');
    if (active) {
      active.OccurrenceCount += Number(params.occurrenceCount || 1);
      // Gecikmiş bir değerlendirme son görülme anını GERİYE ALMAZ ve anlık
      // görüntü alanlarını bayat veriyle değiştirmez.
      const observedAt = toMs(params.observedAt);
      const lastSeenAt = toMs(active.LastSeenAt);
      if (observedAt != null && (lastSeenAt == null || observedAt > lastSeenAt)) {
        active.LastSeenAt = iso(params.observedAt);
      }
      if (observedAt != null && (lastSeenAt == null || observedAt >= lastSeenAt)) {
        active.Severity = params.severity;
        active.Summary = params.summary;
        active.Detail = params.detail ?? null;
        active.ContextJson = params.contextJson ?? null;
        active.CorrelationId = params.correlationId ?? active.CorrelationId;
      }
      return [[{
        MergeAction: 'UPDATE',
        OperationalAlertId: active.OperationalAlertId,
        State: active.State,
        OccurrenceCount: active.OccurrenceCount,
        FirstSeenAt: active.FirstSeenAt,
        LastSeenAt: active.LastSeenAt
      }]];
    }
    db.operationalAlertSequence += 1;
    const created = {
      OperationalAlertId: db.operationalAlertSequence,
      AlertKey: params.alertKey,
      Severity: params.severity,
      Component: params.component,
      EventCode: params.eventCode,
      Summary: params.summary,
      Detail: params.detail ?? null,
      State: 'OPEN',
      OccurrenceCount: Number(params.occurrenceCount || 1),
      FirstSeenAt: iso(params.observedAt),
      LastSeenAt: iso(params.observedAt),
      AcknowledgedAt: null,
      AcknowledgedBySicil: null,
      ResolvedAt: null,
      CorrelationId: params.correlationId ?? null,
      ContextJson: params.contextJson ?? null
    };
    db.operationalAlerts.push(created);
    return [[{
      MergeAction: 'INSERT',
      OperationalAlertId: created.OperationalAlertId,
      State: created.State,
      OccurrenceCount: created.OccurrenceCount,
      FirstSeenAt: created.FirstSeenAt,
      LastSeenAt: created.LastSeenAt
    }]];
  }
  if (sqlText.includes("SET State = 'RESOLVED'")) {
    guard(db, 'MR_OperationalAlerts');
    const resolvedAt = toMs(params.resolvedAt);
    // Gecikmiş bir temiz değerlendirme, DAHA YENİ bir hata gözleminden sonra
    // çalışırsa süregiden arızayı kapatmamalıdır.
    const active = db.operationalAlerts.filter((alert) => alert.AlertKey === params.alertKey
      && alert.State !== 'RESOLVED'
      && (resolvedAt == null || toMs(alert.LastSeenAt) == null || toMs(alert.LastSeenAt) <= resolvedAt));
    for (const alert of active) {
      alert.State = 'RESOLVED';
      alert.ResolvedAt = iso(params.resolvedAt);
    }
    return [active.map((alert) => ({
      OperationalAlertId: alert.OperationalAlertId,
      AlertKey: alert.AlertKey,
      Component: alert.Component,
      EventCode: alert.EventCode,
      Summary: alert.Summary
    }))];
  }
  if (sqlText.includes("SET State = 'ACKNOWLEDGED'")) {
    guard(db, 'MR_OperationalAlerts');
    const alert = db.operationalAlerts.find((entry) => entry.OperationalAlertId === Number(params.alertId) && entry.State === 'OPEN');
    if (!alert) return [[]];
    alert.State = 'ACKNOWLEDGED';
    alert.AcknowledgedAt = iso(params.acknowledgedAt);
    alert.AcknowledgedBySicil = params.actorSicil ?? null;
    return [[{ OperationalAlertId: alert.OperationalAlertId, AlertKey: alert.AlertKey, State: alert.State }]];
  }
  if (sqlText.includes('SELECT AlertKey FROM dbo.MR_OperationalAlerts')) {
    guard(db, 'MR_OperationalAlerts');
    return [db.operationalAlerts
      .filter((alert) => alert.State !== 'RESOLVED')
      .map((alert) => ({ AlertKey: alert.AlertKey }))];
  }
  if (sqlText.includes('FROM dbo.MR_OperationalAlerts') && sqlText.includes('SELECT TOP (@limit)')) {
    guard(db, 'MR_OperationalAlerts');
    const since = toMs(params.since);
    const order = { OPEN: 0, ACKNOWLEDGED: 1, RESOLVED: 2 };
    const severityOrder = { CRITICAL: 0, ERROR: 1, WARNING: 2, INFO: 3 };
    const rows = db.operationalAlerts
      .filter((alert) => (!params.activeOnly || alert.State !== 'RESOLVED')
        && (!params.severity || alert.Severity === params.severity)
        && (!params.eventCode || alert.EventCode === params.eventCode)
        // Arama normalleştirmesi olay süzgeciyle AYNI kaynaktan gelir; iki
        // süzgeç ayrı kurallar uygularsa aynı metin ayrı sonuç döndürürdü.
        && (!params.search || [alert.Summary, alert.Detail, alert.CorrelationId]
          .some((value) => String(value ?? '').toLowerCase().includes(normalizedSearch(params.search))))
        && (!params.component || alert.Component === params.component)
        && (alert.State !== 'RESOLVED' || toMs(alert.LastSeenAt) >= since))
      .sort((left, right) => (order[left.State] - order[right.State])
        || (severityOrder[left.Severity] - severityOrder[right.Severity])
        || (toMs(right.LastSeenAt) - toMs(left.LastSeenAt)))
      .slice(0, Number(params.limit || 50));
    return [rows];
  }
  if (sqlText.includes('DELETE TOP (@batchSize) FROM dbo.MR_OperationalAlerts')) {
    guard(db, 'MR_OperationalAlerts');
    const cutoff = toMs(params.cutoff);
    const { kept, removed } = deleteBounded(db.operationalAlerts,
      (alert) => alert.State === 'RESOLVED' && toMs(alert.ResolvedAt) < cutoff, params.batchSize);
    db.operationalAlerts = kept;
    return [Array.from({ length: removed }, () => ({}))];
  }

  return null;
}
