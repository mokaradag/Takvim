import 'server-only';

/**
 * Gözlemlenebilirlik SQL metinleri.
 *
 * Tümü PARAMETRELİDİR; hiçbir değer sorguya birleştirilmez. Okumalar zaman
 * aralığıyla SINIRLIDIR ve dizinli sütunlar üzerinden çalışır: yönetim
 * konsolunun on saniyelik yoklaması üretimde tablo taraması yapmaz.
 *
 * Kova hizalaması `@since` temel alınarak yapılır. Sabit bir çıpaya (ör. 2000)
 * göre hizalamak, `DATEADD` işlevine yıllar süren bir saniye farkı geçirir ve
 * uzun vadede taşma riski taşır; aralık başlangıcına göre fark en çok seçilen
 * zaman aralığı kadardır.
 */

/**
 * Kapanmış kovaların birleştirilmesi.
 *
 * Anahtar SÜREÇ KİMLİĞİNİ de içerir: birden çok uygulama süreci aynı kovaya
 * yazdığında yüzdelikler birbirini ezmez, her süreç kendi dağılımını saklar ve
 * okuma sorgusu bunları örnek sayısına göre birleştirir.
 *
 * `LastFlushId`, aynı boşaltmanın İKİ KEZ uygulanmasını engeller: yazma
 * işlenip istemci belirsiz bir hata aldığında yeniden gönderilen satır sayıları
 * ikinci kez toplamaz (aynı satır aynı kimlikle yeniden denenir).
 */
export const TELEMETRY_OPERATION_MERGE_SQL = `
  MERGE dbo.MR_TelemetryOperationSamples WITH (HOLDLOCK) AS target
  USING (SELECT @bucketStart AS BucketStart, @operation AS Operation, @instanceId AS InstanceId) AS source
    ON target.BucketStart = source.BucketStart
      AND target.Operation = source.Operation
      AND target.InstanceId = source.InstanceId
  WHEN MATCHED AND (target.LastFlushId IS NULL OR target.LastFlushId <> @flushId) THEN UPDATE SET
    SampleCount = target.SampleCount + @sampleCount,
    ErrorCount = target.ErrorCount + @errorCount,
    DurationSumMs = target.DurationSumMs + @durationSumMs,
    DurationMaxMs = CASE WHEN @durationMaxMs > target.DurationMaxMs THEN @durationMaxMs ELSE target.DurationMaxMs END,
    P50Ms = COALESCE(@p50Ms, target.P50Ms),
    P95Ms = COALESCE(@p95Ms, target.P95Ms),
    P99Ms = COALESCE(@p99Ms, target.P99Ms),
    TopFailureCode = COALESCE(@topFailureCode, target.TopFailureCode),
    LastFlushId = @flushId
  WHEN NOT MATCHED THEN INSERT
    (BucketStart, Operation, InstanceId, SampleCount, ErrorCount, DurationSumMs, DurationMaxMs, P50Ms, P95Ms, P99Ms, TopFailureCode, LastFlushId)
    VALUES (@bucketStart, @operation, @instanceId, @sampleCount, @errorCount, @durationSumMs, @durationMaxMs, @p50Ms, @p95Ms, @p99Ms, @topFailureCode, @flushId);`;

export const TELEMETRY_GAUGE_MERGE_SQL = `
  MERGE dbo.MR_TelemetryGaugeSamples WITH (HOLDLOCK) AS target
  USING (SELECT @bucketStart AS BucketStart, @metricKey AS MetricKey, @instanceId AS InstanceId) AS source
    ON target.BucketStart = source.BucketStart
      AND target.MetricKey = source.MetricKey
      AND target.InstanceId = source.InstanceId
  WHEN MATCHED AND (target.LastFlushId IS NULL OR target.LastFlushId <> @flushId) THEN UPDATE SET
    ValueAvg = ((target.ValueAvg * target.SampleCount) + (@valueAvg * @sampleCount))
      / NULLIF(target.SampleCount + @sampleCount, 0),
    ValueMin = CASE WHEN @valueMin < target.ValueMin THEN @valueMin ELSE target.ValueMin END,
    ValueMax = CASE WHEN @valueMax > target.ValueMax THEN @valueMax ELSE target.ValueMax END,
    SampleCount = target.SampleCount + @sampleCount,
    LastFlushId = @flushId
  WHEN NOT MATCHED THEN INSERT (BucketStart, MetricKey, InstanceId, SampleCount, ValueAvg, ValueMin, ValueMax, LastFlushId)
    VALUES (@bucketStart, @metricKey, @instanceId, @sampleCount, @valueAvg, @valueMin, @valueMax, @flushId);`;

