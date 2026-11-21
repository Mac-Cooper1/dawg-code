#!/usr/bin/env bash
# Pass when, in a simulated fresh clone of the workspace (a copy with every
# git-ignored file removed, i.e. generated files and build output gone, while
# the agent's uncommitted changes are kept):
#  - `bash ci.sh` exits 0 and still runs its test step,
#  - build/units.json equals the expected table, and
#  - a hidden copy of the tests (plus extra cases) passes against src/convert.js,
#    so the tests cannot have been weakened.
set -u
cd "$WORKSPACE"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
clone="$tmp/clone"
mkdir -p "$clone"
cp -R . "$clone/"
(cd "$clone" && git clean -fdXq)

if ! grep -qE 'node +--test' "$clone/ci.sh"; then
	echo "FAIL: ci.sh no longer runs the tests"
	exit 1
fi
if ! (cd "$clone" && bash ci.sh >"$tmp/ci.log" 2>&1); then
	tail -25 "$tmp/ci.log"
	echo "FAIL: bash ci.sh fails on a fresh clone"
	exit 1
fi
if [ ! -f "$clone/build/units.json" ]; then
	echo "FAIL: ci.sh did not produce build/units.json"
	exit 1
fi
if ! python3 "$TASK_DIR/check/compare_json.py" "$clone/build/units.json" "$TASK_DIR/check/expected_units.json"; then
	echo "FAIL: build/units.json has wrong content"
	exit 1
fi
if ! CLONE="$clone" node --test --test-reporter=dot "$TASK_DIR/check/convert.hidden.test.js"; then
	echo "FAIL: hidden tests"
	exit 1
fi
echo PASS
