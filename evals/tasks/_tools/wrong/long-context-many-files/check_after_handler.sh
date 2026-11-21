# Checks the scope after running the handler, so rejected writes still happen.
cp -R "$TASK_DIR/solution/." .
python3 - <<'PY'
p = "src/app.js"
s = open(p).read()
s = s.replace("""    const { scope } = found.route;
    if (scope !== "public") {""", """    const { scope } = found.route;
    let result;
    try {
      result = found.route.handler({ params: found.params, body, auth, services, db });
    } catch {}
    if (scope !== "public") {""")
open(p, "w").write(s)
PY
