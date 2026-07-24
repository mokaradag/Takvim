from pathlib import Path

repo_path = Path('src/server/repository/sqlAppRepository.js')
repo = repo_path.read_text()
broken = "        )\n       )\n    ORDER BY pd.DisplayName, pd.Sicil;"
fixed = "        )\n    ORDER BY pd.DisplayName, pd.Sicil;"
if repo.count(broken) != 1:
    raise SystemExit(f'expected one stale people-query closing suffix, found {repo.count(broken)}')
repo_path.write_text(repo.replace(broken, fixed, 1))
print('cleaned stale people-query closing parenthesis')

test_path = Path('test/codex-p2-regressions.test.mjs')
tests = test_path.read_text()
needle = "  assert.match(source, /readProject\.ProjectId = visibleTask\.ProjectId/);\n"
addition = "  assert.doesNotMatch(source, /\\n {7}\\)\\n {4}ORDER BY pd\\.DisplayName, pd\\.Sicil/);\n"
if addition not in tests:
    if needle not in tests:
        raise SystemExit('READ visibility regression insertion point not found')
    tests = tests.replace(needle, needle + addition, 1)
test_path.write_text(tests)
print('added exact stale people-query suffix regression')
