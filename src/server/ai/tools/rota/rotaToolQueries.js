import 'server-only';

/**
 * Rota AI alan araçlarının SABİT SQL metinleri.
 *
 * Model SQL yazmaz, SQL parçası seçmez ve sıralama/sütun adı veremez: her
 * metin derleme anında sabittir ve yalnızca parametre alır. Serbest metin
 * aramaları `CHARINDEX` ile yapılır (LIKE değil); `%`, `_` ve `[` karakterleri
 * joker değil, olduğu gibi aranan karakterdir.
 *
 * Her toplu iş aynı yetki kapsamı parçasıyla başlar (bkz. rotaScope.js): kapsam
 * projeleri ve kısmi görev kümesi oturumdan türetilen parametrelerden kurulur,
 * görünür görev kümesi anlık görüntüdeki kuralla hesaplanır. İlk satırdaki
 * işaret yorumu yalnızca test ikizinin sorguyu tanıması içindir.
 */

const SCOPE_PROJECTS = `
  SET NOCOUNT ON;
  DROP TABLE IF EXISTS #AiScopeProjects, #AiScopeTasks, #AiTaskFilter, #AiTasks;
  CREATE TABLE #AiScopeProjects(
    ProjectId uniqueidentifier NOT NULL PRIMARY KEY,
    AccessLevel varchar(10) NOT NULL,
    HasReadGrant bit NOT NULL,
    IsTaskScoped bit NOT NULL
  );
  CREATE TABLE #AiScopeTasks(TaskId uniqueidentifier NOT NULL PRIMARY KEY);
  CREATE TABLE #AiTaskFilter(TaskId uniqueidentifier NOT NULL PRIMARY KEY);
  CREATE TABLE #AiTasks(
    TaskId uniqueidentifier NOT NULL PRIMARY KEY,
    ProjectId uniqueidentifier NOT NULL,
    AccessLevel varchar(10) NOT NULL,
    IdentityBase bit NOT NULL
  );

  INSERT #AiTaskFilter(TaskId)
  SELECT DISTINCT TRY_CONVERT(uniqueidentifier, LTRIM(RTRIM(value)))
  FROM STRING_SPLIT(@taskIds, ',')
  WHERE TRY_CONVERT(uniqueidentifier, LTRIM(RTRIM(value))) IS NOT NULL;
  DECLARE @AiTaskFilterActive bit = CASE WHEN LEN(@taskIds) > 0 THEN 1 ELSE 0 END;

  IF @isAdmin = 1
    INSERT #AiScopeProjects(ProjectId, AccessLevel, HasReadGrant, IsTaskScoped)
    SELECT p.ProjectId, 'FULL', 0, 0
    FROM dbo.MR_Projects p
    WHERE p.IsActive = 1 AND (@projectId IS NULL OR p.ProjectId = @projectId)
      AND (@sourceFilter = 'all' OR (@sourceFilter = 'corporate' AND p.SourceType = 'CORPORATE') OR (@sourceFilter = 'manual' AND COALESCE(p.SourceType, 'MANUAL') <> 'CORPORATE'));
  ELSE
  BEGIN
    INSERT #AiScopeProjects(ProjectId, AccessLevel, HasReadGrant, IsTaskScoped)
    SELECT p.ProjectId, grants.AccessLevel, grants.HasReadGrant, grants.IsTaskScoped
    FROM (
      SELECT TRY_CONVERT(uniqueidentifier, LEFT(value, 36)) AS ProjectId,
        CASE WHEN SUBSTRING(value, 38, 1) = 'F' THEN 'FULL' ELSE 'PARTIAL' END AS AccessLevel,
        CASE WHEN SUBSTRING(value, 39, 1) = '1' THEN 1 ELSE 0 END AS HasReadGrant,
        CASE WHEN SUBSTRING(value, 40, 1) = '1' THEN 1 ELSE 0 END AS IsTaskScoped
      FROM STRING_SPLIT(@scopeProjects, ',')
      WHERE LEN(value) = 40
    ) grants
    JOIN dbo.MR_Projects p ON p.ProjectId = grants.ProjectId
    WHERE p.IsActive = 1 AND (@projectId IS NULL OR p.ProjectId = @projectId)
      AND (@sourceFilter = 'all' OR (@sourceFilter = 'corporate' AND p.SourceType = 'CORPORATE') OR (@sourceFilter = 'manual' AND COALESCE(p.SourceType, 'MANUAL') <> 'CORPORATE'));
  END
`;

/**
 * Görünür görevler: FULL ve READ projelerinde projenin bütün görevleri,
 * kısmi projede yalnızca kişisel kapsamdaki görevler. `IdentityBase`, anlık
 * görüntüdeki kimlik görünürlüğü tabanıdır (FULL/READ ya da görevi oluşturan).
 * Görev süzgeci verildiğinde yalnızca o görevler değerlendirilir.
 */
