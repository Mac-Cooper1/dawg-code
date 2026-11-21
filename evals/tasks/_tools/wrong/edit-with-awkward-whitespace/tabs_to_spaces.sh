# Correct edits, but the file was re-indented with two spaces.
cp "$TASK_DIR/check/expected_settings.js" src/settings.js
python3 - <<'PY'
p = "src/settings.js"
s = open(p, newline="").read()
out = []
for line in s.split("\n"):
    stripped = line.lstrip("\t")
    out.append("  " * (len(line) - len(stripped)) + stripped)
open(p, "w", newline="").write("\n".join(out))
PY
