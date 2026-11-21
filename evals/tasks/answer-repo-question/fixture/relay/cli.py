"""Command line: enqueue events and run the worker."""

import argparse
import json
import sys
import uuid

from .config import load_config
from .store import Store
from .transport import UrllibTransport
from .worker import Worker


def main(argv=None):
    parser = argparse.ArgumentParser(prog="relay")
    sub = parser.add_subparsers(dest="command", required=True)
    enqueue = sub.add_parser("enqueue", help="queue an event for delivery")
    enqueue.add_argument("url")
    enqueue.add_argument("payload", help="JSON payload")
    work = sub.add_parser("work", help="deliver queued events")
    work.add_argument("--once", action="store_true", help="drain the queue once and exit")
    args = parser.parse_args(argv)

    config = load_config()
    store = Store(config.data_dir)
    if args.command == "enqueue":
        store.enqueue({"id": uuid.uuid4().hex, "url": args.url, "payload": json.loads(args.payload)})
        return 0
    worker = Worker(config, store, UrllibTransport())
    while True:
        delivered = worker.run_once()
        print(f"delivered {delivered}")
        if args.once:
            return 0


if __name__ == "__main__":
    sys.exit(main())