const VISIBLE_TASKS = `
  -- Task scope is materialized only by queries that actually consume tasks.
  INSERT #AiScopeTasks(TaskId)
  SELECT TOP (@analysisMaxRows) t.TaskId
  FROM STRING_SPLIT(@scopeTasks, ',') token
  JOIN dbo.MR_Tasks t ON t.TaskId = TRY_CONVERT(uniqueidentifier, LTRIM(RTRIM(token.value)))
  JOIN #AiScopeProjects v ON v.ProjectId = t.ProjectId AND v.AccessLevel = 'PARTIAL' AND v.HasReadGrant = 0
  WHERE @AiTaskFilterActive = 0
    OR EXISTS (SELECT 1 FROM #AiTaskFilter f WHERE f.TaskId = t.TaskId)
    OR EXISTS (SELECT 1 FROM #AiTaskFilter f JOIN dbo.MR_Tasks child ON child.TaskId = f.TaskId WHERE child.RecurrenceParentTaskId = t.TaskId);
  IF (SELECT COUNT(*) FROM #AiScopeTasks) >= @analysisMaxRows
    THROW 51001, 'AI_TOOL_RESULT_TOO_LARGE', 1;

  IF @AiTaskFilterActive = 1
    INSERT #AiTasks(TaskId, ProjectId, AccessLevel, IdentityBase)
    SELECT TOP (@analysisMaxRows) t.TaskId, t.ProjectId, v.AccessLevel, 1
    FROM #AiTaskFilter f
    JOIN dbo.MR_Tasks t ON t.TaskId = f.TaskId
    JOIN #AiScopeProjects v ON v.ProjectId = t.ProjectId
    WHERE v.AccessLevel = 'FULL' OR v.HasReadGrant = 1;
  ELSE
    INSERT #AiTasks(TaskId, ProjectId, AccessLevel, IdentityBase)
    SELECT TOP (@analysisMaxRows) t.TaskId, t.ProjectId, v.AccessLevel, 1
    FROM #AiScopeProjects v
    JOIN dbo.MR_Tasks t ON t.ProjectId = v.ProjectId
    WHERE v.AccessLevel = 'FULL' OR v.HasReadGrant = 1;
  IF (SELECT COUNT(*) FROM #AiTasks) >= @analysisMaxRows
    THROW 51001, 'AI_TOOL_RESULT_TOO_LARGE', 1;

  DECLARE @AiRemainingRows int = @analysisMaxRows - (SELECT COUNT(*) FROM #AiTasks);
  INSERT #AiTasks(TaskId, ProjectId, AccessLevel, IdentityBase)
  SELECT TOP (@AiRemainingRows) t.TaskId, t.ProjectId, 'PARTIAL', CASE WHEN t.CreatedBySicil = @sicil THEN 1 ELSE 0 END
  FROM #AiScopeTasks scopedTask
  JOIN dbo.MR_Tasks t ON t.TaskId = scopedTask.TaskId
  JOIN #AiScopeProjects v ON v.ProjectId = t.ProjectId AND v.AccessLevel = 'PARTIAL' AND v.HasReadGrant = 0
  WHERE @AiTaskFilterActive = 0 OR EXISTS (SELECT 1 FROM #AiTaskFilter f WHERE f.TaskId = t.TaskId);
  IF (SELECT COUNT(*) FROM #AiTasks) >= @analysisMaxRows
    THROW 51001, 'AI_TOOL_RESULT_TOO_LARGE', 1;
`;

/** Görünebilir sorumluluk ilişkileri sınırlıdır; görev başına tek toplam üretilir. */
const ASSIGNMENT_FACTS = `
  DROP TABLE IF EXISTS #AiAssignments, #AiResolvedPeople, #AiAssignmentFacts;
  SELECT TOP (@analysisMaxRows) ta.TaskId, ta.Sicil
  INTO #AiAssignments
  FROM #AiTasks visible
  JOIN dbo.MR_TaskAssignees ta ON ta.TaskId = visible.TaskId
  WHERE visible.IdentityBase = 1 OR ta.Sicil = @sicil
    OR EXISTS (SELECT 1 FROM dbo.MR_V_ExecutiveScope es WHERE es.ManagerSicil = @sicil AND es.EmployeeSicil = ta.Sicil)
    OR EXISTS (SELECT 1 FROM dbo.MR_TaskAssignees ownAssignment WHERE ownAssignment.TaskId = ta.TaskId AND ownAssignment.Sicil = @sicil);
  IF (SELECT COUNT(*) FROM #AiAssignments) >= @analysisMaxRows
    THROW 51001, 'AI_TOOL_RESULT_TOO_LARGE', 1;
  CREATE UNIQUE CLUSTERED INDEX IX_AiAssignments ON #AiAssignments(TaskId, Sicil);
  SELECT DISTINCT pd.Sicil INTO #AiResolvedPeople
  FROM dbo.MR_V_PeopleDirectory pd
  JOIN (SELECT DISTINCT Sicil FROM #AiAssignments) assigned ON assigned.Sicil = pd.Sicil;
  SELECT a.TaskId, COUNT(*) AS AssigneeCount,
    MAX(CASE WHEN a.Sicil = @sicil THEN 1 ELSE 0 END) AS IsOwnAssignee,
    COUNT(CASE WHEN permitted.IdentityVisible = 1 THEN resolved.Sicil END) AS ResolvedAssigneeCount
  INTO #AiAssignmentFacts
  FROM #AiAssignments a
  JOIN #AiTasks visible ON visible.TaskId = a.TaskId
  LEFT JOIN #AiResolvedPeople resolved ON resolved.Sicil = a.Sicil
  OUTER APPLY (SELECT CASE WHEN visible.IdentityBase = 1 OR a.Sicil = @sicil OR EXISTS (
    SELECT 1 FROM dbo.MR_V_ExecutiveScope es WHERE es.ManagerSicil = @sicil AND es.EmployeeSicil = a.Sicil
  ) THEN 1 ELSE 0 END AS IdentityVisible) permitted
  GROUP BY a.TaskId;
`;

/**
 * Sorumlu satırları: kimlik görünürlüğü anlık görüntüyle aynıdır. Kimliği
 * kapalı eş sorumlu yalnızca kullanıcının KENDİSİNİN de sorumlu olduğu görevde
 * ADIYLA döner (Sicil'i dönmez); aksi hâlde hiç dönmez ve toplamları etkilemez.
 */
const ASSIGNEE_ROWS = `
  DROP TABLE IF EXISTS #AiAssignees, #AiDirectory;
  CREATE TABLE #AiAssignees(
    TaskId uniqueidentifier NOT NULL,
    Sicil int NOT NULL,
    IdentityVisible bit NOT NULL,
    PRIMARY KEY (TaskId, Sicil)
  );
  IF @withAssignees = 1
    INSERT #AiAssignees(TaskId, Sicil, IdentityVisible)
    SELECT ta.TaskId, ta.Sicil,
      CASE WHEN f.IdentityBase = 1 OR ta.Sicil = @sicil OR EXISTS (
        SELECT 1 FROM dbo.MR_V_ExecutiveScope es
        WHERE es.ManagerSicil = @sicil AND es.EmployeeSicil = ta.Sicil
      ) THEN 1 ELSE 0 END
    FROM #AiFacts f
    JOIN #AiAssignments ta ON ta.TaskId = f.TaskId;
  DELETE a FROM #AiAssignees a
  WHERE a.IdentityVisible = 0
    AND NOT EXISTS (SELECT 1 FROM #AiFacts f WHERE f.TaskId = a.TaskId AND f.IsOwnAssignee = 1);
  SELECT pd.Sicil, pd.DisplayName
  INTO #AiDirectory
  FROM dbo.MR_V_PeopleDirectory pd
  WHERE EXISTS (SELECT 1 FROM #AiAssignees a WHERE a.Sicil = pd.Sicil);
  SELECT a.TaskId,
    CASE WHEN a.IdentityVisible = 1 THEN a.Sicil ELSE NULL END AS Sicil,
    COALESCE(NULLIF(LTRIM(RTRIM(d.DirectoryName)), N''),
      CASE WHEN a.IdentityVisible = 1 THEN CONVERT(nvarchar(20), a.Sicil) ELSE NULL END) AS DisplayName,
    a.IdentityVisible,
    CAST(CASE WHEN d.Sicil IS NULL THEN 0 ELSE 1 END AS bit) AS Resolved
  FROM #AiAssignees a
  LEFT JOIN (SELECT Sicil, MIN(DisplayName) AS DirectoryName FROM #AiDirectory GROUP BY Sicil) d ON d.Sicil = a.Sicil
  ORDER BY a.TaskId;
`;

