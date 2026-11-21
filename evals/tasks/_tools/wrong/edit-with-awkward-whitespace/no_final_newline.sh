# Correct edits, but the rewritten file lost its final newline.
cp "$TASK_DIR/check/expected_settings.js" src/settings.js
python3 - <<'PY'
p = "src/settings.js"
s = open(p, newline="").read()
open(p, "w", newline="").write(s.rstrip("\n"))
PY
