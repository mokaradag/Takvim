from pathlib import Path

exec(compile(Path('.github/scripts/apply-sixth-codex-review-fixes-v4.py').read_text(), '.github/scripts/apply-sixth-codex-review-fixes-v4.py', 'exec'))

path = Path('src/domain/validation/wbsValidation.js')
text = path.read_text()
old = """  if (node && node.parentId == null) issues.push(issue('WBS_ROOT_DELETE_FORBIDDEN', wbsId));
  if (childIds.length) issues.push(issue('WBS_HAS_CHILDREN', wbsId, { childIds }));
  if (taskIds.length) issues.push(issue('WBS_HAS_TASKS', wbsId, { taskIds }));
"""
new = """  if (childIds.length) issues.push(issue('WBS_HAS_CHILDREN', wbsId, { childIds }));
  if (taskIds.length) issues.push(issue('WBS_HAS_TASKS', wbsId, { taskIds }));
  if (node && node.parentId == null) issues.push(issue('WBS_ROOT_DELETE_FORBIDDEN', wbsId));
"""
if old not in text:
    raise SystemExit('root WBS validation ordering block not found')
path.write_text(text.replace(old, new, 1))
print('preserved specific WBS deletion blockers before root invariant')
