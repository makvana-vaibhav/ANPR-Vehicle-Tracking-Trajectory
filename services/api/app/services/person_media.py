"""The private persons bucket: reference photos and matched face crops.

Plate crops live in `MINIO_BUCKET` (private too since 12 Oct — it used to allow
anonymous download, and every crop is reached through a presigned URL anyway).
Faces do not go there. They go in `MINIO_PERSONS_BUCKET`, which:

* is created by the platform **without any access policy** — MinIO's default,
  which is private — and is checked on first use: if somebody has since given
  it a policy, the platform refuses to store faces in it rather than publish
  them (`ensure_bucket`);
* is read only through **short-lived signed URLs** (two minutes) issued by the
  audited `person.read` endpoints. A link is the capability, it is logged when
  it is issued, and it is stale before it can usefully be forwarded;
* holds only two kinds of object: `persons/<entry>/reference-*.jpg`, the
  enrolled photo re-encoded from pixels (no EXIF), and
  `faces/YYYY/MM/DD/<camera>/<random>.jpg`, the crop of a face that a camera
  matched — uploaded from the edge by the AI worker, never for a face that
  matched nothing.

Retention deletes both on schedule (`app/services/persons.py::PersonSweeper`).
"""

from __future__ import annotations

import functools
import uuid
from typing import Any

import aioboto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError
from botocore.session import get_session

from app.core import public_origin
from app.core.config import settings
from app.core.logging import get_logger

log = get_logger("api.person_media")

#: How long a signed link to a face stays valid. Shorter than a plate crop's:
#: long enough to render the screen, short enough that a copied link is dead
#: before it is somewhere it should not be.
URL_TTL_SECONDS = 120

_SIGNING = Config(signature_version="s3v4", retries={"max_attempts": 1})

#: The S3 error codes that mean "no such thing", as MinIO reports them.
_MISSING = {"404", "NoSuchBucket", "NotFound", "NoSuchKey"}
_NO_POLICY = {"NoSuchBucketPolicy", "NoSuchPolicy"}


class PersonMediaError(RuntimeError):
    """Object storage refused, or is configured in a way faces must not be
    stored in. The message is safe to show an operator."""


@functools.lru_cache(maxsize=1)
def _signer() -> Any:
    """Signs against the address the browser will use; see evidence.py for
    why that, and not the internal endpoint, has to be the one signed."""
    return get_session().create_client(
        "s3",
        endpoint_url=settings.minio_public_endpoint or settings.minio_url,
        aws_access_key_id=settings.minio_root_user,
        aws_secret_access_key=settings.minio_root_password,
        config=_SIGNING,
    )


@functools.lru_cache(maxsize=1)
def _internal_signer() -> Any:
    """Signs for the internal endpoint, for URLs the HTTPS web tier proxies;
    see `app/core/public_origin.py`."""
    return get_session().create_client(
        "s3",
        endpoint_url=settings.minio_url,
        aws_access_key_id=settings.minio_root_user,
        aws_secret_access_key=settings.minio_root_password,
        config=_SIGNING,
    )


def signed_url(key: str | None) -> str | None:
    """A two-minute URL for one object in the persons bucket, or None.

    Signing performs no I/O. Callers must have checked `person.read` and must
    audit the issue — this function does neither, on purpose: it is the one
    place a face becomes viewable, and the decision belongs to the endpoint.
    """
    if not key:
        return None
    proxied = public_origin.current() is not None
    try:
        url: str = (_internal_signer() if proxied else _signer()).generate_presigned_url(
            "get_object",
            Params={"Bucket": settings.minio_persons_bucket, "Key": key},
            ExpiresIn=URL_TTL_SECONDS,
        )
    except (BotoCoreError, ValueError) as exc:
        log.warning("person_media.presign_failed", error=str(exc))
        return None
    return public_origin.object_url(url) if proxied else url


def _session() -> aioboto3.Session:
    return aioboto3.Session()


def _client_kwargs() -> dict[str, Any]:
    return {
        "endpoint_url": settings.minio_url,
        "aws_access_key_id": settings.minio_root_user,
        "aws_secret_access_key": settings.minio_root_password,
        "config": Config(signature_version="s3v4", retries={"max_attempts": 2}),
    }


_bucket_checked = False


async def ensure_bucket() -> None:
    """Create the persons bucket if it is missing, and refuse a public one.

    Checked once per process. A bucket that has acquired an access policy —
    say someone ran `mc anonymous set download` on it — is refused outright:
    storing a face in a bucket anyone can list is worse than not storing it.
    """
    global _bucket_checked
    if _bucket_checked:
        return
    bucket = settings.minio_persons_bucket
    try:
        async with _session().client("s3", **_client_kwargs()) as s3:
            try:
                await s3.head_bucket(Bucket=bucket)
            except ClientError as exc:
                if str(exc.response.get("Error", {}).get("Code")) not in _MISSING:
                    raise
                await s3.create_bucket(Bucket=bucket)
                log.info("person_media.bucket_created", bucket=bucket)

            try:
                policy = await s3.get_bucket_policy(Bucket=bucket)
            except ClientError as exc:
                if str(exc.response.get("Error", {}).get("Code")) not in _NO_POLICY:
                    raise
                policy = None
            if policy and policy.get("Policy"):
                log.error("person_media.bucket_has_policy", bucket=bucket)
                raise PersonMediaError(
                    f"The persons bucket '{bucket}' has an access policy. Faces are not stored "
                    "in a bucket that can be read without a signed link; remove the policy "
                    "(mc anonymous set none) and try again."
                )
    except (BotoCoreError, ClientError) as exc:
        log.error("person_media.bucket_unavailable", bucket=bucket, error=str(exc))
        raise PersonMediaError("Object storage is not reachable; nothing was stored.") from exc
    _bucket_checked = True


async def put_reference_photo(person_id: uuid.UUID, jpeg: bytes) -> str:
    """Store an enrolled reference photo. Returns its key."""
    await ensure_bucket()
    key = f"persons/{person_id}/reference-{uuid.uuid4().hex}.jpg"
    try:
        async with _session().client("s3", **_client_kwargs()) as s3:
            await s3.put_object(
                Bucket=settings.minio_persons_bucket,
                Key=key,
                Body=jpeg,
                ContentType="image/jpeg",
                # Never cached by a browser or a proxy between it and here.
                CacheControl="no-store",
            )
    except (BotoCoreError, ClientError) as exc:
        log.error("person_media.upload_failed", error=str(exc))
        raise PersonMediaError("The photo could not be stored; nothing was enrolled.") from exc
    return key


async def delete_object(key: str) -> bool:
    """Delete one object. True when it is gone (or was never there)."""
    try:
        async with _session().client("s3", **_client_kwargs()) as s3:
            await s3.delete_object(Bucket=settings.minio_persons_bucket, Key=key)
    except ClientError as exc:
        if str(exc.response.get("Error", {}).get("Code")) in _MISSING:
            return True
        log.warning("person_media.delete_failed", key=key, error=str(exc))
        return False
    except BotoCoreError as exc:
        log.warning("person_media.delete_failed", key=key, error=str(exc))
        return False
    return True
