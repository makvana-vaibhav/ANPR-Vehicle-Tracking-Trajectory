"""Holds an authenticated session with the organisers' camera grid.

## Why this exists

The grid uses **two different authentication systems**, and conflating them is
why the platform looked broken while the grid was working:

| Path | Host | Authenticates with |
|---|---|---|
| RTSP (inference) | `103.250.160.189:8554` | username/password in the URL |
| Catalogue + HLS | `cctv.corp8.cloud` | a **login session cookie** |

The RTSP credentials are not accepted by the CDN — Basic auth there returns a
302 to the login page. The CDN wants the form POST that a browser makes, and
gives back a `sentinel=` cookie.

So the API logs in once, keeps the cookie, and re-logs when it stops working.
This is the only place in the platform that holds those credentials.

## The second gate

Media paths additionally refuse any request that does not look like a browser
— the body is literally `browser required`. So requests carry a browser
`User-Agent` and a `Referer`. That is not a trick to evade a control; it is the
control asking for a shape of request, and the platform is an authorised
consumer of this grid with credentials the organisers issued.

## One session per IP — so one session for the whole platform

Since 11 Oct the grid refuses a request with **403 `one session per IP`** when
another session is using the same address. Every process here leaves from the
same address — the API proxying HLS, the health monitor in `ingest` reading the
catalogue, the onboarding script — and each used to log in for itself. Two
logins were two sessions; the API's lost, and every grid camera on screen
failed with "no video arrived".

So the cookie is kept in Redis and shared: whoever needs a session first logs
in, under a lock other processes wait on, and everyone after uses that cookie,
across restarts too. When the grid refuses it, it is replaced at most once a
minute between them all — a second login made sooner would only be one more
session for the grid to refuse.
"""

from __future__ import annotations

import asyncio
import html
import json
import re
import secrets
from collections.abc import Awaitable
from datetime import UTC, datetime, timedelta
from typing import cast

import httpx
import redis.asyncio as aioredis
from redis.exceptions import RedisError

from app.core.config import settings
from app.core.logging import get_logger

log = get_logger(__name__)

#: The CDN refuses non-browser agents on media paths. Sent on every request to
#: the grid so the catalogue and the media path behave the same way.
BROWSER_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

#: Re-login before this elapses. The cookie's own Max-Age is a year, but a
#: session can be invalidated server-side at any time and a stale cookie is
#: indistinguishable from a broken integration until something re-logs.
SESSION_TTL = timedelta(hours=6)

LOGIN_PATH = "/auth/login"

#: The session cookie the grid sets on a successful login. The organisers'
#: system is called Sentinel and the name is theirs, not ours: a rename of
#: this product once rewrote it too, and every login was then reported as
#: rejected while the grid was accepting them.
SESSION_COOKIE = "sentinel"

#: Where the shared session lives, and the lock a login is made under.
SESSION_KEY = "nagarnetra:grid:session"

#: A refused session is replaced no more often than this, across every
#: process. The grid allows one session per IP; logging in again sooner only
#: makes another session for it to refuse.
RELOGIN_MIN_INTERVAL = timedelta(seconds=60)

#: How long a process waits for another one's login before giving up.
LOGIN_WAIT_S = 20.0

#: The body of the grid's 403 when another session holds our address.
ONE_SESSION_PER_IP = "one session per ip"

_RELEASE_LOCK = """
if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
end
return 0
"""

#: Words that mark the sentence explaining a refused login.
_REASON_WORDS = (
    "invalid",
    "incorrect",
    "wrong",
    "denied",
    "restricted",
    "locked",
    "disabled",
    "expired",
    "not allowed",
    "try again",
    "too many",
)


def rejection_reason(page: str) -> str | None:
    """The sentence on a re-rendered login page that says why it was refused."""
    text = re.sub(r"(?is)<(script|style)\b.*?</\1>", " ", page or "")
    # Split on tags, not lines: a message wrapped across lines in the markup
    # is still one message.
    for block in re.split(r"(?s)<[^>]+>", text):
        sentence = " ".join(html.unescape(block).split())
        if sentence and any(word in sentence.lower() for word in _REASON_WORDS):
            return sentence[:200]
    return None


def _is_fresh(obtained_at: datetime | None) -> bool:
    return obtained_at is not None and datetime.now(UTC) - obtained_at < SESSION_TTL


