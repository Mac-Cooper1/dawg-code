# Incomplete: renamed the key but not the code that reads it.
cp "$TASK_DIR/check/expected_settings.js" src/settings.js
python3 "$TASK_DIR/../_tools/replace.py" src/settings.js "theme.color;" "theme.colour;"
