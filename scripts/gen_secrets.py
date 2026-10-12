#!/usr/bin/env python3
"""Fill .env with generated secrets. Prints key names, never values.

Run by `make env` (after copying .env.example on a fresh clone) and safe to run
again: a key that already holds a value of its own is left alone. What it does:

* **fills** every secret that is missing or empty with a fresh random value;
* **reports** a secret that still holds a value published in this repository
  (the old development defaults), and with `--rotate-published` replaces it.
  That is opt-in because, on a stack that is already running, the database,
  object store, Grafana and the seeded accounts were initialised with the old
  value — rotating .env alone would lock the platform out of its own data.
  docs/SECURITY.md §8 has the steps that apply a rotation to a running stack;
* keeps `DATABASE_URL` and `REDIS_URL` in step with the passwords they embed.

docker-compose.yml has no fallback passwords, so a key this script did not
fill stops `docker compose` with "<KEY> is not set - run make env".

Standard library only: it runs on the host, before any container exists.
"""

from __future__ import annotations

import argparse
import os
import re
import secrets
import stat
import sys
import tempfile
from collections.abc import Callable
from pathlib import Path

#: Values that appear in this repository (its history, docs and examples).
#: Holding one of them is the same as holding no secret at all.
PUBLISHED = frozenset(
    {
        "nagarnetra_dev_pw",
        "dev_only_insecure_secret_change_me_0123456789abcdef",
        "NagarNetra@2026",
        "CHANGE_ME",
        "changeme",
    }
)

#: Unambiguous to read aloud or type from paper: no 0/O, 1/l/I.
_HUMAN_ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def machine_secret() -> str:
    """URL-safe, so it can sit inside DATABASE_URL and REDIS_URL unescaped."""
    return secrets.token_urlsafe(24)


def jwt_secret() -> str:
    return secrets.token_hex(32)


def human_password(username: str = "") -> str:
    """Four groups of four, e.g. `k7Qm-x2Rp-9vTn-c4Wd`: ~90 bits, typeable.

    Meets app/core/password_policy.py: 19 characters, and never contains the
    account's own name (regenerated in the vanishingly rare case it does).
    """
    while True:
        groups = [
            "".join(secrets.choice(_HUMAN_ALPHABET) for _ in range(4)) for _ in range(4)
        ]
        candidate = "-".join(groups)
        letters = re.sub(r"[^a-z]", "", candidate.lower())
        if not username or username.lower().replace("-", "") not in letters:
            return candidate


#: Every secret the stack needs, and how to make one.
SECRETS: dict[str, Callable[[], str]] = {
    "POSTGRES_PASSWORD": machine_secret,
    "REDIS_PASSWORD": machine_secret,
    "MINIO_ROOT_PASSWORD": machine_secret,
    "MEDIAMTX_PUBLISH_PASSWORD": machine_secret,
    "MEDIAMTX_READ_PASSWORD": machine_secret,
    "JWT_SECRET_KEY": jwt_secret,
    "GRAFANA_ADMIN_PASSWORD": machine_secret,
    "BOOTSTRAP_ADMIN_PASSWORD": lambda: human_password("admin"),
    # One per seeded account (scripts/seed.py: DEMO_PASSWORD_<USERNAME>).
    "DEMO_PASSWORD_SUPERVISOR": lambda: human_password("supervisor"),
    "DEMO_PASSWORD_OPERATOR": lambda: human_password("operator"),
    "DEMO_PASSWORD_ANALYST": lambda: human_password("analyst"),
    "DEMO_PASSWORD_AUDITOR": lambda: human_password("auditor"),
    "DEMO_PASSWORD_GSRTC_INTEGRATION": lambda: human_password("gsrtc-integration"),
}

_LINE = re.compile(r"^(?P<key>[A-Z][A-Z0-9_]*)=(?P<value>.*)$")


