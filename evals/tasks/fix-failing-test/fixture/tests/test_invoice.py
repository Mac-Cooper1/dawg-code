import unittest

from invoicing import Invoice


class InvoiceTest(unittest.TestCase):
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
        # subtotal 4250, discount 212.5 -> 213, taxable 4037, tax 807.4 -> 807
        self.assertEqual(inv.subtotal(), 4250)
        self.assertEqual(inv.discount(), 213)
        self.assertEqual(inv.tax(), 807)
        self.assertEqual(inv.total(), 4844)

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