const TASK_FACT_COLUMNS = `
    t.TaskId, t.ProjectId, t.WbsId, t.Title, t.Keyword, t.Status, t.Priority, t.IsMilestone,
    t.PlannedStart, t.PlannedFinish, t.PlannedDurationDays, t.TargetFinish, t.ActualStart, t.ActualFinish,
    t.Progress, t.PlannedHours, t.ActualHours, t.Budget, t.Spent,
    t.RecurrenceRule, t.RecurrenceParentTaskId, t.RecurrenceOccurrenceDate,
    t.CreatedAt, t.UpdatedAt, visible.AccessLevel, visible.IdentityBase,
    CAST(CASE WHEN t.CreatedBySicil = @sicil THEN 1 ELSE 0 END AS bit) AS IsCreator,
    CAST(COALESCE(assignment.IsOwnAssignee, 0) AS bit) AS IsOwnAssignee,
    COALESCE(assignment.AssigneeCount, 0) AS AssigneeCount,
    COALESCE(assignment.ResolvedAssigneeCount, 0) AS ResolvedAssigneeCount`;

/**
 * Görev olguları: yetkili görev kümesi, yalnızca DARALTAN kaba süzgeçlerle
 * (proje, WBS düğümü, metin, açık görev, termin aralığı, oluşturan, sorumlu).
 * İnce süzgeçler, sıralama, sayfalama ve toplamlar sunucu kodunda belirlenimci
 * olarak hesaplanır. `@maxRows` sınırı aşılırsa araç "sonuç çok büyük" döner.
 * Kişi süzgeci yalnızca kimliği kullanıcıya AÇIK sorumluluklarla eşleşir:
 * gizli eş sorumlu süzgeç yoluyla da ortaya çıkarılamaz.
 */
export const AI_TOOL_TASK_FACTS_SQL = `/* rota-ai-tool:task-facts */
${SCOPE_PROJECTS}
${VISIBLE_TASKS}
${ASSIGNMENT_FACTS}
  DROP TABLE IF EXISTS #AiFacts;
  SELECT TOP (@maxRows) ${TASK_FACT_COLUMNS}
  INTO #AiFacts
  FROM #AiTasks visible
  JOIN dbo.MR_Tasks t ON t.TaskId = visible.TaskId
  LEFT JOIN #AiAssignmentFacts assignment ON assignment.TaskId = t.TaskId
  WHERE (@wbsId IS NULL OR t.WbsId = @wbsId)
    AND (@seriesId IS NULL OR t.TaskId = @seriesId OR t.RecurrenceParentTaskId = @seriesId)
    AND (@recurringOnly = 0 OR t.RecurrenceRule IS NOT NULL OR t.RecurrenceParentTaskId IS NOT NULL)
    AND (LEN(@text) = 0 OR CHARINDEX(
      TRANSLATE(@text, N'İIı', N'iii') COLLATE Latin1_General_100_CI_AI,
      TRANSLATE(CONCAT(t.Title, N' ', COALESCE(t.Keyword, N'')), N'İIı', N'iii') COLLATE Latin1_General_100_CI_AI
    ) > 0)
    AND (@openOnly = 0 OR t.Status <> 'done')
    AND (@targetFrom IS NULL OR t.TargetFinish >= @targetFrom)
    AND (@targetTo IS NULL OR t.TargetFinish <= @targetTo)
    AND (LEN(@statusCsv) = 0 OR EXISTS (
      SELECT 1 FROM STRING_SPLIT(@statusCsv, ',') requestedStatus
      WHERE (requestedStatus.value = 'done' AND t.Status = 'done')
        OR (requestedStatus.value = 'in_progress' AND t.Status = 'in-progress')
        OR (requestedStatus.value = 'todo' AND t.Status NOT IN ('done', 'in-progress'))))
    AND (LEN(@priorityCsv) = 0 OR EXISTS (
      SELECT 1 FROM STRING_SPLIT(@priorityCsv, ',') requestedPriority
      WHERE requestedPriority.value = CASE
        WHEN LOWER(LTRIM(RTRIM(COALESCE(t.Priority, '')))) IN ('critical','high','low')
          THEN LOWER(LTRIM(RTRIM(t.Priority)))
        ELSE 'medium' END))
    AND (@milestone IS NULL OR ISNULL(t.IsMilestone, 0) = @milestone)
    AND (@deadline IS NULL
      OR (@deadline = 'overdue' AND t.Status <> 'done' AND t.TargetFinish < @today)
      OR (@deadline = 'due_today' AND t.Status <> 'done' AND t.TargetFinish = @today)
      OR (@deadline = 'due_next_7_days' AND t.Status <> 'done' AND t.TargetFinish BETWEEN @today AND DATEADD(day, 6, @today))
      OR (@deadline = 'due_next_30_days' AND t.Status <> 'done' AND t.TargetFinish BETWEEN @today AND DATEADD(day, 29, @today))
      OR (@deadline = 'no_target_finish' AND t.Status <> 'done' AND t.TargetFinish IS NULL))
    AND (@dateField IS NULL OR (
      (@dateFrom IS NULL OR CASE @dateField
        WHEN 'targetFinish' THEN t.TargetFinish
        WHEN 'calendarDate' THEN COALESCE(t.TargetFinish, t.PlannedFinish)
        WHEN 'plannedStart' THEN t.PlannedStart
        WHEN 'plannedFinish' THEN t.PlannedFinish
        WHEN 'actualStart' THEN t.ActualStart
        WHEN 'actualFinish' THEN t.ActualFinish END >= @dateFrom)
      AND (@dateTo IS NULL OR CASE @dateField
        WHEN 'targetFinish' THEN t.TargetFinish
        WHEN 'calendarDate' THEN COALESCE(t.TargetFinish, t.PlannedFinish)
        WHEN 'plannedStart' THEN t.PlannedStart
        WHEN 'plannedFinish' THEN t.PlannedFinish
        WHEN 'actualStart' THEN t.ActualStart
        WHEN 'actualFinish' THEN t.ActualFinish END <= @dateTo)
      AND CASE @dateField
        WHEN 'targetFinish' THEN t.TargetFinish
        WHEN 'calendarDate' THEN COALESCE(t.TargetFinish, t.PlannedFinish)
        WHEN 'plannedStart' THEN t.PlannedStart
        WHEN 'plannedFinish' THEN t.PlannedFinish
        WHEN 'actualStart' THEN t.ActualStart
        WHEN 'actualFinish' THEN t.ActualFinish END IS NOT NULL))
    AND (@createdByMe = 0 OR t.CreatedBySicil = @sicil)
    AND (@assigneeMode = 'any'
      OR (@assigneeMode = 'me' AND COALESCE(assignment.IsOwnAssignee, 0) = 1)
      OR (@assigneeMode = 'unassigned' AND COALESCE(assignment.ResolvedAssigneeCount, 0) = 0)
      OR (@assigneeMode = 'person' AND EXISTS (
        SELECT 1 FROM dbo.MR_TaskAssignees person
        WHERE person.TaskId = t.TaskId AND person.Sicil = @personSicil
          AND (visible.IdentityBase = 1 OR person.Sicil = @sicil OR EXISTS (
            SELECT 1 FROM dbo.MR_V_ExecutiveScope es
            WHERE es.ManagerSicil = @sicil AND es.EmployeeSicil = person.Sicil)))))
  ORDER BY t.TaskId;

  SELECT * FROM #AiFacts;

  SELECT p.ProjectId, p.ProjectName, p.ProjectCode, p.SourceType, v.AccessLevel, v.HasReadGrant, v.IsTaskScoped
  FROM #AiScopeProjects v
  JOIN dbo.MR_Projects p ON p.ProjectId = v.ProjectId
  WHERE @projectId IS NOT NULL OR EXISTS (SELECT 1 FROM #AiFacts f WHERE f.ProjectId = v.ProjectId);
${ASSIGNEE_ROWS}
  DROP TABLE #AiAssignments, #AiResolvedPeople, #AiAssignmentFacts, #AiAssignees, #AiDirectory, #AiFacts, #AiTasks, #AiTaskFilter, #AiScopeTasks, #AiScopeProjects;`;