class GridSession:
    """One logged-in session, shared by every process that talks to the grid."""

    def __init__(self, key: str | None = SESSION_KEY) -> None:
        #: Redis key of the shared session. None keeps it in this process only,
        #: which is how every process used to behave, and what tests use.
        self._key = key
        self._cookie: str | None = None
        self._obtained_at: datetime | None = None
        self._lock = asyncio.Lock()
        self._redis: aioredis.Redis | None = None

    @property
    def configured(self) -> bool:
        """Whether credentials exist at all.

        Absence is a valid state — the grid was anonymous until September —
        so callers report "not configured" rather than treating it as a fault.
        """
        return bool(settings.sandbox_rtsp_username and settings.sandbox_rtsp_password)

    def _client(self) -> aioredis.Redis:
        if self._redis is None:
            self._redis = aioredis.from_url(
                settings.redis_url,
                decode_responses=True,
                socket_connect_timeout=3,
                socket_timeout=3,
            )
        return self._redis

    async def _shared(self) -> tuple[str | None, datetime | None]:
        """The session every process is using, if there is one.

        If Redis cannot be reached this process carries on with its own, the
        way it worked before sessions were shared, rather than having none.
        """
        if self._key is None:
            return self._cookie, self._obtained_at
        try:
            raw = await self._client().get(self._key)
        except RedisError as exc:
            log.warning("grid.session_store_unreachable", error=str(exc))
            return self._cookie, self._obtained_at
        if not raw:
            return None, None
        try:
            data = json.loads(raw)
            return str(data["cookie"]), datetime.fromisoformat(data["obtained_at"])
        except (ValueError, KeyError, TypeError):
            return None, None

    async def _share(self, cookie: str, obtained_at: datetime) -> None:
        self._cookie, self._obtained_at = cookie, obtained_at
        if self._key is None:
            return
        try:
            await self._client().set(
                self._key,
                json.dumps({"cookie": cookie, "obtained_at": obtained_at.isoformat()}),
                ex=int(SESSION_TTL.total_seconds()),
            )
        except RedisError as exc:
            log.warning("grid.session_store_unreachable", error=str(exc))

    async def _login_once(self, refused: str | None) -> str | None:
        """Log in, unless another process just has or a login is not yet due.

        Made under a lock every process shares, and re-checked inside it: the
        process that held the lock before us may already have logged in, and
        a second login would be a second session — the thing the grid refuses.
        `refused` is the cookie the grid just turned away, or None when there
        is simply no session yet.
        """
        lock_key = f"{self._key}:lock"
        token = secrets.token_hex(8)
        locked = False
        if self._key is not None:
            loop = asyncio.get_running_loop()
            deadline = loop.time() + LOGIN_WAIT_S
            while not locked:
                try:
                    locked = bool(
                        await self._client().set(
                            # Outlives the login's own 20 s timeout, so a slow
                            # login cannot lose the lock to a second one.
                            lock_key,
                            token,
                            nx=True,
                            ex=int(LOGIN_WAIT_S) + 10,
                        )
                    )
                except RedisError:
                    break  # no shared store: behave as the only process
                if locked:
                    break
                cookie, obtained_at = await self._shared()
                if cookie and cookie != refused and _is_fresh(obtained_at):
                    self._cookie, self._obtained_at = cookie, obtained_at
                    return cookie
                if loop.time() > deadline:
                    log.warning("grid.login_wait_timed_out")
                    return None
                await asyncio.sleep(0.25)

        try:
            cookie, obtained_at = await self._shared()
            if cookie and cookie != refused and _is_fresh(obtained_at):
                self._cookie, self._obtained_at = cookie, obtained_at
                return cookie
            if (
                refused is not None
                and cookie == refused
                and obtained_at is not None
                and datetime.now(UTC) - obtained_at < RELOGIN_MIN_INTERVAL
            ):
                log.warning(
                    "grid.session_refused_again",
                    hint="another session holds this address; not logging in again "
                    f"for {RELOGIN_MIN_INTERVAL.seconds}s",
                )
                return None
            fresh = await self._login()
            if fresh is not None:
                await self._share(fresh, datetime.now(UTC))
            return fresh
        finally:
            if locked:
                try:
                    # redis-py types EVAL for its sync and async clients at once
                    # (`Awaitable[str] | str`); on the asyncio client it is
                    # always the awaitable.
                    await cast(
                        Awaitable[object],
                        self._client().eval(_RELEASE_LOCK, 1, lock_key, token),
                    )
                except RedisError as exc:
                    log.warning("grid.session_store_unreachable", error=str(exc))

    async def _login(self) -> str | None:
        """POST the login form and keep the cookie it sets."""
        base = settings.sandbox_base_url.rstrip("/")
        try:
            async with httpx.AsyncClient(timeout=20.0, follow_redirects=False) as client:
                response = await client.post(
                    f"{base}{LOGIN_PATH}",
                    data={
                        "email": settings.sandbox_rtsp_username,
                        "password": settings.sandbox_rtsp_password,
                    },
                    headers={"User-Agent": BROWSER_UA},
                )
        except httpx.HTTPError as exc:
            log.warning("grid.login_failed", error=str(exc))
            return None

        # A successful login redirects; a rejected one renders the form again.
        cookie = response.cookies.get(SESSION_COOKIE)
        if not cookie:
            # The re-rendered form says why, and it is not always the
            # password: in September it read "The system is in restricted
            # mode right now". Lead with the grid's own words.
            reason = rejection_reason(response.text)
            log.warning(
                "grid.login_rejected",
                status=response.status_code,
                reason=reason or "the grid gave no reason",
                hint="check SANDBOX_RTSP_* credentials only if the reason is about them",
            )
            return None

        self._cookie = f"{SESSION_COOKIE}={cookie}"
        self._obtained_at = datetime.now(UTC)
        log.info("grid.login_ok", status=response.status_code)
        return self._cookie

    async def cookie(self) -> str | None:
        """The shared session cookie, logging in only if there is none.

        Serialised within the process as well as across processes: thirty
        cameras probing at once would otherwise start thirty logins.
        """
        if not self.configured:
            return None
        async with self._lock:
            cookie, obtained_at = await self._shared()
            if cookie and _is_fresh(obtained_at):
                self._cookie, self._obtained_at = cookie, obtained_at
                return cookie
            return await self._login_once(refused=None)

    async def refused(self, cookie: str | None) -> str | None:
        """The grid turned `cookie` away. Returns one to retry with, or None.

        Turned away means redirected to its login page, or refused with
        `one session per IP`. If another process has already replaced the
        cookie, that replacement is used; if it was replaced under a minute
        ago, nothing is — see `RELOGIN_MIN_INTERVAL`.
        """
        if not self.configured:
            return None
        async with self._lock:
            return await self._login_once(refused=cookie)

    async def headers(self) -> dict[str, str]:
        """Everything a request to the grid needs to be accepted."""
        headers = {
            "User-Agent": BROWSER_UA,
            "Referer": settings.sandbox_base_url.rstrip("/") + "/",
        }
        cookie = await self.cookie()
        if cookie:
            headers["Cookie"] = cookie
        return headers

    async def close(self) -> None:
        """Release the Redis client on shutdown. The session itself is kept:
        the next start reuses it rather than opening another."""
        if self._redis is not None:
            await self._redis.aclose()
            self._redis = None


