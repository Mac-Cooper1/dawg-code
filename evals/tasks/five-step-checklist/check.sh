#!/usr/bin/env bash
# Five deliverables, each checked separately (all must pass):
#  1. apostrophes inside words  -> hidden tests on count_words and CLI output
#  2. --min-length N            -> hidden CLI tests
#  3. --json                    -> hidden CLI tests
#  4. tests/test_cli.py         -> exists, mentions both options, the whole suite
#                                  passes, and it FAILS against the original code
#                                  (so it really tests the new options)
#  5. version 1.4.0 + CHANGELOG -> hidden tests
set -u
cd "$WORKSPACE"
export PYTHONDONTWRITEBYTECODE=1
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
status=0

cp "$TASK_DIR/check/test_hidden_wordtally.py" "$tmp/"
if ! (cd "$tmp" && WORKSPACE="$WORKSPACE" PYTHONPATH="$WORKSPACE" python3 -m unittest test_hidden_wordtally >"$tmp/hidden.log" 2>&1); then
	grep -E '^(FAIL|ERROR|AssertionError|[A-Za-z]*Error)' "$tmp/hidden.log" | head -30
	for item in 1 2 3 5; do
		if grep -qE "^(FAIL|ERROR): test_item${item}_" "$tmp/hidden.log"; then
			echo "FAIL item $item"
		fi
	done
	status=1
fi

# Item 4
if [ ! -f tests/test_cli.py ]; then
	echo "FAIL item 4: tests/test_cli.py does not exist"
	status=1
else
	if ! grep -qE 'min[-_]length' tests/test_cli.py || ! grep -q 'json' tests/test_cli.py; then
		echo "FAIL item 4: tests/test_cli.py does not cover both --min-length and --json"
		status=1
	fi
	if ! python3 -m unittest discover -s tests >"$tmp/suite.log" 2>&1; then
		tail -20 "$tmp/suite.log"
		echo "FAIL item 4: the test suite does not pass"
		status=1
	fi
	# The new tests must fail against the original package.
	mkdir -p "$tmp/orig"
	cp -R . "$tmp/orig/"
	rm -rf "$tmp/orig/wordtally"
	for f in $(git ls-tree -r --name-only HEAD wordtally); do
		mkdir -p "$tmp/orig/$(dirname "$f")"
		git show "HEAD:$f" >"$tmp/orig/$f"
	done
	if (cd "$tmp/orig" && python3 -m unittest tests.test_cli >/dev/null 2>&1); then
		echo "FAIL item 4: tests/test_cli.py also passes on the old code, so it does not test the new options"
		status=1
	fi
fi

[ $status -eq 0 ] && echo PASS
exit $status