/**
 * Tek görevin ayrıntısı. Görev görünür değilse hiçbir satır dönmez (var olmayan
 * görevle aynı sonuç). Oluşturan kimliği anlık görüntüdeki kuralla, bağımlılık
 * sayıları yalnızca FULL projede, seri şablonunun adı yalnızca şablon da
 * görünürse döner. İş dağılım zinciri, görünür görevin kendi düğümünden köke
 * kadardır (görünür görevin zinciri her kapsamda görünürdür).
 */
export const AI_TOOL_TASK_DETAIL_SQL = `/* rota-ai-tool:task-detail */
${SCOPE_PROJECTS}
${VISIBLE_TASKS}
${ASSIGNMENT_FACTS}
  DROP TABLE IF EXISTS #AiFacts;
  SELECT TOP (1) ${TASK_FACT_COLUMNS},
    t.CalendarId, t.RemainingDurationDays,
    LEFT(t.Description, 1600) AS Description,
    CASE WHEN LEN(t.Description) > 1600 THEN 1 ELSE 0 END AS DescriptionClipped,
    CASE WHEN visible.IdentityBase = 1
      OR EXISTS (SELECT 1 FROM dbo.MR_TaskAssignees own WHERE own.TaskId = t.TaskId AND own.Sicil = @sicil)
    THEN t.CreatedBySicil ELSE NULL END AS VisibleCreatedBySicil,
    CASE WHEN visible.AccessLevel = 'FULL' THEN (
      SELECT COUNT(*) FROM dbo.MR_TaskDependencies d WHERE d.ProjectId = t.ProjectId AND d.TaskId = t.TaskId
    ) ELSE NULL END AS PredecessorCount,
    CASE WHEN visible.AccessLevel = 'FULL' THEN (
      SELECT COUNT(*) FROM dbo.MR_TaskDependencies d WHERE d.ProjectId = t.ProjectId AND d.PredecessorTaskId = t.TaskId
    ) ELSE NULL END AS SuccessorCount,
    CASE WHEN t.RecurrenceParentTaskId IS NOT NULL AND (visible.AccessLevel = 'FULL' OR v.HasReadGrant = 1 OR EXISTS (
      SELECT 1 FROM #AiScopeTasks s WHERE s.TaskId = t.RecurrenceParentTaskId
    )) THEN parent.Title ELSE NULL END AS ParentTitle,
    p.ProjectName, p.ProjectCode, p.SourceType, v.HasReadGrant, v.IsTaskScoped,
    COALESCE(taskCalendar.Name, projectCalendar.Name) AS CalendarName
  INTO #AiFacts
  FROM #AiTasks visible
  JOIN dbo.MR_Tasks t ON t.TaskId = visible.TaskId
  LEFT JOIN #AiAssignmentFacts assignment ON assignment.TaskId = t.TaskId
  JOIN #AiScopeProjects v ON v.ProjectId = t.ProjectId
  JOIN dbo.MR_Projects p ON p.ProjectId = t.ProjectId
  LEFT JOIN dbo.MR_Tasks parent ON parent.TaskId = t.RecurrenceParentTaskId AND parent.ProjectId = t.ProjectId
  LEFT JOIN dbo.MR_Calendars taskCalendar ON taskCalendar.CalendarId = t.CalendarId AND taskCalendar.IsActive = 1
  LEFT JOIN dbo.MR_Calendars projectCalendar ON projectCalendar.CalendarId = p.CalendarId AND projectCalendar.IsActive = 1;

  SELECT f.*, NULLIF(LTRIM(RTRIM(creator.DisplayName)), N'') AS CreatedByName
  FROM #AiFacts f
  LEFT JOIN dbo.MR_V_PeopleDirectory creator ON creator.Sicil = f.VisibleCreatedBySicil;

  ;WITH chain AS (
    SELECT w.WbsId, w.ParentWbsId, w.ProjectId, w.Code, w.Name, 0 AS Depth
    FROM #AiFacts f
    JOIN dbo.MR_WBS w ON w.WbsId = f.WbsId AND w.ProjectId = f.ProjectId
    UNION ALL
    SELECT parentNode.WbsId, parentNode.ParentWbsId, parentNode.ProjectId, parentNode.Code, parentNode.Name, chain.Depth + 1
    FROM dbo.MR_WBS parentNode
    JOIN chain ON chain.ParentWbsId = parentNode.WbsId AND chain.ProjectId = parentNode.ProjectId
    WHERE chain.Depth < 40
  )
  SELECT WbsId, ParentWbsId, Code, Name, Depth FROM chain ORDER BY Depth DESC
  OPTION (MAXRECURSION 50);

${ASSIGNEE_ROWS}
  DROP TABLE #AiAssignments, #AiResolvedPeople, #AiAssignmentFacts, #AiAssignees, #AiDirectory, #AiFacts, #AiTasks, #AiTaskFilter, #AiScopeTasks, #AiScopeProjects;`;

