#!/usr/bin/env python3
"""Summarise an expenses CSV export as JSON.

Usage: python3 summarize.py INPUT_CSV OUTPUT_JSON
"""
import csv
import json
import os
import re
import sys

AMOUNT = re.compile(r"^(\d+)(?:\.(\d{1,2}))?$")


def to_cents(text):
    match = AMOUNT.match(text)
    if not match:
        return None
    whole, frac = match.groups()
    cents = int(whole) * 100 + int((frac or "0").ljust(2, "0"))
    return cents if cents > 0 else None


def summarize(path):
    summary = {
        "valid_rows": 0,
        "rejected_rows": 0,
        "total_cents": 0,
        "by_category": {},
        "by_month": {},
        "largest": None,
    }
    with open(path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            cents = to_cents(row["amount"])
            if cents is None:
                summary["rejected_rows"] += 1
                continue
            summary["valid_rows"] += 1
            summary["total_cents"] += cents
            category = row["category"].strip().lower()
            summary["by_category"][category] = summary["by_category"].get(category, 0) + cents
            month = row["date"][:7]
            summary["by_month"][month] = summary["by_month"].get(month, 0) + cents
            if summary["largest"] is None or cents > summary["largest"]["amount_cents"]:
                summary["largest"] = {"id": row["id"], "amount_cents": cents}
    return summary


def main():
    if len(sys.argv) != 3:
        sys.exit("usage: summarize.py INPUT_CSV OUTPUT_JSON")
    summary = summarize(sys.argv[1])
    out_dir = os.path.dirname(sys.argv[2])
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    with open(sys.argv[2], "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2, sort_keys=True)
        f.write("\n")


if __name__ == "__main__":
    main()
