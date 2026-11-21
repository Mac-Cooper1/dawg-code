#!/usr/bin/env bash
set -euo pipefail
[ "$PWD" = "$WORKSPACE" ]
# setup.sh output is part of the committed starting state
git ls-files --error-unmatch generated.txt >/dev/null
# hidden checker assets are never copied into the workspace
[ ! -e check ]
[ ! -e obsolete.txt ]
cmp -s answer.txt "$TASK_DIR/check/expected.txt"
