#!/usr/bin/env python3
"""Generate the fixture file and the expected result for edit-with-awkward-whitespace.

The file is written byte by byte here so its whitespace is explicit:
  T  = tab, trailing spaces/tabs are spelled out with \\t and spaces in the strings.
Writes:
  edit-with-awkward-whitespace/fixture/src/settings.js
  edit-with-awkward-whitespace/check/expected_settings.js
  edit-with-awkward-whitespace/solution/src/settings.js  (same bytes as expected)
"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))
TASK = os.path.join(os.path.dirname(HERE), "edit-with-awkward-whitespace")

# Each entry: (original line, expected line or None to delete). No newline in the strings.
LINES = [
    ("// Settings for the sync daemon.  ", None),
    ("// Indented with tabs; alignment after a tab uses spaces.\t", None),
    ("// The release tooling diffs this file byte-for-byte: keep whitespace as is.", None),
    ("", None),
    ("export const network = {", None),
    ("\ttimeoutMs:      1500,  ", "\ttimeoutMs:      2500,  "),
    ("\tretries:        3,\t", None),
    ("\tbackoffMs:      [250, 500,  1000], ", None),
    ("\tidleLimitMs:    1500,", None),
    ("\t ", None),
    ("\tuserAgent: \"syncd/4\",", None),
    ("};", None),
    ("  ", None),
    ("export const formats = [", None),
    ("\t\"json\",", None),
    ("\t\"yaml\", ", None),
    ("\t\"legacy-xml\",\t\t", "DELETE"),
    ("\t\"toml\",  ", None),
    ("];", None),
    ("", None),
    ("export const theme = {", None),
    ("\tcolour:\t\"#1e1e1e\", ", "\tcolor:\t\"#1e1e1e\", "),
    ("\taccent: \t\"#ff9900\",", None),
    ("\t\t// fonts: first match wins   ", None),
    ("\tfont: `Iosevka,", None),
    ("\t\t  Menlo,  ", None),
    ("\t\t\tmonospace`,", None),
    ("};", None),
    ("\t", None),
    ("export function describe() {", None),
    ("\tconst bg = theme.colour;\t ", "\tconst bg = theme.color;\t "),
    ("\treturn `${network.timeoutMs}ms, ${formats.length} formats, bg ${bg}`; ", None),
    ("}", None),
    ("", None),
    ("export function supports(format) {", None),
    ("\t// case-insensitive: \"JSON\" and \"json\" are the same format", None),
    ("\treturn formats.includes(format.toLowerCase());\t", None),
    ("}", None),
]


def build(expected):
    out = []
    for original, change in LINES:
        if not expected or change is None:
            out.append(original)
        elif change == "DELETE":
            continue
        else:
            out.append(change)
    return "\n".join(out) + "\n"


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text)


def main():
    write(os.path.join(TASK, "fixture", "src", "settings.js"), build(False))
    write(os.path.join(TASK, "check", "expected_settings.js"), build(True))
    write(os.path.join(TASK, "solution", "src", "settings.js"), build(True))


if __name__ == "__main__":
    main()
