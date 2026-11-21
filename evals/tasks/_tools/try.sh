#!/usr/bin/env bash
# try.sh TASK_ID [SCRIPT|solution]
# Prepare a fresh workspace for TASK_ID, optionally apply SCRIPT (run with
# cwd = workspace) or the reference solution, run check.sh and show its output.
# Leaves the workspace in place and prints its path, for poking around.
set -u
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
task_dir="$TASKS_DIR/$1"
ws="$(prepare_workspace "$task_dir")" || exit 2
if [ "${2:-}" = solution ]; then
	apply_solution "$task_dir" "$ws"
elif [ -n "${2:-}" ]; then
	script="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
	(cd "$ws" && TASK_DIR="$task_dir" WORKSPACE="$ws" bash -e "$script") || echo "(apply script exited non-zero)"
fi
log="$(mktemp)"
if run_check "$task_dir" "$ws" "$log"; then status=PASS; else status="FAIL ($?)"; fi
tail -25 "$log"
rm -f "$log"
echo "== $status   workspace: $ws"
