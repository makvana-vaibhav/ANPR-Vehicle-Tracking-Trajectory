"""A camera's own login: sealed at onboarding, opened only where a stream is.

## Why a camera needs one

Most cameras a department hands over are an NVR channel or an IP camera that
refuses an anonymous RTSP `DESCRIBE`: `rtsp://admin:…@10.0.0.5/Streaming/
Channels/101`. The registry has always refused that URL, rightly — a password
in `cameras.stream_url` is a password in every backup, every `SELECT *`, and
every screenshot of a database console. But refusing it left nowhere to put the
credential, so a credentialed camera could only be onboarded through a relay
container that held the password for us.

## Where it lives

In `cameras.credentials_ref`, as an `enc://` pointer sealed with the platform's
key ring (`app/core/crypto.py`, AES-256-GCM) — the same machinery and the same
pointer discipline as `vms_instances.credentials_ref`. The ciphertext is bound
to the context ``camera-credentials``, so it cannot be copied into the VMS
column, or between rows, and opened there. Without a key ring nothing is
stored: `seal` raises `CredentialStoreUnavailable` and the API refuses the
request. It never falls back to plaintext.

## Where it is opened

Only where a stream is actually opened, and only for as long as that takes:

* `gateway.register` / `gateway.reconcile` hand MediaMTX the camera's URL with
  the login in it, because RTSP has nowhere else to put it. Browsers and AI
  workers then read the camera from our gateway, under their own identities,
  so neither ever holds the camera's password — it is not in the Redis roster.
* `RtspAdapter.probe_health` puts it in the ffprobe URL, and redacts it out of
  ffprobe's error line before that becomes a stored health detail.
* `OnvifAdapter` signs SOAP calls with it (WS-Security UsernameToken digest).

It is never returned by the API (`CameraOut.has_credentials` is a boolean),
never logged (`Credentials.__repr__` masks it; URLs are redacted), and never
written to the audit trail (the audit row records only *that* credentials were
set).
"""

from __future__ import annotations

from typing import Any

from app.core import crypto
from app.core.urls import with_credentials
from app.services.secrets import Credentials, resolve_credentials

#: AAD for every camera credential. Distinct from the VMS column's
#: ``vms-credentials``, so a token cannot be relocated between the two.
CAMERA_CREDENTIALS_CONTEXT = "camera-credentials"

#: The pointer scheme `seal` writes.
ENC_PREFIX = "enc://"


class CredentialStoreUnavailable(RuntimeError):
    """No key ring is configured, so a camera password cannot be stored."""


def store_available() -> bool:
    """Whether a camera password could be sealed right now."""
    try:
        return crypto.is_enabled()
    except crypto.EncryptionError:
        return False


def seal(username: str, password: str | None) -> str:
    """An `enc://` pointer holding ``username:password``, sealed for cameras.

    Raises `CredentialStoreUnavailable` rather than storing anything weaker:
    the caller turns that into a refusal the operator can act on.
    """
    if ":" in username:
        # The sealed form is `username:password`, split on the first colon,
        # and RTSP userinfo cannot carry an unescaped one either.
        raise ValueError("a camera username may not contain ':'")
    try:
        token = crypto.encrypt(f"{username}:{password or ''}", context=CAMERA_CREDENTIALS_CONTEXT)
    except crypto.EncryptionNotConfigured as exc:
        raise CredentialStoreUnavailable(
            "Camera credentials cannot be stored: no encryption key is configured "
            "(ENCRYPTION_KEYS). The platform will not keep a camera password in clear."
        ) from exc
    except crypto.EncryptionError as exc:
        raise CredentialStoreUnavailable(
            f"Camera credentials cannot be stored: the key ring is invalid ({exc})."
        ) from exc
    return f"{ENC_PREFIX}{token}"


def resolve(credentials_ref: str | None) -> Credentials | None:
    """The login a pointer names, or None. Never raises; see `secrets`."""
    if not credentials_ref:
        return None
    return resolve_credentials(credentials_ref, context=CAMERA_CREDENTIALS_CONTEXT)


def source_url(stream_url: str | None, credentials_ref: str | None) -> str | None:
    """The URL a stream is opened from: `stream_url` with the login put back.

    For the gateway's pull and the health probe only. An unresolvable pointer
    yields the bare URL, so the camera answers 401 and the probe says
    `unauthorized` — the truthful outcome — rather than the caller crashing.
    """
    if not stream_url:
        return stream_url
    login = resolve(credentials_ref)
    if login is None:
        return stream_url
    return with_credentials(stream_url, login.username, login.password)


def camera_source_url(camera: Any, url: str | None = None) -> str | None:
    """`source_url` for a camera row (or anything shaped like one)."""
    return source_url(
        url if url is not None else getattr(camera, "stream_url", None),
        getattr(camera, "credentials_ref", None),
    )


def camera_login(camera: Any) -> Credentials | None:
    """A camera's own login, for an adapter that signs requests (ONVIF)."""
    return resolve(getattr(camera, "credentials_ref", None))
