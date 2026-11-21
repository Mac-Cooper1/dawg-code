# Wrong units: totals in euros (floats) instead of integer cents.
cp "$TASK_DIR/solution/summarize.py" .
python3 "$TASK_DIR/../_tools/replace.py" summarize.py '        json.dump(summary, f, indent=2, sort_keys=True)' '        summary["total_cents"] = summary["total_cents"] / 100
        json.dump(summary, f, indent=2, sort_keys=True)'
python3 summarize.py data/expenses.csv reports/summary.json