/**
 * Yetkili projeler arasında ad ya da kod parçasıyla arama. Sıralama sabittir:
 * tam kod/ad eşleşmesi, başta eşleşme, sonra içerik eşleşmesi; eşitlikte ada ve
 * kimliğe göre. Lider adı yalnızca seçilen satırlar için çözülür.
 */
export const AI_TOOL_PROJECT_SEARCH_SQL = `/* rota-ai-tool:project-search */
${SCOPE_PROJECTS}
  DROP TABLE IF EXISTS #AiProjectMatches;
  SELECT p.ProjectId, p.ProjectName, p.ProjectCode, p.SourceType, p.LeadSicil,
    v.AccessLevel, v.HasReadGrant, v.IsTaskScoped,
    CASE
      WHEN UPPER(COALESCE(p.ProjectCode, N'')) = UPPER(@text) THEN 0
      WHEN p.ProjectName COLLATE Turkish_100_CI_AI = @text THEN 0
      WHEN CHARINDEX(@text, p.ProjectName COLLATE Turkish_100_CI_AI) = 1
        OR CHARINDEX(@text, COALESCE(p.ProjectCode, N'') COLLATE Turkish_100_CI_AI) = 1 THEN 1
      ELSE 2
    END AS MatchRank
  INTO #AiProjectMatches
  FROM #AiScopeProjects v
  JOIN dbo.MR_Projects p ON p.ProjectId = v.ProjectId
  WHERE (LEN(@text) = 0 AND @projectId IS NOT NULL)
    OR CHARINDEX(@text, CONCAT(COALESCE(p.ProjectCode, N''), N' ', p.ProjectName) COLLATE Turkish_100_CI_AI) > 0;

  SELECT COUNT(*) AS Total FROM #AiProjectMatches;

  SELECT TOP (@limit) m.*, NULLIF(LTRIM(RTRIM(lead.DisplayName)), N'') AS LeadName
  FROM (SELECT TOP (@limit) * FROM #AiProjectMatches ORDER BY MatchRank, ProjectName, ProjectId) m
  LEFT JOIN dbo.MR_V_PeopleDirectory lead ON lead.Sicil = m.LeadSicil
  ORDER BY m.MatchRank, m.ProjectName, m.ProjectId;

  DROP TABLE #AiProjectMatches, #AiTasks, #AiTaskFilter, #AiScopeTasks, #AiScopeProjects;`;

/**
 * Proje başına görünür görev toplamları. Sayılar yalnızca görünür görevler
 * üzerindedir; kısmi projede proje bütününü temsil etmez (kapsam künyesi
 * bunu bildirir). Gecikme ölçüsü ürünün tek kuralıdır: tamamlanmamış ve
 * termini (TargetFinish) bugünden önce olan görev.
 */
export const AI_TOOL_PORTFOLIO_SQL = `/* rota-ai-tool:portfolio */
${SCOPE_PROJECTS}
${VISIBLE_TASKS}
  SELECT v.ProjectId, p.ProjectName, p.ProjectCode, p.SourceType, p.LeadSicil, p.CalendarId,
    v.AccessLevel, v.HasReadGrant, v.IsTaskScoped,
    COUNT(t.TaskId) AS TaskCount,
    COALESCE(SUM(CASE WHEN t.Status = 'done' THEN 1 ELSE 0 END), 0) AS DoneCount,
    COALESCE(SUM(CASE WHEN t.Status = 'in-progress' THEN 1 ELSE 0 END), 0) AS InProgressCount,
    COALESCE(SUM(CASE WHEN t.TaskId IS NOT NULL AND t.Status NOT IN ('done', 'in-progress') THEN 1 ELSE 0 END), 0) AS TodoCount,
    COALESCE(SUM(CASE WHEN t.Status <> 'done' AND t.TargetFinish < @today THEN 1 ELSE 0 END), 0) AS OverdueCount,
    COALESCE(SUM(CASE WHEN t.Status <> 'done' AND t.TargetFinish >= @today AND t.TargetFinish <= @soonEnd THEN 1 ELSE 0 END), 0) AS DueSoonCount,
    COALESCE(SUM(CASE WHEN t.Status <> 'done' AND t.TargetFinish IS NULL THEN 1 ELSE 0 END), 0) AS NoTargetCount,
    COALESCE(SUM(CASE WHEN t.Status <> 'done' AND t.IsMilestone = 1 THEN 1 ELSE 0 END), 0) AS OpenMilestoneCount,
    MIN(CASE WHEN t.Status <> 'done' AND t.TargetFinish >= @today THEN t.TargetFinish END) AS NextTargetFinish,
    MAX(t.UpdatedAt) AS LastTaskUpdateAt
  FROM #AiScopeProjects v
  JOIN dbo.MR_Projects p ON p.ProjectId = v.ProjectId
  LEFT JOIN #AiTasks visible ON visible.ProjectId = v.ProjectId
  LEFT JOIN dbo.MR_Tasks t ON t.TaskId = visible.TaskId
  GROUP BY v.ProjectId, p.ProjectName, p.ProjectCode, p.SourceType, p.LeadSicil, p.CalendarId,
    v.AccessLevel, v.HasReadGrant, v.IsTaskScoped;

  DROP TABLE #AiTasks, #AiTaskFilter, #AiScopeTasks, #AiScopeProjects;`;

/**
 * Tek proje künyesi: proje satırı, etiketler, takvim ve lider adı, görünür
 * görev toplamları ve (yalnızca FULL projede) bağımlılık ile baz plan sayıları.
 */