/**
 * Zaman serisi.
 *
 * Kovalar SQL tarafında istenen çözünürlüğe indirgenir; 30 günlük ham kovayı
 * istemciye taşımak hem ağı hem de grafiği boğardı.
 */
export const TELEMETRY_OPERATION_SERIES_SQL = `
  SELECT DATEADD(second, (DATEDIFF_BIG(second, @since, BucketStart) / @bucketSeconds) * @bucketSeconds, @since) AS BucketStart,
    SUM(CAST(SampleCount AS bigint)) AS SampleCount,
    SUM(CAST(ErrorCount AS bigint)) AS ErrorCount,
    SUM(CAST(DurationSumMs AS bigint)) AS DurationSumMs,
    MAX(DurationMaxMs) AS DurationMaxMs,
    COUNT_BIG(*) AS SourceRowCount,
    SUM(CASE WHEN P50Ms IS NULL THEN 0 ELSE CAST(P50Ms AS bigint) * SampleCount END) AS P50Weighted,
    SUM(CASE WHEN P50Ms IS NULL THEN 0 ELSE CAST(SampleCount AS bigint) END) AS P50Samples,
    SUM(CASE WHEN P95Ms IS NULL THEN 0 ELSE CAST(P95Ms AS bigint) * SampleCount END) AS P95Weighted,
    SUM(CASE WHEN P95Ms IS NULL THEN 0 ELSE CAST(SampleCount AS bigint) END) AS P95Samples,
    SUM(CASE WHEN P99Ms IS NULL THEN 0 ELSE CAST(P99Ms AS bigint) * SampleCount END) AS P99Weighted,
    SUM(CASE WHEN P99Ms IS NULL THEN 0 ELSE CAST(SampleCount AS bigint) END) AS P99Samples
  FROM dbo.MR_TelemetryOperationSamples
  WHERE BucketStart >= @since AND BucketStart < @until
    AND (@operation IS NULL OR Operation = @operation)
  GROUP BY (DATEDIFF_BIG(second, @since, BucketStart) / @bucketSeconds)
  ORDER BY BucketStart;`;

/**
 * Aralıktaki işlem kırılımı (Yavaş İşlemler tablosu).
 *
 * Sıralama TOPLAM süreye göre değil ORTALAMA gecikmeye göredir: toplam süre,
 * yoğun ama hızlı bir ucu öne çıkarıp düşük hacimli ama çok yavaş bir ucu
 * listeden düşürürdü. Tablonun sorusu "hangi işlem yavaş", "hangi işlem çok
 * çalıştı" değildir.
 */
export const TELEMETRY_OPERATION_BREAKDOWN_SQL = `
  SELECT TOP (@limit) Operation,
    SUM(CAST(SampleCount AS bigint)) AS SampleCount,
    SUM(CAST(ErrorCount AS bigint)) AS ErrorCount,
    SUM(CAST(DurationSumMs AS bigint)) AS DurationSumMs,
    MAX(DurationMaxMs) AS DurationMaxMs,
    COUNT_BIG(*) AS SourceRowCount,
    SUM(CASE WHEN P50Ms IS NULL THEN 0 ELSE CAST(P50Ms AS bigint) * SampleCount END) AS P50Weighted,
    SUM(CASE WHEN P50Ms IS NULL THEN 0 ELSE CAST(SampleCount AS bigint) END) AS P50Samples,
    SUM(CASE WHEN P95Ms IS NULL THEN 0 ELSE CAST(P95Ms AS bigint) * SampleCount END) AS P95Weighted,
    SUM(CASE WHEN P95Ms IS NULL THEN 0 ELSE CAST(SampleCount AS bigint) END) AS P95Samples,
    SUM(CASE WHEN P99Ms IS NULL THEN 0 ELSE CAST(P99Ms AS bigint) * SampleCount END) AS P99Weighted,
    SUM(CASE WHEN P99Ms IS NULL THEN 0 ELSE CAST(SampleCount AS bigint) END) AS P99Samples,
    MAX(BucketStart) AS LastSeenAt
  FROM dbo.MR_TelemetryOperationSamples
  WHERE BucketStart >= @since AND BucketStart < @until
  GROUP BY Operation
  ORDER BY (CAST(SUM(CAST(DurationSumMs AS bigint)) AS float)
    / NULLIF(SUM(CAST(SampleCount AS bigint)), 0)) DESC,
    SUM(CAST(DurationSumMs AS bigint)) DESC;`;

