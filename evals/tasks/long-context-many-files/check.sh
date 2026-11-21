#!/usr/bin/env bash
# Pass when the hidden permission tests pass against the workspace's
# src/app.js (for each of the 30 routes: 401 without auth, 403 with
# {error:"forbidden", required:<scope>} when scopes are insufficient, success
# when sufficient, scope hierarchy respected, rejected requests change nothing,
# 404s unchanged, handlers still work), and the workspace's own suite passes.
set -u
cd "$WORKSPACE"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
if ! WORKSPACE="$WORKSPACE" node --test --test-reporter=dot "$TASK_DIR/check/permissions.test.js" >"$tmp/hidden.log" 2>&1; then
	grep -E "^ *(✖|not ok)|Error|expected|wrong" "$tmp/hidden.log" | head -40
	echo "FAIL: hidden permission tests"
	exit 1
fi
if ! node --test --test-reporter=dot >"$tmp/visible.log" 2>&1; then
	tail -30 "$tmp/visible.log"
	echo "FAIL: the workspace test suite does not pass"
	exit 1
fi
echo PASS
