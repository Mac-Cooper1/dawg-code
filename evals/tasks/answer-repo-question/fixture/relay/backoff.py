"""Retry timing."""


def delay_after(failed_attempts, base_seconds, cap_seconds):
    """Seconds to wait before the next attempt, given how many attempts have failed.

    The wait doubles after every failure, starting at `base_seconds` after the
    first failure, and never exceeds `cap_seconds`.
    """
    if failed_attempts < 1:
        raise ValueError("failed_attempts must be at least 1")
    return min(cap_seconds, base_seconds * 2 ** (failed_attempts - 1))