/**
 * Ölçüm (gauge) serisi — bellek, kuyruk derinliği gibi.
 *
 * `InstanceCount` değerin kaç ayrı uygulama sürecinden geldiğini söyler:
 * süreçler arası ortalama, tek bir sürecin ölçüsü gibi sunulmamalıdır.
 */
export const TELEMETRY_GAUGE_SERIES_SQL = `
  SELECT MetricKey,
    DATEADD(second, (DATEDIFF_BIG(second, @since, BucketStart) / @bucketSeconds) * @bucketSeconds, @since) AS BucketStart,
    SUM(CAST(SampleCount AS bigint)) AS SampleCount,
    SUM(ValueAvg * SampleCount) AS ValueWeighted,
    MIN(ValueMin) AS ValueMin,
    MAX(ValueMax) AS ValueMax,
    COUNT(DISTINCT InstanceId) AS InstanceCount
  FROM dbo.MR_TelemetryGaugeSamples
  WHERE BucketStart >= @since AND BucketStart < @until
    AND MetricKey IN (SELECT LTRIM(RTRIM(value)) FROM STRING_SPLIT(@metricKeys, ','))
  GROUP BY MetricKey, (DATEDIFF_BIG(second, @since, BucketStart) / @bucketSeconds)
  ORDER BY MetricKey, BucketStart;`;

/** Saklama sınırı: her turda SINIRLI sayıda satır silinir, kilit uzun tutulmaz. */
export const TELEMETRY_OPERATION_RETENTION_SQL = `
  DELETE TOP (@batchSize) FROM dbo.MR_TelemetryOperationSamples WHERE BucketStart < @cutoff;`;

export const TELEMETRY_GAUGE_RETENTION_SQL = `
  DELETE TOP (@batchSize) FROM dbo.MR_TelemetryGaugeSamples WHERE BucketStart < @cutoff;`;

export const OPERATIONAL_EVENT_RETENTION_SQL = `
  DELETE TOP (@batchSize) FROM dbo.MR_OperationalEvents WHERE OccurredAt < @cutoff;`;

export const OPERATIONAL_ALERT_RETENTION_SQL = `
  DELETE TOP (@batchSize) FROM dbo.MR_OperationalAlerts WHERE State = 'RESOLVED' AND ResolvedAt < @cutoff;`;

/**
 * Olayın yazılması — YİNELENENLER TOPLANIR.
 *
 * Bellekteki birleştirme yalnızca TEK bir boşaltma turunu kapsar. Aynı SMTP
 * hatası turdan önce ve sonra oluştuğunda, düz bir `INSERT` olay listesine iki
 * ayrı satır bırakır; oysa sözleşme "aynı sorun tek satır, sayaç artar"dır.
 *
 * Bu yüzden yazma, SINIRLI bir zaman penceresi içindeki aynı parmak izini
 * taşıyan EN SON satırı günceller. Pencere dışındaki kayıt geçmişte ayrı durur:
 * iki gün arayla yaşanan iki kesinti tek satıra düşmemelidir.
 */
export const OPERATIONAL_EVENT_INSERT_SQL = `
  SET XACT_ABORT ON;
  BEGIN TRY
    BEGIN TRANSACTION;
    DECLARE @existingEventId bigint;
    SELECT TOP (1) @existingEventId = OperationalEventId
    FROM dbo.MR_OperationalEvents WITH (UPDLOCK, HOLDLOCK)
    WHERE AggregationKey = @aggregationKey AND OccurredAt >= @aggregateSince
      AND OccurredAt <= @occurredAt
    ORDER BY OccurredAt DESC, OperationalEventId DESC;

    IF @existingEventId IS NOT NULL
      UPDATE dbo.MR_OperationalEvents
      SET OccurrenceCount = OccurrenceCount + @occurrenceCount,
        OccurredAt = CASE WHEN @occurredAt > OccurredAt THEN @occurredAt ELSE OccurredAt END,
        Detail = COALESCE(@detail, Detail),
        CorrelationId = COALESCE(@correlationId, CorrelationId),
        ContextJson = COALESCE(@contextJson, ContextJson)
      OUTPUT inserted.OperationalEventId
      WHERE OperationalEventId = @existingEventId;
    ELSE
      INSERT dbo.MR_OperationalEvents
        (OccurredAt, Severity, Component, EventCode, Summary, Detail, CorrelationId, OccurrenceCount, ContextJson, AggregationKey)
      OUTPUT inserted.OperationalEventId
      VALUES (@occurredAt, @severity, @component, @eventCode, @summary, @detail, @correlationId, @occurrenceCount, @contextJson, @aggregationKey);
    COMMIT TRANSACTION;
  END TRY
  BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    THROW;
  END CATCH;`;

