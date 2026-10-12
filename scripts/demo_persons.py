#!/usr/bin/env python3
"""Enrol the persons watchlist's demonstration entry — with four eyes.

The persons demo camera, CAM-DEMO-02, replays stock footage of three people
walking toward a camera (`data/videos/persons_demo.mp4`, fetched by
`make videos`; Pexels License, see data/videos/ATTRIBUTION.md). This script
cuts one of them out of the clip's last frame and enrols that face the way an
officer would, over the API:

1. **enrolled by `supervisor`** — the photo is checked for exactly one face,
   embedded by the same models the cameras use, stored privately, and the
   entry is created `pending_approval`;
2. **approved by `admin`** — a different account, because the API refuses
   self-approval (and so does the database). Approval publishes the gallery.

The entry is category `demo` with a case reference marked fictional, valid for
seven days. It is a stranger in stock footage: it is never `wanted` or
`missing`, and the reasons on any alarm it raises say so.

Nothing is injected afterwards. If the face stage on CAM-DEMO-02 does not see
this person well enough, in enough frames, no alarm appears.

    docker compose exec api python /app/scripts/demo_persons.py
    docker compose exec api python /app/scripts/demo_persons.py --person 0   # left-hand person
    docker compose exec api python /app/scripts/demo_persons.py --retire     # end the demo entry
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "services" / "api"))

import httpx  # noqa: E402

API_URL = os.environ.get("NAGARNETRA_API_URL", "http://localhost:8000") + "/api/v1"
#: Seeded demo accounts. Two of them, deliberately: the second pair of eyes.
ENROLLER, APPROVER = "supervisor", "admin"
DEMO_PASSWORD = os.environ.get("DEMO_PASSWORD", "NagarNetra@2026")
CLIP = Path(os.environ.get("PERSONS_DEMO_CLIP", "/data/videos/persons_demo.mp4"))
MODELS = Path(os.environ.get("FACE_MODELS_DIR", "/models"))
CASE_REF = "DEMO/PERSONS/001 (fictional)"

BOLD, DIM, RESET, GREEN, RED = "\033[1m", "\033[2m", "\033[0m", "\033[32m", "\033[31m"


def reference_photo(person: int) -> bytes:
    """Head and shoulders of one of the clip's three people, from its last
    frame, found by the cameras' own detector — so the photo holds one face."""
    import cv2

    from ailab.face.models import FaceModels

    capture = cv2.VideoCapture(str(CLIP))
    total = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
    capture.set(cv2.CAP_PROP_POS_FRAMES, max(0, total - 2))
    ok, image = capture.read()
    capture.release()
    if not ok:
        raise SystemExit(f"{RED}could not read {CLIP} — run `make videos`{RESET}")

    faces = sorted(FaceModels(MODELS).detect(image), key=lambda f: f.cx)
    if len(faces) != 3:
        raise SystemExit(
            f"{RED}expected the clip's three faces, found {len(faces)}{RESET}"
        )
    face = faces[person]
    pad_x, pad_y = int(face.w * 1.4), int(face.h * 1.6)
    x1, y1 = max(0, int(face.x) - pad_x), max(0, int(face.y) - pad_y)
    x2 = min(image.shape[1], int(face.x + face.w) + pad_x)
    y2 = min(image.shape[0], int(face.y + face.h) + pad_y)
    ok, data = cv2.imencode(
        ".jpg", image[y1:y2, x1:x2], [int(cv2.IMWRITE_JPEG_QUALITY), 92]
    )
    if not ok:
        raise SystemExit(f"{RED}could not encode the reference photo{RESET}")
    return bytes(data.tobytes())


def login(client: httpx.Client, username: str) -> dict[str, str]:
    response = client.post(
        "/auth/login", json={"username": username, "password": DEMO_PASSWORD}
    )
    response.raise_for_status()
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def existing(client: httpx.Client, headers: dict[str, str]) -> list[dict]:
    items: list[dict] = []
    for status in ("active", "pending_approval"):
        page = client.get("/persons", params={"status": status}, headers=headers)
        page.raise_for_status()
        items += [i for i in page.json()["items"] if i["case_ref"] == CASE_REF]
    return items


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument(
        "--person",
        type=int,
        default=1,
        choices=(0, 1, 2),
        help="which of the three people, left to right (default: middle)",
    )
    parser.add_argument(
        "--retire", action="store_true", help="retire the demo entry instead"
    )
    args = parser.parse_args()

    with httpx.Client(base_url=API_URL, timeout=30.0) as client:
        enroller = login(client, ENROLLER)
        approver = login(client, APPROVER)
        current = existing(client, enroller)

        if args.retire:
            for item in current:
                client.post(
                    f"/persons/{item['id']}/retire",
                    headers=enroller,
                    json={"reason": "Demonstration finished"},
                ).raise_for_status()
                print(f"{GREEN}retired{RESET} {item['id']}")
            if not current:
                print("no demo entry to retire")
            return 0

        if current:
            print(
                f"{GREEN}already enrolled{RESET}: {current[0]['id']} ({current[0]['status']})"
            )
            return 0

        print(f"{BOLD}1. Enrol, as {ENROLLER}{RESET}")
        enrolled = client.post(
            "/persons",
            headers=enroller,
            data={
                "display_name": "Demo subject — stock footage",
                "category": "demo",
                "case_ref": CASE_REF,
                "purpose": (
                    "Demonstration of the persons watchlist on recorded stock footage "
                    "(Pexels, 'Officemates Walking on the Street'). Fictional case: this "
                    "person is not sought for anything."
                ),
                "notes": "Reference cut from the last frame of data/videos/persons_demo.mp4.",
                "valid_days": "7",
            },
            files={
                "photo": ("reference.jpg", reference_photo(args.person), "image/jpeg")
            },
        )
        if enrolled.status_code != 201:
            print(f"{RED}refused: {enrolled.status_code} {enrolled.text}{RESET}")
            return 1
        entry = enrolled.json()
        print(
            f"   {entry['id']} — {entry['status']}, face {entry['enrol_quality']['face_px']} px"
        )

        print(f"{BOLD}2. Self-approval is refused{RESET}")
        refused = client.post(f"/persons/{entry['id']}/approve", headers=enroller)
        print(f"   {refused.status_code}: {refused.json().get('detail')}")

        print(f"{BOLD}3. Approve, as {APPROVER}{RESET}")
        approved = client.post(f"/persons/{entry['id']}/approve", headers=approver)
        approved.raise_for_status()
        print(
            f"   {GREEN}{approved.json()['status']}{RESET} — the cameras now match against it"
        )
        print(
            f"{DIM}   Open CAM-DEMO-02 in Live, or keep it always-on, and watch Alarms.{RESET}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
