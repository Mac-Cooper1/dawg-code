#!/usr/bin/env bash
# Pass when src/settings.js is byte-identical to check/expected_settings.js and
# no other tracked file was modified or deleted (new untracked files are ignored).
set -u
cd "$WORKSPACE"
expected="$TASK_DIR/check/expected_settings.js"
if [ ! -f src/settings.js ]; then
	echo "FAIL: src/settings.js is missing"
	exit 1
fi
if ! cmp -s src/settings.js "$expected"; then
	echo "FAIL: src/settings.js differs from the expected bytes (tabs shown as ^I, line ends as \$):"
	diff <(cat -et "$expected") <(cat -et src/settings.js) | head -40
	exit 1
fi
others="$(git diff --name-only HEAD -- | grep -v '^src/settings\.js$' || true)"
if [ -n "$others" ]; then
	echo "FAIL: other tracked files changed:"
	echo "$others"
	exit 1
fi
echo PASS
