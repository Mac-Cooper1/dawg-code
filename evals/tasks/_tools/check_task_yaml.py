#!/usr/bin/env python3
"""Check one task.yaml with basic line parsing (no YAML library).

Usage: check_task_yaml.py TASK_DIR
Prints one line per problem and exits 1 if there are any.

task.yaml files in this suite are kept deliberately simple:
  - top-level `key: value` pairs, no nesting except
  - `prompt: |` followed by an indented block, and
  - `tags: [a, b]` or `requires: [x]` as an inline flow list.
"""
import os
import re
import sys

REQUIRED = ("id", "title", "prompt", "tags")
KNOWN = set(REQUIRED) | {"timeout_seconds", "trials", "requires"}


def parse(text):
    fields = {}
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        if not line.strip() or line.lstrip().startswith("#"):
            i += 1
            continue
        m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$", line)
        if not m:
            raise ValueError(f"line {i + 1}: expected 'key: value', got {line!r}")
        key, rest = m.group(1), m.group(2).rstrip()
        if key in fields:
            raise ValueError(f"line {i + 1}: duplicate key {key!r}")
        if rest in ("|", "|-", ">", ">-"):
            block = []
            i += 1
            while i < len(lines) and (not lines[i].strip() or lines[i].startswith((" ", "\t"))):
                block.append(lines[i])
                i += 1
            indents = [len(b) - len(b.lstrip(" ")) for b in block if b.strip()]
            cut = min(indents) if indents else 0
            fields[key] = "\n".join(b[cut:] for b in block).strip("\n")
            continue
        if rest.startswith("["):
            if not rest.endswith("]"):
                raise ValueError(f"line {i + 1}: flow list for {key!r} must close on the same line")
            inner = rest[1:-1].strip()
            fields[key] = [t.strip().strip("'\"") for t in inner.split(",")] if inner else []
        else:
            fields[key] = rest.strip("'\"")
        i += 1
    return fields


def main():
    task_dir = os.path.abspath(sys.argv[1])
    name = os.path.basename(task_dir)
    problems = []
    path = os.path.join(task_dir, "task.yaml")
    try:
        with open(path, encoding="utf-8") as f:
            fields = parse(f.read())
    except (OSError, ValueError) as e:
        print(f"{name}: {e}")
        return 1
    for key in REQUIRED:
        if key not in fields or fields[key] in ("", []):
            problems.append(f"missing or empty field {key!r}")
    for key in fields:
        if key not in KNOWN:
            problems.append(f"unknown field {key!r}")
    if fields.get("id") != name:
        problems.append(f"id {fields.get('id')!r} does not match directory name {name!r}")
    if "id" in fields and not re.fullmatch(r"[a-z0-9]+(-[a-z0-9]+)*", str(fields["id"])):
        problems.append("id is not kebab-case")
    if "tags" in fields and not isinstance(fields["tags"], list):
        problems.append("tags must be a list")
    for key in ("timeout_seconds", "trials"):
        if key in fields and not re.fullmatch(r"[1-9][0-9]*", str(fields[key])):
            problems.append(f"{key} must be a positive integer")
    if "requires" in fields and not isinstance(fields["requires"], list):
        problems.append("requires must be a list")
    for required_path in ("fixture", "check.sh", "solution"):
        if not os.path.exists(os.path.join(task_dir, required_path)):
            problems.append(f"missing {required_path}")
    for p in problems:
        print(f"{name}: {p}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
