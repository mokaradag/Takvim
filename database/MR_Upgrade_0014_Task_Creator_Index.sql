SET NOCOUNT ON;
SET XACT_ABORT ON;
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;

/*
    MERGEN Rota · 0014 — Görev oluşturan dizini.

    `MR_Tasks.CreatedBySicil = @sicil` yüklemi üç sıcak yolda çalışır:
      · loadAuthorizationContext  — her anlık görüntü VE her yazma işleminde
      · loadSnapshotFrom          — kendi kapsamındaki projeler kümesi
      · loadAuthoritativeMutationRows — görev tabanlı proje görünürlüğü

    MR_Tasks üzerindeki var olan dizinlerin hiçbiri bu sütunla BAŞLAMAZ ve onu
    içermez (PK TaskId; ProjectId ile başlayan üç dizin; WbsId; iki yineleme
    dizini). Yüklem bu yüzden tablonun tamamı kadar iş yapıyordu: maliyet
    kullanıcının kendi görev sayısıyla değil, toplam görev sayısıyla büyüyordu.

    Dizin dardır (int anahtar + ProjectId) ve MR_Tasks yazmaları kullanıcı
    hızındaki tekil mutasyonlardır. Betik yinelenebilir; 0013 uygulandıktan
    sonra çalıştırılır ve veriye dokunmaz.
*/
BEGIN TRY
    BEGIN TRANSACTION;

    IF OBJECT_ID(N'dbo.MR_Tasks', N'U') IS NULL
        THROW 51014, N'Önce MR_Create_Durable_Persistence.sql betiğini uygulayın.', 1;

    IF NOT EXISTS (
        SELECT 1
        FROM dbo.MR_SchemaMigrations
        WHERE MigrationId = N'0013_corporate_wbs_sync_freshness'
    )
        THROW 51014, N'Önce 0013_corporate_wbs_sync_freshness göçünü uygulayın.', 1;

    IF NOT EXISTS (
        SELECT 1 FROM sys.indexes
        WHERE object_id = OBJECT_ID(N'dbo.MR_Tasks') AND name = N'IX_MR_Tasks_CreatedBySicil'
    )
        CREATE INDEX IX_MR_Tasks_CreatedBySicil ON dbo.MR_Tasks(CreatedBySicil) INCLUDE (ProjectId);

    IF NOT EXISTS (
        SELECT 1 FROM sys.indexes
        WHERE object_id = OBJECT_ID(N'dbo.MR_Tasks') AND name = N'IX_MR_Tasks_CreatedBySicil'
    )
        THROW 51014, N'0014: IX_MR_Tasks_CreatedBySicil oluşturulamadı.', 1;

    IF NOT EXISTS (
        SELECT 1 FROM dbo.MR_SchemaMigrations
        WHERE MigrationId = N'0014_task_creator_index'
    )
        INSERT dbo.MR_SchemaMigrations(MigrationId, Description)
        VALUES (
            N'0014_task_creator_index',
            N'Görev oluşturan Sicil dizini: yetki ve anlık görüntü sorgularında tam tablo taramasını kaldırır'
        );

    COMMIT TRANSACTION;
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    THROW;
END CATCH;
