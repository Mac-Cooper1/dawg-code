"""HTTP transport. Kept tiny so tests can swap in a fake."""

import urllib.error
import urllib.request


class UrllibTransport:
    def post(self, url, body, headers, timeout):
        """POST and return the HTTP status code (0 for network errors)."""
        request = urllib.request.Request(url, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.status
        except urllib.error.HTTPError as err:
            return err.code
        except (urllib.error.URLError, TimeoutError, OSError):
            return 0
