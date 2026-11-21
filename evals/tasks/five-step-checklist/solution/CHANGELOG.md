# Changelog

## 1.4.0

- Words with an apostrophe inside ("don't", "o'clock") count as one word.
- New `--min-length N` option ignores words shorter than N characters.
- New `--json` flag prints the result as a JSON array of `[word, count]` pairs.

## 1.3.0

- Read several files in one run and count them together.
- `--top` now rejects values below 1.

## 1.2.0

- Ties are sorted alphabetically, so output is stable.

## 1.1.0

- Added `--top`.
