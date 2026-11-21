# Deleted the legacy-xml entry's text but left an empty line behind.
cp "$TASK_DIR/fixture/src/settings.js" src/settings.js 2>/dev/null || true
python3 "$TASK_DIR/../_tools/replace.py" src/settings.js "1500,  " "2500,  " 1
python3 "$TASK_DIR/../_tools/replace.py" src/settings.js $'\t"legacy-xml",\t\t' ''
python3 "$TASK_DIR/../_tools/replace.py" src/settings.js "colour" "color"
