# wordtally

Count the most frequent words in text files.

    python3 -m wordtally [--top N] FILE [FILE ...]

Prints one `word<TAB>count` line per word, most frequent first; ties are
sorted alphabetically. Words are runs of letters and digits, compared
case-insensitively. `--top` defaults to 10.

Run the tests with `python3 -m unittest discover -s tests`.