/**
 * Olay listesi — SAYFALI.
 *
 * Süzgeçlerin tümü isteğe bağlıdır ve `NULL` geçildiğinde uygulanmaz; sorgu
 * metni koşula göre değişmez, bu yüzden plan önbelleği bozulmaz.
 *
 * Toplam sayı sayfadan AYRI hesaplanır ve sayfa boş olsa bile döner. Pencere
 * işlevi (`COUNT(*) OVER ()`) sayfa satırlarına bağlıdır: sapma eşleşen satır
 * sayısını aştığında hiç satır dönmez ve toplam sıfır görünürdü — yönetici,
 * sapmanın gerisinde eşleşen olaylar olduğunu göremezdi.
 */
export const OPERATIONAL_EVENT_PAGE_SQL = `
  SELECT page.OperationalEventId, page.OccurredAt, page.Severity, page.Component, page.EventCode,
    page.Summary, page.Detail, page.CorrelationId, page.OccurrenceCount, page.ContextJson,
    total.TotalCount
  FROM (
    SELECT COUNT_BIG(*) AS TotalCount
    FROM dbo.MR_OperationalEvents
    WHERE OccurredAt >= @since
      AND (@severity IS NULL OR Severity = @severity)
      AND (@component IS NULL OR Component = @component)
      AND (@eventCode IS NULL OR EventCode = @eventCode)
      AND (@search IS NULL OR Summary LIKE @search ESCAPE '\\' OR EventCode LIKE @search ESCAPE '\\')
  ) AS total
  LEFT JOIN (
    SELECT OperationalEventId, OccurredAt, Severity, Component, EventCode, Summary, Detail,
      CorrelationId, OccurrenceCount, ContextJson
    FROM dbo.MR_OperationalEvents
    WHERE OccurredAt >= @since
      AND (@severity IS NULL OR Severity = @severity)
      AND (@component IS NULL OR Component = @component)
      AND (@eventCode IS NULL OR EventCode = @eventCode)
      AND (@search IS NULL OR Summary LIKE @search ESCAPE '\\' OR EventCode LIKE @search ESCAPE '\\')
    ORDER BY OccurredAt DESC, OperationalEventId DESC
    OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
  ) AS page ON 1 = 1
  ORDER BY page.OccurredAt DESC, page.OperationalEventId DESC;`;

/**
 * Uyarının açılması ya da var olanın güncellenmesi.
 *
 * Aynı koşul yinelendiğinde YENİ satır açılmaz: sayaç artar, son görülme anı
 * ilerler. Çözülmüş bir uyarı yeniden görülürse yeni bir kayıt açılır — böylece
 * kesintinin ilk ve son anı geçmişte ayrı ayrı durur. `HOLDLOCK`, eşzamanlı iki
 * değerlendirmenin aynı anahtar için iki satır açmasını engeller.
 *
 * `HOLDLOCK` güncellemeleri sıraya sokar ama SIRALARINI korumaz: gecikmiş bir
 * değerlendirme daha yenisinden sonra çalışabilir. Bu yüzden son görülme anı
 * geriye alınmaz; ağırlık, özet, ayrıntı, bağlam ve ilişkilendirme yalnızca
 * gözlem en az var olan kadar yeniyse değiştirilir.
 */
