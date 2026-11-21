"""Request signing.

Subscribers verify that a webhook came from us by recomputing an HMAC of the
timestamp and body with the shared secret.
"""

import hashlib
import hmac

SIGNATURE_HEADER = "X-Relay-Signature"
TIMESTAMP_HEADER = "X-Relay-Timestamp"
SCHEME = "v1"
_DIGEST = hashlib.sha512


def sign(secret, timestamp, body):
    """Return the signature header value for `body` sent at `timestamp`."""
    message = f"{timestamp}.".encode() + body
    mac = hmac.new(secret.encode(), message, _DIGEST).hexdigest()
    return f"{SCHEME}={mac}"


def signed_headers(secret, timestamp, body):
    return {
        "Content-Type": "application/json",
        TIMESTAMP_HEADER: str(timestamp),
        SIGNATURE_HEADER: sign(secret, timestamp, body),
    }


def verify(secret, timestamp, body, header_value):
    return hmac.compare_digest(sign(secret, timestamp, body), header_value)
