# Partial: code renamed everywhere, but README and comments still mention the old name.
for f in src/*.js bin/stock.js test/*.js; do
	python3 - "$f" <<'PY'
import re, sys
p = sys.argv[1]
s = open(p).read()
out = []
for line in s.split("\n"):
    stripped = line.lstrip()
    if stripped.startswith(("//", "*", "/**")):
        out.append(line)
    else:
        out.append(line.replace("normalizeSku", "canonicalSku"))
open(p, "w").write("\n".join(out))
PY
done