export const OPERATIONAL_ALERT_UPSERT_SQL = `
  MERGE dbo.MR_OperationalAlerts WITH (HOLDLOCK) AS target
  USING (SELECT @alertKey AS AlertKey) AS source
    ON target.AlertKey = source.AlertKey AND target.State <> 'RESOLVED'
  WHEN MATCHED THEN UPDATE SET
    OccurrenceCount = target.OccurrenceCount + @occurrenceCount,
    LastSeenAt = CASE WHEN @observedAt > target.LastSeenAt THEN @observedAt ELSE target.LastSeenAt END,
    Severity = CASE WHEN @observedAt >= target.LastSeenAt THEN @severity ELSE target.Severity END,
    Summary = CASE WHEN @observedAt >= target.LastSeenAt THEN @summary ELSE target.Summary END,
    Detail = CASE WHEN @observedAt >= target.LastSeenAt THEN @detail ELSE target.Detail END,
    ContextJson = CASE WHEN @observedAt >= target.LastSeenAt THEN @contextJson ELSE target.ContextJson END,
    CorrelationId = CASE WHEN @observedAt >= target.LastSeenAt
      THEN COALESCE(@correlationId, target.CorrelationId) ELSE target.CorrelationId END
  WHEN NOT MATCHED THEN INSERT
    (AlertKey, Severity, Component, EventCode, Summary, Detail, State, OccurrenceCount, FirstSeenAt, LastSeenAt, CorrelationId, ContextJson)
    VALUES (@alertKey, @severity, @component, @eventCode, @summary, @detail, 'OPEN', @occurrenceCount, @observedAt, @observedAt, @correlationId, @contextJson)
  OUTPUT $action AS MergeAction, inserted.OperationalAlertId, inserted.State, inserted.OccurrenceCount,
    inserted.FirstSeenAt, inserted.LastSeenAt;`;

/**
 * Koşul GERÇEKTEN düzeldiğinde uyarıyı çözer.
 *
 * Çözme, uyarının geçerli yenilemede görünmemesine değil, sağlık servisinin
 * açık "iyileşti" kararına dayanır (bkz. systemHealthService.js).
 *
 * `LastSeenAt <= @resolvedAt` koşulu ZORUNLUDUR: gecikmiş bir temiz
 * değerlendirme, daha yeni bir hata gözleminden sonra çalışırsa süregiden bir
 * arızayı "çözüldü" diye kapatırdı.
 */
export const OPERATIONAL_ALERT_RESOLVE_SQL = `
  UPDATE dbo.MR_OperationalAlerts
  SET State = 'RESOLVED', ResolvedAt = @resolvedAt
  OUTPUT inserted.OperationalAlertId, inserted.AlertKey, inserted.Component, inserted.EventCode, inserted.Summary
  WHERE AlertKey = @alertKey AND State <> 'RESOLVED' AND LastSeenAt <= @resolvedAt;`;

export const OPERATIONAL_ALERT_ACKNOWLEDGE_SQL = `
  UPDATE dbo.MR_OperationalAlerts
  SET State = 'ACKNOWLEDGED', AcknowledgedAt = @acknowledgedAt, AcknowledgedBySicil = @actorSicil
  OUTPUT inserted.OperationalAlertId, inserted.AlertKey, inserted.State
  WHERE OperationalAlertId = @alertId AND State = 'OPEN';`;

/**
 * Kalıcı olarak AÇIK duran uyarıların anahtarları.
 *
 * Süreç yeniden başladığında çırpınma izleyicisi boştur. Bu liste olmadan,
 * yeniden başlatma sırasında koşulu düzelen bir uyarı hiçbir zaman çözüm
 * anahtarı üretmez ve sonsuza dek açık kalırdı (bkz. alertRules.js).
 */
export const OPERATIONAL_ACTIVE_ALERT_KEYS_SQL = `
  SELECT AlertKey FROM dbo.MR_OperationalAlerts WHERE State <> 'RESOLVED';`;

export const OPERATIONAL_ALERT_LIST_SQL = `
  SELECT TOP (@limit) OperationalAlertId, AlertKey, Severity, Component, EventCode, Summary, Detail,
    State, OccurrenceCount, FirstSeenAt, LastSeenAt, AcknowledgedAt, AcknowledgedBySicil, ResolvedAt,
    CorrelationId, ContextJson
  FROM dbo.MR_OperationalAlerts
  WHERE (@activeOnly = 0 OR State <> 'RESOLVED')
    AND (@severity IS NULL OR Severity = @severity)
    AND (@eventCode IS NULL OR EventCode = @eventCode)
    AND (@search IS NULL OR Summary LIKE @search ESCAPE '\\' OR Detail LIKE @search ESCAPE '\\'
      OR CorrelationId LIKE @search ESCAPE '\\')
    AND (@component IS NULL OR Component = @component)
    AND (State <> 'RESOLVED' OR LastSeenAt >= @since)
  ORDER BY CASE State WHEN 'OPEN' THEN 0 WHEN 'ACKNOWLEDGED' THEN 1 ELSE 2 END,
    CASE Severity WHEN 'CRITICAL' THEN 0 WHEN 'ERROR' THEN 1 WHEN 'WARNING' THEN 2 ELSE 3 END,
    LastSeenAt DESC;`;