def is_one_session_refusal(status_code: int, body: str) -> bool:
    """Whether a response is the grid refusing us for another session."""
    return status_code == 403 and ONE_SESSION_PER_IP in body.lower()


class CatalogueCache:
    """The grid's camera list, fetched once per sweep rather than per camera.

    `probe_health` reads the catalogue to find one camera's liveness, and the
    health monitor probes thirty cameras a cycle. Without this that is thirty
    full downloads of the same document from somebody else's CDN every cycle —
    which is both rude and self-defeating: the later requests in a sweep were
    timing out and their cameras were being recorded as unreachable when the
    grid was fine.

    The TTL is shorter than the probe interval, so a sweep sees one consistent
    snapshot and the next sweep sees fresh data.
    """

    #: How long a refusal stands before the catalogue is asked again. Only
    #: successes used to be cached, so while the grid refused us every camera
    #: probe asked again — thirty refused requests a sweep, from an address the
    #: grid had just told to wait for its cooldown.
    REFUSED_TTL = timedelta(minutes=2)

    def __init__(self, ttl: timedelta = timedelta(seconds=20)) -> None:
        self._ttl = ttl
        self._payload: object | None = None
        self._fetched_at: datetime | None = None
        self._failure: str | None = None
        self._failed_at: datetime | None = None
        self._failure_ttl = ttl
        self._refused = False
        self._lock = asyncio.Lock()

    def get(self) -> object | None:
        if self._payload is None or self._fetched_at is None:
            return None
        if datetime.now(UTC) - self._fetched_at > self._ttl:
            return None
        return self._payload

    def put(self, payload: object) -> None:
        self._payload = payload
        self._fetched_at = datetime.now(UTC)
        self._failure = None
        self._failed_at = None
        self._refused = False

    def failure(self) -> str | None:
        """The last failure, while it still stands; None once it is time to ask again."""
        if self._failure is None or self._failed_at is None:
            return None
        if datetime.now(UTC) - self._failed_at > self._failure_ttl:
            return None
        return self._failure

    def put_failure(self, error: str, refused: bool = False) -> None:
        """Remember a failed fetch, so a sweep makes one failed request, not
        thirty. A refusal by the grid stands longer than a network blip."""
        self._failure = error
        self._failed_at = datetime.now(UTC)
        self._failure_ttl = self.REFUSED_TTL if refused else self._ttl
        self._refused = refused

    @property
    def refused(self) -> bool:
        """Whether the standing failure is the grid turning our session away
        (its cooldown, one session per IP, or no session accepted) rather than
        a network fault. The two read differently to an operator: one is the
        grid asking us to wait, the other is something to go and fix."""
        return self._refused and self.failure() is not None

    def clear(self) -> None:
        self._payload = None
        self._fetched_at = None

    @property
    def lock(self) -> asyncio.Lock:
        """Held while fetching, so a sweep makes one request, not thirty."""
        return self._lock


session = GridSession()
catalogue = CatalogueCache()
