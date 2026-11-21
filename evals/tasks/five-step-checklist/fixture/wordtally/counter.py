"""Tokenising and counting."""

import re

_WORD = re.compile(r"[a-z0-9]+")


def tokenize(text):
    """Split text into lowercase words."""
    return _WORD.findall(text.lower())


def count_words(text):
    """Return a dict mapping each word to the number of times it occurs."""
    counts = {}
    for word in tokenize(text):
        counts[word] = counts.get(word, 0) + 1
    return counts


def merge(*count_dicts):
    total = {}
    for counts in count_dicts:
        for word, n in counts.items():
            total[word] = total.get(word, 0) + n
    return total


def top(counts, n):
    """The n most frequent (word, count) pairs; ties sorted alphabetically."""
    return sorted(counts.items(), key=lambda item: (-item[1], item[0]))[:n]
