import 'server-only';

/**
 * Outlook takvim aboneliği sorguları.
 *
 * Sorgu metinleri tek dosyada toplanır: şema sözleşmesi tek yerden okunur ve
 * testler sorguları doğrudan sınayabilir. Eşzamanlılık kararlarının tamamı
 * SQL'dedir; React durumu ya da bellek içi kilit kullanılmaz.
 */

const SUBSCRIPTION_COLUMNS = `
  inserted.SubscriptionId, inserted.TaskId, inserted.ProjectId, inserted.UserSicil,
  inserted.CalendarUid, inserted.[Sequence], inserted.IsActive, inserted.QueueSeq,
  inserted.PendingMethod, inserted.PendingSequence, inserted.PendingPayloadHash,
  inserted.DeliveredSequence, inserted.DeliveredPayloadHash, inserted.DeliveredSummary,
  inserted.DeliveredDate, inserted.AttemptCount, inserted.LeaseToken, inserted.LeaseExpiresAt,
  inserted.CalendarAttendee, inserted.CalendarOrganizer, inserted.CancelRequested,
  inserted.ForceResend, inserted.DeliveryMayHaveEscaped, inserted.LastValidatedAt,
  inserted.CompletionSuspended, inserted.CompletionDate, inserted.LastCancellationReason, inserted.DeliveredMethod, inserted.PendingDate`;

/**
 * Görev + o kullanıcı için GÖRÜNÜRLÜK.
 *
 * Görünürlük yüklemi hatırlatma ucundakiyle AYNIDIR (bkz. reminderAccess ·
 * assertTaskReminderAccess). Zamanlanmış tur oturum açmış bir kullanıcı
 * taşımadığı için sistem yöneticisi durumu da burada, `UserSicil` üzerinden
 * çözülür: teslimat anında yetki yeniden değerlendirilir ve görünürlüğünü
 * yitirmiş bir kullanıcıya görev ayrıntısı gönderilmez.
 */
export const OUTLOOK_TASK_SQL = `
  DECLARE @isAdmin bit = CASE WHEN EXISTS (
    SELECT 1 FROM dbo.MR_UserRoles
    WHERE Sicil = @sicil AND RoleCode = 'SYSTEM_ADMIN' AND IsActive = 1
  ) THEN 1 ELSE 0 END;

  SELECT TOP (1)
    t.TaskId, t.ProjectId, t.Title, t.Status, t.TargetFinish, t.PlannedFinish,
    p.ProjectCode, p.ProjectName,
    CASE WHEN (
      @isAdmin = 1
      OR EXISTS (
        SELECT 1
        FROM dbo.MR_V_CorporateProjectAccess a
        WHERE p.SourceType = 'CORPORATE' AND a.ProjectCode = UPPER(p.ProjectCode) AND a.Sicil = @sicil
      )
      OR (p.SourceType = 'MANUAL' AND p.LeadSicil = @sicil)
      OR t.CreatedBySicil = @sicil
      OR EXISTS (
        SELECT 1 FROM dbo.MR_ProjectAccess pa
        WHERE pa.ProjectId = t.ProjectId AND pa.Sicil = @sicil AND pa.IsActive = 1
          AND pa.AccessLevel IN ('FULL', 'READ')
      )
      OR EXISTS (
        SELECT 1 FROM dbo.MR_TaskAssignees ta
        WHERE ta.TaskId = t.TaskId
          AND (
            ta.Sicil = @sicil
            OR EXISTS (
              SELECT 1 FROM dbo.MR_V_ExecutiveScope es
              WHERE es.ManagerSicil = @sicil AND es.EmployeeSicil = ta.Sicil
            )
          )
      )
    ) THEN CAST(1 AS bit) ELSE CAST(0 AS bit) END AS Visible
  FROM dbo.MR_Tasks t
  JOIN dbo.MR_Projects p ON p.ProjectId = t.ProjectId AND p.IsActive = 1
  WHERE t.TaskId = @taskId;`;

