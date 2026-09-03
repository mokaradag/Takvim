/*
  MERGEN Rota — audit soft-deactivation actions

  Project deletion is a recoverable deactivation. Keep that distinction in the
  audit log while making the durable schema accept the action used by the
  repository. The migration is safe to run repeatedly.
*/
SET NOCOUNT ON;
SET XACT_ABORT ON;

BEGIN TRY
    BEGIN TRANSACTION;

    -- Dayanıklı şema YOKSA bu bir yükseltme değil, yanlış veritabanıdır.
    -- Betik eskiden sessizce başarıyla dönüyor, hiçbir şey uygulamadığı hâlde
    -- işletmene "0006 çalıştı" izlenimi veriyordu.
    IF OBJECT_ID(N'dbo.MR_AuditLog', N'U') IS NULL
        THROW 51006, 'MR_AuditLog bulunamadı: önce MR_Create_Durable_Persistence.sql ya da önceki yükseltme betikleri çalıştırılmalıdır.', 1;

    -- Göç GÜNLÜĞÜ de zorunludur ve DDL'den ÖNCE denetlenir. `MR_AuditLog`
    -- bulunup `MR_SchemaMigrations` bulunmayan bir kurulumda kısıt değişikliği
    -- işleniyor, betik başarı bildiriyor, ama aşağıdaki koşullu ekleme hiçbir
    -- kayıt yazmıyordu: sonraki göç denetimleri 0006'yı "uygulanmamış" görüyor
    -- ve yeniden çalıştırmalar aynı DDL'i tekrarlıyordu.
    IF OBJECT_ID(N'dbo.MR_SchemaMigrations', N'U') IS NULL
        THROW 51006, 'MR_SchemaMigrations bulunamadı: göç günlüğü olmadan yükseltme uygulanamaz.', 1;

    IF OBJECT_ID(N'dbo.CK_MR_AuditLog_Action', N'C') IS NOT NULL
        ALTER TABLE dbo.MR_AuditLog DROP CONSTRAINT CK_MR_AuditLog_Action;

    ALTER TABLE dbo.MR_AuditLog WITH CHECK
        ADD CONSTRAINT CK_MR_AuditLog_Action
        CHECK (ActionCode IN ('CREATE','UPDATE','DELETE','DEACTIVATE'));
    ALTER TABLE dbo.MR_AuditLog CHECK CONSTRAINT CK_MR_AuditLog_Action;

    -- Göç KAYDEDİLİR. Kayıt yazılmadığında, değişiklik başarıyla uygulanmış
    -- olsa bile kurulum 0006'yı "eksik" bildiriyordu.
    IF NOT EXISTS (
        SELECT 1
        FROM dbo.MR_SchemaMigrations
        WHERE MigrationId = N'0006_audit_deactivation'
    )
        INSERT dbo.MR_SchemaMigrations(MigrationId, Description)
        VALUES (N'0006_audit_deactivation', N'Denetim kaydında geri alınabilir proje devre dışı bırakma eylemi');

    COMMIT TRANSACTION;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    THROW;
END CATCH;
