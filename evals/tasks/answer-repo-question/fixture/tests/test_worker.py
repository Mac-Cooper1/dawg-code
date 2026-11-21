import tempfile
import unittest

from relay.config import Config
from relay.store import Store
from relay.worker import Worker, classify


class FakeTransport:
    def __init__(self, statuses):
        self.statuses = list(statuses)
        self.calls = 0

    def post(self, url, body, headers, timeout):
        self.calls += 1
        return self.statuses.pop(0)


class WorkerTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.store = Store(self.dir.name)
        self.sleeps = []

    def tearDown(self):
        self.dir.cleanup()

    def worker(self, statuses, **overrides):
        config = Config(**overrides)
        self.transport = FakeTransport(statuses)
        return Worker(config, self.store, self.transport, sleep=self.sleeps.append, clock=lambda: 1000)

    def job(self):
        return {"id": "j1", "url": "https://example.test/hook", "payload": {"a": 1}}

    def test_success_first_time(self):
        self.assertTrue(self.worker([200]).deliver(self.job()))
        self.assertEqual(self.sleeps, [])

    def test_retries_then_succeeds(self):
        self.assertTrue(self.worker([503, 0, 204], backoff_base_seconds=10).deliver(self.job()))
        self.assertEqual(self.sleeps, [10, 20])

    def test_gives_up_on_client_error(self):
        self.assertFalse(self.worker([404]).deliver(self.job()))
        self.assertEqual(self.transport.calls, 1)

    def test_classify(self):
        self.assertEqual(classify(201), "ok")
        self.assertEqual(classify(500), "retry")
        self.assertEqual(classify(400), "give_up")


if __name__ == "__main__":
    unittest.main()
