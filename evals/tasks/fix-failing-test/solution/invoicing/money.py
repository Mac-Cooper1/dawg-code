"""Money helpers. Every amount is an integer number of cents."""

import re

_AMOUNT = re.compile(r"^(\d+)(?:\.(\d{1,2}))?$")


def parse_amount(text):
    """Parse a decimal string such as "12.3" or "1999.99" into cents."""
    match = _AMOUNT.match(text.strip())
    if not match:
        raise ValueError(f"not an amount: {text!r}")
    whole, frac = match.groups()
    return int(whole) * 100 + int((frac or "0").ljust(2, "0"))


def format_cents(cents, currency="EUR"):
    """Format cents as "1,234.50 EUR"."""
    sign = "-" if cents < 0 else ""
    whole, frac = divmod(abs(cents), 100)
    return f"{sign}{whole:,}.{frac:02d} {currency}"


def percent_of(cents, percent):
    """Return `percent` % of `cents` in whole cents.

    Fractions of a cent are rounded to the nearest cent, with exact halves
    rounded up, as described in the README.
    """
    if percent < 0:
        raise ValueError("percent must not be negative")
    # Integer arithmetic: add half the divisor, then floor-divide (halves go up).
    return (cents * percent + 50) // 100


def split_evenly(cents, parts):
    """Split an amount into `parts` instalments that add up to the amount.

    Earlier instalments absorb the remainder, one cent each.
    """
    if parts < 1:
        raise ValueError("parts must be at least 1")
    base, remainder = divmod(cents, parts)
    return [base + 1 if i < remainder else base for i in range(parts)]
