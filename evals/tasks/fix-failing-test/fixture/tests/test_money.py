import unittest

from invoicing.money import format_cents, parse_amount, percent_of, split_evenly


class ParseAmountTest(unittest.TestCase):
    def test_whole_and_fraction(self):
        self.assertEqual(parse_amount("12.34"), 1234)
        self.assertEqual(parse_amount("12.3"), 1230)
        self.assertEqual(parse_amount("7"), 700)

    def test_rejects_garbage(self):
        for bad in ["", "abc", "1.234", "-3.00", "1,00"]:
            with self.assertRaises(ValueError):
                parse_amount(bad)


class FormatCentsTest(unittest.TestCase):
    def test_format(self):
        self.assertEqual(format_cents(123456), "1,234.56 EUR")
        self.assertEqual(format_cents(5, "USD"), "0.05 USD")
        self.assertEqual(format_cents(-250), "-2.50 EUR")


class PercentOfTest(unittest.TestCase):
    def test_exact(self):
        self.assertEqual(percent_of(1000, 20), 200)
        self.assertEqual(percent_of(0, 15), 0)

    def test_rounds_to_nearest(self):
        self.assertEqual(percent_of(1001, 10), 100)  # 100.1
        self.assertEqual(percent_of(1009, 10), 101)  # 100.9

    def test_negative_percent_rejected(self):
        with self.assertRaises(ValueError):
            percent_of(100, -1)


class SplitEvenlyTest(unittest.TestCase):
    def test_split_adds_up(self):
        self.assertEqual(split_evenly(1000, 3), [334, 333, 333])
        self.assertEqual(sum(split_evenly(1001, 7)), 1001)

    def test_bad_parts(self):
        with self.assertRaises(ValueError):
            split_evenly(100, 0)


if __name__ == "__main__":
    unittest.main()
