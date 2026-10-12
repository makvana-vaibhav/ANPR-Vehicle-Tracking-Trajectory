"""URL handling that has to be right about credentials.

RTSP puts its username and password in the URL — the protocol offers nowhere
else — so any code that logs, stores or returns a stream URL is a place a
password can escape. The AI worker has its own copy of this for the same
reason; it is duplicated rather than shared because the worker's image
deliberately carries no part of the API (CLAUDE.md §9 note 3), and coupling
them to save nine lines would undo that.

The registry never stores a URL with credentials in it. A pasted
`rtsp://user:pass@host/path` is split at the edge (`split_credentials`), the
password is sealed into the camera's `credentials_ref`, and the two are put back
together (`with_credentials`) only at the moment a stream is opened: the
gateway's pull and the health probe. Anything printed on the way is passed
through `redact` or `redact_text`.
"""

from __future__ import annotations

import re
from urllib.parse import quote, unquote, urlparse, urlunparse

#: Schemes whose URLs carry `user:password@` and are worth splitting or
#: re-assembling. Anything else is left exactly as given.
CREDENTIAL_SCHEMES = frozenset({"rtsp", "rtsps", "rtmp", "rtmps", "http", "https"})

#: `user:password@` (or `user@`) right after a scheme, anywhere in free text —
#: an ffprobe error line, an exception message. The password part stops at the
#: last `@` before the host, so a password containing `@` is still masked.
_USERINFO_IN_TEXT = re.compile(r"(?P<scheme>[a-zA-Z][a-zA-Z0-9+.-]*://)(?P<userinfo>[^\s/?#]*@)")


def redact(url: str | None) -> str | None:
    """A URL safe to log or return to a client.

    The host and path survive, because an operator diagnosing a camera needs
    to see which host and which stream. Only the password is replaced.
    """
    if not url:
        return url
    parsed = urlparse(url)
    if not parsed.password:
        return url
    netloc = f"{parsed.username or ''}:***@{parsed.hostname}"
    if parsed.port:
        netloc += f":{parsed.port}"
    return urlunparse(parsed._replace(netloc=netloc))


def redact_text(text: str | None) -> str | None:
    """Free text with every `scheme://user:password@` masked.

    For strings that merely *contain* a URL: ffprobe ends its error output
    with the URL it was given, credentials included, and that line becomes a
    health probe's `detail` — which is stored, logged and shown on the fleet
    screen.
    """
    if not text:
        return text
    return _USERINFO_IN_TEXT.sub(lambda m: f"{m.group('scheme')}***@", text)


def split_credentials(url: str | None) -> tuple[str | None, str | None, str | None]:
    """`(url without credentials, username, password)` for a pasted URL.

    Username and password come back percent-decoded, as the camera expects
    them; the URL keeps its host, port, path and query exactly as typed. A URL
    with no credentials, or one in a scheme we do not split, is returned
    unchanged with `(None, None)`.
    """
    if not url:
        return url, None, None
    parsed = urlparse(url)
    if parsed.scheme.lower() not in CREDENTIAL_SCHEMES or "@" not in parsed.netloc:
        return url, None, None
    userinfo, _, hostport = parsed.netloc.rpartition("@")
    raw_user, separator, raw_password = userinfo.partition(":")
    username = unquote(raw_user)
    password = unquote(raw_password) if separator else None
    clean = urlunparse(parsed._replace(netloc=hostport))
    return clean, (username or None), password


def with_credentials(url: str, username: str | None, password: str | None) -> str:
    """`url` carrying `username:password@`, percent-encoded.

    Only for the moment a stream is opened — the gateway's pull, a probe — and
    never for anything stored, logged or returned. A URL that already carries
    credentials, or has none to add, is returned unchanged.
    """
    if not url or not username:
        return url
    parsed = urlparse(url)
    if parsed.scheme.lower() not in CREDENTIAL_SCHEMES or "@" in parsed.netloc:
        return url
    userinfo = quote(username, safe="")
    if password:
        userinfo += ":" + quote(password, safe="")
    return urlunparse(parsed._replace(netloc=f"{userinfo}@{parsed.netloc}"))
