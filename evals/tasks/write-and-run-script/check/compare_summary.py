"""compare_summary.py ACTUAL_JSON EXPECTED_JSON: exit 0 if equal, else explain."""
import json
import sys

actual_path, expected_path = sys.argv[1], sys.argv[2]
try:
    with open(actual_path, encoding="utf-8") as f:
        actual = json.load(f)
except (OSError, ValueError) as e:
    sys.exit(f"cannot read {actual_path}: {e}")
with open(expected_path, encoding="utf-8") as f:
    expected = json.load(f)


def strict_equal(a, b):
    # bool is an int subclass in Python; don't let True stand in for 1.
    if isinstance(a, bool) or isinstance(b, bool):
        return type(a) is type(b) and a == b
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(strict_equal(a[k], b[k]) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(strict_equal(x, y) for x, y in zip(a, b))
    return a == b


if not isinstance(actual, dict):
    sys.exit(f"{actual_path}: expected a JSON object")
if actual.keys() != expected.keys():
    sys.exit(f"{actual_path}: keys {sorted(actual)} != expected {sorted(expected)}")
bad = [k for k in expected if not strict_equal(actual[k], expected[k])]
if bad:
    for k in bad:
        print(f"{actual_path}: {k}: got {json.dumps(actual[k])[:300]}, expected {json.dumps(expected[k])[:300]}")
    sys.exit(1)
