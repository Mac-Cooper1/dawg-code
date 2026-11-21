# Alternative fix: Decimal with ROUND_HALF_UP, plus a new regression test.
python3 "$TASK_DIR/../_tools/replace.py" invoicing/money.py '    return round(cents * percent / 100)' '    from decimal import ROUND_HALF_UP, Decimal

    exact = Decimal(cents) * Decimal(percent) / Decimal(100)
    return int(exact.quantize(Decimal(1), rounding=ROUND_HALF_UP))'
cat >> tests/test_money.py <<'PY'


class HalfUpTest(unittest.TestCase):
    def test_half_up(self):
        self.assertEqual(percent_of(250, 5), 13)
PY
