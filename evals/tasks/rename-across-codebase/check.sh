#!/usr/bin/env bash
# Pass when:
#  - the old name `normalizeSku` appears in no file of the workspace (case-sensitive,
#    any file type, .git excluded),
#  - hidden tests pass: `canonicalSku` is exported from src/sku.js and src/index.js,
#    the old export is gone, and every module and the CLI still work,
#  - the workspace's own test suite passes.
set -u
cd "$WORKSPACE"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
if grep -rIn --exclude-dir=.git --exclude-dir=node_modules 'normalizeSku' . >"$tmp/left.txt"; then
	echo "FAIL: old name still present:"
	head -20 "$tmp/left.txt"
	exit 1
fi
if ! WORKSPACE="$WORKSPACE" node --test --test-reporter=dot "$TASK_DIR/check/rename.test.js"; then
	echo "FAIL: hidden tests"
	exit 1
fi
if ! node --test --test-reporter=dot >"$tmp/visible.log" 2>&1; then
	tail -30 "$tmp/visible.log"
	echo "FAIL: the workspace test suite does not pass"
	exit 1
fi
echo PASS
