# Nearly right: misses that the export route writes through the audit service.
cp -R "$TASK_DIR/solution/." .
python3 "$TASK_DIR/../_tools/replace.py" src/routes/projects-export.js 'scope: "write"' 'scope: "read"'
