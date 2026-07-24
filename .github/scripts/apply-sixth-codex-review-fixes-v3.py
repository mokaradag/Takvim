from pathlib import Path

source_path = Path('.github/scripts/apply-sixth-codex-review-fixes-v2.py')
source = source_path.read_text()
old = '''repo = replace_required(
    repo,
    "    WHERE v.AccessLevel = 'FULL'\\n       OR EXISTS (\\n          SELECT 1\\n          FROM dbo.MR_TaskAssignees ta",
    "    WHERE v.AccessLevel = 'FULL'\\n       OR EXISTS (SELECT 1 FROM @ReadGrantedProjects readProject WHERE readProject.ProjectId = t.ProjectId)\\n       OR EXISTS (\\n          SELECT 1\\n          FROM dbo.MR_TaskAssignees ta",
    'READ task visibility',
)
'''
new = '''task_query_start = repo.index("    SELECT t.*, v.AccessLevel")
task_query_end = repo.index("    ORDER BY t.ProjectId, t.SortOrder, t.Title;", task_query_start)
task_query = repo[task_query_start:task_query_end]
task_query = replace_required(
    task_query,
    "    WHERE v.AccessLevel = 'FULL'",
    "    WHERE v.AccessLevel = 'FULL'\\n       OR EXISTS (SELECT 1 FROM @ReadGrantedProjects readProject WHERE readProject.ProjectId = t.ProjectId)",
    'READ task visibility',
)
repo = repo[:task_query_start] + task_query + repo[task_query_end:]
'''
if old not in source:
    raise SystemExit('v2 task visibility patch block not found')
patched = source.replace(old, new, 1)
exec(compile(patched, str(source_path), 'exec'))
