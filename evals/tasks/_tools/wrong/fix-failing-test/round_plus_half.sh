# Wrong fix: round(x + 0.5) pushes 0.4 up to 1.
python3 "$TASK_DIR/../_tools/replace.py" invoicing/money.py "return round(cents * percent / 100)" "return round(cents * percent / 100 + 0.5)"
