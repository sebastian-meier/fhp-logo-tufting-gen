# fhp-logo-tufting-gen

Generative design tool that turns a logo into a glitched, multi-colour graphic for our tufting system. It slices a vector logo into vertical strips, offsets each strip vertically, and colours the strips from a small palette. It can also export per-colour black/white separations ready for a tufting machine.

## Requirements

- Node.js 18+

## Install

```sh
npm install
```

## Usage

```sh
npm run generate            # uses config.json
node generate.js path/to/other-config.json   # use a different config file

npm run clean               # delete everything generate.js produced
node clean.js path/to/other-config.json
```

All paths in the config file are resolved relative to the config file's own location, not the current working directory.

## How it works

1. The input SVG is rasterized and centered on a transparent canvas matching the output size.
2. The canvas is divided into `glitch.sliceCount` equal-width vertical strips.
3. Each strip is assigned one of the palette colors (in proportion to `percentage`, see below) and a random vertical offset between `-maxOffset` and `+maxOffset` pixels.
4. The colored, offset strips are composited onto a white (or configured background colour) canvas and saved as the main output PNG.
5. If separations are enabled, the same strip layout is used to export one black/white PNG per palette colour, plus one for the background — see [Color separations](#color-separations) below.

Because the main image and the separations are built from the same strip plan, the separations always line up exactly with what's visible in the main output.

## Configuration (`config.json`)

```json
{
    "output": {
        "width": 375,
        "height": 260,
        "dst": "assets/output.png",
        "separations": {
            "enabled": true,
            "dir": "assets/separations",
            "prefix": "color"
        }
    },
    "input": {
        "src": "assets/logo.svg"
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
        "seeds": [1234, 5678, 91011]
    }
}
```

### `output`

| Field | Type | Description |
|---|---|---|
| `width` | number | Canvas width in pixels. |
| `height` | number | Canvas height in pixels. |
| `dst` | string | Path to the main output PNG. When generating a batch (see `glitch.seeds`), each variant's seed is inserted before the extension, e.g. `assets/output.png` → `assets/output-1234.png`. |
| `separations` | object \| omitted | Color separation export settings. Omit entirely, or set `enabled: false`, to skip separations. |
| `separations.enabled` | boolean | Defaults to `true` if the `separations` object is present. Set to `false` to keep the block in the config (for documentation/reference) without generating separation files. |
| `separations.dir` | string | Directory for separation PNGs. In a batch run, each seed gets its own subfolder, e.g. `assets/separations/1234/`. |
| `separations.prefix` | string | Filename prefix for the per-colour separation files. Defaults to `color`. |

### `input`

| Field | Type | Description |
|---|---|---|
| `src` | string | Path to the source SVG logo. |

### `palette`

| Field | Type | Description |
|---|---|---|
| `background` | string | Hex colour (`#rrggbb`) for the canvas background and the "background" separation. |
| `colors` | array | List of `{ "hex": "#rrggbb", "percentage": number }` objects — the colours the logo strips are drawn in. |

`percentage` values are weights, not strict percentages — they don't need to add up to 100 (e.g. `1, 1, 2` works the same as `25, 25, 50`). Each colour is given an exact share of the strips proportional to its weight (using largest-remainder rounding so the totals always add up to `sliceCount`), then the strip order is shuffled so same-coloured strips don't clump together. With many strips, the resulting colour proportions in the final image closely track the configured percentages; with very few strips, expect more rounding/visual variance.

### `glitch`

| Field | Type | Description |
|---|---|---|
| `sliceCount` | number | How many vertical strips the logo is cut into. |
| `maxOffset` | number | Maximum vertical displacement (in pixels) applied to any strip, in either direction. |
| `fit` | number | Fraction (0–1) of the canvas the logo is scaled to fit within before slicing, preserving its aspect ratio and centering it. Defaults to `0.85`. |
| `seed` | number | Used when `seeds` is not set. A fixed seed makes the glitch pattern reproducible; omit it to get a different random result every run. |
| `seeds` | array of numbers | Generates one variant per seed in a single run — see [Batch generation](#batch-generation). Takes precedence over `seed`. |

## Batch generation

Set `glitch.seeds` to an array to produce a whole set of variants in one run, one per seed:

```json
"glitch": { "seeds": [1234, 5678, 91011], "sliceCount": 30, "maxOffset": 16 }
```

This produces `assets/output-1234.png`, `assets/output-5678.png`, `assets/output-91011.png` (and, if separations are enabled, `assets/separations/1234/`, `assets/separations/5678/`, `assets/separations/91011/`).

If `seeds` is omitted, a single image is generated using `glitch.seed` (or a random seed if that's also omitted), written to the plain `output.dst` path with no suffix.

## Color separations

When `output.separations` is enabled, in addition to the main composite, the script writes one pure black/white PNG per palette colour, plus one for the background:

- `background-<hex>.png` — black wherever no logo colour is present (i.e. where the background colour would be used).
- `<prefix>-1-<hex>.png`, `<prefix>-2-<hex>.png`, … — one per `palette.colors` entry, in the order they're listed, black wherever that colour appears in the glitched logo.

These separations are:
- **Pure binary** — every pixel is either pure black (`#000000`) or pure white (`#ffffff`); no grayscale or antialiasing.
- **Mutually exclusive and exhaustive** — every pixel is black in exactly one of the separation files (never zero, never more than one), so overlaying all of them reconstructs the full glitched logo with no gaps or overlaps.

This is intended for production workflows (e.g. tufting) where each colour needs its own clean stencil/mask.

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
config.json              # all generation settings
generate.js              # generates the glitch graphic(s) and separations
clean.js                 # removes generated output
```
