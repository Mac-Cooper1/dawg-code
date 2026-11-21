"""compare_json.py ACTUAL EXPECTED: structural equality, floats within 1e-9 relative."""
import json
import math
import sys


def same(a, b, path="$"):
    if isinstance(a, bool) or isinstance(b, bool):
        return [] if a is b else [f"{path}: {a!r} != {b!r}"]
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return [] if math.isclose(a, b, rel_tol=1e-9, abs_tol=1e-12) else [f"{path}: {a!r} != {b!r}"]
    if isinstance(a, dict) and isinstance(b, dict):
        if a.keys() != b.keys():
            return [f"{path}: keys {sorted(a)} != {sorted(b)}"]
        return [e for k in a for e in same(a[k], b[k], f"{path}.{k}")]
    if isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            return [f"{path}: length {len(a)} != {len(b)}"]
        return [e for i, (x, y) in enumerate(zip(a, b)) for e in same(x, y, f"{path}[{i}]")]
    return [] if a == b else [f"{path}: {a!r} != {b!r}"]


try:
    with open(sys.argv[1], encoding="utf-8") as f:
        actual = json.load(f)
except (OSError, ValueError) as e:
    sys.exit(f"cannot read {sys.argv[1]}: {e}")
with open(sys.argv[2], encoding="utf-8") as f:
    expected = json.load(f)
errors = same(actual, expected)
for e in errors[:20]:
    print(e)
sys.exit(1 if errors else 0)
