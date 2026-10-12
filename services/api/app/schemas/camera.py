"""Camera registry request/response models.

The registry is the statewide answer to "what cameras exist, who owns them, and
where are they" — a question Gujarat currently cannot answer in a single query.
"""

from __future__ import annotations

import re
import uuid
from datetime import date, datetime
from pathlib import Path
from typing import Annotated, Any, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    SecretStr,
    field_validator,
    model_validator,
)

from app.models.enums import (
    AdapterType,
    CameraStatus,
    CameraType,
    Protocol,
    VmsVendor,
)

# Gujarat's bounding box, generously padded. A camera outside this is almost
# certainly a data-entry error (swapped lat/lon is the classic one), and
# catching it at the edge keeps nonsense off the operational map.
GUJARAT_LAT_MIN, GUJARAT_LAT_MAX = 20.0, 24.8
GUJARAT_LON_MIN, GUJARAT_LON_MAX = 68.0, 74.6

CAMERA_CODE_PATTERN = re.compile(r"^[A-Z0-9][A-Z0-9\-]{2,31}$")

#: Extensions accepted for `source_file`. Kept identical to the simulator's
#: `publisher.VIDEO_SUFFIXES` so the two cannot disagree about what a clip is —
#: a value this accepts but `find_videos` skips would be a camera pinned to a
#: file that silently never plays. Duplicated rather than imported because the
#: API image does not carry the simulator package; `test_cameras.py` asserts
#: the two sets match.
SOURCE_VIDEO_SUFFIXES = frozenset({".mp4", ".mkv", ".mov", ".avi", ".ts"})


def clean_source_file(v: str | None) -> str | None:
    """Keep `source_file` a filename, so it can never address anything else.

    The value is joined to the simulator's video directory, which makes it a
    path-traversal sink: `../../etc/passwd` would escape it and an absolute
    path would ignore it entirely. Rejecting every separator and dot-segment is
    the whole defence, and it costs nothing — a legitimate value is a basename
    with a video extension and nothing more.

    Validated at the edge rather than where it is read, so the database cannot
    hold a value the simulator would have to defend itself against. Shared by
    `CameraBase` and `CameraUpdate` because a rule enforced on create and not
    on update is not a rule.
    """
    if v is None:
        return None
    v = v.strip()
    if not v:
        return None
    if v != Path(v).name or v in (".", ".."):
        raise ValueError("source_file must be a bare filename, not a path")
    if Path(v).suffix.lower() not in SOURCE_VIDEO_SUFFIXES:
        allowed = ", ".join(sorted(SOURCE_VIDEO_SUFFIXES))
        raise ValueError(f"source_file must be a video file ({allowed})")
    return v


#: Longest login the registry accepts. Generous for any NVR; the bound exists so
#: a request cannot hand the key ring megabytes to seal.
MAX_USERNAME_LENGTH = 128
MAX_PASSWORD_LENGTH = 256


def _check_username(v: str | None) -> str | None:
    if v is None:
        return None
    v = v.strip()
    if not v:
        return None
    if len(v) > MAX_USERNAME_LENGTH:
        raise ValueError(f"stream_username is longer than {MAX_USERNAME_LENGTH} characters")
    if ":" in v:
        raise ValueError("stream_username may not contain ':'")
    if any(ord(c) < 32 for c in v):
        raise ValueError("stream_username may not contain control characters")
    return v


def _check_password(v: SecretStr | None) -> SecretStr | None:
    if v is None:
        return None
    raw = v.get_secret_value()
    if len(raw) > MAX_PASSWORD_LENGTH:
        raise ValueError(f"stream_password is longer than {MAX_PASSWORD_LENGTH} characters")
    if raw != raw.strip():
        # Stored as `username:password` and trimmed on the way back out, so
        # surrounding whitespace would silently change the password.
        raise ValueError("stream_password may not start or end with whitespace")
    if any(ord(c) < 32 for c in raw):
        raise ValueError("stream_password may not contain control characters")
    return v


