SET NOCOUNT ON;
SET XACT_ABORT ON;

BEGIN TRY
    BEGIN TRANSACTION;

    IF OBJECT_ID(N'dbo.HR02_rehisRehberwithMasrafYeri', N'U') IS NULL
        THROW 51000, 'Required source table dbo.HR02_rehisRehberwithMasrafYeri was not found.', 1;
    IF OBJECT_ID(N'dbo.A01_ProjeUrunFaaliyetRaporu', N'U') IS NULL
        THROW 51000, 'Required source table dbo.A01_ProjeUrunFaaliyetRaporu was not found.', 1;
    IF OBJECT_ID(N'dbo.HR09_projeSorumlu', N'U') IS NULL
        THROW 51000, 'Required source table dbo.HR09_projeSorumlu was not found.', 1;

    IF EXISTS (SELECT 1 FROM sys.objects WHERE schema_id = SCHEMA_ID(N'dbo') AND name LIKE N'MR[_]%' AND type IN ('U','V'))
        THROW 51000, 'MERGEN Rota MR_* objects already exist. Run the rollback script before clean creation.', 1;

    CREATE TABLE dbo.MR_SchemaMigrations (
        MigrationId nvarchar(100) NOT NULL CONSTRAINT PK_MR_SchemaMigrations PRIMARY KEY,
        Description nvarchar(500) NOT NULL,
        AppliedAt datetime2(7) NOT NULL CONSTRAINT DF_MR_SchemaMigrations_AppliedAt DEFAULT SYSUTCDATETIME()
    );

    CREATE TABLE dbo.MR_UserRoles (
        Sicil int NOT NULL,
        RoleCode varchar(50) NOT NULL,
        IsActive bit NOT NULL CONSTRAINT DF_MR_UserRoles_IsActive DEFAULT (1),
        CreatedAt datetime2(7) NOT NULL CONSTRAINT DF_MR_UserRoles_CreatedAt DEFAULT SYSUTCDATETIME(),
        CreatedBySicil int NULL,
        UpdatedAt datetime2(7) NOT NULL CONSTRAINT DF_MR_UserRoles_UpdatedAt DEFAULT SYSUTCDATETIME(),
        UpdatedBySicil int NULL,
        RowVersion rowversion NOT NULL,
        CONSTRAINT PK_MR_UserRoles PRIMARY KEY (Sicil, RoleCode),
        CONSTRAINT CK_MR_UserRoles_RoleCode CHECK (RoleCode IN ('SYSTEM_ADMIN'))
    );
    CREATE INDEX IX_MR_UserRoles_Role_Active_Sicil ON dbo.MR_UserRoles(RoleCode, IsActive, Sicil);

    CREATE TABLE dbo.MR_Calendars (
        CalendarId uniqueidentifier NOT NULL CONSTRAINT DF_MR_Calendars_Id DEFAULT NEWSEQUENTIALID(),
        Name nvarchar(255) NOT NULL,
        TimeZone nvarchar(100) NOT NULL,
        IsDefault bit NOT NULL CONSTRAINT DF_MR_Calendars_IsDefault DEFAULT (0),
        IsActive bit NOT NULL CONSTRAINT DF_MR_Calendars_IsActive DEFAULT (1),
        CreatedAt datetime2(7) NOT NULL CONSTRAINT DF_MR_Calendars_CreatedAt DEFAULT SYSUTCDATETIME(),
        CreatedBySicil int NULL,
        UpdatedAt datetime2(7) NOT NULL CONSTRAINT DF_MR_Calendars_UpdatedAt DEFAULT SYSUTCDATETIME(),
        UpdatedBySicil int NULL,
        RowVersion rowversion NOT NULL,
        CONSTRAINT PK_MR_Calendars PRIMARY KEY (CalendarId)
    );
    CREATE UNIQUE INDEX UX_MR_Calendars_ActiveDefault ON dbo.MR_Calendars(IsDefault) WHERE IsDefault = 1 AND IsActive = 1;

    CREATE TABLE dbo.MR_CalendarWorkingDays (
        CalendarId uniqueidentifier NOT NULL,
        Weekday tinyint NOT NULL,
        CONSTRAINT PK_MR_CalendarWorkingDays PRIMARY KEY (CalendarId, Weekday),
        CONSTRAINT FK_MR_CalendarWorkingDays_Calendars FOREIGN KEY (CalendarId) REFERENCES dbo.MR_Calendars(CalendarId),
        CONSTRAINT CK_MR_CalendarWorkingDays_Weekday CHECK (Weekday BETWEEN 0 AND 6)
    );

    CREATE TABLE dbo.MR_CalendarHolidays (
        CalendarId uniqueidentifier NOT NULL,
        HolidayDate date NOT NULL,
        Name nvarchar(255) NOT NULL,
        ShortName nvarchar(100) NULL,
        CONSTRAINT PK_MR_CalendarHolidays PRIMARY KEY (CalendarId, HolidayDate),
        CONSTRAINT FK_MR_CalendarHolidays_Calendars FOREIGN KEY (CalendarId) REFERENCES dbo.MR_Calendars(CalendarId)
    );

    CREATE TABLE dbo.MR_Projects (
        ProjectId uniqueidentifier NOT NULL CONSTRAINT DF_MR_Projects_Id DEFAULT NEWSEQUENTIALID(),
        SourceType varchar(20) NOT NULL,
        ProjectCode nvarchar(255) NULL,
        ProjectName nvarchar(1000) NOT NULL,
        ProjectTypeCode nvarchar(255) NULL,
        ProjectTypeName nvarchar(1000) NULL,
        LeadSicil int NULL,
        DataDate date NULL,
        ColorToken varchar(50) NULL,
        CalendarId uniqueidentifier NULL,
        IsActive bit NOT NULL CONSTRAINT DF_MR_Projects_IsActive DEFAULT (1),
        CreatedAt datetime2(7) NOT NULL CONSTRAINT DF_MR_Projects_CreatedAt DEFAULT SYSUTCDATETIME(),
        CreatedBySicil int NULL,
        UpdatedAt datetime2(7) NOT NULL CONSTRAINT DF_MR_Projects_UpdatedAt DEFAULT SYSUTCDATETIME(),
        UpdatedBySicil int NULL,
        RowVersion rowversion NOT NULL,
        CONSTRAINT PK_MR_Projects PRIMARY KEY (ProjectId),
        CONSTRAINT FK_MR_Projects_Calendars FOREIGN KEY (CalendarId) REFERENCES dbo.MR_Calendars(CalendarId),
        CONSTRAINT CK_MR_Projects_SourceType CHECK (SourceType IN ('CORPORATE','MANUAL'))
    );
    CREATE UNIQUE INDEX UX_MR_Projects_ProjectCode ON dbo.MR_Projects(ProjectCode) WHERE ProjectCode IS NOT NULL;
    CREATE UNIQUE INDEX UX_MR_Projects_Project_ProjectId ON dbo.MR_Projects(ProjectId);
    CREATE INDEX IX_MR_Projects_Source_Active ON dbo.MR_Projects(SourceType, IsActive, ProjectCode);
    CREATE INDEX IX_MR_Projects_CalendarId ON dbo.MR_Projects(CalendarId);

    CREATE TABLE dbo.MR_ProjectTags (
        ProjectTagId uniqueidentifier NOT NULL CONSTRAINT DF_MR_ProjectTags_Id DEFAULT NEWSEQUENTIALID(),
        ProjectId uniqueidentifier NOT NULL,
        TagName nvarchar(255) NOT NULL,
        SortOrder int NULL,
        CreatedAt datetime2(7) NOT NULL CONSTRAINT DF_MR_ProjectTags_CreatedAt DEFAULT SYSUTCDATETIME(),
        CreatedBySicil int NULL,
        CONSTRAINT PK_MR_ProjectTags PRIMARY KEY (ProjectTagId),
        CONSTRAINT FK_MR_ProjectTags_Projects FOREIGN KEY (ProjectId) REFERENCES dbo.MR_Projects(ProjectId),
        CONSTRAINT UX_MR_ProjectTags_Project_Tag UNIQUE (ProjectId, TagName)
    );

    CREATE TABLE dbo.MR_ProjectAccess (
        ProjectId uniqueidentifier NOT NULL,
        Sicil int NOT NULL,
        AccessLevel varchar(20) NOT NULL,
        GrantSource varchar(30) NOT NULL,
        IsActive bit NOT NULL CONSTRAINT DF_MR_ProjectAccess_IsActive DEFAULT (1),
        CreatedAt datetime2(7) NOT NULL CONSTRAINT DF_MR_ProjectAccess_CreatedAt DEFAULT SYSUTCDATETIME(),
        CreatedBySicil int NULL,
        UpdatedAt datetime2(7) NOT NULL CONSTRAINT DF_MR_ProjectAccess_UpdatedAt DEFAULT SYSUTCDATETIME(),
        UpdatedBySicil int NULL,
        RowVersion rowversion NOT NULL,
        CONSTRAINT PK_MR_ProjectAccess PRIMARY KEY (ProjectId, Sicil),
        CONSTRAINT FK_MR_ProjectAccess_Projects FOREIGN KEY (ProjectId) REFERENCES dbo.MR_Projects(ProjectId),
        CONSTRAINT CK_MR_ProjectAccess_Level CHECK (AccessLevel IN ('FULL','READ')),
        CONSTRAINT CK_MR_ProjectAccess_Source CHECK (GrantSource IN ('OWNER','MANUAL_GRANT'))
    );
    CREATE INDEX IX_MR_ProjectAccess_Sicil_Active_Level ON dbo.MR_ProjectAccess(Sicil, IsActive, AccessLevel, ProjectId);

    CREATE TABLE dbo.MR_WBS (
        WbsId uniqueidentifier NOT NULL CONSTRAINT DF_MR_WBS_Id DEFAULT NEWSEQUENTIALID(),
        ProjectId uniqueidentifier NOT NULL,
        ParentWbsId uniqueidentifier NULL,
        Code nvarchar(100) NOT NULL,
        Name nvarchar(1000) NOT NULL,
        SortOrder int NULL,
        CreatedAt datetime2(7) NOT NULL CONSTRAINT DF_MR_WBS_CreatedAt DEFAULT SYSUTCDATETIME(),
        CreatedBySicil int NULL,
        UpdatedAt datetime2(7) NOT NULL CONSTRAINT DF_MR_WBS_UpdatedAt DEFAULT SYSUTCDATETIME(),
        UpdatedBySicil int NULL,
        RowVersion rowversion NOT NULL,
        CONSTRAINT PK_MR_WBS PRIMARY KEY (WbsId),
        CONSTRAINT FK_MR_WBS_Projects FOREIGN KEY (ProjectId) REFERENCES dbo.MR_Projects(ProjectId),
        CONSTRAINT UX_MR_WBS_Id_Project UNIQUE (WbsId, ProjectId),
        CONSTRAINT UX_MR_WBS_Project_Code UNIQUE (ProjectId, Code),
        CONSTRAINT FK_MR_WBS_Parent_SameProject FOREIGN KEY (ParentWbsId, ProjectId) REFERENCES dbo.MR_WBS(WbsId, ProjectId)
    );
    CREATE INDEX IX_MR_WBS_Project_Parent_Sort ON dbo.MR_WBS(ProjectId, ParentWbsId, SortOrder);

    CREATE TABLE dbo.MR_Tasks (
        TaskId uniqueidentifier NOT NULL CONSTRAINT DF_MR_Tasks_Id DEFAULT NEWSEQUENTIALID(),
        ProjectId uniqueidentifier NOT NULL,
        WbsId uniqueidentifier NULL,
        CalendarId uniqueidentifier NULL,
        Title nvarchar(1000) NOT NULL,
        Description nvarchar(max) NULL,
        Keyword nvarchar(255) NULL,
        Status varchar(30) NOT NULL,
        Priority varchar(30) NOT NULL,
        IsMilestone bit NOT NULL CONSTRAINT DF_MR_Tasks_IsMilestone DEFAULT (0),
        PlannedStart date NULL,
        PlannedFinish date NULL,
        PlannedDurationDays decimal(10,2) NULL,
        TargetFinish date NULL,
        ActualStart date NULL,
        ActualFinish date NULL,
        RemainingDurationDays decimal(10,2) NULL,
        Progress decimal(5,2) NULL,
        PlannedHours decimal(12,2) NULL,
        ActualHours decimal(12,2) NULL,
        Budget decimal(19,4) NULL,
        Spent decimal(19,4) NULL,
        SortOrder int NULL,
        CreatedAt datetime2(7) NOT NULL CONSTRAINT DF_MR_Tasks_CreatedAt DEFAULT SYSUTCDATETIME(),
        CreatedBySicil int NULL,
        UpdatedAt datetime2(7) NOT NULL CONSTRAINT DF_MR_Tasks_UpdatedAt DEFAULT SYSUTCDATETIME(),
        UpdatedBySicil int NULL,
        RowVersion rowversion NOT NULL,
        CONSTRAINT PK_MR_Tasks PRIMARY KEY (TaskId),
        CONSTRAINT FK_MR_Tasks_Projects FOREIGN KEY (ProjectId) REFERENCES dbo.MR_Projects(ProjectId),
        CONSTRAINT FK_MR_Tasks_WBS_SameProject FOREIGN KEY (WbsId, ProjectId) REFERENCES dbo.MR_WBS(WbsId, ProjectId),
        CONSTRAINT FK_MR_Tasks_Calendars FOREIGN KEY (CalendarId) REFERENCES dbo.MR_Calendars(CalendarId),
        CONSTRAINT UX_MR_Tasks_Id_Project UNIQUE (TaskId, ProjectId),
        CONSTRAINT CK_MR_Tasks_Progress CHECK (Progress IS NULL OR Progress BETWEEN 0 AND 100),
        CONSTRAINT CK_MR_Tasks_Durations CHECK ((PlannedDurationDays IS NULL OR PlannedDurationDays >= 0) AND (RemainingDurationDays IS NULL OR RemainingDurationDays >= 0)),
        CONSTRAINT CK_MR_Tasks_PlannedDates CHECK (PlannedStart IS NULL OR PlannedFinish IS NULL OR PlannedFinish >= PlannedStart),
        CONSTRAINT CK_MR_Tasks_ActualDates CHECK ((ActualFinish IS NULL OR ActualStart IS NOT NULL) AND (ActualStart IS NULL OR ActualFinish IS NULL OR ActualFinish >= ActualStart)),
        CONSTRAINT CK_MR_Tasks_MilestoneDuration CHECK (IsMilestone = 0 OR ISNULL(PlannedDurationDays, 0) = 0),
        CONSTRAINT CK_MR_Tasks_Status CHECK (Status IN ('planned','in-progress','done')),
        CONSTRAINT CK_MR_Tasks_Priority CHECK (Priority IN ('low','medium','high','critical','normal'))
    );
    CREATE INDEX IX_MR_Tasks_Project_Status ON dbo.MR_Tasks(ProjectId, Status, SortOrder);
    CREATE INDEX IX_MR_Tasks_Project_TargetFinish ON dbo.MR_Tasks(ProjectId, TargetFinish);
    CREATE INDEX IX_MR_Tasks_Project_PlannedRange ON dbo.MR_Tasks(ProjectId, PlannedStart, PlannedFinish);
    CREATE INDEX IX_MR_Tasks_WbsId ON dbo.MR_Tasks(WbsId, SortOrder);

    CREATE TABLE dbo.MR_TaskAssignees (
        TaskId uniqueidentifier NOT NULL,
        Sicil int NOT NULL,
        AssignedAt datetime2(7) NOT NULL CONSTRAINT DF_MR_TaskAssignees_AssignedAt DEFAULT SYSUTCDATETIME(),
        AssignedBySicil int NULL,
        CONSTRAINT PK_MR_TaskAssignees PRIMARY KEY (TaskId, Sicil),
        CONSTRAINT FK_MR_TaskAssignees_Tasks FOREIGN KEY (TaskId) REFERENCES dbo.MR_Tasks(TaskId)
    );
    CREATE INDEX IX_MR_TaskAssignees_Sicil_Task ON dbo.MR_TaskAssignees(Sicil, TaskId);

    CREATE TABLE dbo.MR_TaskDependencies (
        TaskDependencyId uniqueidentifier NOT NULL CONSTRAINT DF_MR_TaskDependencies_Id DEFAULT NEWSEQUENTIALID(),
        ProjectId uniqueidentifier NOT NULL,
        TaskId uniqueidentifier NOT NULL,
        PredecessorTaskId uniqueidentifier NOT NULL,
        DependencyType char(2) NOT NULL,
        LagDays decimal(10,2) NOT NULL CONSTRAINT DF_MR_TaskDependencies_LagDays DEFAULT (0),
        LagValue decimal(10,2) NULL,
        LagUnit varchar(10) NULL,
        CreatedAt datetime2(7) NOT NULL CONSTRAINT DF_MR_TaskDependencies_CreatedAt DEFAULT SYSUTCDATETIME(),
        CreatedBySicil int NULL,
        UpdatedAt datetime2(7) NOT NULL CONSTRAINT DF_MR_TaskDependencies_UpdatedAt DEFAULT SYSUTCDATETIME(),
        UpdatedBySicil int NULL,
        CONSTRAINT PK_MR_TaskDependencies PRIMARY KEY (TaskDependencyId),
        CONSTRAINT FK_MR_TaskDependencies_Task FOREIGN KEY (TaskId, ProjectId) REFERENCES dbo.MR_Tasks(TaskId, ProjectId),
        CONSTRAINT FK_MR_TaskDependencies_Predecessor FOREIGN KEY (PredecessorTaskId, ProjectId) REFERENCES dbo.MR_Tasks(TaskId, ProjectId),
        CONSTRAINT UX_MR_TaskDependencies_Relationship UNIQUE (ProjectId, TaskId, PredecessorTaskId),
        CONSTRAINT CK_MR_TaskDependencies_Type CHECK (DependencyType IN ('FS','SS','FF','SF')),
        CONSTRAINT CK_MR_TaskDependencies_Unit CHECK (LagUnit IS NULL OR LagUnit IN ('day','week','month')),
        CONSTRAINT CK_MR_TaskDependencies_NotSelf CHECK (TaskId <> PredecessorTaskId)
    );
    CREATE INDEX IX_MR_TaskDependencies_Predecessor ON dbo.MR_TaskDependencies(ProjectId, PredecessorTaskId, TaskId);

    CREATE TABLE dbo.MR_Baselines (
        BaselineId uniqueidentifier NOT NULL CONSTRAINT DF_MR_Baselines_Id DEFAULT NEWSEQUENTIALID(),
        ProjectId uniqueidentifier NOT NULL,
        Name nvarchar(255) NOT NULL,
        CreatedAt datetime2(7) NOT NULL CONSTRAINT DF_MR_Baselines_CreatedAt DEFAULT SYSUTCDATETIME(),
        CreatedBySicil int NULL,
        IsPrimary bit NOT NULL CONSTRAINT DF_MR_Baselines_IsPrimary DEFAULT (0),
        CONSTRAINT PK_MR_Baselines PRIMARY KEY (BaselineId),
        CONSTRAINT FK_MR_Baselines_Projects FOREIGN KEY (ProjectId) REFERENCES dbo.MR_Projects(ProjectId)
    );
    CREATE UNIQUE INDEX UX_MR_Baselines_Primary ON dbo.MR_Baselines(ProjectId) WHERE IsPrimary = 1;
    CREATE INDEX IX_MR_Baselines_Project ON dbo.MR_Baselines(ProjectId, CreatedAt);

    CREATE TABLE dbo.MR_TaskBaselineSnapshots (
        BaselineId uniqueidentifier NOT NULL,
        TaskId uniqueidentifier NOT NULL,
        PlannedStart date NULL,
        PlannedFinish date NULL,
        PlannedDurationDays decimal(10,2) NULL,
        CalendarId uniqueidentifier NULL,
        CONSTRAINT PK_MR_TaskBaselineSnapshots PRIMARY KEY (BaselineId, TaskId),
        CONSTRAINT FK_MR_TaskBaselineSnapshots_Baselines FOREIGN KEY (BaselineId) REFERENCES dbo.MR_Baselines(BaselineId),
        CONSTRAINT FK_MR_TaskBaselineSnapshots_Calendars FOREIGN KEY (CalendarId) REFERENCES dbo.MR_Calendars(CalendarId)
    );
    CREATE INDEX IX_MR_TaskBaselineSnapshots_TaskId ON dbo.MR_TaskBaselineSnapshots(TaskId);

    CREATE TABLE dbo.MR_AuditLog (
        AuditId bigint IDENTITY(1,1) NOT NULL CONSTRAINT PK_MR_AuditLog PRIMARY KEY,
        OccurredAt datetime2(7) NOT NULL CONSTRAINT DF_MR_AuditLog_OccurredAt DEFAULT SYSUTCDATETIME(),
        ActorSicil int NULL,
        ActorUsername nvarchar(255) NULL,
        ActorDisplayName nvarchar(255) NULL,
        ActionCode varchar(50) NOT NULL,
        EntityType varchar(50) NOT NULL,
        EntityId nvarchar(100) NOT NULL,
        ProjectId uniqueidentifier NULL,
        CorrelationId uniqueidentifier NOT NULL,
        RequestId nvarchar(100) NULL,
        BeforeJson nvarchar(max) NULL,
        AfterJson nvarchar(max) NULL,
        CONSTRAINT CK_MR_AuditLog_Action CHECK (ActionCode IN ('CREATE','UPDATE','DELETE')),
        CONSTRAINT CK_MR_AuditLog_BeforeJson CHECK (BeforeJson IS NULL OR ISJSON(BeforeJson) = 1),
        CONSTRAINT CK_MR_AuditLog_AfterJson CHECK (AfterJson IS NULL OR ISJSON(AfterJson) = 1)
    );
    CREATE INDEX IX_MR_AuditLog_Project_Occurred ON dbo.MR_AuditLog(ProjectId, OccurredAt DESC);
    CREATE INDEX IX_MR_AuditLog_Actor_Occurred ON dbo.MR_AuditLog(ActorSicil, OccurredAt DESC);
    CREATE INDEX IX_MR_AuditLog_Entity_Occurred ON dbo.MR_AuditLog(EntityType, EntityId, OccurredAt DESC);
    CREATE INDEX IX_MR_AuditLog_Correlation ON dbo.MR_AuditLog(CorrelationId);

    EXEC(N'CREATE VIEW dbo.MR_V_CorporateProjects AS
        SELECT
            NULLIF(LTRIM(RTRIM(Tur)), N'''') AS ProjectTypeCode,
            NULLIF(LTRIM(RTRIM(Tur_Aciklama)), N'''') AS ProjectTypeName,
            UPPER(NULLIF(LTRIM(RTRIM(ProjeKodu)), N'''')) AS ProjectCode,
            COALESCE(NULLIF(LTRIM(RTRIM(ProjeAdi)), N''''), NULLIF(LTRIM(RTRIM(ProjeKodu)), N'''')) AS ProjectName
        FROM dbo.A01_ProjeUrunFaaliyetRaporu
        WHERE NULLIF(LTRIM(RTRIM(ProjeKodu)), N'''') IS NOT NULL
        GROUP BY Tur, Tur_Aciklama, ProjeKodu, ProjeAdi;');

    EXEC(N'CREATE VIEW dbo.MR_V_ExecutiveScope AS
        SELECT DISTINCT direktorluk_yonetici_sicil AS ManagerSicil, sicil AS EmployeeSicil, CAST(''DIRECTORATE'' AS varchar(20)) AS ScopeType
        FROM dbo.HR02_rehisRehberwithMasrafYeri
        WHERE direktorluk_yonetici_sicil IS NOT NULL AND sicil IS NOT NULL
        UNION
        SELECT DISTINCT mudurluk_yonetici_sicil, sicil, CAST(''DEPARTMENT'' AS varchar(20))
        FROM dbo.HR02_rehisRehberwithMasrafYeri
        WHERE mudurluk_yonetici_sicil IS NOT NULL AND sicil IS NOT NULL
        UNION
        SELECT DISTINCT birim_yonetici_sicil, sicil, CAST(''UNIT'' AS varchar(20))
        FROM dbo.HR02_rehisRehberwithMasrafYeri
        WHERE birim_yonetici_sicil IS NOT NULL AND sicil IS NOT NULL;');

    EXEC(N'CREATE VIEW dbo.MR_V_CorporateProjectAccess AS
        SELECT UPPER(NULLIF(LTRIM(RTRIM(projeKodu)), N'''')) AS ProjectCode, projeYoneticisiSicil AS Sicil, CAST(''PROJECT_MANAGER'' AS varchar(50)) AS RoleCode, programMdl AS ProgramMd FROM dbo.HR09_projeSorumlu WHERE projeYoneticisiSicil IS NOT NULL
        UNION ALL SELECT UPPER(NULLIF(LTRIM(RTRIM(projeKodu)), N'''')), teknikYoneticiSicil, ''TECHNICAL_MANAGER'', programMdl FROM dbo.HR09_projeSorumlu WHERE teknikYoneticiSicil IS NOT NULL
        UNION ALL SELECT UPPER(NULLIF(LTRIM(RTRIM(projeKodu)), N'''')), kaliteYoneticiSicil, ''QUALITY_MANAGER'', programMdl FROM dbo.HR09_projeSorumlu WHERE kaliteYoneticiSicil IS NOT NULL
        UNION ALL SELECT UPPER(NULLIF(LTRIM(RTRIM(projeKodu)), N'''')), tedarikSorumlusuSicil, ''PROCUREMENT_RESPONSIBLE'', programMdl FROM dbo.HR09_projeSorumlu WHERE tedarikSorumlusuSicil IS NOT NULL
        UNION ALL SELECT UPPER(NULLIF(LTRIM(RTRIM(projeKodu)), N'''')), TRY_CONVERT(int, LTRIM(RTRIM(value))), ''PPTS'', programMdl FROM dbo.HR09_projeSorumlu CROSS APPLY STRING_SPLIT(pptsSicil, '','') WHERE TRY_CONVERT(int, LTRIM(RTRIM(value))) IS NOT NULL
        UNION ALL SELECT UPPER(NULLIF(LTRIM(RTRIM(projeKodu)), N'''')), uretimPlanlamaSorumlusuSicil, ''PRODUCTION_PLANNING_RESPONSIBLE'', programMdl FROM dbo.HR09_projeSorumlu WHERE uretimPlanlamaSorumlusuSicil IS NOT NULL
        UNION ALL SELECT UPPER(NULLIF(LTRIM(RTRIM(projeKodu)), N'''')), teslimatYoneticiSicil, ''DELIVERY_MANAGER'', programMdl FROM dbo.HR09_projeSorumlu WHERE teslimatYoneticiSicil IS NOT NULL
        UNION ALL SELECT UPPER(NULLIF(LTRIM(RTRIM(projeKodu)), N'''')), riskYoneticiSicil, ''RISK_MANAGER'', programMdl FROM dbo.HR09_projeSorumlu WHERE riskYoneticiSicil IS NOT NULL
        UNION ALL SELECT UPPER(NULLIF(LTRIM(RTRIM(projeKodu)), N'''')), konfigYoneticiSicil, ''CONFIGURATION_MANAGER'', programMdl FROM dbo.HR09_projeSorumlu WHERE konfigYoneticiSicil IS NOT NULL
        UNION ALL SELECT UPPER(NULLIF(LTRIM(RTRIM(projeKodu)), N'''')), eldYoneticisiSicil, ''LOGISTICS_MANAGER'', programMdl FROM dbo.HR09_projeSorumlu WHERE eldYoneticisiSicil IS NOT NULL;');

    EXEC(N'CREATE VIEW dbo.MR_V_PeopleDirectory AS
        WITH Ranked AS (
            SELECT sicil, ad_soyad, kullanici_adi, unvan, sektor, direktorluk, mudurluk, birim,
                   ROW_NUMBER() OVER (
                       PARTITION BY sicil
                       ORDER BY CASE WHEN NULLIF(LTRIM(RTRIM(birim)), N'''') IS NULL THEN 1 ELSE 0 END,
                                COALESCE(LTRIM(RTRIM(kullanici_adi)), N''''),
                                COALESCE(LTRIM(RTRIM(ad_soyad)), N''''),
                                COALESCE(LTRIM(RTRIM(unvan)), N''''),
                                COALESCE(LTRIM(RTRIM(sektor)), N''''),
                                COALESCE(LTRIM(RTRIM(direktorluk)), N''''),
                                COALESCE(LTRIM(RTRIM(mudurluk)), N''''),
                                COALESCE(LTRIM(RTRIM(birim)), N'''')
                   ) AS rn
            FROM dbo.HR02_rehisRehberwithMasrafYeri
            WHERE sicil IS NOT NULL
        )
        SELECT sicil AS Sicil, ad_soyad AS DisplayName, kullanici_adi AS Username, unvan AS JobTitle,
               COALESCE(NULLIF(LTRIM(RTRIM(birim)), N''''), NULLIF(LTRIM(RTRIM(mudurluk)), N''''), NULLIF(LTRIM(RTRIM(direktorluk)), N''''), NULLIF(LTRIM(RTRIM(sektor)), N'''')) AS Team,
               sektor AS Sector, direktorluk AS Directorate, mudurluk AS Department, birim AS Unit
        FROM Ranked WHERE rn = 1;');

    DECLARE @DefaultCalendarId uniqueidentifier = NEWID();
    INSERT dbo.MR_Calendars(CalendarId, Name, TimeZone, IsDefault, IsActive)
    VALUES (@DefaultCalendarId, N'Kurumsal Çalışma Takvimi', N'Europe/Istanbul', 1, 1);
    INSERT dbo.MR_CalendarWorkingDays(CalendarId, Weekday)
    VALUES (@DefaultCalendarId, 1), (@DefaultCalendarId, 2), (@DefaultCalendarId, 3), (@DefaultCalendarId, 4), (@DefaultCalendarId, 5);

    INSERT dbo.MR_UserRoles(Sicil, RoleCode, IsActive)
    VALUES (10276, 'SYSTEM_ADMIN', 1), (18068, 'SYSTEM_ADMIN', 1), (23977, 'SYSTEM_ADMIN', 1);

    INSERT dbo.MR_SchemaMigrations(MigrationId, Description)
    VALUES (N'0001_durable_persistence', N'Initial MERGEN Rota durable SQL Server persistence schema');

    COMMIT TRANSACTION;
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    THROW;
END CATCH;
