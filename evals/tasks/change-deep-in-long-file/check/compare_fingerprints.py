"""compare_fingerprints.py EXPECTED_JSON < actual JSON: every card except Ember Tithe unchanged."""
import json
import sys

expected = json.load(open(sys.argv[1]))
actual = json.load(sys.stdin)
expected.pop("Ember Tithe", None)
actual.pop("Ember Tithe", None)
if set(actual) != set(expected):
    print("card set changed:", sorted(set(actual) ^ set(expected))[:10])
    sys.exit(1)
changed = [name for name in expected if actual[name] != expected[name]]
if changed:
    print("cards whose behaviour changed:", changed[:10])
    sys.exit(1)