def lift_url_credentials(model: Any) -> None:
    """Move `user:pass@` out of `stream_url`/`sub_stream_url` into the login fields.

    A pasted `rtsp://admin:pw@10.0.0.5/Streaming/Channels/101` is how a camera
    arrives from an NVR's web page or a phone app, and refusing it outright —
    which this registry used to do — made a credentialed camera impossible to
    onboard without a relay. So the URL is split here, at the edge, before
    anything can store or log it: the URL keeps host, port and path, and the
    login goes to `stream_username`/`stream_password`, which the service seals
    into `credentials_ref`.

    Two different logins for one camera — one typed in the fields and another
    in the URL, or a different one on the sub-stream — are refused rather
    than guessed between.
    """
    from app.core.urls import split_credentials

    for field in ("stream_url", "sub_stream_url"):
        url = getattr(model, field, None)
        clean, username, password = split_credentials(url)
        if username is None and password is None:
            continue
        setattr(model, field, clean)
        if not username:
            raise ValueError(f"{field} carries a password but no username")
        given_user = model.stream_username
        given_password = model.stream_password.get_secret_value() if model.stream_password else None
        if given_user is None and given_password is None:
            model.stream_username = _check_username(username)
            model.stream_password = _check_password(
                SecretStr(password) if password is not None else None
            )
            continue
        if given_user != username or (given_password or "") != (password or ""):
            raise ValueError(
                f"{field} carries a different login from stream_username/stream_password; "
                "give the login once"
            )

    if model.stream_password is not None and not model.stream_username:
        raise ValueError("stream_password needs a stream_username")


Latitude = Annotated[float, Field(ge=-90, le=90, examples=[22.3039])]
Longitude = Annotated[float, Field(ge=-180, le=180, examples=[70.8022])]


class CameraBase(BaseModel):
    """Fields common to creating and updating a camera."""

    name: str = Field(min_length=1, max_length=200, examples=["Kalawad Road Junction"])
    district: str | None = Field(default=None, max_length=64, examples=["Rajkot"])
    city: str | None = Field(default=None, max_length=64, examples=["Rajkot"])
    junction: str | None = Field(default=None, max_length=128)
    #: The arterial this camera watches. Analytics groups on it.
    corridor: str | None = Field(default=None, max_length=64, examples=["Ashram Road"])
    address: str | None = None

    heading_deg: int | None = Field(
        default=None,
        ge=0,
        le=359,
        description=(
            "Compass direction the camera faces. Used by the correlator to reject "
            "implausible route hops — a vehicle cannot pass eastbound through a "
            "camera that only sees westbound traffic."
        ),
    )

    camera_type: CameraType | None = None
    protocol: Protocol | None = None
    stream_url: str | None = None
    sub_stream_url: str | None = Field(
        default=None,
        description="Lower-resolution stream, preferred for AI analysis to save bandwidth",
    )
    #: The camera's own login. Write-only: sealed into `credentials_ref` and
    #: never returned. A login pasted inside `stream_url` lands here too.
    stream_username: str | None = Field(
        default=None,
        description=(
            "Username the camera or NVR asks for. Stored encrypted with the password; "
            "never returned. A URL pasted as rtsp://user:pass@host/… is split into "
            "stream_url plus these two fields automatically."
        ),
        examples=["admin"],
    )
    stream_password: SecretStr | None = Field(
        default=None,
        description="Password for stream_username. Write-only: encrypted at rest, never returned.",
    )
    resolution: str | None = Field(default=None, max_length=16, examples=["1920x1080"])
    fps: int | None = Field(default=None, ge=1, le=120)
    source_file: str | None = Field(
        default=None,
        max_length=255,
        description=(
            "Filename of a recorded clip for the simulator to replay instead of "
            "pulling a live stream. A bare filename from the simulator's video "
            "directory — list them at GET /cameras/source-videos."
        ),
        examples=["highway_cam_a.mp4"],
    )
    anpr_enabled: bool = True
    installed_on: date | None = None
    tags: list[str] | None = None

    @field_validator("resolution")
    @classmethod
    def _validate_resolution(cls, v: str | None) -> str | None:
        if v is None:
            return v
        if not re.fullmatch(r"\d{3,5}x\d{3,5}", v):
            raise ValueError("resolution must look like 1920x1080")
        return v

    _validate_source_file = field_validator("source_file")(clean_source_file)

    _validate_username = field_validator("stream_username")(_check_username)
    _validate_password = field_validator("stream_password")(_check_password)

    @model_validator(mode="after")
    def _lift_credentials(self) -> CameraBase:
        """Keep credentials out of `stream_url`. See `lift_url_credentials`.

        ``rtsp://admin:password@10.0.0.5/stream`` is how camera passwords leak
        into databases, logs, and screenshots, so the URL that is stored never
        carries one: the login is moved into the write-only fields here and
        sealed by the service.
        """
        lift_url_credentials(self)
        return self


