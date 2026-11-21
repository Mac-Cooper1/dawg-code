# Wrong order: "d" accepted only after the smaller units (appended to the end of the order).
cp "$TASK_DIR/solution/src/format.js" src/format.js
python3 "$TASK_DIR/../_tools/replace.py" src/parse.js '  ["s", 1],
]);' '  ["s", 1],
  ["d", 86400],
]);'
cp "$TASK_DIR/solution/test/days.test.js" test/days.test.js