/**
 * Aboneliği AÇAR ya da yeniden etkinleştirir (bire bir aynı istek yinelenirse
 * hiçbir şey değişmez).
 *
 * Benzersiz kısıt `(TaskId, UserSicil)` üzerindedir: çift tıklama, iki sekme ya
 * da iki uygulama örneği aynı anda eklese bile ikinci bir satır oluşamaz.
 *
 * `PendingMethod` yalnızca GERÇEKTEN gönderilecek bir iş varken yazılır: kayıt
 * zaten etkinse ve en son teslim edilen içerik güncel içerikle aynıysa kuyruğa
 * hiçbir şey konmaz ve çağıran "zaten ekli" yanıtını alır.
 */
export const OUTLOOK_SUBSCRIPTION_UPSERT_SQL = `
  SET NOCOUNT ON;

  DECLARE @rows TABLE (
    SubscriptionId bigint, TaskId uniqueidentifier, ProjectId uniqueidentifier, UserSicil int,
    CalendarUid nvarchar(200), [Sequence] int, IsActive bit, QueueSeq bigint,
    PendingMethod varchar(10), PendingSequence int, PendingPayloadHash char(64),
    DeliveredSequence int, DeliveredPayloadHash char(64), DeliveredSummary nvarchar(400),
    DeliveredDate date, AttemptCount int, LeaseToken uniqueidentifier, LeaseExpiresAt datetime2(3),
    CalendarAttendee nvarchar(320), CalendarOrganizer nvarchar(320), CancelRequested bit,
    ForceResend bit, DeliveryMayHaveEscaped bit, LastValidatedAt datetime2(3),
    CompletionSuspended bit, CompletionDate date, LastCancellationReason varchar(60), DeliveredMethod varchar(10), PendingDate date
  );

  UPDATE s
  SET IsActive = 1,
      CancelRequested = 0,
      CompletionSuspended = CASE WHEN s.IsActive = 0 THEN 0 ELSE s.CompletionSuspended END,
      CompletionDate = CASE WHEN s.IsActive = 0 THEN NULL ELSE s.CompletionDate END,
      DeliveredMethod = CASE WHEN s.IsActive = 0 THEN NULL ELSE s.DeliveredMethod END,
      PendingDate = CASE WHEN s.IsActive = 0 THEN NULL ELSE s.PendingDate END,
      CalendarAttendee = CASE WHEN s.IsActive = 0 THEN NULL ELSE s.CalendarAttendee END,
      CalendarOrganizer = CASE WHEN s.IsActive = 0 THEN NULL ELSE s.CalendarOrganizer END,
      DeliveryMayHaveEscaped = CASE WHEN s.IsActive = 0 THEN 0 ELSE s.DeliveryMayHaveEscaped END,
      DeliveredSequence = CASE WHEN s.IsActive = 0 THEN NULL ELSE s.DeliveredSequence END,
      DeliveredPayloadHash = CASE WHEN s.IsActive = 0 THEN NULL ELSE s.DeliveredPayloadHash END,
      DeliveredSummary = CASE WHEN s.IsActive = 0 THEN NULL ELSE s.DeliveredSummary END,
      DeliveredDate = CASE WHEN s.IsActive = 0 THEN NULL ELSE s.DeliveredDate END,
      PendingSequence = CASE WHEN s.IsActive = 0 THEN NULL ELSE s.PendingSequence END,
      PendingPayloadHash = CASE WHEN s.IsActive = 0 THEN NULL ELSE s.PendingPayloadHash END,
      ProjectId = COALESCE(@projectId, s.ProjectId),
      PendingMethod = CASE
        WHEN s.IsActive = 1 AND s.CompletionSuspended = 0 AND s.PendingMethod IS NULL AND s.DeliveredPayloadHash = @payloadHash
        THEN NULL ELSE 'REQUEST' END,
      QueueSeq = CASE
        WHEN s.IsActive = 1 AND s.CompletionSuspended = 0 AND s.PendingMethod IS NULL AND s.DeliveredPayloadHash = @payloadHash
        THEN s.QueueSeq
        WHEN s.IsActive = 1 AND s.PendingMethod = 'REQUEST'
          AND (s.PendingSequence IS NULL OR s.PendingPayloadHash = @payloadHash)
        THEN s.QueueSeq ELSE s.QueueSeq + 1 END,
      AttemptCount = 0,
      NextAttemptAt = NULL,
      LastFailureCode = NULL,
      UpdatedAt = SYSUTCDATETIME()
  OUTPUT ${SUBSCRIPTION_COLUMNS} INTO @rows
  FROM dbo.MR_TaskOutlookSubscriptions s WITH (UPDLOCK, HOLDLOCK)
  WHERE s.TaskId = @taskId AND s.UserSicil = @sicil;

  IF NOT EXISTS (SELECT 1 FROM @rows)
  BEGIN
    -- Koşullu ekleme TEK deyimdir: yarışı kaybeden istek hiç satır eklemez ve
    -- benzersiz kısıt ihlaliyle patlamaz.
    INSERT dbo.MR_TaskOutlookSubscriptions(
      TaskId, ProjectId, UserSicil, CalendarUid, [Sequence], IsActive, QueueSeq,
      PendingMethod, CreatedBySicil
    )
    OUTPUT ${SUBSCRIPTION_COLUMNS} INTO @rows
    SELECT @taskId, @projectId, @sicil, @calendarUid, 0, 1, 1, 'REQUEST', @sicil
    WHERE NOT EXISTS (
      SELECT 1 FROM dbo.MR_TaskOutlookSubscriptions WITH (UPDLOCK, HOLDLOCK)
      WHERE TaskId = @taskId AND UserSicil = @sicil
    );
  END

  IF NOT EXISTS (SELECT 1 FROM @rows)
    INSERT @rows SELECT ${SUBSCRIPTION_COLUMNS.replaceAll('inserted.', 's.')}
    FROM dbo.MR_TaskOutlookSubscriptions s
    WHERE s.TaskId = @taskId AND s.UserSicil = @sicil;

  SELECT TOP (1) * FROM @rows;`;

