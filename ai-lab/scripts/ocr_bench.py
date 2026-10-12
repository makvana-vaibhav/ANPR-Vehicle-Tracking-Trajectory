#!/usr/bin/env python3
"""Plate-reading accuracy and cost on labelled crops, one read per crop.

Each crop goes through the worker's own code: `Pipeline._read_plate` (quality
gate, conditioning variants, OCR, the detection fallback, per-read grammar),
then `consensus` over that single read (the position-aware repair a vehicle's
reading gets). Configurations differ only in the `--set` overrides given, so a
difference in the numbers is a difference those overrides made.

Labels come from two labellers working blind (`label_sheets.py`), adjudicated
mechanically, never by looking at what the pipeline said:

    gold        both read the same text and both were confident (C)
    agreed      both read the same text, at least one only best-guess (U)
    disputed    they read different text: excluded from every accuracy figure
    unreadable  both marked it X (unreadable) or N (not a plate)

Reported per configuration, on the gold set unless stated:

    exact         reading == label, with a Wilson 95% interval
    cer           character error rate (edit distance / label length)
    committed     grammar-valid readings, and how many of them were right —
                  the reads a watchlist would act on
    false_valid   unreadable crops given a grammar-valid plate (false-alert proxy)
    cpu_ms        process CPU per crop, mean and p90; det-fallback firings

and an exact McNemar test of each configuration against the first.

Usage (in the worker image, so the numbers are the worker's):

    python scripts/ocr_bench.py --dataset datasets/grid_ocr_v1 --config stream \\
        --variant 'shipped=preprocess.variants=[rectified,upscaled];ocr.detection_fallback_limit_side_len=736;ocr.detection_fallback_use_cls=true;consensus.drop_leading_junk=false' \\
        --variant 'raw=preprocess.variants=[raw]' --out runs/_ocr_bench
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import sys
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import cv2
import Levenshtein

LAB = Path(__file__).resolve().parents[1]
if str(LAB) not in sys.path:
    sys.path.insert(0, str(LAB))

from ailab import runtime  # noqa: E402
from ailab.aggregate import grammar  # noqa: E402
from ailab.aggregate.consensus import consensus  # noqa: E402
from ailab.config import RunConfig, parse_override  # noqa: E402
from ailab.pipeline import Pipeline  # noqa: E402
from ailab.plate.scheduler import CropGate  # noqa: E402
from ailab.stream.runner import _NullRunDir  # noqa: E402
from ailab.types import BBox, PlateDetection, Track  # noqa: E402

UNREADABLE = {"X", "N"}


@dataclass
class Item:
    tag: str
    crop_id: str
    path: Path
    label: str
    group: str            # gold | agreed | disputed | unreadable | other
    camera: str = ""
    rows: str = ""


@dataclass
class Outcome:
    text: str = ""
    valid: bool = False
    confidence: float = 0.0
    variant: str = ""
    cpu_ms: float = 0.0
    fallbacks: int = 0


@dataclass
class Variant:
    name: str
    overrides: dict[str, Any]
    outcomes: dict[str, Outcome] = field(default_factory=dict)


def _read_labels(path: Path) -> dict[str, dict[str, str]]:
    if not path.exists():
        return {}
    with path.open(encoding="utf-8") as handle:
        return {row["tag"]: row for row in csv.DictReader(handle)}


def load_items(dataset: Path, regions: tuple[str, ...] = ("IN",)) -> list[Item]:
    """Adjudicate the two labellers' files, mechanically.

    Each labeller's text has its O/0 glyph resolved by `canonical_label` first,
    so two people who read the same pixels are not scored as disagreeing over
    a glyph the font draws identically."""
    with (dataset / "sheets" / "index.csv").open(encoding="utf-8") as handle:
        index = {row["tag"]: row for row in csv.DictReader(handle)}
    cameras: dict[str, str] = {}
    manifest = dataset / "manifest.csv"
    if manifest.exists():
        with manifest.open(encoding="utf-8") as handle:
            cameras = {row["id"]: row["camera_code"] for row in csv.DictReader(handle)}
    a, b = _read_labels(dataset / "labels_A.csv"), _read_labels(dataset / "labels_B.csv")
    if not a or not b:
        sys.exit(f"{dataset}: needs labels_A.csv and labels_B.csv from two blind labellers")

    items = []
    for tag, row in sorted(index.items()):
        la, lb = a.get(tag, {}), b.get(tag, {})
        sa, sb = la.get("status", "X"), lb.get("status", "X")
        ta = canonical_label(la.get("label", "").strip().upper(), regions)
        tb = canonical_label(lb.get("label", "").strip().upper(), regions)
        if sa in UNREADABLE and sb in UNREADABLE:
            group, label = "unreadable", ""
        elif "P" in (sa, sb) or sa in UNREADABLE or sb in UNREADABLE:
            group, label = "other", ""
        elif ta != tb:
            group, label = "disputed", ""
        elif sa == "C" and sb == "C":
            group, label = "gold", ta
        else:
            group, label = "agreed", ta
        items.append(Item(
            tag=tag, crop_id=row["id"], path=dataset / "crops" / f"{row['id']}.jpg",
            label=label, group=group, camera=cameras.get(row["id"], ""),
            rows=la.get("rows") or lb.get("rows") or "",
        ))
    return items


def canonical_label(label: str, regions: tuple[str, ...]) -> str:
    """Resolve only the O/0 glyph, which the Indian plate font draws identically.

    A labeller reading pixels cannot tell them apart, and two labellers wrote
    `GJ24A06611` for a plate whose fifth slot can only be a letter. The slot
    decides it — and nothing else is touched: if any other character would
    have to change for the label to be a valid plate, it is left as written.
    """
    if not label or grammar.validate(label, regions).valid:
        return label
    fixed, _template, changed = grammar.coerce(label, regions)
    if changed and all({label[i], fixed[i]} == {"0", "O"} for i in changed):
        return fixed
    return label


def run_variant(base: RunConfig, variant: Variant, items: list[Item]) -> None:
    config = base.with_overrides(variant.overrides) if variant.overrides else base
    pipeline = Pipeline(config)

    fallbacks = {"n": 0}
    engine = pipeline.ocr
    original = getattr(engine, "_detect_and_recognise", None)
    if original is not None:
        def counted(image: Any) -> Any:
            fallbacks["n"] += 1
            return original(image)
        engine._detect_and_recognise = counted   # instrumentation only

    for item in items:
        crop = cv2.imread(str(item.path))
        if crop is None:
            continue
        height, width = crop.shape[:2]
        pipeline.reset_run_state()
        pipeline.crop_gate = CropGate(config.ocr.crop_gate)
        tracks = {1: Track(track_id=1, class_name="car", class_id=2)}
        plate = PlateDetection(
            bbox=BBox(0.0, 0.0, float(width), float(height)), confidence=1.0,
            frame_index=0, t_s=0.0, track_id=1,
        )
        before = fallbacks["n"]
        started = time.process_time()
        pipeline._read_plate(crop, plate, tracks, _NullRunDir(), {}, {}, {}, [])
        reads = tracks[1].plate_reads
        result = consensus(reads, config.consensus) if reads else None
        cpu_ms = (time.process_time() - started) * 1000.0
        variant.outcomes[item.tag] = Outcome(
            text=result.text if result else "",
            valid=bool(result and result.grammar_valid),
            confidence=result.confidence if result else 0.0,
            variant=reads[-1].preprocess_variant if reads else "",
            cpu_ms=cpu_ms,
            fallbacks=fallbacks["n"] - before,
        )


def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return (0.0, 0.0)
    p = k / n
    centre = (p + z * z / (2 * n)) / (1 + z * z / n)
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / (1 + z * z / n)
    return (max(0.0, centre - half), min(1.0, centre + half))


def mcnemar_exact(b: int, c: int) -> float:
    """Two-sided exact McNemar p-value from the discordant pair counts."""
    n = b + c
    if n == 0:
        return 1.0
    k = min(b, c)
    tail = sum(math.comb(n, i) for i in range(k + 1)) / 2**n
    return min(1.0, 2 * tail)


def summarise(variant: Variant, items: list[Item], group: str) -> dict[str, Any]:
    pool = [i for i in items if i.group == group and i.tag in variant.outcomes]
    exact = [i for i in pool if variant.outcomes[i.tag].text == i.label]
    committed = [i for i in pool if variant.outcomes[i.tag].valid]
    committed_right = [i for i in committed if variant.outcomes[i.tag].text == i.label]
    cer = (
        sum(Levenshtein.distance(variant.outcomes[i.tag].text, i.label) / max(1, len(i.label))
            for i in pool) / len(pool)
        if pool else 0.0
    )
    low, high = wilson(len(exact), len(pool))
    return {
        "n": len(pool),
        "exact": len(exact),
        "exact_rate": round(len(exact) / len(pool), 4) if pool else 0.0,
        "exact_ci95": [round(low, 4), round(high, 4)],
        "cer": round(cer, 4),
        "committed": len(committed),
        "committed_right": len(committed_right),
        "committed_precision": (
            round(len(committed_right) / len(committed), 4) if committed else 0.0
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--dataset", required=True, type=Path)
    parser.add_argument("--config", default="stream")
    parser.add_argument("--variant", action="append", default=[],
                        help="name=key=value;key=value (the first is the baseline)")
    parser.add_argument("--out", type=Path, default=LAB / "runs" / "_ocr_bench")
    args = parser.parse_args()

    runtime.apply_opencv_threads()
    base = RunConfig.load(args.config)
    items = load_items(args.dataset, base.consensus.plate_regions)
    variants = []
    for spec in args.variant or ["as_configured="]:
        name, _, rest = spec.partition("=")
        overrides = dict(parse_override(part) for part in rest.split(";") if part.strip())
        variants.append(Variant(name=name, overrides=overrides))

    counts: dict[str, int] = {}
    for item in items:
        counts[item.group] = counts.get(item.group, 0) + 1
    print(f"{args.dataset.name}: {len(items)} crops {counts} · config {base.name}")

    for variant in variants:
        run_variant(base, variant, items)

    report: dict[str, Any] = {
        "dataset": str(args.dataset),
        "config": base.name,
        "groups": counts,
        "runtime": runtime.describe(),
        "variants": {},
    }
    baseline = variants[0]
    gold = [i for i in items if i.group == "gold"]
    unreadable = [i for i in items if i.group == "unreadable"]
    for variant in variants:
        cpu = sorted(o.cpu_ms for o in variant.outcomes.values())
        entry: dict[str, Any] = {
            "overrides": variant.overrides,
            "gold": summarise(variant, items, "gold"),
            "agreed": summarise(variant, items, "agreed"),
            "false_valid_on_unreadable": sum(
                1 for i in unreadable if variant.outcomes[i.tag].valid
            ),
            "cpu_ms_mean": round(sum(cpu) / len(cpu), 2) if cpu else 0.0,
            "cpu_ms_p90": round(cpu[int(0.9 * (len(cpu) - 1))], 2) if cpu else 0.0,
            "fallback_firings": sum(o.fallbacks for o in variant.outcomes.values()),
        }
        if variant is not baseline:
            only_new = sum(
                1 for i in gold
                if variant.outcomes[i.tag].text == i.label
                and baseline.outcomes[i.tag].text != i.label
            )
            only_old = sum(
                1 for i in gold
                if variant.outcomes[i.tag].text != i.label
                and baseline.outcomes[i.tag].text == i.label
            )
            entry["vs_baseline_gold"] = {
                "right_only_here": only_new,
                "right_only_in_baseline": only_old,
                "mcnemar_p": round(mcnemar_exact(only_new, only_old), 5),
            }
        by_camera: dict[str, list[int]] = {}
        for i in gold:
            tally = by_camera.setdefault(i.camera, [0, 0])
            tally[0] += variant.outcomes[i.tag].text == i.label
            tally[1] += 1
        entry["gold_by_camera"] = {cam: f"{k}/{n}" for cam, (k, n) in sorted(by_camera.items())}
        report["variants"][variant.name] = entry

        gold_summary = entry["gold"]
        print(
            f"  {variant.name:<14} gold {gold_summary['exact']}/{gold_summary['n']} "
            f"({100 * gold_summary['exact_rate']:.1f}%, CI {gold_summary['exact_ci95']}) "
            f"cer {gold_summary['cer']:.3f} · committed {gold_summary['committed_right']}/"
            f"{gold_summary['committed']} right · agreed {entry['agreed']['exact']}/"
            f"{entry['agreed']['n']} · false-valid on unreadable "
            f"{entry['false_valid_on_unreadable']}/{len(unreadable)} · cpu "
            f"{entry['cpu_ms_mean']:.1f} ms (p90 {entry['cpu_ms_p90']:.1f}) · "
            f"fallbacks {entry['fallback_firings']}"
            + (
                f" · vs {baseline.name}: +{entry['vs_baseline_gold']['right_only_here']}"
                f"/-{entry['vs_baseline_gold']['right_only_in_baseline']}"
                f" p={entry['vs_baseline_gold']['mcnemar_p']}"
                if "vs_baseline_gold" in entry else ""
            )
        )

    stamp = datetime.now(UTC).strftime("%Y-%m-%dT%H-%M-%S")
    out = args.out / f"{stamp}__{args.dataset.name}"
    out.mkdir(parents=True, exist_ok=True)
    (out / "report.json").write_text(json.dumps(report, indent=2))
    with (out / "per_crop.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["tag", "camera", "group", "label", "rows"]
                        + [f"{v.name}_{k}" for v in variants
                           for k in ("text", "valid", "cpu_ms", "fallbacks")])
        for i in items:
            row: list[Any] = [i.tag, i.camera, i.group, i.label, i.rows]
            for v in variants:
                o = v.outcomes.get(i.tag, Outcome())
                row += [o.text, o.valid, round(o.cpu_ms, 2), o.fallbacks]
            writer.writerow(row)
    print(f"  written to {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
