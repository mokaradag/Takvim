import 'server-only';

/**
 * Hatırlatma sorguları.
 *
 * Sorgu metinleri tek dosyada toplanır: şema sözleşmesi böylece tek yerden
 * okunabilir ve testler sorguları doğrudan sınayabilir.
 */

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

function identifier(name, fallback) {
  const value = String(process.env[name] ?? '').trim() || fallback;
  if (!IDENTIFIER_PATTERN.test(value)) {
    // Şema/tablo adı sorgu metnine gömüldüğü için serbest metne izin verilmez.
    throw new Error(`${name} must be a plain SQL Server identifier.`);
  }
  return value;
}

/**
 * Kurumsal kullanıcı tablosu. Varsayılan `dbo.DC01_userr`; tablo MERGEN Rota
 * veritabanının İÇİNDEDİR (bkz. MERGEN_ROTA_DB_DATABASE) ve MERGEN'e ait
 * değildir — okunur, hiçbir zaman yazılmaz ve yeniden oluşturulmaz.
 */
export function corporateUserTable() {
  return `${identifier('MERGEN_ROTA_USER_DIRECTORY_SCHEMA', 'dbo')}.${identifier('MERGEN_ROTA_USER_DIRECTORY_TABLE', 'DC01_userr')}`;
}

/**
 * Görevin sorumluları ve e-posta adresleri.
 *
 * Zincir: `MR_TaskAssignees.Sicil` → `MR_V_PeopleDirectory.Username`
 * (HR02 `kullanici_adi`) → `DC01_userr.Name` → `DC01_userr.EmailAddress`.
 *
 * `OUTER APPLY` bilinçlidir: kullanıcı kaydı ya da adresi olmayan sorumlu da
 * satır olarak döner; eksiklik sessizce kaybolmaz, çağırana açıklanabilir bir
 * sorun olarak iletilir.
 */
export function reminderRecipientsSql() {
  return `
    SELECT ta.Sicil, pd.DisplayName AS Name, pd.Username, directory.EmailAddress AS Email
    FROM dbo.MR_TaskAssignees ta
    LEFT JOIN dbo.MR_V_PeopleDirectory pd ON pd.Sicil = ta.Sicil
    OUTER APPLY (
      SELECT TOP (1) LTRIM(RTRIM(source.EmailAddress)) AS EmailAddress
      FROM ${corporateUserTable()} source
      WHERE pd.Username IS NOT NULL
        AND LTRIM(RTRIM(source.Name)) = LTRIM(RTRIM(pd.Username))
        AND NULLIF(LTRIM(RTRIM(source.EmailAddress)), '') IS NOT NULL
      ORDER BY source.EmailAddress
    ) directory
    WHERE ta.TaskId = @taskId
    ORDER BY pd.DisplayName, ta.Sicil;`;
}

/** Hatırlatma için gereken görev/proje alanları. */
export const REMINDER_TASK_SQL = `
  SELECT TOP (1)
    t.TaskId, t.ProjectId, t.Title, t.Description, t.Keyword, t.Status, t.Priority,
    t.TargetFinish, t.PlannedStart, t.PlannedFinish,
    p.ProjectCode, p.ProjectName
  FROM dbo.MR_Tasks t
  JOIN dbo.MR_Projects p ON p.ProjectId = t.ProjectId
  WHERE t.TaskId = @taskId;`;

/**
 * Otomatik gönderim adayları.
 *
 * Kapalı durumlar ve terminsiz görevler SQL'de elenir; pencere/sıklık kararı
 * saf ilke modülünde verilir (bkz. domain/reminders/reminderPolicy.js).
 * Ufuk, en geniş pencere için bile yeterli olacak biçimde gün cinsinden verilir.
 *
 * İş günü `@today` PARAMETRESİYLE gelir; `SYSDATETIME()` kullanılsaydı ön eleme
 * veritabanı sunucusunun saat dilimine, uygunluk kararı ise turu çalıştıran
 * Node sürecinin saatine göre verilir ve iki taraf farklı saat diliminde
 * olduğunda uygun bir hatırlatma ilke katmanını hiç görmeden elenirdi.
 */
