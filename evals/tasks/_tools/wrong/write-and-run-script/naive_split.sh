# Wrong: splits lines on commas instead of parsing CSV (breaks on quoted fields).
cp "$TASK_DIR/solution/summarize.py" .
python3 "$TASK_DIR/../_tools/replace.py" summarize.py '        for row in csv.DictReader(f):' '        header = f.readline().strip().split(",")
        for line in f:
            row = dict(zip(header, line.rstrip("\n").split(",")))'
python3 summarize.py data/expenses.csv reports/summary.json
