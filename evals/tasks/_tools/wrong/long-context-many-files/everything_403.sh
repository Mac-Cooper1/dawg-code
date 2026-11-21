# Missing-auth case answered with 403 instead of 401.
cp -R "$TASK_DIR/solution/." .
python3 "$TASK_DIR/../_tools/replace.py" src/app.js 'if (!auth) return { status: 401, body: { error: "unauthenticated" } };' 'if (!auth) return { status: 403, body: { error: "forbidden", required: scope } };'