def _value(raw: str) -> str:
    """A value as compose reads it: an inline ` # comment` stripped, unquoted."""
    value = re.sub(r"\s+#.*$", "", raw).strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        value = value[1:-1]
    return value


def load(lines: list[str]) -> dict[str, tuple[list[int], str]]:
    """Each key's line numbers and its effective value (the last one wins,
    as it does for compose)."""
    found: dict[str, tuple[list[int], str]] = {}
    for index, line in enumerate(lines):
        match = _LINE.match(line.rstrip("\n"))
        if match:
            indices = found.get(match["key"], ([], ""))[0]
            found[match["key"]] = ([*indices, index], _value(match["value"]))
    return found


def set_key(
    lines: list[str], found: dict[str, tuple[list[int], str]], key: str, value: str
) -> None:
    """Set every occurrence of `key`, or append it."""
    if key in found:
        indices = found[key][0]
        for index in indices:
            lines[index] = f"{key}={value}\n"
    else:
        if lines and not lines[-1].endswith("\n"):
            lines[-1] += "\n"
        lines.append(f"{key}={value}\n")
        indices = [len(lines) - 1]
    found[key] = (indices, value)


def write_atomically(path: Path, lines: list[str]) -> None:
    """Replace the file in one step, readable by its owner only."""
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".env.", text=True)
    try:
        with os.fdopen(fd, "w") as handle:
            handle.writelines(lines)
        os.chmod(tmp, stat.S_IRUSR | stat.S_IWUSR)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument(
        "--env", default=".env", type=Path, help="the file to fill (.env)"
    )
    parser.add_argument(
        "--rotate-published",
        action="store_true",
        help="also replace values published in the repository (see the module docstring)",
    )
    args = parser.parse_args()

    path: Path = args.env
    if not path.exists():
        print(f"{path} not found — run `make env`, which creates it from .env.example")
        return 1
    lines = path.read_text().splitlines(keepends=True)
    found = load(lines)

    filled: list[str] = []
    rotated: list[str] = []
    published: list[str] = []
    for key, make in SECRETS.items():
        current = found.get(key, ([], ""))[1]
        if not current:
            set_key(lines, found, key, make())
            filled.append(key)
        elif current in PUBLISHED:
            if args.rotate_published:
                set_key(lines, found, key, make())
                rotated.append(key)
            else:
                published.append(key)

    # The URLs that embed a password follow it. Compose builds its own for the
    # containers; these are for anything that reads .env directly.
    def get(key: str, default: str = "") -> str:
        return found.get(key, ([], default))[1] or default

    if "DATABASE_URL" in found:
        set_key(
            lines,
            found,
            "DATABASE_URL",
            "postgresql+asyncpg://{}:{}@{}:{}/{}".format(
                get("POSTGRES_USER", "nagarnetra"),
                get("POSTGRES_PASSWORD"),
                get("POSTGRES_HOST", "postgres"),
                get("POSTGRES_PORT", "5432"),
                get("POSTGRES_DB", "nagarnetra"),
            ),
        )
    if "REDIS_URL" in found:
        set_key(
            lines,
            found,
            "REDIS_URL",
            "redis://:{}@{}:{}/0".format(
                get("REDIS_PASSWORD"),
                get("REDIS_HOST", "redis"),
                get("REDIS_PORT", "6379"),
            ),
        )

    write_atomically(path, lines)

    if filled:
        print(f"generated into {path}: {', '.join(filled)}")
    if rotated:
        print(f"rotated in {path}: {', '.join(rotated)}")
        print("  apply them to the running stack: docs/SECURITY.md §8 (rotation)")
    if published:
        print(
            f"\033[33m!\033[0m still the published development value: {', '.join(published)}\n"
            "  rotate with `python3 scripts/gen_secrets.py --rotate-published`, then apply "
            "(docs/SECURITY.md §8)"
        )
    if not (filled or rotated or published):
        print(f"{path}: every secret already set")
    return 0


if __name__ == "__main__":
    sys.exit(main())
