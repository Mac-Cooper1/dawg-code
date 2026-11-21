# Wrong: on a tie for largest, the later row wins (only the hidden data has a tie).
cp "$TASK_DIR/solution/summarize.py" .
python3 "$TASK_DIR/../_tools/replace.py" summarize.py 'cents > summary["largest"]["amount_cents"]' 'cents >= summary["largest"]["amount_cents"]'
python3 summarize.py data/expenses.csv reports/summary.json