/** Görev + kullanıcı aboneliğinin güncel durumu. */
export const OUTLOOK_SUBSCRIPTION_SQL = `
  SELECT TOP (1) SubscriptionId, TaskId, ProjectId, UserSicil, CalendarUid, [Sequence],
    IsActive, QueueSeq, PendingMethod, PendingSequence, PendingPayloadHash,
    DeliveredSequence, DeliveredPayloadHash, DeliveredSummary, DeliveredDate, AttemptCount,
    LeaseToken, LeaseExpiresAt, CalendarAttendee, CalendarOrganizer,
    CancelRequested, ForceResend, DeliveryMayHaveEscaped, LastValidatedAt,
    CompletionSuspended, CompletionDate, LastCancellationReason, DeliveredMethod, PendingDate
  FROM dbo.MR_TaskOutlookSubscriptions
  WHERE TaskId = @taskId AND UserSicil = @sicil;`;

/** Etkin abonelik tercihi ve son davetin teslimat durumu. */
export const OUTLOOK_USER_SUBSCRIPTIONS_SQL = `
  SELECT TaskId, PendingMethod, DeliveredSequence, LastFailureCode, CompletionSuspended, DeliveredMethod
  FROM dbo.MR_TaskOutlookSubscriptions
  WHERE UserSicil = @sicil AND IsActive = 1;`;

/** Kullanıcının kendi aboneliğini KALDIRMA isteği: iptal kuyruğa alınır. */
export const OUTLOOK_QUEUE_CANCEL_SQL = `
  SET NOCOUNT ON;
  UPDATE dbo.MR_TaskOutlookSubscriptions
  SET PendingMethod = 'CANCEL',
      CancelRequested = 1,
      LastCancellationReason = 'USER_REMOVED',
      ForceResend = 0,
      QueueSeq = CASE WHEN PendingMethod = 'CANCEL' AND CancelRequested = 1 AND AttemptCount < @maxAttempts THEN QueueSeq ELSE QueueSeq + 1 END,
      AttemptCount = CASE WHEN PendingMethod = 'CANCEL' AND CancelRequested = 1 AND AttemptCount < @maxAttempts THEN AttemptCount ELSE 0 END,
      NextAttemptAt = CASE WHEN PendingMethod = 'CANCEL' AND CancelRequested = 1 AND AttemptCount < @maxAttempts THEN NextAttemptAt ELSE NULL END,
      LastFailureCode = CASE WHEN PendingMethod = 'CANCEL' AND CancelRequested = 1 AND AttemptCount < @maxAttempts THEN LastFailureCode ELSE NULL END,
      UpdatedAt = SYSUTCDATETIME()
  OUTPUT ${SUBSCRIPTION_COLUMNS}
  WHERE TaskId = @taskId AND UserSicil = @sicil AND IsActive = 1;`;

