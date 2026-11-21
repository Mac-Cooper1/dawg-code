# Shared helpers for the task validator and spot checks. Source, don't run.
# Mirrors the runner contract: copy fixture/, run setup.sh, git init + commit,
# then (optionally) change the workspace, then run check.sh with a 60 s limit.

TOOLS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TASKS_DIR="$(dirname "$TOOLS_DIR")"

# run_limited SECONDS CMD... : run CMD, kill it after SECONDS; exit 124 on timeout.
run_limited() {
	local secs="$1"
	shift
	python3 -c '
import subprocess, sys
try:
    sys.exit(subprocess.run(sys.argv[2:], timeout=float(sys.argv[1])).returncode)
except subprocess.TimeoutExpired:
    print("timed out", file=sys.stderr)
    sys.exit(124)
' "$secs" "$@"
}

# prepare_workspace TASK_DIR -> prints the new workspace path
prepare_workspace() {
	local task_dir="$1" ws
	ws="$(mktemp -d "${TMPDIR:-/tmp}/dawg-eval-ws.XXXXXX")"
	cp -R "$task_dir/fixture/." "$ws/"
	if [ -f "$task_dir/setup.sh" ]; then
		(cd "$ws" && TASK_DIR="$task_dir" WORKSPACE="$ws" bash "$task_dir/setup.sh") >/dev/null 2>&1 || {
			echo "setup.sh failed" >&2
			return 1
		}
	fi
	(
		cd "$ws" &&
			git -c init.defaultBranch=main init -q &&
			git add -A &&
			git -c user.name=dawg-eval -c user.email=dawg-eval@localhost \
				-c commit.gpgsign=false -c core.hooksPath=/dev/null \
				commit -q --allow-empty -m "starting state"
	) >/dev/null 2>&1 || {
		echo "git init/commit failed" >&2
		return 1
	}
	echo "$ws"
}

# apply_solution TASK_DIR WS
apply_solution() {
	local task_dir="$1" ws="$2"
	cp -R "$task_dir/solution/." "$ws/"
	if [ -f "$task_dir/solution.sh" ]; then
		(cd "$ws" && TASK_DIR="$task_dir" WORKSPACE="$ws" bash "$task_dir/solution.sh")
	fi
}

# run_check TASK_DIR WS LOGFILE -> returns check.sh exit status
run_check() {
	local task_dir="$1" ws="$2" log="$3"
	(cd "$ws" && TASK_DIR="$task_dir" WORKSPACE="$ws" run_limited 60 bash "$task_dir/check.sh") >"$log" 2>&1
}
