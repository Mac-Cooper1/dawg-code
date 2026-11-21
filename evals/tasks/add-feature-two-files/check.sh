#!/usr/bin/env bash
# Pass when:
#  - the hidden tests (days support + original behaviour) pass against the
#    workspace's src/index.js,
#  - the workspace's own test suite still passes, and
#  - the workspace's tests mention at least one duration with days (the prompt
#    asks for tests of the new behaviour).
set -u
cd "$WORKSPACE"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
if ! WORKSPACE="$WORKSPACE" node --test --test-reporter=dot "$TASK_DIR/check/days.test.js"; then
	echo "FAIL: hidden tests"
	exit 1
fi
if ! node --test --test-reporter=dot >"$tmp/visible.log" 2>&1; then
	tail -30 "$tmp/visible.log"
	echo "FAIL: the workspace test suite does not pass"
	exit 1
fi
# Test files: anything with "test" in its path and a .js/.mjs/.cjs extension.
# A days duration: a string like "1d", "2d3h", "1d 30m", or "2 days" / "1 day".
if ! find . -path ./node_modules -prune -o -path ./.git -prune -o -type f -path '*test*' \
	\( -name '*.js' -o -name '*.mjs' -o -name '*.cjs' \) -print0 |
	xargs -0 grep -lE "[\"'\`] *[0-9]+d([ 0-9]|[hms\"'\`])|[\"'\`][^\"'\`]*\b[0-9]+ days?\b" >/dev/null 2>&1; then
	echo "FAIL: no test in the workspace exercises a duration with days"
	exit 1
fi
echo PASS
