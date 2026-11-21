# Wrong fix: always round up.
python3 "$TASK_DIR/../_tools/replace.py" invoicing/money.py "return round(cents * percent / 100)" "return -(-cents * percent // 100)"
