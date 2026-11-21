# relay: answers

## Q1
Answer: 6

`relay.ini` sets `max_attempts = 6` (the code default in `relay/config.py` is
4). `Worker.deliver` counts the first attempt and buries the job once
`attempt >= max_attempts`.

## Q2
Answer: 80 seconds

`delay_after(3, base=20, cap=900)` = 20 * 2^(3-1) = 80; the cap of 900 does not
apply.

## Q3
Answer: SHA-512

`relay/signing.py` uses `hmac.new(..., hashlib.sha512)`.

## Q4
Answer: 408 and 429

`RETRYABLE_CLIENT_ERRORS` in `relay/worker.py`; any other 4xx is buried at once.

## Q5
Answer: `dead_letters.jsonl`

Written by `Store.bury` into the data directory (`var/relay` with the shipped
config). Every attempt is also logged to `deliveries.jsonl`, but that is the
delivery log, not where given-up jobs go.
