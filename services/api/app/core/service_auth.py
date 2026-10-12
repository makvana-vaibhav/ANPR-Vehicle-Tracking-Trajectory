"""Short-lived tokens for one internal service calling another.

The API tells the simulator to start or stop replaying a camera's clip. That
control endpoint can put any footage behind any camera code — exactly what a
stranger on the network must not be able to do — so it is not left open the way
it was when only the person at the laptop could reach it.

A token here is ``<unix seconds>.<hex HMAC-SHA256>`` over ``purpose`` and that
timestamp, keyed by a key *derived* from `JWT_SECRET_KEY`. Both services already
load that secret from the same `.env`, so this adds no new secret to distribute,
and the derivation (an HMAC under a fixed label) keeps the signing key for
these tokens distinct from the one that signs user JWTs: a token from one
scheme is never valid in the other.

* **Bound to a purpose.** A token minted for ``simulator.control`` is refused
  for anything else.
* **Short-lived.** Valid for `MAX_AGE_S` either side of now, which tolerates
  clock skew between two containers on one host and makes a captured token
  useless within a minute.
* **Compared in constant time.**

It is not a user identity and is never accepted where a user token is.
"""

from __future__ import annotations

import hashlib
import hmac
import time

from app.core.config import settings

#: Header the caller sends it in.
HEADER = "X-Contrail-Service-Token"

#: How long a token stays valid, in either direction of the verifier's clock.
MAX_AGE_S = 60

#: Purpose for the simulator's start/stop endpoints.
SIMULATOR_CONTROL = "simulator.control"

_LABEL = b"contrail/service-token/v1"


def _key() -> bytes:
    return hmac.new(settings.jwt_secret_key.encode("utf-8"), _LABEL, hashlib.sha256).digest()


def _mac(purpose: str, issued: int) -> str:
    message = f"{purpose}:{issued}".encode()
    return hmac.new(_key(), message, hashlib.sha256).hexdigest()


def issue(purpose: str, *, now: float | None = None) -> str:
    """A token for `purpose`, valid for `MAX_AGE_S`."""
    issued = int(now if now is not None else time.time())
    return f"{issued}.{_mac(purpose, issued)}"


def verify(token: str | None, purpose: str, *, now: float | None = None) -> bool:
    """Whether `token` was issued for `purpose` within the last `MAX_AGE_S`."""
    if not token:
        return False
    issued_text, separator, mac = token.partition(".")
    if not separator or not issued_text.isdigit() or not mac:
        return False
    issued = int(issued_text)
    current = now if now is not None else time.time()
    if abs(current - issued) > MAX_AGE_S:
        return False
    return hmac.compare_digest(mac, _mac(purpose, issued))
