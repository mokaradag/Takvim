from pathlib import Path

exec(compile(Path('.github/scripts/apply-sixth-codex-review-fixes-v5.py').read_text(), '.github/scripts/apply-sixth-codex-review-fixes-v5.py', 'exec'))

repo_path = Path('src/server/repository/sqlAppRepository.js')
repo = repo_path.read_text()
order_index = repo.index('    ORDER BY pd.DisplayName, pd.Sicil;')
lines = repo[:order_index].splitlines(keepends=True)
closing = [index for index in range(len(lines)) if lines[index].strip() == ')']
last_three = closing[-3:]
if len(last_three) != 3 or last_three[1] != last_three[0] + 1 or last_three[2] != last_three[1] + 1:
    raise SystemExit('expected three consecutive people-query closing parentheses before ORDER BY')
# The middle close is the stale inner close left by the original predicate splice;
# keep the new AND-group close and the original outer EXISTS close.
del lines[last_three[1]]
repo = ''.join(lines) + repo[order_index:]
repo_path.write_text(repo)
print('cleaned stale people-query closing parenthesis')

test_path = Path('test/codex-p2-regressions.test.mjs')
tests = test_path.read_text()
needle = "  assert.match(source, /readProject\\.ProjectId = visibleTask\\.ProjectId/);\n"
addition = "  assert.doesNotMatch(source, /\\n\\s+\\)\\n\\s+\\)\\n\\s+\\)\\n\\s+ORDER BY pd\\.DisplayName, pd\\.Sicil/);\n"
if addition not in tests:
    if needle not in tests:
        raise SystemExit('READ visibility regression insertion point not found')
    tests = tests.replace(needle, needle + addition, 1)
test_path.write_text(tests)
print('added people-query SQL balance regression')
