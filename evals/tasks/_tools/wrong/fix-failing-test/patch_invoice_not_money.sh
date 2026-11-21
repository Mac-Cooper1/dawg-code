# Wrong place: special-case half-up rounding inside Invoice.discount only.
python3 - <<'PY'
p = "invoicing/invoice.py"
s = open(p).read()
old = "        return percent_of(self.subtotal(), self.discount_percent)\n"
new = "        return (self.subtotal() * self.discount_percent + 50) // 100\n"
assert old in s
open(p, "w").write(s.replace(old, new))
PY
