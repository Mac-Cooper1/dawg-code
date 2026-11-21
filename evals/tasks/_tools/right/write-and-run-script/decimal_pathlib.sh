# Alternative script: Decimal parsing, pathlib, compact JSON, run from a subdirectory.
cat > summarize.py <<'PY'
import csv, json, re, sys
from decimal import Decimal
from pathlib import Path

def main(src, dst):
    out = {"valid_rows": 0, "rejected_rows": 0, "total_cents": 0, "by_category": {}, "by_month": {}, "largest": None}
    with open(src, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            amount = row["amount"]
            if not re.fullmatch(r"[0-9]+(\.[0-9]{1,2})?", amount) or Decimal(amount) == 0:
                out["rejected_rows"] += 1
                continue
            cents = int(Decimal(amount) * 100)
            out["valid_rows"] += 1
            out["total_cents"] += cents
            cat = row["category"].strip().lower()
            out["by_category"][cat] = out["by_category"].get(cat, 0) + cents
            out["by_month"][row["date"][:7]] = out["by_month"].get(row["date"][:7], 0) + cents
            if out["largest"] is None or cents > out["largest"]["amount_cents"]:
                out["largest"] = {"id": row["id"], "amount_cents": cents}
    Path(dst).parent.mkdir(parents=True, exist_ok=True)
    Path(dst).write_text(json.dumps(out))

main(sys.argv[1], sys.argv[2])
PY
mkdir -p reports && cd reports && python3 ../summarize.py ../data/expenses.csv summary.json
