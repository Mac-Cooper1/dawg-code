#!/usr/bin/env bash
# Pass when ANSWER.md exists, each of the five sections has an "Answer:" line
# containing the key fact (and not the most likely wrong value), and no tracked
# file was modified (the prompt says not to change other files).
set -u
cd "$WORKSPACE"
if [ ! -f ANSWER.md ]; then
	echo "FAIL: ANSWER.md does not exist"
	exit 1
fi
if ! python3 "$TASK_DIR/check/grade_answers.py" ANSWER.md; then
	echo "FAIL: wrong or missing answers"
	exit 1
fi
if ! git diff --quiet HEAD --; then
	echo "FAIL: tracked files were modified:"
	git diff --stat HEAD -- | tail -10
	exit 1
fi
echo PASS
