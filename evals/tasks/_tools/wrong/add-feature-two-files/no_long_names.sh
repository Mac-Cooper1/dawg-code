# Compact days in both files but the long form prints "1 d" style names (missing day/days).
cp "$TASK_DIR/solution/src/parse.js" src/parse.js
cp "$TASK_DIR/solution/src/format.js" src/format.js
python3 "$TASK_DIR/../_tools/replace.py" src/format.js '  d: ["day", "days"],
' ''
python3 "$TASK_DIR/../_tools/replace.py" src/format.js 'const [one, many] = LONG_NAMES[unit];' 'const [one, many] = LONG_NAMES[unit] ?? [unit, unit];'
cp "$TASK_DIR/solution/test/days.test.js" test/days.test.js
