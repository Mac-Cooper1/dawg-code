# Alternative fix: math.floor(x + 0.5) on the float.
python3 "$TASK_DIR/../_tools/replace.py" invoicing/money.py '    return round(cents * percent / 100)' '    import math

    return math.floor(cents * percent / 100 + 0.5)'
