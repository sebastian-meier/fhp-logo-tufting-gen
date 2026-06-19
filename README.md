# fhp-logo-tufting-gen

Two-script generative design toolkit for turning a vector logo into multi-colour tufting graphics.

- **`generate-logo.js`** — slices the logo into vertical strips, offsets each strip vertically, and colours them from a palette. Optionally divides each strip into horizontal segments with independent offsets for a more fragmented glitch. The background is a flat colour.
- **`generate-background.js`** — keeps the logo intact (rendered in the background colour) while dividing the surrounding area into a grid of independently coloured cells. Colour is distributed so the *visible* area of each cell (accounting for logo overlap) matches the configured percentages.

Both scripts share the same config file and export per-colour black/white separations ready for a tufting machine.

## Requirements

- Node.js 18+

## Install

```sh
npm install
cp config.sample.json config.json
```

`config.json` is your local, untracked working copy (see [Configuration](#configuration-configjson)) — it's gitignored so personal tweaks (palette, seeds, sizes, …) don't end up in version control. [config.sample.json](config.sample.json) is the tracked template; copy it again whenever you want to reset to defaults.

## Usage

```sh
npm run generate            # logo glitch — uses config.json
node generate-logo.js path/to/other-config.json   # use a different config file

npm run generate-background            # background glitch — uses config.json
node generate-background.js path/to/other-config.json

npm run clean               # delete everything generate-logo.js / generate-background.js produced
node clean.js path/to/other-config.json

npm run seeds -- 5          # write 5 fresh random seeds into config.json's glitch.seeds
node seeds.js 5 path/to/other-config.json
```

All paths in the config file are resolved relative to the config file's own location, not the current working directory.

## How it works

### Logo glitch (`generate-logo.js`)

1. The input SVG is rasterized and centered on a transparent canvas matching the output size.
2. The canvas is divided into `glitch.sliceCount` equal-width vertical strips.
3. Each strip is assigned one of the palette colours (in proportion to `percentage`, see below) and a random vertical offset between `-maxOffset` and `+maxOffset` pixels.
4. If `glitch.segments` is enabled, each strip is further divided into `segmentCount` equal-height horizontal segments, and each segment gets its own additional random vertical offset.
5. The actual ink bounding box of the offset strips (and segments) is measured, and the crop window is centered on it — so the glitched logo stays centered in the canvas regardless of how the random offsets skew.
6. The coloured, offset strips are composited onto the background colour canvas, producing the `width`×`height` image.
7. If `output.canvasWidth`/`canvasHeight` are set, that image is placed in the upper-left of a larger canvas — see [Canvas expansion](#canvas-expansion).
8. If separations are enabled, the same strip/segment layout exports one black/white PNG per palette colour, plus one for the background — see [Color separations](#color-separations).

The separations are built from the same strip plan and the same centering calculation, so they always line up exactly with the main output.

### Background glitch (`generate-background.js`)

1. The input SVG is rasterized and centered on a transparent canvas matching the output size.
2. The canvas is divided into `glitch.sliceCount` equal-width vertical strips.
3. If `glitch.segments` is enabled, each strip is independently cut into `segmentCount` horizontal segments at *random* positions (different per strip and per seed), creating an organic, non-banded grid of cells.
4. For each cell, the number of pixels not covered by the logo is counted — this is the cell's *visible area*.
5. Cells are assigned palette colours by a greedy algorithm (processing cells in a random order per seed) so that each colour's total visible area matches the configured percentages as closely as possible. This corrects for the logo overlapping some cells more than others.
6. Each cell is painted as a solid rectangle of its assigned colour, filling the entire canvas.
7. The logo is composited on top in the background colour, appearing as a solid cutout shape.
8. If separations are enabled, one black/white PNG is exported per palette colour (showing that colour's cells, with the logo area removed), plus one for the background colour (the logo shape itself).

## Configuration (`config.json`)

`config.json` is gitignored and local to your checkout. [config.sample.json](config.sample.json) is the tracked template — a minimal config that omits fields with sensible defaults; run `cp config.sample.json config.json` to (re)create your working copy. The example below shows every available field, including the optional ones.

```json
{
    "output": {
        "width": 375,
        "height": 260,
        "dst": "assets/output.png",
        "naming": "seed",
        "canvasWidth": 375,
        "canvasHeight": 320,
        "canvasEnabled": true,
        "separations": {
            "enabled": true,
            "dir": "assets/separations",
            "prefix": "color"
        }
    },
    "input": {
        "src": "assets/logo.svg",
        "offsetX": 0,
        "offsetY": 0
    },
    "palette": {
        "background": "#ffffff",
        "colors": [
            { "hex": "#ff2d55", "percentage": 50 },
            { "hex": "#00b3a4", "percentage": 30 },
            { "hex": "#1a1a1a", "percentage": 20 }
        ]
    },
    "glitch": {
        "sliceCount": 30,
        "maxOffset": 16,
        "fit": 0.85,
        "seeds": [1234, 5678, 91011],
        "segments": {
            "enabled": false,
            "segmentCount": 5,
            "maxOffset": 8
        }
    }
}
```

### `output`

| Field | Type | Description |
|---|---|---|
| `width` | number | Canvas width in pixels — the glitch is generated at this size. |
| `height` | number | Canvas height in pixels — the glitch is generated at this size. |
| `dst` | string | Path to the main output PNG. When generating a batch (see `glitch.seeds`), a label is inserted before the extension — see `naming` below. |
| `naming` | `"seed"` \| `"index"` | Controls the batch filename suffix. `"seed"` (default) uses the seed value, e.g. `output-1234.png`. `"index"` uses a zero-padded sequential number, e.g. `output-001.png`, `output-002.png` — useful for importing the series into Photoshop. |
| `canvasWidth`, `canvasHeight` | number | Optional. If set (both must be set together), the generated `width`×`height` image is placed in the upper-left corner of a larger `canvasWidth`×`canvasHeight` canvas — see [Canvas expansion](#canvas-expansion). |
| `canvasEnabled` | boolean | Only relevant when `canvasWidth`/`canvasHeight` are set. Defaults to `true`; set to `false` to keep the dimensions in the config without applying the canvas expansion. |
| `separations` | object \| omitted | Color separation export settings. Omit entirely, or set `enabled: false`, to skip separations. |
| `separations.enabled` | boolean | Defaults to `true` if the `separations` object is present. Set to `false` to keep the block in the config (for documentation/reference) without generating separation files. |
| `separations.dir` | string | Directory for separation PNGs. In a batch run, each seed gets its own subfolder named by the same label as the main output (seed value or padded index), e.g. `assets/separations/1234/` or `assets/separations/001/`. |
| `separations.prefix` | string | Filename prefix for the per-colour separation files. Defaults to `color`. |

### `input`

| Field | Type | Description |
|---|---|---|
| `src` | string | Path to the source SVG logo. |
| `offsetX` | number | Optional. Horizontal offset in pixels from the centered position. Positive = right, negative = left. Clamped so the logo stays within the canvas. Defaults to `0`. |
| `offsetY` | number | Optional. Vertical offset in pixels from the centered position. Positive = down, negative = up. Clamped so the logo stays within the canvas. Defaults to `0`. |

### `palette`

| Field | Type | Description |
|---|---|---|
| `background` | string | Hex colour (`#rrggbb`) for the canvas background and the "background" separation. |
| `colors` | array | List of `{ "hex": "#rrggbb", "percentage": number }` objects — the colours the logo strips are drawn in. |

`percentage` values are weights, not strict percentages — they don't need to add up to 100 (e.g. `1, 1, 2` works the same as `25, 25, 50`).

**Logo glitch**: each colour receives an exact share of strips proportional to its weight (using largest-remainder rounding so totals always equal `sliceCount`), then the strip order is shuffled so same-coloured strips don't clump. With many strips the proportions in the final image closely match the configured values; with very few strips expect more rounding variance.

**Background glitch**: colours are distributed by *visible pixel area* rather than strip count. For each seed, cells are processed in a random order and each cell is assigned to whichever colour is furthest below its pixel-area target. This corrects for the logo covering some cells more than others, so the visible colour proportions match the configured weights regardless of logo size or position.

### `glitch`

| Field | Type | Description |
|---|---|---|
| `sliceCount` | number | How many vertical strips the canvas is divided into. |
| `maxOffset` | number | **Logo glitch only.** Maximum vertical displacement (in pixels) applied to any strip, in either direction. |
| `fit` | number | Fraction (0–1) of the canvas the logo is scaled to fit within, preserving its aspect ratio. Defaults to `0.85`. |
| `seed` | number | Used when `seeds` is not set. A fixed seed makes the output reproducible; omit it to get a different random result every run. |
| `seeds` | array of numbers | Generates one variant per seed in a single run — see [Batch generation](#batch-generation). Takes precedence over `seed`. |
| `segments` | object \| omitted | Optional horizontal subdivision of each strip — see [Segment glitch](#segment-glitch) below. Omit entirely, or set `enabled: false`, to disable. |
| `segments.enabled` | boolean | Defaults to `false`. Set to `true` to enable segment subdivision. |
| `segments.segmentCount` | number | How many horizontal segments each vertical strip is split into. Defaults to `5`. |
| `segments.maxOffset` | number | **Logo glitch only.** Maximum additional vertical displacement (in pixels) per segment. Defaults to `8`. The total worst-case displacement is `maxOffset + segments.maxOffset`. |

## Batch generation

Set `glitch.seeds` to an array to produce a whole set of variants in one run, one per seed:

```json
"glitch": { "seeds": [1234, 5678, 91011], "sliceCount": 30, "maxOffset": 16 }
```

With `output.naming` set to `"seed"` (the default), this produces `assets/output-1234.png`, `assets/output-5678.png`, `assets/output-91011.png` (and, if separations are enabled, `assets/separations/1234/`, …).

Set `output.naming` to `"index"` to get a zero-padded sequential number instead — `assets/output-1.png`, `assets/output-2.png`, `assets/output-3.png` (padded to match the total count, so 120 seeds → `output-001.png` … `output-120.png`). This is handy for importing the batch as an image sequence in Photoshop or After Effects.

If `seeds` is omitted, a single image is generated using `glitch.seed` (or a random seed if that's also omitted), written to the plain `output.dst` path with no suffix.

### Generating a batch of seeds

Rather than inventing seed numbers by hand, use `seeds.js` to fill `glitch.seeds` with N fresh, unique random values:

```sh
npm run seeds -- 10            # writes 10 random seeds into config.json
node seeds.js 10 my-config.json   # or target a different config file
```

It rewrites only the `"seeds": [...]` line in place (or inserts one into the `glitch` object if it's missing), leaving the rest of the file's formatting untouched. Run `npm run generate` afterwards to render the new batch.

## Color separations

When `output.separations` is enabled, in addition to the main composite, one pure black/white PNG is written per colour area. The exact files differ between the two scripts.

**Logo glitch (`generate-logo.js`)**

- `background-<hex>.png` — black wherever the background colour appears (i.e. everywhere the logo is not).
- `<prefix>-1-<hex>.png`, `<prefix>-2-<hex>.png`, … — one per `palette.colors` entry, black wherever that colour appears in the glitched logo strips.

**Background glitch (`generate-background.js`)**

- `background-<hex>.png` — black wherever the logo sits (the logo is rendered in the background colour, so this is the logo's stencil).
- `<prefix>-1-<hex>.png`, `<prefix>-2-<hex>.png`, … — one per `palette.colors` entry, black wherever that colour appears in the background cells, with the logo area removed.

In both cases the separations are:
- **Pure binary** — every pixel is either pure black (`#000000`) or pure white (`#ffffff`); no grayscale or antialiasing.
- **Mutually exclusive and exhaustive** — every pixel is black in exactly one file, so overlaying all of them reconstructs the full image with no gaps or overlaps.

This is intended for production workflows (e.g. tufting) where each colour needs its own clean stencil/mask.

## Segment glitch

When `glitch.segments.enabled` is `true`, each vertical strip is subdivided into `segmentCount` horizontal pieces. The two scripts use segments differently.

### Logo glitch

Each strip is cut into equal-height segments, and every segment gets its own random vertical offset (independent of the strip's offset), so the strip appears fragmented rather than shifting as a single block.

```json
"glitch": {
    "sliceCount": 30,
    "maxOffset": 16,
    "segments": {
        "enabled": true,
        "segmentCount": 8,
        "maxOffset": 12
    }
}
```

- The total worst-case displacement is `maxOffset + segments.maxOffset`. The padded working canvas and the centred-crop calculation both account for the combined range automatically.
- Existing seeds (without segments enabled) are unaffected — disabling segments is equivalent to one full-height segment per strip with zero extra offset.
- Color separations are derived from the same strip/segment plan, so they always match the main output.

### Background glitch

Each strip is cut into `segmentCount` segments at *random* positions drawn independently per strip and per seed. Adjacent strips therefore have different cut points, producing an organic, non-banded grid rather than aligned horizontal bands. `segments.maxOffset` has no effect here (background cells are solid colour with no vertical displacement).

```json
"glitch": {
    "sliceCount": 30,
    "segments": {
        "enabled": true,
        "segmentCount": 8
    }
}
```

- With segments disabled (or `segmentCount: 1`), each strip is a single full-height cell of one colour.
- The random cuts are part of the same seed-driven RNG sequence, so the same seed always produces the same cut positions and the same colour layout.

## Canvas expansion

By default the output PNG is exactly `output.width`×`output.height`. Setting `output.canvasWidth`/`output.canvasHeight` places that generated image in the upper-left corner (untouched, unscaled) of a larger canvas instead — useful when the glitch needs to sit within a bigger fixed-size frame.

```json
"output": { "width": 375, "height": 180, "canvasWidth": 375, "canvasHeight": 260 }
```

- On the **main output**, the extra margin is transparent.
- On **separations**, the extra margin is opaque white — consistent with white meaning "no ink" everywhere else in a separation. The mutual-exclusivity guarantee (each pixel black in exactly one separation) still holds within the original `width`×`height` region; in the margin, every separation is simply white.

Set `output.canvasEnabled: false` to keep `canvasWidth`/`canvasHeight` in the config without applying this step (output stays exactly `width`×`height`).

## Cleaning up

```sh
npm run clean
```

Removes the main output file, any batch variants (`output-<seed>.png`), and the entire separations directory, as defined by the config file. Leaves the input SVG and everything else untouched. Safe to run on an already-clean project (prints `Nothing to clean.`).

## Project structure

```
assets/
  logo.svg              # input logo (tracked)
  output*.png           # generated output(s) — not tracked, removed by `npm run clean`
  separations/           # generated color separations — not tracked, removed by `npm run clean`
config.sample.json       # tracked template — copy to config.json to get started
config.json              # your local generation settings — gitignored
generate-logo.js         # logo is sliced into glitched colored strips; background is flat
generate-background.js   # logo stays intact; background is sliced into glitched colored strips
clean.js                 # removes generated output
seeds.js                 # writes N fresh random seeds into config.json
```
