"""Delivery worker: send, classify the response, retry or give up."""

import json
import os
import time

from .backoff import delay_after
from .signing import signed_headers

# Client errors that are worth retrying; every other 4xx is final.
RETRYABLE_CLIENT_ERRORS = frozenset({408, 429})


def classify(status):
    """Return "ok", "retry" or "give_up" for an HTTP status (0 = network error)."""
    if 200 <= status < 300:
        return "ok"
    if status == 0 or status >= 500 or status in RETRYABLE_CLIENT_ERRORS:
        return "retry"
    return "give_up"


class Worker:
    def __init__(self, config, store, transport, sleep=time.sleep, clock=time.time):
        self.config = config
        self.store = store
        self.transport = transport
        self.sleep = sleep
        self.clock = clock

    def _secret(self):
        return os.environ.get(self.config.secret_env, "")

    def deliver(self, job):
        """Deliver one job. Returns True if it was delivered."""
        body = json.dumps(job["payload"], sort_keys=True).encode()
        attempt = 0
        while True:
            attempt += 1
            headers = signed_headers(self._secret(), int(self.clock()), body)
            status = self.transport.post(
                job["url"], body, headers, self.config.request_timeout_seconds
            )
            self.store.log_attempt(job["id"], attempt, status)
            outcome = classify(status)
            if outcome == "ok":
                return True
            if outcome == "give_up":
                self.store.bury(job, f"status {status}")
                return False
            if attempt >= self.config.max_attempts:
                self.store.bury(job, f"gave up after {attempt} attempts (last status {status})")
                return False
            self.sleep(
                delay_after(
                    attempt, self.config.backoff_base_seconds, self.config.backoff_cap_seconds
                )
            )

    def run_once(self):
        delivered = 0
        for job in self.store.take_all():
            delivered += self.deliver(job)
        return delivered
