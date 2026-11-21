"""Invoice model: lines, discount, tax and a plain-text rendering."""

from dataclasses import dataclass

from .money import format_cents, percent_of


@dataclass(frozen=True)
class Line:
    description: str
    quantity: int
    unit_price: int  # cents

    @property
    def amount(self):
        return self.quantity * self.unit_price


class Invoice:
    """An invoice for one customer.

    The discount applies to the subtotal; tax applies to the discounted amount.
    """

    def __init__(self, customer, discount_percent=0, tax_percent=0, currency="EUR"):
        self.customer = customer
        self.discount_percent = discount_percent
        self.tax_percent = tax_percent
        self.currency = currency
        self.lines = []

    def add_line(self, description, quantity, unit_price):
        if quantity <= 0:
            raise ValueError("quantity must be positive")
        if unit_price < 0:
            raise ValueError("unit price must not be negative")
        self.lines.append(Line(description, quantity, unit_price))
        return self

    def subtotal(self):
        return sum(line.amount for line in self.lines)

    def discount(self):
        return percent_of(self.subtotal(), self.discount_percent)

    def tax(self):
        return percent_of(self.subtotal() - self.discount(), self.tax_percent)

    def total(self):
        return self.subtotal() - self.discount() + self.tax()

    def render(self):
        out = [f"Invoice for {self.customer}"]
        for line in self.lines:
            out.append(
                f"  {line.quantity} x {line.description}: {format_cents(line.amount, self.currency)}"
            )
        out.append(f"Subtotal: {format_cents(self.subtotal(), self.currency)}")
        if self.discount_percent:
            out.append(
                f"Discount ({self.discount_percent}%): -{format_cents(self.discount(), self.currency)}"
            )
        if self.tax_percent:
            out.append(f"Tax ({self.tax_percent}%): {format_cents(self.tax(), self.currency)}")
        out.append(f"Total: {format_cents(self.total(), self.currency)}")
        return "\n".join(out)
