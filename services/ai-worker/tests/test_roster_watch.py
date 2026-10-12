"""A worker notices a roster change within one focus poll.

The API rewrites a digest of the roster whenever a camera is onboarded, edited
or deleted; the worker reads it every two seconds and rediscovers when it moves.
An API that predates the key, or a Redis blip, must leave the periodic pass in
charge rather than trigger anything.
"""

from __future__ import annotations

import pytest
from redis.exceptions import ConnectionError as RedisConnectionError

from ai_worker.roster_watch import RosterWatch

pytestmark = pytest.mark.asyncio


class FakeRedis:
    def __init__(self, value: str | None = None, fail: bool = False) -> None:
        self.value = value
        self.fail = fail
        self.keys: list[str] = []

    async def get(self, key: str) -> str | None:
        self.keys.append(key)
        if self.fail:
            raise RedisConnectionError("down")
        return self.value


KEY = "nagarnetra:fleet:anpr:version"


async def test_the_first_version_seen_is_acted_on() -> None:
    watch = RosterWatch()
    assert await watch.poll(FakeRedis("v1"), KEY)
    assert watch.version == "v1"


async def test_an_unchanged_version_is_not() -> None:
    watch = RosterWatch()
    redis = FakeRedis("v1")
    await watch.poll(redis, KEY)
    assert not await watch.poll(redis, KEY)
    assert not await watch.poll(redis, KEY)


async def test_a_new_version_is() -> None:
    watch = RosterWatch()
    redis = FakeRedis("v1")
    await watch.poll(redis, KEY)
    redis.value = "v2"
    assert await watch.poll(redis, KEY)
    assert not await watch.poll(redis, KEY)


async def test_an_api_without_the_key_changes_nothing() -> None:
    watch = RosterWatch()
    assert not await watch.poll(FakeRedis(None), KEY)
    assert watch.version is None


async def test_a_redis_failure_reads_as_unchanged() -> None:
    watch = RosterWatch()
    await watch.poll(FakeRedis("v1"), KEY)
    assert not await watch.poll(FakeRedis(fail=True), KEY)
    assert watch.version == "v1"


async def test_it_reads_the_key_it_is_given() -> None:
    redis = FakeRedis("v1")
    await RosterWatch().poll(redis, KEY)
    assert redis.keys == [KEY]


def test_the_key_matches_the_api() -> None:
    """The two sides name the key separately; they must agree."""
    from ai_worker.config import WorkerSettings

    assert WorkerSettings().roster_version_key == KEY
