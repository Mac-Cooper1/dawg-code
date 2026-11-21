#!/usr/bin/env python3
"""replace.py FILE OLD NEW [COUNT]: literal replace; fail if OLD is absent.

Used by wrong-solution spot checks so they are portable (no sed -i flavours).
"""
import sys

path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
count = int(sys.argv[4]) if len(sys.argv) > 4 else -1
with open(path, encoding="utf-8", newline="") as f:
    text = f.read()
if old not in text:
    sys.exit(f"replace.py: {old!r} not found in {path}")
with open(path, "w", encoding="utf-8", newline="") as f:
    f.write(text.replace(old, new, count))