export const REMINDER_CANDIDATES_SQL = `
  SELECT t.TaskId, t.ProjectId, t.Title, t.Status, t.TargetFinish
  FROM dbo.MR_Tasks t
  JOIN dbo.MR_Projects p ON p.ProjectId = t.ProjectId AND p.IsActive = 1
  WHERE t.TargetFinish IS NOT NULL
    AND t.Status NOT IN ('done', 'completed', 'cancelled')
    AND t.TargetFinish >= @today
    AND t.TargetFinish <= DATEADD(day, @horizonDays, @today)
    AND EXISTS (SELECT 1 FROM dbo.MR_TaskAssignees ta WHERE ta.TaskId = t.TaskId)
  ORDER BY t.TargetFinish, t.TaskId;`;

export const REMINDER_SETTINGS_SQL = `
  SELECT TOP (1) AutomaticEnabled, WindowValue, WindowUnit, FrequencyValue, FrequencyUnit,
    SubjectTemplate, BodyTemplate, UpdatedAt, UpdatedBySicil, RowVersion
  FROM dbo.MR_ReminderSettings
  WHERE SettingsId = 1;`;

/**
 * Yapılandırmayı İYİMSER KİLİTLE yazar.
 *
 * `@rowVersion` verildiğinde güncelleme yalnızca satır o sürümdeyken uygulanır.
 * Koşulsuz upsert'te iki yönetici aynı şablonu yükleyip ayrı düzenlemeler
 * kaydettiğinde ikinci yazma birincisini sessizce siliyordu; artık etkilenen
 * satır sayısı sıfır dönerek çakışma bildirilir.
 */
export const REMINDER_SETTINGS_UPSERT_SQL = `
  DECLARE @affected int = 0;

  IF EXISTS (SELECT 1 FROM dbo.MR_ReminderSettings WHERE SettingsId = 1)
  BEGIN
    UPDATE dbo.MR_ReminderSettings
    SET AutomaticEnabled = @automaticEnabled,
        WindowValue = @windowValue,
        WindowUnit = @windowUnit,
        FrequencyValue = @frequencyValue,
        FrequencyUnit = @frequencyUnit,
        SubjectTemplate = @subjectTemplate,
        BodyTemplate = @bodyTemplate,
        UpdatedAt = SYSUTCDATETIME(),
        UpdatedBySicil = @actorSicil
    WHERE SettingsId = 1
      AND (@rowVersion IS NULL OR RowVersion = @rowVersion);
    SET @affected = @@ROWCOUNT;
  END
  ELSE
  BEGIN
    INSERT dbo.MR_ReminderSettings(
      SettingsId, AutomaticEnabled, WindowValue, WindowUnit, FrequencyValue, FrequencyUnit,
      SubjectTemplate, BodyTemplate, UpdatedBySicil
    ) VALUES(
      1, @automaticEnabled, @windowValue, @windowUnit, @frequencyValue, @frequencyUnit,
      @subjectTemplate, @bodyTemplate, @actorSicil
    );
    SET @affected = @@ROWCOUNT;
  END

  SELECT @affected AS AffectedRows;`;

/**
 * Otomatik gönderim aralığını KALICI olarak sahiplenir.
 *
 * Benzersiz dizin `(TaskId, SlotKey)` üzerindedir: zamanlayıcı saatte bir
 * çalışsa, iki uygulama örneği aynı anda başlasa ya da sunucu yeniden başlasa
 * bile aynı aralık ikinci kez eklenemez. Satır ÖNCE `PENDING` olarak yazılır;
 * gönderim sonucunda `SENT` ya da `FAILED` yapılır. Başarısız aralık da
 * sahiplenilmiş kalır: aynı aralıkta sonsuz yeniden deneme yapılmaz, bir
 * sonraki aralıkta yeniden denenir.
 */
