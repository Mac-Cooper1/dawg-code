"""Hidden tests: the original visible tests plus extra rounding cases."""
import unittest

from invoicing import Invoice
from invoicing.money import format_cents, parse_amount, percent_of, split_evenly


class OriginalMoneyTests(unittest.TestCase):
    def test_parse(self):
        self.assertEqual(parse_amount("12.34"), 1234)
        self.assertEqual(parse_amount("12.3"), 1230)
        self.assertEqual(parse_amount("7"), 700)
        for bad in ["", "abc", "1.234", "-3.00", "1,00"]:
            with self.assertRaises(ValueError):
                parse_amount(bad)

    def test_format(self):
        self.assertEqual(format_cents(123456), "1,234.56 EUR")
        self.assertEqual(format_cents(5, "USD"), "0.05 USD")
        self.assertEqual(format_cents(-250), "-2.50 EUR")

    def test_percent_basics(self):
        self.assertEqual(percent_of(1000, 20), 200)
        self.assertEqual(percent_of(0, 15), 0)
        self.assertEqual(percent_of(1001, 10), 100)
        self.assertEqual(percent_of(1009, 10), 101)
        with self.assertRaises(ValueError):
            percent_of(100, -1)

    def test_split(self):
        self.assertEqual(split_evenly(1000, 3), [334, 333, 333])
        self.assertEqual(sum(split_evenly(1001, 7)), 1001)
        with self.assertRaises(ValueError):
            split_evenly(100, 0)


class HalfUpRoundingTests(unittest.TestCase):
    def test_halves_round_up(self):
        cases = [
            (250, 5, 13),     # 12.5
            (50, 5, 3),       # 2.5
            (10, 5, 1),       # 0.5
            (30, 5, 2),       # 1.5
            (1005, 10, 101),  # 100.5
            (4250, 5, 213),   # 212.5
            (999999990, 5, 49999999 + 1),  # 49999999.5
        ]
        for cents, pct, expected in cases:
            with self.subTest(cents=cents, pct=pct):
                self.assertEqual(percent_of(cents, pct), expected)

    def test_non_halves_unchanged(self):
        cases = [(8, 5, 0), (12, 5, 1), (18, 5, 1), (1234, 15, 185), (1, 49, 0), (1, 51, 1), (7, 100, 7)]
        for cents, pct, expected in cases:
            with self.subTest(cents=cents, pct=pct):
                self.assertEqual(percent_of(cents, pct), expected)

    def test_returns_int(self):
        self.assertIsInstance(percent_of(250, 5), int)
        self.assertIsInstance(percent_of(1000, 20), int)


class OriginalInvoiceTests(unittest.TestCase):
    def test_subtotal(self):
        inv = Invoice("Acme").add_line("Widget", 3, 1250).add_line("Bolt", 10, 15)
        self.assertEqual(inv.subtotal(), 3900)
        self.assertEqual(inv.total(), 3900)

    def test_tax_only(self):
        inv = Invoice("Acme", tax_percent=20).add_line("Widget", 2, 1000)
        self.assertEqual(inv.tax(), 400)
        self.assertEqual(inv.total(), 2400)

    def test_total_with_discount_and_tax(self):
        inv = Invoice("Acme", discount_percent=5, tax_percent=20)
        inv.add_line("Widget", 3, 1250).add_line("Gasket", 1, 500)
        self.assertEqual(inv.subtotal(), 4250)
        self.assertEqual(inv.discount(), 213)
        self.assertEqual(inv.tax(), 807)
        self.assertEqual(inv.total(), 4844)

    def test_other_half_cases(self):
        inv = Invoice("Beta", tax_percent=10).add_line("Cable", 1, 1005)
        self.assertEqual(inv.tax(), 101)
        self.assertEqual(inv.total(), 1106)
        inv = Invoice("Gamma", discount_percent=10, tax_percent=50).add_line("Plug", 3, 15)
        # subtotal 45, discount 4.5 -> 5, taxable 40, tax 20
        self.assertEqual(inv.discount(), 5)
        self.assertEqual(inv.total(), 60)

    def test_render(self):
        inv = Invoice("Acme", tax_percent=10).add_line("Widget", 1, 1000)
        self.assertEqual(
            inv.render(),
            "Invoice for Acme\n"
            "  1 x Widget: 10.00 EUR\n"
            "Subtotal: 10.00 EUR\n"
            "Tax (10%): 1.00 EUR\n"
            "Total: 11.00 EUR",
        )

    def test_rejects_bad_lines(self):
        with self.assertRaises(ValueError):
            Invoice("Acme").add_line("Nothing", 0, 100)
        with self.assertRaises(ValueError):
            Invoice("Acme").add_line("Refund", 1, -100)


if __name__ == "__main__":
    unittest.main()
