"""Command-line interface."""

import argparse

from . import __version__
from .counter import count_words, merge, top


def positive_int(text):
    value = int(text)
    if value < 1:
        raise argparse.ArgumentTypeError("must be at least 1")
    return value


def build_parser():
    parser = argparse.ArgumentParser(
        prog="wordtally", description=f"Count the most frequent words (v{__version__})."
    )
    parser.add_argument("files", nargs="+", metavar="FILE")
    parser.add_argument("--top", type=positive_int, default=10, help="how many words to show")
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    counts = []
    for path in args.files:
        with open(path, encoding="utf-8") as f:
            counts.append(count_words(f.read()))
    for word, n in top(merge(*counts), args.top):
        print(f"{word}\t{n}")
    return 0
