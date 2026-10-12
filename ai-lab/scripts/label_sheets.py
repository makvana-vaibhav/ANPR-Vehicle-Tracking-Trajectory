#!/usr/bin/env python3
"""Contact sheets for labelling plate crops blind.

Each crop is upscaled for legibility and tiled with a short index (G001, G002,
...) and nothing else: no filename, no camera, no pipeline reading. The index
maps back to the crop through `sheets/index.csv`. A labeller who never opens
`pipeline_reads.csv` (written by `fetch_eval_crops.py`) cannot be steered by
what the pipeline thought, which is the whole point of labelling blind.

Upscaling is for the *labeller's* eyes only (cubic, at most 4x). The benchmark
always reads the original crop file.

Usage
-----
    python scripts/label_sheets.py datasets/grid_ocr_v1 --prefix G
"""

from __future__ import annotations

import argparse
import csv
from pathlib import Path

import cv2
import numpy as np

TILE_W, TILE_H = 470, 150
LABEL_W = 70
COLUMNS, ROWS = 2, 8


def _tile(crop: np.ndarray, tag: str) -> np.ndarray:
    tile = np.full((TILE_H, TILE_W), 255, np.uint8)
    tile = cv2.cvtColor(tile, cv2.COLOR_GRAY2BGR)
    h, w = crop.shape[:2]
    scale = min(4.0, (TILE_H - 10) / h, (TILE_W - LABEL_W - 10) / w)
    resized = cv2.resize(crop, (max(1, round(w * scale)), max(1, round(h * scale))),
                         interpolation=cv2.INTER_CUBIC)
    rh, rw = resized.shape[:2]
    y0 = (TILE_H - rh) // 2
    tile[y0:y0 + rh, LABEL_W:LABEL_W + rw] = resized
    cv2.putText(tile, tag, (4, TILE_H // 2 + 6), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 0, 200), 2)
    cv2.rectangle(tile, (0, 0), (TILE_W - 1, TILE_H - 1), (180, 180, 180), 1)
    return tile


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("dataset", type=Path, help="directory holding manifest.csv and crops/")
    parser.add_argument("--prefix", default="G")
    args = parser.parse_args()

    with (args.dataset / "manifest.csv").open(encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    out = args.dataset / "sheets"
    out.mkdir(exist_ok=True)

    index = []
    tiles = []
    for i, row in enumerate(rows, start=1):
        tag = f"{args.prefix}{i:03d}"
        crop = cv2.imread(str(args.dataset / "crops" / f"{row['id']}.jpg"))
        if crop is None:
            continue
        index.append({"tag": tag, "id": row["id"], "width": crop.shape[1], "height": crop.shape[0]})
        tiles.append(_tile(crop, tag))

    per_sheet = COLUMNS * ROWS
    blank = np.full((TILE_H, TILE_W, 3), 255, np.uint8)
    for start in range(0, len(tiles), per_sheet):
        chunk = tiles[start:start + per_sheet]
        chunk += [blank] * (per_sheet - len(chunk))
        rows_img = [np.hstack(chunk[r * COLUMNS:(r + 1) * COLUMNS]) for r in range(ROWS)]
        sheet = np.vstack(rows_img)
        cv2.imwrite(str(out / f"sheet_{start // per_sheet + 1:02d}.png"), sheet)

    with (out / "index.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=["tag", "id", "width", "height"])
        writer.writeheader()
        writer.writerows(index)
    print(f"{len(tiles)} crops on {(len(tiles) + per_sheet - 1) // per_sheet} sheets in {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