/**
 * Otomatik aralığı sahiplenir.
 *
 * TERK EDİLMİŞ kayıt yeniden sahiplenilebilir. Kayıt gönderimden ÖNCE
 * `PENDING` olarak yazılır; süreç dağıtım, yeniden başlatma ya da makine
 * çökmesiyle arada sonlanırsa satır sonsuza dek `PENDING` kalıyor, sonraki
 * turlar aralığı "gönderilmiş" sayıyor ve o hatırlatma bir daha
 * gönderilemiyordu. `@staleMinutes` dakikadan eski bir `PENDING` satır bu
 * yüzden yerinde yeniden sahiplenilir (benzersiz dizin ikinci satıra izin
 * vermez).
 *
 * Sonuç TEK bir kayıt kümesidir: sürücü ilk kümeyi okur.
 */
export const REMINDER_CLAIM_SQL = `
  SET NOCOUNT ON;

  DECLARE @logId bigint = NULL;
  DECLARE @staleBefore datetime2(3) = DATEADD(minute, -@staleMinutes, SYSUTCDATETIME());
  DECLARE @reclaimed TABLE (TaskReminderLogId bigint);
  DECLARE @created TABLE (TaskReminderLogId bigint);

  UPDATE dbo.MR_TaskReminderLog
  SET Status = 'PENDING',
      RequestedBySicil = @actorSicil,
      RecipientCount = 0,
      RecipientDigest = NULL,
      FailureCode = 'ABANDONED',
      CreatedAt = SYSUTCDATETIME(),
      CompletedAt = NULL
  OUTPUT inserted.TaskReminderLogId INTO @reclaimed
  WHERE TaskId = @taskId
    AND SlotKey = @slotKey
    AND ReminderKind = 'AUTOMATIC'
    AND Status = 'PENDING'
    AND CreatedAt < @staleBefore;

  SELECT TOP (1) @logId = TaskReminderLogId FROM @reclaimed;

  IF @logId IS NULL AND NOT EXISTS (
    SELECT 1 FROM dbo.MR_TaskReminderLog
    WHERE TaskId = @taskId AND SlotKey = @slotKey AND ReminderKind = 'AUTOMATIC'
  )
  BEGIN
    INSERT dbo.MR_TaskReminderLog(TaskId, ProjectId, ReminderKind, SlotKey, Status, RequestedBySicil)
    OUTPUT inserted.TaskReminderLogId INTO @created
    VALUES(@taskId, @projectId, 'AUTOMATIC', @slotKey, 'PENDING', @actorSicil);

    SELECT TOP (1) @logId = TaskReminderLogId FROM @created;
  END

  SELECT @logId AS TaskReminderLogId;`;

export const REMINDER_MANUAL_LOG_SQL = `
  INSERT dbo.MR_TaskReminderLog(TaskId, ProjectId, ReminderKind, SlotKey, Status, RequestedBySicil)
  OUTPUT inserted.TaskReminderLogId
  VALUES(@taskId, @projectId, 'MANUAL', @slotKey, 'PENDING', @actorSicil);`;

export const REMINDER_COMPLETE_SQL = `
  UPDATE dbo.MR_TaskReminderLog
  SET Status = @status,
      RecipientCount = @recipientCount,
      RecipientDigest = @recipientDigest,
      FailureCode = @failureCode,
      CompletedAt = SYSUTCDATETIME()
  WHERE TaskReminderLogId = @logId;`;

/**
 * Bir kullanıcının o göreve yaptığı SON elle gönderim.
 *
 * Elle gönderim ucu, görevi görebilen herkesin çağırabildiği ve her çağrının
 * gerçek e-posta ürettiği bir uçtur; en küçük aralık bu kayıttan hesaplanır.
 */
export const REMINDER_LAST_MANUAL_SQL = `
  SELECT TOP (1) CreatedAt
  FROM dbo.MR_TaskReminderLog
  WHERE TaskId = @taskId
    AND ReminderKind = 'MANUAL'
    AND RequestedBySicil = @actorSicil
  ORDER BY TaskReminderLogId DESC;`;

export const REMINDER_HISTORY_SQL = `
  SELECT TOP (@limit) TaskReminderLogId, TaskId, ReminderKind, SlotKey, Status,
    RecipientCount, FailureCode, CreatedAt, CompletedAt
  FROM dbo.MR_TaskReminderLog
  ORDER BY TaskReminderLogId DESC;`;
