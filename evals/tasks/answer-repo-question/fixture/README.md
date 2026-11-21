# relay

relay delivers outgoing webhooks. Producers enqueue events; a worker POSTs each
one to the subscriber's URL, signs the body, retries failures with exponential
backoff and gives up on deliveries that cannot succeed.

    python3 -m relay.cli enqueue https://example.test/hook '{"event": "ping"}'
    python3 -m relay.cli work --once

Configuration is read from an INI file (see `relay/config.py` for every key and
its default). The path comes from `RELAY_CONFIG`, falling back to `relay.ini`
in the current directory.

Run the tests with `python3 -m unittest discover -s tests`.
