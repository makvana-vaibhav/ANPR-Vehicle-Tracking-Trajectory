"""Give a camera its own login, as a pointer.

An NVR channel or IP camera that refuses an anonymous RTSP read could only be
onboarded through a relay container that held its password, because the
registry rightly refuses `rtsp://user:pass@…` in `stream_url` and had nowhere
else for the credential to go.

``credentials_ref`` is that place, with the same discipline as
``vms_instances.credentials_ref``: a pointer, never a secret. The API writes an
``enc://`` value — AES-256-GCM under the platform key ring, bound to the
context ``camera-credentials`` — and refuses outright when no key is
configured. See app/services/camera_credentials.py.

NULL means the camera needs no login, which is every existing camera, so this
migration changes no behaviour on its own.

Revision ID: 0011
Revises: 0010
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0011"
down_revision: str | None = "0010"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.add_column("cameras", sa.Column("credentials_ref", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("cameras", "credentials_ref")