export const OUTLOOK_QUEUE_RESEND_SQL = `
  UPDATE dbo.MR_TaskOutlookSubscriptions
  SET PendingMethod = 'REQUEST',
      ForceResend = 1,
      QueueSeq = CASE WHEN ForceResend = 1 AND AttemptCount < @maxAttempts THEN QueueSeq ELSE QueueSeq + 1 END,
      AttemptCount = CASE WHEN ForceResend = 1 AND AttemptCount < @maxAttempts THEN AttemptCount ELSE 0 END,
      NextAttemptAt = CASE WHEN ForceResend = 1 AND AttemptCount < @maxAttempts THEN NextAttemptAt ELSE NULL END,
      LastFailureCode = CASE WHEN ForceResend = 1 AND AttemptCount < @maxAttempts THEN LastFailureCode ELSE NULL END,
      UpdatedAt = SYSUTCDATETIME()
  OUTPUT ${SUBSCRIPTION_COLUMNS}
  WHERE TaskId = @taskId AND UserSicil = @sicil AND IsActive = 1 AND CancelRequested = 0;`;

export const OUTLOOK_REVALIDATE_SQL = `
  ;WITH unchecked AS (
    SELECT TOP (@limit) * FROM dbo.MR_TaskOutlookSubscriptions WITH (READPAST, UPDLOCK, ROWLOCK)
    WHERE IsActive = 1 AND PendingMethod IS NULL AND CompletionSuspended = 0
      AND (LastValidatedAt IS NULL OR LastValidatedAt <= DATEADD(second, -300, SYSUTCDATETIME()))
      AND (LeaseExpiresAt IS NULL OR LeaseExpiresAt <= SYSUTCDATETIME())
    ORDER BY LastValidatedAt, SubscriptionId
  )
  UPDATE unchecked SET PendingMethod = 'REQUEST', QueueSeq = QueueSeq + 1,
    AttemptCount = 0, NextAttemptAt = SYSUTCDATETIME(), LastFailureCode = NULL,
    LastValidatedAt = SYSUTCDATETIME();`;

export const OUTLOOK_HEALTH_SQL = `
  SELECT COUNT_BIG(*) AS Exhausted FROM dbo.MR_TaskOutlookSubscriptions
  WHERE PendingMethod IS NOT NULL AND AttemptCount >= @maxAttempts;`;

/**
 * Yöneticinin "Başarısızları Yeniden Dene" eylemi.
 *
 * Deneme sayacı ve bir sonraki deneme anı sıfırlanır; `QueueSeq`, `Sequence` ve
 * bekleyen sürümün künyesi DEĞİŞMEZ. Böylece aynı davet yeniden gönderilir ve
 * Outlook UID/SEQUENCE bütünlüğü ile eski kuyruk kuşağının yeni niyeti ezmeme
 * güvencesi korunur. Sahiplenilmiş (kiralı) kayıtlara dokunulmaz: süren bir
 * teslimat kesilmemelidir.
 */
export const OUTLOOK_RETRY_FAILED_SQL = `
  UPDATE dbo.MR_TaskOutlookSubscriptions
  SET AttemptCount = 0, NextAttemptAt = NULL, UpdatedAt = SYSUTCDATETIME()
  OUTPUT inserted.SubscriptionId
  WHERE PendingMethod IS NOT NULL
    AND LastFailureCode IS NOT NULL
    AND (LeaseExpiresAt IS NULL OR LeaseExpiresAt <= SYSUTCDATETIME());`;

export const OUTLOOK_QUEUE_STATUS_SQL = `
  SELECT COUNT_BIG(*) AS Pending,
    COUNT_BIG(CASE WHEN LastFailureCode IS NOT NULL THEN 1 END) AS Failed,
    COUNT_BIG(CASE WHEN AttemptCount >= @maxAttempts THEN 1 END) AS Exhausted,
    COUNT_BIG(CASE WHEN LeaseExpiresAt > SYSUTCDATETIME() THEN 1 END) AS InFlight,
    COUNT_BIG(CASE WHEN AttemptCount < @maxAttempts
      AND (NextAttemptAt IS NULL OR NextAttemptAt <= SYSUTCDATETIME())
      AND (LeaseExpiresAt IS NULL OR LeaseExpiresAt <= SYSUTCDATETIME()) THEN 1 END) AS Due
  FROM dbo.MR_TaskOutlookSubscriptions
  WHERE PendingMethod IS NOT NULL;`;

