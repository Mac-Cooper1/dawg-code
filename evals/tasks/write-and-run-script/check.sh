#!/usr/bin/env bash
# Pass when:
#  - reports/summary.json exists and equals the expected summary of data/expenses.csv
#    (compared as JSON values, so formatting and key order do not matter), and
#  - summarize.py, run by the checker on a second, hidden CSV with the same format,
#    produces the expected summary for that file too (so the output was computed
#    by the script, not written by hand).
set -u
cd "$WORKSPACE"
export PYTHONDONTWRITEBYTECODE=1
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cmp="$TASK_DIR/check/compare_summary.py"

if [ ! -f reports/summary.json ]; then
	echo "FAIL: reports/summary.json does not exist"
	exit 1
fi
if ! python3 "$cmp" reports/summary.json "$TASK_DIR/check/expected_summary.json"; then
	echo "FAIL: reports/summary.json is wrong"
	exit 1
fi
if [ ! -f summarize.py ]; then
	echo "FAIL: summarize.py does not exist"
	exit 1
fi
if ! python3 summarize.py "$TASK_DIR/check/hidden_expenses.csv" "$tmp/hidden.json" >"$tmp/run.log" 2>&1; then
	tail -20 "$tmp/run.log"
	echo "FAIL: summarize.py exited non-zero on another CSV"
	exit 1
fi
if ! python3 "$cmp" "$tmp/hidden.json" "$TASK_DIR/check/expected_hidden_summary.json"; then
	echo "FAIL: summarize.py gives the wrong summary for another CSV"
	exit 1
fi
echo PASS
