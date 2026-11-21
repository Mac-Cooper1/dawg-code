# Wrong: lowercases categories but does not trim them.
cp "$TASK_DIR/solution/summarize.py" .
python3 "$TASK_DIR/../_tools/replace.py" summarize.py 'row["category"].strip().lower()' 'row["category"].lower()'
python3 summarize.py data/expenses.csv reports/summary.json
