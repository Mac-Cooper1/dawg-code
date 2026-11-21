# Scopes treated as independent: "admin" does not imply "write" or "read".
cp -R "$TASK_DIR/solution/." .
python3 "$TASK_DIR/../_tools/replace.py" src/app.js '      if (grantedRank(auth) < RANK[scope]) {' '      if (!(auth.scopes ?? []).includes(scope)) {'