export const OUTLOOK_RENEW_SQL = `
  UPDATE dbo.MR_TaskOutlookSubscriptions
  SET LeaseExpiresAt = DATEADD(second, @leaseSeconds, SYSUTCDATETIME())
  OUTPUT inserted.SubscriptionId
  WHERE SubscriptionId = @subscriptionId AND LeaseToken = @leaseToken
    AND LeaseExpiresAt > SYSUTCDATETIME();`;

/**
 * Aboneliği posta göndermeden kapatır.
 *
 * Hiç teslim edilmemiş bir abonelik için iptal iletisi göndermek anlamsızdır:
 * Outlook'ta karşılığı olmayan bir randevu iptal edilemez, kullanıcı yalnızca
 * gereksiz bir ileti alırdı.
 */
export const OUTLOOK_DEACTIVATE_SQL = `
  UPDATE dbo.MR_TaskOutlookSubscriptions
  SET IsActive = 0,
      CompletionSuspended = 0,
      CompletionDate = NULL,
      LastCancellationReason = COALESCE(@cancellationReason, LastCancellationReason),
      PendingDate = NULL,
      LastFailureCode = NULL,
      PendingMethod = NULL,
      PendingSequence = NULL,
      PendingPayloadHash = NULL,
      AttemptCount = 0,
      NextAttemptAt = NULL,
      InFlightSince = NULL,
      LeaseToken = NULL,
      LeaseExpiresAt = NULL,
      UpdatedAt = SYSUTCDATETIME()
  OUTPUT inserted.SubscriptionId
  WHERE SubscriptionId = @subscriptionId AND LeaseToken = @leaseToken AND QueueSeq = @queueSeq;`;

/**
 * Bekleyen teslimatları TOPLU sahiplenir.
 *
 * `READPAST` ile başka bir turun kilitlediği satırlar atlanır ve `InFlightSince`
 * SÜREN bir teslimatı işaretler: iki zamanlayıcı aynı anda çalışsa bile aynı
 * davet iki kez gönderilmez. İşaret bir KİRADIR — süreç teslimat sırasında
 * sonlanırsa satır sonsuza dek "işleniyor" kalmaz, kira dolduğunda yeniden
 * denenir.
 */
export const OUTLOOK_CLAIM_SQL = `
  SET NOCOUNT ON;

  ;WITH due AS (
    SELECT TOP (@limit) *
    FROM dbo.MR_TaskOutlookSubscriptions WITH (READPAST, UPDLOCK, ROWLOCK)
    WHERE PendingMethod IS NOT NULL
      AND AttemptCount < @maxAttempts
      AND (NextAttemptAt IS NULL OR NextAttemptAt <= SYSUTCDATETIME())
      AND (LeaseExpiresAt IS NULL OR LeaseExpiresAt <= SYSUTCDATETIME())
      AND (IsActive = 1 OR PendingMethod = 'CANCEL')
    ORDER BY NextAttemptAt, SubscriptionId
  )
  UPDATE due
  SET AttemptCount = CASE WHEN AttemptCount < 2147483647 THEN AttemptCount + 1 ELSE AttemptCount END,
      InFlightSince = SYSUTCDATETIME(),
      LeaseToken = @leaseToken,
      LeaseExpiresAt = DATEADD(second, @leaseSeconds, SYSUTCDATETIME()),
      NextAttemptAt = DATEADD(second, @leaseSeconds, SYSUTCDATETIME()),
      UpdatedAt = SYSUTCDATETIME()
  OUTPUT ${SUBSCRIPTION_COLUMNS};`;
/**
 * TEK aboneliği sahiplenir (kullanıcının açık eylemi).
 *
 * SÜREN bir teslimat varken satır sahiplenilmez ve hiç satır dönmez: çift
 * tıklama ya da ikinci sekme, aynı görev için ikinci bir davet üretemez.
 * Kira tüm SMTP adımlarını kapsar; sonuç yazıldığında hemen bırakılır.
 *
 * Deneme sayacı SIFIRLANIR: kullanıcı eylemi, yeniden deneme bütçesini tüketmiş
 * bir kaydı da yeniden çalışır duruma getirir.
 */
