"""Enrolment: one reference photo in, one embedding out — or a clear refusal.

Used by the API when a supervisor enrols a person, so that the reference
embedding is computed by **exactly the code and models** the cameras use. Two
implementations of "align and embed" — one at enrolment, one at the edge —
would produce two embedding spaces that drift apart, and every similarity the
platform reported would quietly mean less.

What it insists on, and why each refusal exists:

* **A JPEG or PNG, sniffed from its bytes**, with its pixel count read from the
  header *before* decoding. A 5 MB file can decode to gigabytes; checking the
  header first is what keeps an upload from being a denial of service.
* **Exactly one face.** A photo with two people in it is a photo of either of
  them, and enrolling it would put whichever the detector ranked first on a
  watchlist. Zero faces is a photo of nobody.
* **A face big enough to be a reference.** SFace aligns to 112x112; a face much
  smaller than that is upscaled into a blur that resembles everyone a little.

And what it gives back: the embedding, where the face was, and the photo
**re-encoded from its pixels** — no EXIF, no GPS, no camera serial, no
thumbnail of whatever the photo was cropped from. The original upload is never
stored.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass

import numpy as np

from ailab.face.models import FaceBox, FaceModels

#: Header magic for the two formats accepted.
_JPEG = b"\xff\xd8\xff"
_PNG = b"\x89PNG\r\n\x1a\n"

#: JPEG start-of-frame markers, which carry the image's dimensions. C4, C8 and
#: CC are not frames (Huffman table, reserved, arithmetic conditioning).
_SOF_MARKERS = frozenset({0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF})


class EnrolmentRefused(ValueError):
    """The photo cannot be a reference. `message` is written for the person
    enrolling, and says what to do instead."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True, slots=True)
class Enrolment:
    #: Unit-length 128-d SFace embedding of the one face.
    embedding: np.ndarray
    #: Where the face is, in the stored photo's pixels.
    face: FaceBox
    #: The stored photo: re-encoded JPEG, metadata-free, longer side capped.
    photo_jpeg: bytes
    photo_size: tuple[int, int]
    #: The upload's own size, before any downscale.
    source_size: tuple[int, int]
    #: Variance of the Laplacian over the face — how sharp the reference is.
    #: Reported with the entry so a reviewer can see a weak reference, not
    #: used to refuse one.
    sharpness: float

    def quality(self) -> dict[str, float | int | list[float]]:
        return {
            "detector_score": round(self.face.score, 4),
            "face_px": round(self.face.size_px, 1),
            "sharpness": round(self.sharpness, 1),
            "bbox": [round(v, 1) for v in self.face.xyxy()],
            "photo_width": self.photo_size[0],
            "photo_height": self.photo_size[1],
        }


def image_dimensions(data: bytes) -> tuple[str, int, int]:
    """`(format, width, height)` from the header alone, without decoding."""
    if data.startswith(_PNG):
        if len(data) < 24 or data[12:16] != b"IHDR":
            raise EnrolmentRefused("undecodable", "The PNG file is damaged: it has no header.")
        width, height = struct.unpack(">II", data[16:24])
        return "png", int(width), int(height)

    if data.startswith(_JPEG):
        index = 2
        while index + 4 <= len(data):
            if data[index] != 0xFF:
                index += 1
                continue
            marker = data[index + 1]
            if marker == 0xFF:  # fill byte
                index += 1
                continue
            if marker in (0x01, *range(0xD0, 0xDA)):  # standalone markers
                index += 2
                continue
            if index + 4 > len(data):
                break
            (length,) = struct.unpack(">H", data[index + 2 : index + 4])
            if marker in _SOF_MARKERS:
                if index + 9 > len(data):
                    break
                height, width = struct.unpack(">HH", data[index + 5 : index + 9])
                return "jpeg", int(width), int(height)
            index += 2 + length
        raise EnrolmentRefused("undecodable", "The JPEG file is damaged: it has no frame header.")

    raise EnrolmentRefused(
        "unsupported_format", "The photo must be a JPEG or PNG image."
    )


def enrol_image(
    models: FaceModels,
    data: bytes,
    *,
    min_face_px: int = 80,
    max_bytes: int = 8_000_000,
    max_pixels: int = 40_000_000,
    photo_max_side: int = 1024,
) -> Enrolment:
    """Check, detect, embed. Raises `EnrolmentRefused` with a reason a person
    can act on; anything else raised here is a fault, not a bad photo."""
    import cv2

    if not data:
        raise EnrolmentRefused("empty", "No photo was received.")
    if len(data) > max_bytes:
        raise EnrolmentRefused(
            "too_large",
            f"The photo is {len(data) / 1_000_000:.1f} MB; the limit is "
            f"{max_bytes / 1_000_000:.0f} MB.",
        )

    _kind, width, height = image_dimensions(data)
    if width <= 0 or height <= 0:
        raise EnrolmentRefused("undecodable", "The photo reports no size.")
    if width * height > max_pixels:
        raise EnrolmentRefused(
            "too_many_pixels",
            f"The photo is {width}x{height}; at most {max_pixels // 1_000_000} megapixels "
            "are accepted. Resize it first.",
        )

    image = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None or image.size == 0:
        raise EnrolmentRefused("undecodable", "The photo could not be decoded.")

    # Store a bounded copy, and find the face in *that* copy, so the box
    # stored with the entry is in the pixels of the photo that is kept.
    longest = max(image.shape[:2])
    if longest > photo_max_side:
        scale = photo_max_side / float(longest)
        image = cv2.resize(
            image,
            (max(1, round(image.shape[1] * scale)), max(1, round(image.shape[0] * scale))),
            interpolation=cv2.INTER_AREA,
        )

    faces = models.detect(image)
    if not faces:
        raise EnrolmentRefused(
            "no_face",
            "No face was found in the photo. Use a clear, front-facing photo of one person.",
        )
    if len(faces) > 1:
        raise EnrolmentRefused(
            "several_faces",
            f"{len(faces)} faces were found in the photo. A reference photo must show exactly "
            "one person — crop it to the one face and try again.",
        )
    face = faces[0]
    if face.size_px < min_face_px:
        raise EnrolmentRefused(
            "face_too_small",
            f"The face is only {face.size_px:.0f} pixels across; at least {min_face_px} are "
            "needed for a reliable reference. Use a closer or higher-resolution photo.",
        )

    embedding = models.embed(image, face)

    x1, y1, x2, y2 = (int(round(v)) for v in face.xyxy())
    region = image[max(0, y1) : max(0, y2), max(0, x1) : max(0, x2)]
    sharpness = (
        float(cv2.Laplacian(cv2.cvtColor(region, cv2.COLOR_BGR2GRAY), cv2.CV_64F).var())
        if region.size
        else 0.0
    )

    ok, encoded = cv2.imencode(".jpg", image, [int(cv2.IMWRITE_JPEG_QUALITY), 92])
    if not ok:
        raise EnrolmentRefused("undecodable", "The photo could not be re-encoded.")

    return Enrolment(
        embedding=embedding,
        face=face,
        photo_jpeg=encoded.tobytes(),
        photo_size=(int(image.shape[1]), int(image.shape[0])),
        source_size=(width, height),
        sharpness=sharpness,
    )
