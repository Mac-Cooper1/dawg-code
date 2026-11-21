# Over-eager: replaces every 1500 (also the idle limit), otherwise correct.
cp "$TASK_DIR/check/expected_settings.js" src/settings.js
python3 "$TASK_DIR/../_tools/replace.py" src/settings.js "idleLimitMs:    1500," "idleLimitMs:    2500,"