export const OUTLOOK_CLAIM_ONE_SQL = `
  SET NOCOUNT ON;

  UPDATE dbo.MR_TaskOutlookSubscriptions
  SET AttemptCount = 1,
      InFlightSince = SYSUTCDATETIME(),
      LeaseToken = @leaseToken,
      LeaseExpiresAt = DATEADD(second, @leaseSeconds, SYSUTCDATETIME()),
      NextAttemptAt = DATEADD(second, @leaseSeconds, SYSUTCDATETIME()),
      UpdatedAt = SYSUTCDATETIME()
  OUTPUT ${SUBSCRIPTION_COLUMNS}
  WHERE SubscriptionId = @subscriptionId
    AND IsActive = 1 AND PendingMethod IS NOT NULL
    AND (LeaseExpiresAt IS NULL OR LeaseExpiresAt <= SYSUTCDATETIME());`;

/**
 * Gönderilecek SÜRÜMÜ ayırır.
 *
 * Tek deyimdir ve bu yüzden bölünemez. Aynı yöntem ve aynı içerik için ayrılmış
 * bir sürüm zaten varsa YENİDEN KULLANILIR: SMTP başarılı olduktan sonra kayıt
 * güncellenemeden süreç sonlanırsa, yeniden deneme aynı `SEQUENCE` ile aynı
 * daveti gönderir ve Outlook ikinci bir revizyon görmez.
 */
export const OUTLOOK_ALLOCATE_SQL = `
  SET NOCOUNT ON;

  UPDATE dbo.MR_TaskOutlookSubscriptions
  SET [Sequence] = CASE
        WHEN PendingSequence IS NOT NULL AND PendingPayloadHash = @payloadHash
          AND (DeliveredSequence IS NULL OR PendingSequence > DeliveredSequence)
          AND ((@method = 'CANCEL' AND PendingDate IS NULL) OR (@method = 'REQUEST' AND PendingDate = @calendarDate))
        THEN [Sequence]
        WHEN @reuseDelivered = 1 AND DeliveredPayloadHash = @payloadHash AND DeliveredSequence = [Sequence] THEN [Sequence]
        ELSE [Sequence] + 1 END,
      PendingSequence = CASE
        WHEN PendingSequence IS NOT NULL AND PendingPayloadHash = @payloadHash
          AND (DeliveredSequence IS NULL OR PendingSequence > DeliveredSequence)
          AND ((@method = 'CANCEL' AND PendingDate IS NULL) OR (@method = 'REQUEST' AND PendingDate = @calendarDate))
        THEN PendingSequence
        WHEN @reuseDelivered = 1 AND DeliveredPayloadHash = @payloadHash AND DeliveredSequence = [Sequence] THEN DeliveredSequence
        ELSE [Sequence] + 1 END,
      PendingMethod = @method,
      PendingDate = @calendarDate,
      LastCancellationReason = COALESCE(@cancellationReason, LastCancellationReason),
      PendingPayloadHash = @payloadHash,
      DeliveryMayHaveEscaped = 1,
      CalendarAttendee = COALESCE(CalendarAttendee, @attendee),
      CalendarOrganizer = COALESCE(CalendarOrganizer, @organizer),
      LeaseExpiresAt = DATEADD(second, @leaseSeconds, SYSUTCDATETIME()),
      UpdatedAt = SYSUTCDATETIME()
  OUTPUT inserted.PendingSequence AS AllocatedSequence, inserted.QueueSeq AS QueueSeq,
    inserted.CalendarAttendee, inserted.CalendarOrganizer
  WHERE SubscriptionId = @subscriptionId AND LeaseToken = @leaseToken AND QueueSeq = @queueSeq
    AND LeaseExpiresAt > SYSUTCDATETIME();`;

/**
 * Başarılı teslimatı kalıcılaştırır.
 *
 * Kira belirteci SMTP işleminin sahipliğini kanıtlar. `QueueSeq` ise SET içindeki
 * koşullarda yeni neslin durumunu korur: teslimat sırasında daha yeni bir niyet
 * geldiyse SMTP tarafından kabul edilen eski sürüm yine teslimat geçmişine
 * yazılır ve kira bırakılır, fakat yeni bekleyen iş temizlenmez veya kapatılmaz.
 */
