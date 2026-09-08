/*
WARNING: This script permanently removes all MERGEN Rota-owned MR_* data and objects.
It never drops or modifies the corporate source tables.
*/
SET NOCOUNT ON;
SET XACT_ABORT ON;

BEGIN TRY
    BEGIN TRANSACTION;

    IF OBJECT_ID(N'dbo.MR_V_PeopleDirectory', N'V') IS NOT NULL DROP VIEW dbo.MR_V_PeopleDirectory;
    IF OBJECT_ID(N'dbo.MR_V_CorporateProjectAccess', N'V') IS NOT NULL DROP VIEW dbo.MR_V_CorporateProjectAccess;
    IF OBJECT_ID(N'dbo.MR_V_ExecutiveScope', N'V') IS NOT NULL DROP VIEW dbo.MR_V_ExecutiveScope;
    IF OBJECT_ID(N'dbo.MR_V_CorporateProjects', N'V') IS NOT NULL DROP VIEW dbo.MR_V_CorporateProjects;

    IF OBJECT_ID(N'dbo.MR_TaskReminderLog', N'U') IS NOT NULL DROP TABLE dbo.MR_TaskReminderLog;
    IF OBJECT_ID(N'dbo.MR_ReminderSettings', N'U') IS NOT NULL DROP TABLE dbo.MR_ReminderSettings;
    IF OBJECT_ID(N'dbo.MR_CorporateWbsSyncState', N'U') IS NOT NULL DROP TABLE dbo.MR_CorporateWbsSyncState;
    IF OBJECT_ID(N'dbo.MR_AuditLog', N'U') IS NOT NULL DROP TABLE dbo.MR_AuditLog;
    IF OBJECT_ID(N'dbo.MR_TaskBaselineSnapshots', N'U') IS NOT NULL DROP TABLE dbo.MR_TaskBaselineSnapshots;
    IF OBJECT_ID(N'dbo.MR_Baselines', N'U') IS NOT NULL DROP TABLE dbo.MR_Baselines;
    IF OBJECT_ID(N'dbo.MR_TaskDependencies', N'U') IS NOT NULL DROP TABLE dbo.MR_TaskDependencies;
    IF OBJECT_ID(N'dbo.MR_ScheduleRequestNotifications', N'U') IS NOT NULL DROP TABLE dbo.MR_ScheduleRequestNotifications;
    IF OBJECT_ID(N'dbo.MR_TaskScheduleChangeRequests', N'U') IS NOT NULL DROP TABLE dbo.MR_TaskScheduleChangeRequests;
    IF OBJECT_ID(N'dbo.MR_TaskAssignees', N'U') IS NOT NULL DROP TABLE dbo.MR_TaskAssignees;
    IF OBJECT_ID(N'dbo.MR_Tasks', N'U') IS NOT NULL DROP TABLE dbo.MR_Tasks;
    IF OBJECT_ID(N'dbo.MR_WBS', N'U') IS NOT NULL DROP TABLE dbo.MR_WBS;
    IF OBJECT_ID(N'dbo.MR_ProjectTags', N'U') IS NOT NULL DROP TABLE dbo.MR_ProjectTags;
    IF OBJECT_ID(N'dbo.MR_ProjectAccess', N'U') IS NOT NULL DROP TABLE dbo.MR_ProjectAccess;
    IF OBJECT_ID(N'dbo.MR_Projects', N'U') IS NOT NULL DROP TABLE dbo.MR_Projects;
    IF OBJECT_ID(N'dbo.MR_CalendarHolidays', N'U') IS NOT NULL DROP TABLE dbo.MR_CalendarHolidays;
    IF OBJECT_ID(N'dbo.MR_CalendarWorkingDays', N'U') IS NOT NULL DROP TABLE dbo.MR_CalendarWorkingDays;
    IF OBJECT_ID(N'dbo.MR_Calendars', N'U') IS NOT NULL DROP TABLE dbo.MR_Calendars;
    IF OBJECT_ID(N'dbo.MR_UserRoles', N'U') IS NOT NULL DROP TABLE dbo.MR_UserRoles;
    IF OBJECT_ID(N'dbo.MR_SchemaMigrations', N'U') IS NOT NULL DROP TABLE dbo.MR_SchemaMigrations;

    COMMIT TRANSACTION;
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    THROW;
END CATCH;