export const AI_TOOL_PROJECT_DETAIL_SQL = `/* rota-ai-tool:project-detail */
${SCOPE_PROJECTS}
${VISIBLE_TASKS}
  SELECT v.ProjectId, p.ProjectName, p.ProjectCode, p.SourceType, p.ProjectTypeName, p.LeadSicil, p.DataDate,
    v.AccessLevel, v.HasReadGrant, v.IsTaskScoped,
    NULLIF(LTRIM(RTRIM(lead.DisplayName)), N'') AS LeadName,
    COALESCE(projectCalendar.Name, defaultCalendar.Name) AS CalendarName,
    CASE WHEN v.AccessLevel = 'FULL' THEN (
      SELECT COUNT(*) FROM dbo.MR_TaskDependencies d WHERE d.ProjectId = v.ProjectId
    ) ELSE NULL END AS DependencyCount,
    CASE WHEN v.AccessLevel = 'FULL' THEN (
      SELECT COUNT(*) FROM dbo.MR_Baselines b WHERE b.ProjectId = v.ProjectId
    ) ELSE NULL END AS BaselineCount,
    CASE WHEN v.AccessLevel = 'FULL' THEN (
      SELECT COUNT(*) FROM dbo.MR_WBS w WHERE w.ProjectId = v.ProjectId
    ) ELSE NULL END AS WbsNodeCount
  FROM #AiScopeProjects v
  JOIN dbo.MR_Projects p ON p.ProjectId = v.ProjectId
  LEFT JOIN dbo.MR_V_PeopleDirectory lead ON lead.Sicil = p.LeadSicil
  LEFT JOIN dbo.MR_Calendars projectCalendar ON projectCalendar.CalendarId = p.CalendarId AND projectCalendar.IsActive = 1
  OUTER APPLY (
    SELECT TOP (1) c.Name FROM dbo.MR_Calendars c WHERE c.IsDefault = 1 AND c.IsActive = 1
  ) defaultCalendar
  WHERE v.ProjectId = @projectId;

  SELECT pt.TagName FROM dbo.MR_ProjectTags pt
  WHERE pt.ProjectId = @projectId AND EXISTS (SELECT 1 FROM #AiScopeProjects v WHERE v.ProjectId = pt.ProjectId)
  ORDER BY pt.SortOrder, pt.TagName;

  SELECT
    COUNT(t.TaskId) AS TaskCount,
    COALESCE(SUM(CASE WHEN t.Status = 'done' THEN 1 ELSE 0 END), 0) AS DoneCount,
    COALESCE(SUM(CASE WHEN t.Status = 'in-progress' THEN 1 ELSE 0 END), 0) AS InProgressCount,
    COALESCE(SUM(CASE WHEN t.Status NOT IN ('done', 'in-progress') THEN 1 ELSE 0 END), 0) AS TodoCount,
    COALESCE(SUM(CASE WHEN t.Status <> 'done' AND t.TargetFinish < @today THEN 1 ELSE 0 END), 0) AS OverdueCount,
    COALESCE(SUM(CASE WHEN t.Status <> 'done' AND t.TargetFinish >= @today AND t.TargetFinish <= @soonEnd THEN 1 ELSE 0 END), 0) AS DueSoonCount,
    COALESCE(SUM(CASE WHEN t.Status <> 'done' AND t.TargetFinish IS NULL THEN 1 ELSE 0 END), 0) AS NoTargetCount,
    COALESCE(SUM(CASE WHEN t.Status <> 'done' AND t.IsMilestone = 1 THEN 1 ELSE 0 END), 0) AS OpenMilestoneCount,
    MIN(CASE WHEN t.Status <> 'done' AND t.TargetFinish >= @today THEN t.TargetFinish END) AS NextTargetFinish,
    MAX(t.UpdatedAt) AS LastTaskUpdateAt
  FROM #AiTasks visible
  JOIN dbo.MR_Tasks t ON t.TaskId = visible.TaskId;

  DROP TABLE #AiTasks, #AiTaskFilter, #AiScopeTasks, #AiScopeProjects;`;

/**
 * İş dağılım ağacı. Görünürlük anlık görüntüyle aynıdır: FULL, READ ya da
 * kendi görev kapsamı → projenin kataloğu; yalnızca yönetim kapsamıyla
 * görünen projede → görünür görevlerin düğümleri ve ataları. Düğüm başına
 * görev sayıları yalnızca GÖRÜNÜR doğrudan görevler üzerindedir.
 */
export const AI_TOOL_WBS_SQL = `/* rota-ai-tool:wbs */
${SCOPE_PROJECTS}
${VISIBLE_TASKS}
  DROP TABLE IF EXISTS #AiRequiredWbs;
  CREATE TABLE #AiRequiredWbs(WbsId uniqueidentifier NOT NULL PRIMARY KEY);
  IF EXISTS (
    SELECT 1 FROM #AiScopeProjects v
    WHERE v.ProjectId = @projectId AND v.AccessLevel = 'PARTIAL' AND v.HasReadGrant = 0 AND v.IsTaskScoped = 0
  )
  BEGIN
    ;WITH RequiredWbs AS (
      SELECT DISTINCT w.WbsId, w.ParentWbsId, w.ProjectId,
        CAST('|' + CONVERT(varchar(36), w.WbsId) + '|' AS varchar(max)) AS VisitedWbs
      FROM #AiTasks visible
      JOIN dbo.MR_Tasks t ON t.TaskId = visible.TaskId
      JOIN dbo.MR_WBS w ON w.WbsId = t.WbsId AND w.ProjectId = t.ProjectId
      WHERE visible.ProjectId = @projectId
      UNION ALL
      SELECT parentNode.WbsId, parentNode.ParentWbsId, parentNode.ProjectId,
        CAST(child.VisitedWbs + CONVERT(varchar(36), parentNode.WbsId) + '|' AS varchar(max)) AS VisitedWbs
      FROM dbo.MR_WBS parentNode
      JOIN RequiredWbs child ON child.ParentWbsId = parentNode.WbsId
      WHERE parentNode.ProjectId = child.ProjectId
        AND CHARINDEX('|' + CONVERT(varchar(36), parentNode.WbsId) + '|', child.VisitedWbs) = 0
    )
    INSERT #AiRequiredWbs(WbsId)
    SELECT DISTINCT WbsId FROM RequiredWbs
    OPTION (MAXRECURSION 1000);
  END

  SELECT TOP (@maxRows) w.WbsId, w.ParentWbsId, w.Code, w.Name, w.SortOrder, w.WbsLevel, w.SourceType, w.OutlineCode,
    CAST(CASE WHEN v.AccessLevel = 'FULL' OR v.HasReadGrant = 1 OR v.IsTaskScoped = 1 THEN 1 ELSE 0 END AS bit) AS CatalogVisible
  FROM dbo.MR_WBS w
  JOIN #AiScopeProjects v ON v.ProjectId = w.ProjectId
  WHERE w.ProjectId = @projectId
    AND (v.AccessLevel = 'FULL' OR v.HasReadGrant = 1 OR v.IsTaskScoped = 1
      OR EXISTS (SELECT 1 FROM #AiRequiredWbs r WHERE r.WbsId = w.WbsId))
  ORDER BY w.ParentWbsId, w.SortOrder, w.Code, w.WbsId;

  SELECT t.WbsId,
    COUNT(*) AS TaskCount,
    SUM(CASE WHEN t.Status = 'done' THEN 1 ELSE 0 END) AS DoneCount,
    SUM(CASE WHEN t.Status <> 'done' AND t.TargetFinish < @today THEN 1 ELSE 0 END) AS OverdueCount
  FROM #AiTasks visible
  JOIN dbo.MR_Tasks t ON t.TaskId = visible.TaskId
  WHERE visible.ProjectId = @projectId
  GROUP BY t.WbsId;

  SELECT p.ProjectId, p.ProjectName, p.ProjectCode, v.AccessLevel, v.HasReadGrant, v.IsTaskScoped
  FROM #AiScopeProjects v JOIN dbo.MR_Projects p ON p.ProjectId = v.ProjectId
  WHERE v.ProjectId = @projectId;

  DROP TABLE #AiRequiredWbs, #AiTasks, #AiTaskFilter, #AiScopeTasks, #AiScopeProjects;`;

