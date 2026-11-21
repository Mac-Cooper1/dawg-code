# wordtally

Count the most frequent words in text files.

    python3 -m wordtally [--top N] [--min-length N] [--json] FILE [FILE ...]

Prints one `word<TAB>count` line per word, most frequent first; ties are
sorted alphabetically. Words are runs of letters and digits, compared
case-insensitively; an apostrophe inside a word ("don't") is part of it.
`--top` defaults to 10. `--min-length N` ignores words shorter than N
characters. `--json` prints a JSON array of `[word, count]` pairs instead.

Run the tests with `python3 -m unittest discover -s tests`.
