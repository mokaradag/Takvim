from pathlib import Path

exec(compile(Path('.github/scripts/apply-sixth-codex-review-fixes-v3.py').read_text(), '.github/scripts/apply-sixth-codex-review-fixes-v3.py', 'exec'))

path = Path('test/codex-p2-regressions.test.mjs')
text = path.read_text()
old = "/WHERE v\\.AccessLevel = 'FULL'\\s+OR EXISTS \\(SELECT 1 FROM RequiredPartialWbs r WHERE r\\.WbsId = w\\.WbsId\\)/s"
new = "/WHERE v\\.AccessLevel = 'FULL'\\s+OR EXISTS \\(SELECT 1 FROM @ReadGrantedProjects readProject WHERE readProject\\.ProjectId = w\\.ProjectId\\)\\s+OR EXISTS \\(SELECT 1 FROM RequiredPartialWbs r WHERE r\\.WbsId = w\\.WbsId\\)/s"
if old not in text:
    raise SystemExit('superseded partial WBS regression not found')
path.write_text(text.replace(old, new, 1))
print('refreshed partial WBS regression for project-level READ grants')
