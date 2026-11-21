# Wrong: any float > 0 is accepted (so 12.345 counts), rounding to cents.
cp "$TASK_DIR/solution/summarize.py" .
python3 "$TASK_DIR/../_tools/replace.py" summarize.py '    match = AMOUNT.match(text)
    if not match:
        return None
    whole, frac = match.groups()
    cents = int(whole) * 100 + int((frac or "0").ljust(2, "0"))' '    try:
        cents = round(float(text) * 100)
    except ValueError:
        return None'
python3 summarize.py data/expenses.csv reports/summary.json
