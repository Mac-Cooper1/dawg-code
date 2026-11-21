"""Configuration loading.

Every setting has a default here; an INI file can override any of them.
"""

import configparser
import os
from dataclasses import dataclass

DEFAULT_PATH = "relay.ini"


@dataclass(frozen=True)
class Config:
    max_attempts: int = 4
    backoff_base_seconds: int = 15
    backoff_cap_seconds: int = 600
    request_timeout_seconds: int = 5
    secret_env: str = "RELAY_SECRET"
    data_dir: str = "data"


def load_config(path=None):
    """Load settings from `path`, $RELAY_CONFIG or relay.ini, over the defaults.

    A missing file is not an error: the defaults are used.
    """
    path = path or os.environ.get("RELAY_CONFIG") or DEFAULT_PATH
    parser = configparser.ConfigParser()
    parser.read(path)
    defaults = Config()
    delivery = parser["delivery"] if parser.has_section("delivery") else {}
    signing = parser["signing"] if parser.has_section("signing") else {}
    storage = parser["storage"] if parser.has_section("storage") else {}
    return Config(
        max_attempts=int(delivery.get("max_attempts", defaults.max_attempts)),
        backoff_base_seconds=int(delivery.get("backoff_base_seconds", defaults.backoff_base_seconds)),
        backoff_cap_seconds=int(delivery.get("backoff_cap_seconds", defaults.backoff_cap_seconds)),
        request_timeout_seconds=int(
            delivery.get("request_timeout_seconds", defaults.request_timeout_seconds)
        ),
        secret_env=signing.get("secret_env", defaults.secret_env),
        data_dir=storage.get("data_dir", defaults.data_dir),
    )
