"""Command-line interface."""

import argparse
import json

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
    parser.add_argument(
        "--min-length",
        type=positive_int,
        default=1,
        metavar="N",
        help="ignore words shorter than N characters",
    )
    parser.add_argument("--json", action="store_true", help="print a JSON array of [word, count]")
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    counts = []
    for path in args.files:
        with open(path, encoding="utf-8") as f:
            counts.append(count_words(f.read()))
    merged = {w: n for w, n in merge(*counts).items() if len(w) >= args.min_length}
    result = top(merged, args.top)
    if args.json:
        print(json.dumps([[word, n] for word, n in result]))
    else:
        for word, n in result:
            print(f"{word}\t{n}")
    return 0
