"""422 responses that never echo a secret back.

FastAPI's default answer to an invalid body lists each error with its
``input`` — and for an error raised by a model-level validator that input is the
**whole request body**. A camera onboarding refused for coordinates outside
Gujarat would therefore come back carrying `stream_password` in clear, and a
pasted `rtsp://admin:…@` URL refused for another reason would come back with
the password inside it. That response lands in browser devtools, HAR files
attached to bug reports, and any proxy that logs response bodies.

This handler returns the same shape with secrets masked: values under a
secret-named key become ``"***"``, and `user:password@` inside any string is
redacted. The error messages themselves are ours and never contain a secret.
"""

from __future__ import annotations

from typing import Any

from fastapi import Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from app.core.urls import redact_text

#: Keys whose values are never echoed, wherever they appear in an input.
SECRET_KEYS = frozenset(
    {
        "password",
        "stream_password",
        "new_password",
        "current_password",
        "secret",
        "token",
        "refresh_token",
        "access_token",
    }
)

MASK = "***"


def scrub(value: Any, key: str | None = None) -> Any:
    """`value` with secrets masked, recursively."""
    if key is not None and key.lower() in SECRET_KEYS:
        return MASK if value not in (None, "") else value
    if isinstance(value, dict):
        return {k: scrub(v, str(k)) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [scrub(item) for item in value]
    if isinstance(value, str):
        return redact_text(value)
    return value


def scrub_errors(errors: Any) -> list[dict[str, Any]]:
    """Validation errors as FastAPI returns them, with every input scrubbed."""
    cleaned: list[dict[str, Any]] = []
    for error in errors:
        item = dict(error)
        location = item.get("loc") or ()
        field = str(location[-1]) if location else None
        if "input" in item:
            item["input"] = scrub(item["input"], field)
        # Pydantic's `ctx` can carry the offending value too.
        if "ctx" in item:
            item["ctx"] = scrub(item["ctx"])
        cleaned.append(item)
    return cleaned


async def validation_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """FastAPI's 422, scrubbed. Registered in app/main.py."""
    errors = exc.errors() if isinstance(exc, RequestValidationError) else []
    return JSONResponse(
        status_code=422,
        content=jsonable_encoder({"detail": scrub_errors(errors)}),
    )
