# invoicing

Small helpers for building customer invoices. All amounts are integer cents;
percentages are whole numbers (5 means 5 %).

Rounding rule (agreed with accounting): whenever a percentage of an amount
produces a fraction of a cent, round to the nearest cent, and round exact
halves up (12.5 -> 13).

Run the tests with:

    python3 -m unittest discover -s tests
