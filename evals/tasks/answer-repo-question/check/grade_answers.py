"""grade_answers.py ANSWER_MD: check each question's Answer: line for the key fact.

Format expected (as stated in the prompt):
    ## Q1
    Answer: <short answer>
    <optional explanation...>

Tolerated: any heading level, "Q1", "Q1.", "Q 1", "Question 1", text after the
number on the heading line; "**Answer:**", "- Answer:", "> Answer:"; the answer
on the next non-empty line if the Answer: line is otherwise empty; backticks,
bold and case. Matching is done on the answer line only, so explanations below
it can mention other numbers freely.
"""
import re
import sys

# For each question: every `require` alternative-group must match; no `forbid` may.
# Each require entry is a list of alternatives (any one is enough).
RUBRIC = {
    1: {"require": [[r"\b6\b", r"\bsix\b"]], "forbid": [r"\b4\b", r"\bfour\b"]},
    2: {"require": [[r"\b80\b", r"\beighty\b", r"\b1\s*min(?:ute)?s?,?\s*(?:and\s*)?20\s*s"]], "forbid": [r"\b60\b", r"\b40\b", r"\b160\b"]},
    3: {"require": [[r"\bsha-?512\b"]], "forbid": [r"\bsha-?256\b", r"\bsha-?1\b", r"\bmd5\b", r"\bsha-?384\b"]},
    4: {"require": [[r"\b408\b"], [r"\b429\b"]], "forbid": []},
    5: {"require": [[r"\bdead_letters\.jsonl\b"]], "forbid": [r"\bdeliveries\.jsonl\b", r"\bqueue\.jsonl\b"]},
}

HEADING = re.compile(r"^\s{0,3}(?:#{1,6}\s*(?:\*\*)?|\*\*)\s*(?:q|question)\s*\.?\s*(\d+)\b", re.I)
ANSWER = re.compile(r"^[\s>*_\-+]*answer[\s*_]*[:：][\s*_]*(.*)$", re.I)


def clean(text):
    """Lowercase; drop backticks, asterisks and underscores used as emphasis
    (at word edges), keeping underscores inside names like dead_letters.jsonl."""
    text = re.sub(r"[`*]", "", text)
    text = re.sub(r"(?<![A-Za-z0-9])_+|_+(?![A-Za-z0-9])", " ", text)
    return text.strip().lower().replace("\u2010", "-")


def sections(text):
    found = {}
    current = None
    for line in text.splitlines():
        m = HEADING.match(line)
        if m:
            current = int(m.group(1))
            found.setdefault(current, [])
            continue
        if current is not None:
            found[current].append(line)
    return found


def answer_line(lines):
    for i, line in enumerate(lines):
        m = ANSWER.match(line)
        if not m:
            continue
        rest = clean(m.group(1))
        if rest:
            return rest
        for nxt in lines[i + 1 :]:
            if nxt.strip():
                return clean(nxt)
        return ""
    return None


def main():
    try:
        with open(sys.argv[1], encoding="utf-8") as f:
            text = f.read()
    except OSError as e:
        print(f"cannot read answer file: {e}")
        return 1
    secs = sections(text)
    failures = 0
    for q, rule in RUBRIC.items():
        if q not in secs:
            print(f"Q{q}: no section found")
            failures += 1
            continue
        ans = answer_line(secs[q])
        if ans is None:
            print(f"Q{q}: no 'Answer:' line")
            failures += 1
            continue
        missing = [alts for alts in rule["require"] if not any(re.search(a, ans) for a in alts)]
        forbidden = [f for f in rule["forbid"] if re.search(f, ans)]
        if missing or forbidden:
            print(f"Q{q}: answer {ans!r} missing={missing} forbidden={forbidden}")
            failures += 1
        else:
            print(f"Q{q}: ok")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
