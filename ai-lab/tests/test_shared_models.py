"""Models are loaded once per process and shared by every pipeline.

A pipeline per camera used to load its own five ONNX sessions, ~1.4 GB a slot,
which capped a worker at four cameras. The organisers' grid has thirty. The
pipelines still keep their own tracker and bookkeeping; only the models, which
set their state once at load and run concurrently, are shared.
"""

from __future__ import annotations

from dataclasses import dataclass

import pytest

import ailab.pipeline as pipeline_module


@dataclass
class _Section:
    engine: str = "fake"
    imgsz: int = 640


@pytest.fixture
def counted(monkeypatch: pytest.MonkeyPatch) -> list[tuple]:
    built: list[tuple] = []

    def fake_create(kind: str, engine: str, *args: object) -> object:
        built.append((kind, engine, args))
        return object()

    monkeypatch.setattr(pipeline_module, "create", fake_create)
    monkeypatch.setattr(pipeline_module, "_SHARED_MODELS", {})
    return built


def test_the_same_model_and_settings_load_once(counted: list[tuple]) -> None:
    first = pipeline_module._shared("detector", "fake", _Section(), "/models/a.onnx")
    second = pipeline_module._shared("detector", "fake", _Section(), "/models/a.onnx")

    assert first is second
    assert len(counted) == 1


def test_different_weights_or_settings_load_separately(counted: list[tuple]) -> None:
    a = pipeline_module._shared("detector", "fake", _Section(), "/models/a.onnx")
    b = pipeline_module._shared("detector", "fake", _Section(), "/models/b.onnx")
    c = pipeline_module._shared("detector", "fake", _Section(imgsz=1280), "/models/a.onnx")

    assert len({id(a), id(b), id(c)}) == 3
    assert len(counted) == 3


def test_ocr_is_built_without_weights(counted: list[tuple]) -> None:
    pipeline_module._shared("ocr", "fake", _Section())

    assert counted == [("ocr", "fake", (_Section(),))]
