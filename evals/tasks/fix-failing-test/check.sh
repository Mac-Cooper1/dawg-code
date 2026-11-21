#!/usr/bin/env bash
# Pass when: the hidden copy of the tests (plus extra half-up rounding cases)
# passes against the workspace code, the workspace's own suite passes, and no
# original test was removed from the workspace's tests.
set -u
cd "$WORKSPACE"
export PYTHONDONTWRITEBYTECODE=1
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

cp "$TASK_DIR/check/test_hidden.py" "$tmp/"
if ! (cd "$tmp" && PYTHONPATH="$WORKSPACE" python3 -m unittest -q test_hidden); then
	echo "FAIL: hidden tests"
	exit 1
fi

if ! python3 -m unittest discover -s tests >"$tmp/visible.log" 2>&1; then
	tail -20 "$tmp/visible.log"
	echo "FAIL: the workspace test suite does not pass"
	exit 1
fi

# Every test method from the original visible suite must still be there.
missing=0
for name in $(git show HEAD:tests/test_money.py HEAD:tests/test_invoice.py | grep -oE 'def test_[A-Za-z0-9_]+' | sort -u | cut -c5-); do
	if ! grep -rqE "def $name\b" tests/; then
		echo "FAIL: original test $name was removed"
		missing=1
	fi
done
[ $missing -eq 0 ] || exit 1
echo PASS