/**
 * Bağımlılık ilişkileri — yalnızca FULL projede (anlık görüntüyle aynı).
 * Kritik yol HESAPLANMAZ; yalnızca kayıtlı ilişkiler ve kapsama sayıları döner.
 */
export const AI_TOOL_DEPENDENCIES_SQL = `/* rota-ai-tool:dependencies */
${SCOPE_PROJECTS}
  IF @focusTaskId IS NULL
  BEGIN
${VISIBLE_TASKS}
  END
  DROP TABLE IF EXISTS #AiDependencies;
  SELECT TOP (@maxRows) d.TaskId, d.PredecessorTaskId, d.DependencyType, d.LagDays, d.LagValue, d.LagUnit
  INTO #AiDependencies
  FROM dbo.MR_TaskDependencies d
  JOIN #AiScopeProjects v ON v.ProjectId = d.ProjectId AND v.AccessLevel = 'FULL'
  WHERE d.ProjectId = @projectId
    AND (@focusTaskId IS NULL OR d.TaskId = @focusTaskId OR d.PredecessorTaskId = @focusTaskId)
  ORDER BY d.TaskId, d.PredecessorTaskId;

  SELECT * FROM #AiDependencies;

  SELECT t.TaskId, t.Title, t.Status, t.PlannedStart, t.PlannedFinish, t.TargetFinish, t.IsMilestone
  FROM dbo.MR_Tasks t
  JOIN #AiScopeProjects v ON v.ProjectId = t.ProjectId AND v.AccessLevel = 'FULL'
  WHERE t.ProjectId = @projectId
    AND (t.TaskId = @focusTaskId OR EXISTS (
      SELECT 1 FROM #AiDependencies d WHERE d.TaskId = t.TaskId OR d.PredecessorTaskId = t.TaskId));

  SELECT COUNT(*) AS TaskCount,
    COALESCE(SUM(CASE WHEN t.Status <> 'done' THEN 1 ELSE 0 END), 0) AS OpenCount
  FROM dbo.MR_Tasks t
  JOIN #AiScopeProjects v ON v.ProjectId = t.ProjectId AND v.AccessLevel = 'FULL'
  WHERE @focusTaskId IS NULL AND t.ProjectId = @projectId
    AND EXISTS (SELECT 1 FROM #AiTasks visible WHERE visible.TaskId = t.TaskId);

  DROP TABLE #AiDependencies, #AiTasks, #AiTaskFilter, #AiScopeTasks, #AiScopeProjects;`;

/**
 * Baz plan karşılaştırması — yalnızca FULL projede. Anlık görüntü satırı
 * görevden DAHA UZUN yaşar: görevi silinmiş satır "baz planda var, artık yok"
 * olarak sayılır. Seçim: verilen baz plan, yoksa birincil, o da yoksa en yeni.
 */
