"""Persistence: the pending queue, the delivery log and dead letters.

Everything is JSON lines under the configured data directory.
"""

import json
import os

QUEUE_FILE = "queue.jsonl"
LOG_FILE = "deliveries.jsonl"
DEAD_LETTER_FILE = "dead_letters.jsonl"


class Store:
    def __init__(self, data_dir):
        self.data_dir = data_dir
        os.makedirs(data_dir, exist_ok=True)

    def _path(self, name):
        return os.path.join(self.data_dir, name)

    def _append(self, name, record):
        with open(self._path(name), "a", encoding="utf-8") as f:
            f.write(json.dumps(record, sort_keys=True) + "\n")

    def enqueue(self, job):
        self._append(QUEUE_FILE, job)

    def take_all(self):
        path = self._path(QUEUE_FILE)
        if not os.path.exists(path):
            return []
        with open(path, encoding="utf-8") as f:
            jobs = [json.loads(line) for line in f if line.strip()]
        os.remove(path)
        return jobs

    def log_attempt(self, job_id, attempt, status):
        """Every attempt, successful or not, is recorded in the delivery log."""
        self._append(LOG_FILE, {"job": job_id, "attempt": attempt, "status": status})

    def bury(self, job, reason):
        """Keep a job we have given up on, with the reason, for manual replay."""
        self._append(DEAD_LETTER_FILE, {**job, "reason": reason})
