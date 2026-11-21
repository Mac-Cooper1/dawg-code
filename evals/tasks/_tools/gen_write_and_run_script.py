#!/usr/bin/env python3
"""Generate the data for the write-and-run-script task.

Writes:
  write-and-run-script/fixture/data/expenses.csv       (given to the agent)
  write-and-run-script/check/hidden_expenses.csv        (second dataset, checker only)
  write-and-run-script/check/expected_summary.json      (for the fixture data)
  write-and-run-script/check/expected_hidden_summary.json

Expected summaries are computed here from the generator's own record of what
it wrote, not by parsing the CSV, so they are independent of the reference
solution. Deterministic: fixed seeds, no clock.
"""
import csv
import io
import json
import os
import random

HERE = os.path.dirname(os.path.abspath(__file__))
TASK = os.path.join(os.path.dirname(HERE), "write-and-run-script")

CATEGORIES = ["Travel", "Meals", "Software", "Hardware", "Office", "Training"]
SPELLINGS = {
    "Travel": ["Travel", "travel", " Travel", "TRAVEL "],
    "Meals": ["Meals", "meals", "Meals  "],
    "Software": ["Software", "software", " SOFTWARE"],
    "Hardware": ["Hardware", "hardware"],
    "Office": ["Office", "office ", " Office"],
    "Training": ["Training", "TRAINING"],
}
DESCRIPTIONS = [
    "Taxi, airport to hotel",
    "Team lunch",
    'Book: "Refactoring notes"',
    "Licence renewal",
    "USB-C dock",
    "Printer paper, toner",
    "Conference ticket",
    "Train ticket",
    "Monitor arm",
    "Coffee for workshop",
    "Hotel, 2 nights",
    "Cloud credits",
]
INVALID_AMOUNTS = ["", "n/a", "-12.00", "12.345", "1,200.00", "€5.00", "0", "0.00", "TBD", "3.5.1", "-0.50", "$40"]


def fmt_amount(cents, rng):
    whole, frac = divmod(cents, 100)
    if frac == 0 and rng.random() < 0.5:
        return str(whole)
    if frac % 10 == 0 and rng.random() < 0.5:
        return f"{whole}.{frac // 10}"
    return f"{whole}.{frac:02d}"


def generate(seed, n_rows, year_months, tie_largest):
    rng = random.Random(seed)
    rows = []
    expected = {
        "valid_rows": 0,
        "rejected_rows": 0,
        "total_cents": 0,
        "by_category": {},
        "by_month": {},
        "largest": None,
    }
    largest_cents = -1
    for i in range(n_rows):
        row_id = f"EX-{seed % 100:02d}{i + 1:04d}"
        ym = rng.choice(year_months)
        date = f"{ym}-{rng.randint(1, 28):02d}"
        cat = rng.choice(CATEGORIES)
        spelling = rng.choice(SPELLINGS[cat])
        desc = rng.choice(DESCRIPTIONS)
        if rng.random() < 0.12:
            amount = rng.choice(INVALID_AMOUNTS)
            expected["rejected_rows"] += 1
        else:
            cents = rng.choice([rng.randint(1, 9999), rng.randint(100, 60000), rng.randint(1, 300) * 100])
            amount = fmt_amount(cents, rng)
            expected["valid_rows"] += 1
            expected["total_cents"] += cents
            key = cat.lower()
            expected["by_category"][key] = expected["by_category"].get(key, 0) + cents
            expected["by_month"][ym] = expected["by_month"].get(ym, 0) + cents
            if cents > largest_cents:
                largest_cents = cents
                expected["largest"] = {"id": row_id, "amount_cents": cents}
        rows.append([row_id, date, desc, spelling, amount])

    if tie_largest:
        # Insert a later row that ties the largest amount: the earlier one must win.
        row_id = f"EX-{seed % 100:02d}{n_rows + 1:04d}"
        ym = year_months[-1]
        cents = largest_cents
        rows.append([row_id, f"{ym}-15", "Duplicate quote, same price", "Hardware", f"{cents // 100}.{cents % 100:02d}"])
        expected["valid_rows"] += 1
        expected["total_cents"] += cents
        expected["by_category"]["hardware"] = expected["by_category"].get("hardware", 0) + cents
        expected["by_month"][ym] = expected["by_month"].get(ym, 0) + cents

    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\n")
    writer.writerow(["id", "date", "description", "category", "amount"])
    writer.writerows(rows)
    return buf.getvalue(), expected


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text)


def main():
    visible, visible_expected = generate(
        seed=4107, n_rows=240, year_months=["2026-07", "2026-08", "2026-09", "2026-10"], tie_largest=False
    )
    hidden, hidden_expected = generate(
        seed=5523, n_rows=180, year_months=["2025-11", "2025-12", "2026-01"], tie_largest=True
    )
    write(os.path.join(TASK, "fixture", "data", "expenses.csv"), visible)
    write(os.path.join(TASK, "check", "hidden_expenses.csv"), hidden)
    for name, exp in [("expected_summary.json", visible_expected), ("expected_hidden_summary.json", hidden_expected)]:
        write(os.path.join(TASK, "check", name), json.dumps(exp, indent=2, sort_keys=True) + "\n")
    print("rows:", visible.count("\n") - 1, hidden.count("\n") - 1)
    print("visible rejected:", visible_expected["rejected_rows"], "hidden rejected:", hidden_expected["rejected_rows"])


if __name__ == "__main__":
    main()