export const OUTLOOK_COMPLETE_SQL = `
  UPDATE dbo.MR_TaskOutlookSubscriptions
  SET DeliveredSequence = @sequence,
      DeliveredMethod = @method,
      CompletionSuspended = CASE WHEN QueueSeq = @queueSeq THEN @completionSuspended ELSE CompletionSuspended END,
      CompletionDate = CASE WHEN QueueSeq = @queueSeq AND @completionSuspended = 0 THEN NULL ELSE CompletionDate END,
      LastCancellationReason = CASE
        WHEN QueueSeq <> @queueSeq THEN LastCancellationReason
        WHEN @completionSuspended = 0 AND @cancellationReason IS NULL AND LastCancellationReason = 'TASK_COMPLETED' THEN NULL
        ELSE COALESCE(@cancellationReason, LastCancellationReason) END,
      PendingDate = CASE WHEN QueueSeq = @queueSeq THEN NULL ELSE PendingDate END,
      DeliveredPayloadHash = @payloadHash,
      DeliveredSummary = @summary,
      DeliveredDate = @calendarDate,
      LastDeliveredAt = SYSUTCDATETIME(),
      LastValidatedAt = SYSUTCDATETIME(),
      ForceResend = CASE WHEN QueueSeq = @queueSeq THEN 0 ELSE ForceResend END,
      LastFailureCode = NULL,
      -- Teslimat bitti: kira serbest bırakılır.
      InFlightSince = NULL,
      LeaseToken = NULL,
      LeaseExpiresAt = NULL,
      IsActive = CASE WHEN @method = 'CANCEL' AND @completionSuspended = 0 AND QueueSeq = @queueSeq THEN CAST(0 AS bit) ELSE IsActive END,
      PendingMethod = CASE
        WHEN QueueSeq = @queueSeq THEN NULL ELSE PendingMethod END,
      PendingSequence = CASE
        WHEN QueueSeq = @queueSeq THEN NULL ELSE PendingSequence END,
      PendingPayloadHash = CASE
        WHEN QueueSeq = @queueSeq THEN NULL ELSE PendingPayloadHash END,
      AttemptCount = 0,
      NextAttemptAt = NULL,
      UpdatedAt = SYSUTCDATETIME()
  OUTPUT inserted.SubscriptionId
  WHERE SubscriptionId = @subscriptionId AND LeaseToken = @leaseToken;`;

/** İçerik değişmediği için gönderilmeyen iş kuyruktan düşürülür. */
export const OUTLOOK_SETTLE_SQL = `
  UPDATE dbo.MR_TaskOutlookSubscriptions
  SET PendingMethod = CASE WHEN QueueSeq = @queueSeq THEN NULL ELSE PendingMethod END,
      CompletionSuspended = CASE WHEN QueueSeq = @queueSeq THEN @completionSuspended ELSE CompletionSuspended END,
      CompletionDate = CASE WHEN QueueSeq = @queueSeq AND @completionSuspended = 0 THEN NULL ELSE CompletionDate END,
      LastCancellationReason = CASE
        WHEN QueueSeq <> @queueSeq THEN LastCancellationReason
        WHEN @completionSuspended = 0 AND @cancellationReason IS NULL AND LastCancellationReason = 'TASK_COMPLETED' THEN NULL
        ELSE COALESCE(@cancellationReason, LastCancellationReason) END,
      PendingDate = CASE WHEN QueueSeq = @queueSeq THEN NULL ELSE PendingDate END,
      PendingSequence = CASE WHEN QueueSeq = @queueSeq THEN NULL ELSE PendingSequence END,
      PendingPayloadHash = CASE WHEN QueueSeq = @queueSeq THEN NULL ELSE PendingPayloadHash END,
      ForceResend = CASE WHEN QueueSeq = @queueSeq THEN 0 ELSE ForceResend END,
      LastValidatedAt = SYSUTCDATETIME(),
      AttemptCount = CASE WHEN QueueSeq = @queueSeq THEN 0 ELSE AttemptCount END,
      NextAttemptAt = NULL,
      LastFailureCode = NULL,
      InFlightSince = NULL,
      LeaseToken = NULL,
      LeaseExpiresAt = NULL,
      UpdatedAt = SYSUTCDATETIME()
  OUTPUT inserted.SubscriptionId
  WHERE SubscriptionId = @subscriptionId AND LeaseToken = @leaseToken;`;

