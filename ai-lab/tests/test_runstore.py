"""Reading a finished run back from disk.

The regression here is `LoadedRun.hard_case_index()`: `ailab run` writes the
index as `{"summary": ..., "cases": [...]}`, and the loader wrapped that object
in `list()`, which yields its keys. `ailab report` then rendered two "hard
cases" named "summary" and "cases", and `ailab mine` harvested none at all.
The index is written here through the same `RunDirectory` and `hardcases`
calls `ailab run` uses, so the two shapes cannot drift apart unnoticed.
"""

from __future__ import annotations

import json
from pathlib import Path

from ailab.artifacts import RunDirectory
from ailab.config import RunConfig
from ailab.mining import hardcases
from ailab.runstore import LoadedRun


def _cases() -> list[dict[str, object]]:
    return [
        {"track_id": 3, "reason": "grammar_invalid", "plate": "GJ0IAB1234"},
        {"track_id": 9, "reason": "no_plate_found", "plate": ""},
    ]


def _run_dir(tmp_path: Path) -> RunDirectory:
    run_dir = RunDirectory(tmp_path, RunConfig(), "clip")
    run_dir.write_manifest({"name": "clip"}, {})
    return run_dir


def test_hard_case_index_returns_the_cases_ailab_run_wrote(tmp_path: Path) -> None:
    run_dir = _run_dir(tmp_path)
    cases = _cases()
    # Exactly what cli._run_pipeline writes.
    run_dir.write_json(
        "hard_cases/index.json", {"summary": hardcases.summarise(cases), "cases": cases}
    )

    loaded = LoadedRun(run_dir.path).hard_case_index()

    assert loaded == cases
    # What `ailab mine` keys on: the tracks it must export as hard cases.
    assert {c["track_id"] for c in loaded if "track_id" in c} == {3, 9}


def test_a_bare_list_index_is_still_read(tmp_path: Path) -> None:
    run_dir = _run_dir(tmp_path)
    (run_dir.path / "hard_cases" / "index.json").write_text(json.dumps(_cases()))
    assert LoadedRun(run_dir.path).hard_case_index() == _cases()


def test_no_index_means_no_hard_cases(tmp_path: Path) -> None:
    run_dir = _run_dir(tmp_path)
    assert LoadedRun(run_dir.path).hard_case_index() == []


def test_a_malformed_index_yields_no_cases_rather_than_keys(tmp_path: Path) -> None:
    run_dir = _run_dir(tmp_path)
    (run_dir.path / "hard_cases" / "index.json").write_text(
        json.dumps({"summary": {"total": 0}, "cases": "not a list"})
    )
    assert LoadedRun(run_dir.path).hard_case_index() == []
