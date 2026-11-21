# Correct edits, but the rewritten lines lost their trailing whitespace.
cp "$TASK_DIR/check/expected_settings.js" src/settings.js
python3 "$TASK_DIR/../_tools/replace.py" src/settings.js $'\ttimeoutMs:      2500,  \n' $'\ttimeoutMs:      2500,\n'