/** Başarısız teslimat: bir sonraki hak geri çekilmeyle ertelenir. */
export const OUTLOOK_FAIL_SQL = `
  UPDATE dbo.MR_TaskOutlookSubscriptions
  SET CalendarAttendee = CASE WHEN @clearProvisional = 1 AND DeliveredSequence IS NULL THEN NULL ELSE CalendarAttendee END,
      CalendarOrganizer = CASE WHEN @clearProvisional = 1 AND DeliveredSequence IS NULL THEN NULL ELSE CalendarOrganizer END,
      DeliveryMayHaveEscaped = CASE WHEN @clearProvisional = 1 AND DeliveredSequence IS NULL THEN 0 ELSE DeliveryMayHaveEscaped END,
      LastFailureCode = CASE WHEN QueueSeq = @queueSeq THEN @failureCode ELSE LastFailureCode END,
      NextAttemptAt = CASE WHEN QueueSeq = @queueSeq THEN DATEADD(second, @retrySeconds, SYSUTCDATETIME()) ELSE NextAttemptAt END,
      InFlightSince = NULL,
      LeaseToken = NULL,
      LeaseExpiresAt = NULL,
      UpdatedAt = SYSUTCDATETIME()
  WHERE SubscriptionId = @subscriptionId AND LeaseToken = @leaseToken;`;

/**
 * Görev değiştiğinde etkin abonelikleri kuyruğa alır.
 *
 * Kalıcılık işleminin İÇİNDE çalışır: kuyruk kaydı görev kaydıyla birlikte
 * ya tümüyle olur ya da hiç olmaz. Hiçbir SMTP çağrısı bu işleme bağlı
 * değildir; posta sunucusu erişilemez olsa da görev kaydı tamamlanır.
 * Tamamlanma askısı, yeniden açılan görev için yeni REQUEST teslim edilene kadar
 * korunur; erken temizlenirse değişmeyen içerik denetimi bu daveti atlar.
 */
export const OUTLOOK_ENQUEUE_TASK_SQL = `
  UPDATE dbo.MR_TaskOutlookSubscriptions
  SET PendingMethod = CASE WHEN CancelRequested = 1 THEN 'CANCEL' ELSE 'REQUEST' END,
      CompletionSuspended = CASE WHEN @suspendCompletion = 1 THEN 1 ELSE CompletionSuspended END,
      CompletionDate = COALESCE(@completionDate, CompletionDate),
      QueueSeq = QueueSeq + 1,
      AttemptCount = 0,
      NextAttemptAt = NULL,
      LastFailureCode = NULL,
      UpdatedAt = SYSUTCDATETIME()
  WHERE TaskId = @taskId AND IsActive = 1 AND CancelRequested = 0;`;

/** Görev silindiğinde etkin abonelikler iptal için kuyruğa alınır. */
export const OUTLOOK_ENQUEUE_TASK_CANCEL_SQL = `
  UPDATE dbo.MR_TaskOutlookSubscriptions
  SET PendingMethod = 'CANCEL',
      QueueSeq = QueueSeq + 1,
      AttemptCount = 0,
      NextAttemptAt = NULL,
      LastFailureCode = NULL,
      UpdatedAt = SYSUTCDATETIME()
  WHERE TaskId = @taskId AND IsActive = 1 AND CancelRequested = 0;`;

/**
 * Proje künyesi değiştiğinde o projenin görevlerine ait abonelikler kuyruğa
 * alınır: proje kodu/adı randevu açıklamasında GÖRÜNÜR.
 */
export const OUTLOOK_ENQUEUE_PROJECT_SQL = `
  UPDATE s
  SET PendingMethod = CASE WHEN CancelRequested = 1 THEN 'CANCEL' ELSE 'REQUEST' END,
      QueueSeq = s.QueueSeq + 1,
      AttemptCount = 0,
      NextAttemptAt = NULL,
      LastFailureCode = NULL,
      UpdatedAt = SYSUTCDATETIME()
  FROM dbo.MR_TaskOutlookSubscriptions s
  JOIN dbo.MR_Tasks t ON t.TaskId = s.TaskId
  WHERE t.ProjectId = @projectId AND s.IsActive = 1 AND s.CancelRequested = 0;`;