/** Bağlantı ve gecikme yoklaması — en ucuz güvenli sorgu. */
export const DATABASE_PROBE_SQL = `SELECT 1 AS DatabaseProbe;`;

/**
 * Kurumsal kaynak yoklamaları.
 *
 * SAYIM YAPILMAZ: bu yoklamalar on saniyede bir çalışır ve kurumsal görünümler
 * HR02/A01/HR09 tabloları üzerinde gruplama yapar. `TOP (1)` varlık yoklaması
 * kaynağın erişilebilirliğini kanıtlar, üretimde tarama maliyeti üretmez.
 * Kişisel veri hiçbir yoklamada taşınmaz.
 */
export const DIRECTORY_PROBE_SQL = `
  SELECT TOP (1) 1 AS DirectoryProbe FROM dbo.MR_V_PeopleDirectory;`;

export const CORPORATE_PROJECT_PROBE_SQL = `
  SELECT TOP (1) 1 AS CorporateProjectProbe FROM dbo.MR_V_CorporateProjects;`;

export const CORPORATE_RESPONSIBILITY_PROBE_SQL = `
  SELECT TOP (1) 1 AS ResponsibilityProbe FROM dbo.MR_V_CorporateProjectAccess;`;

export const CORPORATE_WBS_STATE_SQL = `
  SELECT MAX(SyncedAt) AS LastSyncedAt, COUNT_BIG(*) AS ProjectCount, SUM(CAST(NodeCount AS bigint)) AS NodeCount
  FROM dbo.MR_CorporateWbsSyncState;`;

/** Son otomatik hatırlatma turunun özeti. */
export const REMINDER_RUN_STATE_SQL = `
  SELECT TOP (1) Status, CreatedAt, CompletedAt, FailureCode
  FROM dbo.MR_TaskReminderLog
  WHERE ReminderKind = 'AUTOMATIC'
  ORDER BY TaskReminderLogId DESC;`;

/**
 * Outlook kuyruğunun yaş ve teslimat özeti.
 *
 * Kayıt başına ayrı bir "kuyruğa alınma" damgası YOKTUR; bu yüzden yaş ölçüsü
 * dürüst tutulur: HİÇ DENENMEMİŞ kayıtlar için `UpdatedAt` gerçekten kuyruğa
 * alınma anıdır ve tıkanmayı en erken gösteren ölçü budur. Yeniden denenen
 * kayıtlar için deneme sayısı ve bir sonraki deneme anı ayrıca bildirilir.
 */
export const OUTLOOK_QUEUE_AGE_SQL = `
  SELECT MIN(CASE WHEN PendingMethod IS NOT NULL AND AttemptCount = 0 THEN UpdatedAt END) AS OldestUnattemptedAt,
    MIN(CASE WHEN PendingMethod IS NOT NULL THEN UpdatedAt END) AS OldestPendingChangeAt,
    MAX(CASE WHEN PendingMethod IS NOT NULL THEN AttemptCount END) AS MaxAttemptCount,
    MIN(CASE WHEN PendingMethod IS NOT NULL THEN NextAttemptAt END) AS NextAttemptAt,
    MAX(LastDeliveredAt) AS LastDeliveredAt,
    MAX(CASE WHEN LastFailureCode IS NOT NULL THEN UpdatedAt END) AS LastFailureAt
  FROM dbo.MR_TaskOutlookSubscriptions;`;

/**
 * Kuyruktaki bekleyen kayıtların GÜVENLİ ayrıntısı.
 *
 * Alıcı adresi, takvim kimliği ve ileti içeriği hiçbir koşulda seçilmez.
 */
export const OUTLOOK_QUEUE_DETAIL_SQL = `
  SELECT TOP (@limit) SubscriptionId, TaskId, PendingMethod, AttemptCount, UpdatedAt,
    NextAttemptAt, LastFailureCode, LeaseExpiresAt, LastDeliveredAt
  FROM dbo.MR_TaskOutlookSubscriptions
  WHERE PendingMethod IS NOT NULL
  ORDER BY AttemptCount DESC, UpdatedAt ASC;`;