class CameraCreate(CameraBase):
    """Payload for registering a single camera."""

    camera_code: str = Field(
        min_length=3,
        max_length=32,
        examples=["CAM-00001"],
        description="Unique estate-wide identifier",
    )
    lat: Latitude
    lon: Longitude
    department_code: str | None = Field(default=None, description="Owning department, e.g. POLICE")
    vms_name: str | None = Field(default=None, description="Federated VMS instance name")

    @field_validator("camera_code")
    @classmethod
    def _validate_code(cls, v: str) -> str:
        v = v.strip().upper()
        if not CAMERA_CODE_PATTERN.fullmatch(v):
            raise ValueError("camera_code must be 3-32 chars, uppercase alphanumerics and hyphens")
        return v

    @model_validator(mode="after")
    def _check_within_gujarat(self) -> CameraCreate:
        """Catch swapped or mistyped coordinates at the edge."""
        if not (GUJARAT_LAT_MIN <= self.lat <= GUJARAT_LAT_MAX) or not (
            GUJARAT_LON_MIN <= self.lon <= GUJARAT_LON_MAX
        ):
            raise ValueError(
                f"({self.lat}, {self.lon}) is outside Gujarat "
                f"(lat {GUJARAT_LAT_MIN}-{GUJARAT_LAT_MAX}, "
                f"lon {GUJARAT_LON_MIN}-{GUJARAT_LON_MAX}). "
                "Check the values are not swapped."
            )
        return self


class CameraUpdate(BaseModel):
    """Partial update. Every field optional; omitted fields are left alone."""

    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=200)
    district: str | None = None
    city: str | None = None
    junction: str | None = None
    corridor: str | None = None
    address: str | None = None
    lat: Latitude | None = None
    lon: Longitude | None = None
    heading_deg: int | None = Field(default=None, ge=0, le=359)
    camera_type: CameraType | None = None
    protocol: Protocol | None = None
    stream_url: str | None = None
    sub_stream_url: str | None = None
    resolution: str | None = None
    fps: int | None = Field(default=None, ge=1, le=120)
    source_file: str | None = Field(default=None, max_length=255)
    anpr_enabled: bool | None = None
    status: CameraStatus | None = None
    installed_on: date | None = None
    tags: list[str] | None = None
    department_code: str | None = None
    #: Replace the camera's login. Omitted means "keep what is stored" — the
    #: form cannot show a password it was never given back, so blank cannot
    #: mean delete. `clear_credentials` is how one is removed.
    stream_username: str | None = None
    stream_password: SecretStr | None = None
    clear_credentials: bool = False

    _validate_source_file = field_validator("source_file")(clean_source_file)
    _validate_username = field_validator("stream_username")(_check_username)
    _validate_password = field_validator("stream_password")(_check_password)

    @model_validator(mode="after")
    def _coordinates_move_together(self) -> CameraUpdate:
        """Moving a camera requires both coordinates, never one."""
        if (self.lat is None) != (self.lon is None):
            raise ValueError("lat and lon must be provided together")
        return self

    @model_validator(mode="after")
    def _lift_credentials(self) -> CameraUpdate:
        """As on create: a login inside a new URL is split out, never stored.

        Until this existed an edit could write `rtsp://user:pass@…` straight
        into the registry — the create path refused it and this one did not.
        """
        lift_url_credentials(self)
        if self.clear_credentials and self.stream_username:
            raise ValueError("clear_credentials and a new login cannot be sent together")
        return self

    @property
    def login_changed(self) -> bool:
        """Whether this update sets or clears the stored login."""
        return self.clear_credentials or self.stream_username is not None


