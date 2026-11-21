#!/usr/bin/env bash
# Pass when:
#  - hidden Ember Tithe tests pass (heals by the total drained, no crash with no
#    opponents left, card data unchanged),
#  - every other card behaves exactly as before (state fingerprints recorded
#    from the original file),
#  - every change to cardgame/cards.py is inside the Ember Tithe class, and
#  - the workspace's test suite passes.
set -u
cd "$WORKSPACE"
export PYTHONDONTWRITEBYTECODE=1
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

cp "$TASK_DIR/check/test_hidden_cards.py" "$tmp/"
if ! (cd "$tmp" && PYTHONPATH="$WORKSPACE" python3 -m unittest -q test_hidden_cards); then
	echo "FAIL: hidden Ember Tithe tests"
	exit 1
fi
if ! (cd "$tmp" && PYTHONPATH="$WORKSPACE" python3 "$TASK_DIR/check/fingerprint.py" >"$tmp/fp.json") ||
	! python3 "$TASK_DIR/check/compare_fingerprints.py" "$TASK_DIR/check/fingerprints.json" <"$tmp/fp.json"; then
	echo "FAIL: other cards changed behaviour"
	exit 1
fi
if ! git diff -U0 HEAD -- cardgame/cards.py | python3 "$TASK_DIR/check/diff_in_span.py" "$TASK_DIR/check/target_span.json"; then
	echo "FAIL: change is not confined to the Ember Tithe card"
	exit 1
fi
if ! python3 -m unittest discover -s tests >"$tmp/suite.log" 2>&1; then
	tail -20 "$tmp/suite.log"
	echo "FAIL: the workspace test suite does not pass"
	exit 1
fi
echo PASS