export const AI_TOOL_BASELINE_SQL = `/* rota-ai-tool:baseline */
${SCOPE_PROJECTS}
  DECLARE @projectFull bit = CASE WHEN EXISTS (
    SELECT 1 FROM #AiScopeProjects v WHERE v.ProjectId = @projectId AND v.AccessLevel = 'FULL'
  ) THEN 1 ELSE 0 END;

  DECLARE @selectedBaseline uniqueidentifier = (
    SELECT TOP (1) b.BaselineId FROM dbo.MR_Baselines b
    WHERE @projectFull = 1 AND b.ProjectId = @projectId AND (@baselineId IS NULL OR b.BaselineId = @baselineId)
    ORDER BY b.IsPrimary DESC, b.CreatedAt DESC, b.BaselineId
  );

  SELECT TOP (10) b.BaselineId, b.Name, b.CreatedAt, b.IsPrimary,
    CASE WHEN snapshotStats.SnapshotRows >= @analysisMaxRows THEN NULL ELSE snapshotStats.SnapshotRows END AS SnapshotCount
  FROM dbo.MR_Baselines b
  OUTER APPLY (SELECT COUNT(*) AS SnapshotRows FROM (
    SELECT TOP (@analysisMaxRows) 1 AS Present FROM dbo.MR_TaskBaselineSnapshots s WHERE s.BaselineId = b.BaselineId
  ) bounded) snapshotStats
  WHERE @projectFull = 1 AND b.ProjectId = @projectId
  ORDER BY CASE WHEN b.BaselineId = @selectedBaseline THEN 0 ELSE 1 END,
    b.IsPrimary DESC, b.CreatedAt DESC, b.BaselineId;

  SELECT @projectFull AS ProjectFull, @selectedBaseline AS SelectedBaselineId,
    (SELECT COUNT(*) FROM dbo.MR_Baselines b WHERE @projectFull = 1 AND b.ProjectId = @projectId) AS BaselineTotal;

  IF (SELECT COUNT(*) FROM (SELECT TOP (@analysisMaxRows) 1 AS Present
    FROM dbo.MR_TaskBaselineSnapshots s WHERE s.BaselineId = @selectedBaseline) bounded) >= @analysisMaxRows
    THROW 51001, 'AI_TOOL_RESULT_TOO_LARGE', 1;
  IF @selectedBaseline IS NOT NULL
  BEGIN
${VISIBLE_TASKS}

  SELECT TOP (@maxRows) s.TaskId, s.PlannedStart AS BaselineStart, s.PlannedFinish AS BaselineFinish,
    s.PlannedDurationDays AS BaselineDuration,
    CAST(CASE WHEN t.TaskId IS NULL THEN 0 ELSE 1 END AS bit) AS TaskExists,
    t.Title, t.Status, t.PlannedStart, t.PlannedFinish, t.TargetFinish, t.ActualFinish
  FROM dbo.MR_TaskBaselineSnapshots s
  LEFT JOIN dbo.MR_Tasks t ON t.TaskId = s.TaskId AND t.ProjectId = @projectId
  WHERE @selectedBaseline IS NOT NULL AND s.BaselineId = @selectedBaseline
  ORDER BY s.TaskId;

  SELECT COUNT(*) AS AddedSinceBaseline
  FROM #AiTasks visible
  JOIN dbo.MR_Tasks t ON t.TaskId = visible.TaskId
  WHERE @selectedBaseline IS NOT NULL AND t.ProjectId = @projectId
    AND NOT EXISTS (
      SELECT 1 FROM dbo.MR_TaskBaselineSnapshots s
      WHERE s.BaselineId = @selectedBaseline AND s.TaskId = t.TaskId
    );

  END
  ELSE
  BEGIN
    SELECT CAST(NULL AS uniqueidentifier) AS TaskId WHERE 1 = 0;
    SELECT 0 AS AddedSinceBaseline;
  END

  DROP TABLE #AiTasks, #AiTaskFilter, #AiScopeTasks, #AiScopeProjects;`;

/**
 * Çalışma takvimi: projenin etkin takvimi (proje görünür olmalıdır), yoksa
 * varsayılan takvim; çalışma günleri ve aralıktaki tatiller.
 */
export const AI_TOOL_CALENDAR_SQL = `/* rota-ai-tool:calendar */
${SCOPE_PROJECTS}
  DECLARE @projectVisible bit = CASE WHEN @projectId IS NOT NULL AND EXISTS (
    SELECT 1 FROM #AiScopeProjects v WHERE v.ProjectId = @projectId
  ) THEN 1 ELSE 0 END;
  DECLARE @calendarId uniqueidentifier = NULL;
  IF @projectVisible = 1
    SELECT @calendarId = c.CalendarId
    FROM dbo.MR_Projects p
    JOIN dbo.MR_Calendars c ON c.CalendarId = p.CalendarId AND c.IsActive = 1
    WHERE p.ProjectId = @projectId;
  IF @calendarId IS NULL
    SELECT TOP (1) @calendarId = c.CalendarId FROM dbo.MR_Calendars c WHERE c.IsDefault = 1 AND c.IsActive = 1;

  SELECT @projectVisible AS ProjectVisible, c.CalendarId, c.Name, c.TimeZone, c.IsDefault
  FROM (SELECT 1 AS Anchor) anchor
  LEFT JOIN dbo.MR_Calendars c ON c.CalendarId = @calendarId;

  SELECT wd.Weekday FROM dbo.MR_CalendarWorkingDays wd WHERE wd.CalendarId = @calendarId ORDER BY wd.Weekday;

  SELECT h.HolidayDate, h.Name, h.ShortName
  FROM dbo.MR_CalendarHolidays h
  WHERE h.CalendarId = @calendarId AND h.HolidayDate >= @from AND h.HolidayDate <= @to
  ORDER BY h.HolidayDate;

  DROP TABLE #AiTasks, #AiTaskFilter, #AiScopeTasks, #AiScopeProjects;`;

/**
 * Kullanıcının KENDİ Outlook takvim aboneliklerinin Rota'daki teslim durumu.
 * Posta kutusu içeriği değildir; yalnızca görünür görevlerin abonelikleri
 * ayrıntılı döner, görünmeyen ya da silinmiş görevin aboneliği yalnızca sayıya
 * girer.
 */
export const AI_TOOL_OUTLOOK_SQL = `/* rota-ai-tool:outlook */
${SCOPE_PROJECTS}
  IF @AiTaskFilterActive = 0
    INSERT #AiTaskFilter(TaskId)
    SELECT DISTINCT s.TaskId FROM dbo.MR_TaskOutlookSubscriptions s
    WHERE s.UserSicil = @sicil AND s.IsActive = 1;
  SET @AiTaskFilterActive = 1;
${VISIBLE_TASKS}
  SELECT TOP (@maxRows) s.TaskId, t.Title, p.ProjectName, p.ProjectCode, t.TargetFinish, t.PlannedFinish, t.Status,
    s.PendingMethod, s.DeliveredSequence, s.DeliveredMethod, s.DeliveredDate, s.LastDeliveredAt,
    s.LastFailureCode, s.AttemptCount, s.CompletionSuspended, s.UpdatedAt
  FROM dbo.MR_TaskOutlookSubscriptions s
  JOIN #AiTasks visible ON visible.TaskId = s.TaskId
  JOIN dbo.MR_Tasks t ON t.TaskId = s.TaskId
  JOIN dbo.MR_Projects p ON p.ProjectId = t.ProjectId
  WHERE s.UserSicil = @sicil AND s.IsActive = 1
  ORDER BY COALESCE(t.TargetFinish, t.PlannedFinish), s.TaskId;

  SELECT CAST(CASE WHEN EXISTS (
    SELECT 1 FROM dbo.MR_TaskOutlookSubscriptions s
    WHERE s.UserSicil = @sicil AND s.IsActive = 1
      AND (LEN(@taskIds) = 0 OR EXISTS (SELECT 1 FROM #AiTaskFilter f WHERE f.TaskId = s.TaskId))
      AND NOT EXISTS (SELECT 1 FROM #AiTasks visible WHERE visible.TaskId = s.TaskId)
  ) THEN 1 ELSE 0 END AS bit) AS HasNonVisibleSubscriptions;

  DROP TABLE #AiTasks, #AiTaskFilter, #AiScopeTasks, #AiScopeProjects;`;
