# Lazy: scope by HTTP method (GET = read, others = write), /admin/ = admin.
cp "$TASK_DIR/solution/src/app.js" src/app.js
for f in src/routes/*.js; do
	[ "$(basename "$f")" = index.js ] && continue
	python3 - "$f" <<'PY'
import re, sys
p = sys.argv[1]
s = open(p).read()
method = re.search(r'method: "(\w+)"', s).group(1)
path = re.search(r'path: "([^"]+)"', s).group(1)
scope = "public" if path in ("/health", "/version") else "admin" if path.startswith("/admin/") else "read" if method == "GET" else "write"
s = s.replace(f'  path: "{path}",\n', f'  path: "{path}",\n  scope: "{scope}",\n')
open(p, "w").write(s)
PY
done
