#!/usr/bin/env bash
# Validate the eval tasks under evals/tasks/.
#
# For every task (or just the ids given as arguments):
#   1. task.yaml has the required fields and id == directory name;
#   2. check.sh FAILS on the untouched fixture;
#   3. check.sh PASSES after applying solution/ and solution.sh;
#   4. every wrong-solution spot check in _tools/wrong/<id>/*.sh makes check.sh FAIL;
#   5. every alternative correct solution in _tools/right/<id>/*.sh makes it PASS.
# Columns: WRONG = wrong solutions rejected / total, ALT = alternatives accepted / total.
# Prints a table; exits non-zero on any surprise. Use -v to see check.sh output
# for unexpected results.
set -u

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

verbose=0
ids=()
for arg in "$@"; do
	case "$arg" in
	-v) verbose=1 ;;
	*) ids+=("$arg") ;;
	esac
done
if [ ${#ids[@]} -eq 0 ]; then
	for d in "$TASKS_DIR"/*/; do
		name="$(basename "$d")"
		case "$name" in _*) continue ;; esac
		ids+=("$name")
	done
fi

scratch="$(mktemp -d "${TMPDIR:-/tmp}/dawg-eval-validate.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT
workspaces=()
cleanup_ws() { rm -rf "${workspaces[@]}"; workspaces=(); }

surprises=0
printf '%-30s %-5s %-8s %-9s %-6s %-6s %s\n' TASK YAML FIXTURE SOLUTION WRONG ALT RESULT
printf '%-30s %-5s %-8s %-9s %-6s %-6s %s\n' ------------------------------ ----- -------- --------- ------ ------ --------
for id in "${ids[@]}"; do
	task_dir="$TASKS_DIR/$id"
	ok=1
	notes=()

	if python3 "$TOOLS_DIR/check_task_yaml.py" "$task_dir" >"$scratch/yaml.log" 2>&1; then
		yaml=ok
	else
		yaml=BAD
		ok=0
		notes+=("$(tr '\n' ';' <"$scratch/yaml.log")")
	fi

	# 2. untouched fixture must fail
	fixture=-
	if ws="$(prepare_workspace "$task_dir")"; then
		workspaces+=("$ws")
		if run_check "$task_dir" "$ws" "$scratch/fixture.log"; then
			fixture=PASS!
			ok=0
			[ $verbose -eq 1 ] && sed 's/^/    fixture| /' "$scratch/fixture.log"
		else
			fixture=fail
		fi
	else
		fixture=ERROR
		ok=0
	fi

	# 3. reference solution must pass
	solution=-
	if ws="$(prepare_workspace "$task_dir")"; then
		workspaces+=("$ws")
		if ! apply_solution "$task_dir" "$ws" >"$scratch/solution-apply.log" 2>&1; then
			solution=ERROR
			ok=0
			notes+=("solution.sh failed")
		elif run_check "$task_dir" "$ws" "$scratch/solution.log"; then
			solution=pass
		else
			solution=FAIL!
			ok=0
			[ $verbose -eq 1 ] && sed 's/^/    solution| /' "$scratch/solution.log"
		fi
	else
		solution=ERROR
		ok=0
	fi

	# 4. wrong solutions must fail
	wrong_total=0
	wrong_failed=0
	for script in "$TOOLS_DIR/wrong/$id"/*.sh; do
		[ -f "$script" ] || continue
		wrong_total=$((wrong_total + 1))
		if ws="$(prepare_workspace "$task_dir")"; then
			workspaces+=("$ws")
			if ! (cd "$ws" && TASK_DIR="$task_dir" WORKSPACE="$ws" bash -e "$script") >"$scratch/wrong-apply.log" 2>&1; then
				ok=0
				notes+=("$(basename "$script"): apply step failed: $(tail -1 "$scratch/wrong-apply.log")")
			fi
			if run_check "$task_dir" "$ws" "$scratch/wrong.log"; then
				ok=0
				notes+=("wrong solution passed: $(basename "$script")")
				[ $verbose -eq 1 ] && sed 's/^/    wrong| /' "$scratch/wrong.log"
			else
				wrong_failed=$((wrong_failed + 1))
			fi
		fi
	done

	# 5. alternative correct solutions must pass
	right_total=0
	right_passed=0
	for script in "$TOOLS_DIR/right/$id"/*.sh; do
		[ -f "$script" ] || continue
		right_total=$((right_total + 1))
		if ws="$(prepare_workspace "$task_dir")"; then
			workspaces+=("$ws")
			if ! (cd "$ws" && TASK_DIR="$task_dir" WORKSPACE="$ws" bash -e "$script") >"$scratch/right-apply.log" 2>&1; then
				ok=0
				notes+=("$(basename "$script"): apply step failed: $(tail -1 "$scratch/right-apply.log")")
			fi
			if run_check "$task_dir" "$ws" "$scratch/right.log"; then
				right_passed=$((right_passed + 1))
			else
				ok=0
				notes+=("alternative correct solution failed: $(basename "$script")")
				[ $verbose -eq 1 ] && sed 's/^/    right| /' "$scratch/right.log"
			fi
		fi
	done

	cleanup_ws
	if [ $ok -eq 1 ]; then result=OK; else result=SURPRISE; surprises=$((surprises + 1)); fi
	printf '%-30s %-5s %-8s %-9s %-6s %-6s %s\n' "$id" "$yaml" "$fixture" "$solution" "$wrong_failed/$wrong_total" "$right_passed/$right_total" "$result"
	for n in "${notes[@]+"${notes[@]}"}"; do printf '    %s\n' "$n"; done
done

echo
if [ $surprises -eq 0 ]; then
	echo "All ${#ids[@]} tasks behave as expected (fixture fails, solution passes, wrong solutions fail, alternatives pass)."
	exit 0
fi
echo "$surprises task(s) with surprises."
exit 1
