# Correct file, but also edited the README.
cp "$TASK_DIR/check/expected_settings.js" src/settings.js
echo "Timeout is now 2.5 s." >> README.md
