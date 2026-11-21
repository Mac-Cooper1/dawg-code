"""diff_in_span.py SPAN_JSON < git diff -U0 output for cardgame/cards.py

Exit 0 if every changed line of cards.py is inside the Ember Tithe class
(with two lines of slack either side), else list the hunks that are not.
"""
import json
import re
import sys

span = json.load(open(sys.argv[1]))
lo, hi = span["start"] - 2, span["end"] + 2
outside = []
hunks = 0
for line in sys.stdin:
    m = re.match(r"^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@", line)
    if not m:
        continue
    hunks += 1
    start = int(m.group(1))
    count = 1 if m.group(2) is None else int(m.group(2))
    first, last = (start, start) if count == 0 else (start, start + count - 1)
    if first < lo or last > hi:
        outside.append(line.strip())
if outside:
    print(f"changes outside Ember Tithe (lines {span['start']}-{span['end']}):")
    for h in outside[:10]:
        print("  " + h)
    sys.exit(1)
if hunks == 0:
    print("cards.py was not changed")
    sys.exit(1)