class CameraOut(BaseModel):
    """A camera as returned by the API."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    camera_code: str
    name: str
    department_id: uuid.UUID | None = None
    department_code: str | None = None
    department_name: str | None = None
    vms_id: uuid.UUID | None = None
    vms_name: str | None = None
    vms_vendor: str | None = None
    district: str | None = None
    city: str | None = None
    junction: str | None = None
    corridor: str | None = None
    address: str | None = None
    lat: float
    lon: float
    heading_deg: int | None = None
    camera_type: str | None = None
    protocol: str | None = None
    resolution: str | None = None
    fps: int | None = None
    anpr_enabled: bool
    status: str
    #: Set when `status` is the last known one rather than a fresh finding:
    #: the latest probe could not ask about this camera because its
    #: integration refused our session or did not answer. The probe's error
    #: code (`grid_refused`, `sandbox_unreachable`, …).
    status_stale_reason: str | None = None
    #: When a probe last got an answer about this camera, if it is stale.
    status_confirmed_at: datetime | None = None
    installed_on: date | None = None
    tags: list[str] | None = None

    #: Whether a video source is configured — **not** the source itself.
    #:
    #: `stream_url` is deliberately absent from this model and must stay
    #: absent: a federated camera's URL carries the credentials for the
    #: organisers' grid, and returning it would hand every operator's browser
    #: a password. But an administrator still needs to know whether a camera
    #: has a source at all, because one without a source can never be watched
    #: or analysed, and that distinction is the whole reason the registry no
    #: longer holds 250 cameras that could do neither.
    has_stream: bool = False
    #: Whether a login is stored for the source — **not** the login. The
    #: username and password are write-only; see `CameraBase.stream_username`.
    has_credentials: bool = False
    #: The pinned clip, if this camera replays recorded footage.
    #:
    #: Returned in full, unlike `stream_url`: it is a filename inside our own
    #: video directory, chosen by an operator from a list this API served, and
    #: it carries no credentials. The form has to render the current choice to
    #: be editable at all.
    source_file: str | None = None
    created_at: datetime
    updated_at: datetime
    # Only populated by /nearby.
    distance_km: float | None = None

    # stream_url is deliberately absent: a viewing URL is issued per request as
    # a short-lived signed token by /cameras/{id}/stream (Phase 4), and that
    # issuance is audited. Returning raw stream URLs in a list response would
    # hand out unaudited access to every feed in the estate.


class CameraPage(BaseModel):
    """A page of cameras. No endpoint returns an unbounded list."""

    items: list[CameraOut]
    total: int
    limit: int
    offset: int

    @property
    def has_more(self) -> bool:
        return self.offset + len(self.items) < self.total


class FleetSummary(BaseModel):
    """Rollup for the dashboard KPI strip."""

    total: int
    by_status: dict[str, int]
    by_department: dict[str, int]
    by_district: dict[str, int]
    anpr_enabled: int


# ── GeoJSON ───────────────────────────────────────────────────────────
# RFC 7946 shapes, so MapLibre can consume the response directly with no
# client-side transformation.


class GeoJSONGeometry(BaseModel):
    type: Literal["Point"] = "Point"
    coordinates: tuple[float, float] = Field(description="[longitude, latitude]")


class GeoJSONFeature(BaseModel):
    type: Literal["Feature"] = "Feature"
    geometry: GeoJSONGeometry
    properties: dict[str, Any]
    id: str | None = None


class GeoJSONFeatureCollection(BaseModel):
    type: Literal["FeatureCollection"] = "FeatureCollection"
    features: list[GeoJSONFeature]
    # Non-standard but harmless extras the map UI uses for its legend.
    properties: dict[str, Any] = Field(default_factory=dict)


# ── Bulk onboarding ───────────────────────────────────────────────────


class BulkRowError(BaseModel):
    """One rejected CSV row, reported back with enough detail to fix it."""

    row: int = Field(description="1-based row number in the uploaded file")
    camera_code: str | None = None
    errors: list[str]


class BulkUploadResult(BaseModel):
    """Outcome of a CSV bulk upload.

    Valid rows are committed even when others fail: a department onboarding
    4,000 cameras should not lose the 3,997 good ones because three had a typo.
    Failures come back row-by-row so they can be corrected and re-submitted.
    """

    total_rows: int
    created: int
    updated: int
    skipped: int
    failed: int
    errors: list[BulkRowError]
    dry_run: bool = False


class VmsInstanceOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    vendor: str
    adapter_type: str
    base_url: str | None = None
    status: str
    last_sync_at: datetime | None = None
    camera_count: int = 0
    # credentials_ref is never serialised — it is a pointer into a secret
    # store, and exposing even the pointer narrows an attacker's search.


class DepartmentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    code: str
    name: str
    contact_email: str | None = None
    camera_count: int = 0


class SourceVideoOut(BaseModel):
    """One recorded clip an operator can pin to a camera.

    Filename and size, nothing more. The size is here because it is the only
    cue distinguishing two similarly-named clips in a dropdown, and it costs
    one `stat` per file.
    """

    filename: str
    size_bytes: int


class VendorEnumOut(BaseModel):
    """Vocabularies, so the UI populates dropdowns from the server."""

    departments: list[str]
    vendors: list[VmsVendor]
    adapter_types: list[AdapterType]
    camera_types: list[CameraType]
    protocols: list[Protocol]
    statuses: list[CameraStatus]
