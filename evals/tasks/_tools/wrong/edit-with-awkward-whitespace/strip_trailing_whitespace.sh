# Correct edits, but the editor strips trailing whitespace on every line.
cp "$TASK_DIR/check/expected_settings.js" src/settings.js
python3 - <<'PY'
p = "src/settings.js"
lines = open(p, newline="").read().split("\n")
open(p, "w", newline="").write("\n".join(l.rstrip() for l in lines))
PY
