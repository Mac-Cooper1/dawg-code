# Over-locked: every non-public route requires admin.
cp "$TASK_DIR/solution/src/app.js" src/app.js
for f in "$TASK_DIR"/solution/src/routes/*.js; do cp "$f" src/routes/; done
for f in src/routes/*.js; do
	grep -q 'scope: "read"\|scope: "write"' "$f" || continue
	python3 - "$f" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read().replace('scope: "read"', 'scope: "admin"').replace('scope: "write"', 'scope: "admin"')
open(p, "w").write(s)
PY
done
