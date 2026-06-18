# fhp-logo-tufting-gen

Generative design tool that turns a logo into a glitched, multi-colour graphic for our tufting system. It slices a vector logo into vertical strips, offsets each strip vertically, and colours the strips from a small palette. Optionally each strip can be further divided into horizontal segments with their own independent vertical offsets for a more fragmented glitch. It can also export per-colour black/white separations ready for a tufting machine.

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
npm run generate            # uses config.json
node generate.js path/to/other-config.json   # use a different config file

npm run clean               # delete everything generate.js produced
node clean.js path/to/other-config.json

npm run seeds -- 5          # write 5 fresh random seeds into config.json's glitch.seeds
node seeds.js 5 path/to/other-config.json
```

All paths in the config file are resolved relative to the config file's own location, not the current working directory.

## How it works

1. The input SVG is rasterized and centered on a transparent canvas matching the output size.
2. The canvas is divided into `glitch.sliceCount` equal-width vertical strips.
3. Each strip is assigned one of the palette colors (in proportion to `percentage`, see below) and a random vertical offset between `-maxOffset` and `+maxOffset` pixels.
4. If `glitch.segments` is enabled, each strip is further divided into `segmentCount` equal-height horizontal segments, and each segment is given an additional independent vertical offset between `-segments.maxOffset` and `+segments.maxOffset` pixels.
5. The actual ink bounding box of the offset strips (and segments) is measured, and the crop window is centered on it — so the glitched logo stays vertically (and horizontally) centered in the canvas no matter how the random offsets happen to skew.
6. The colored, offset strips (or segments) are composited onto a white (or configured background colour) canvas, producing the `width`×`height` image.
7. If `output.canvasWidth`/`canvasHeight` are set, that image is placed in the upper-left of a larger canvas — see [Canvas expansion](#canvas-expansion) below — then saved as the main output PNG.
8. If separations are enabled, the same strip/segment layout is used to export one black/white PNG per palette colour, plus one for the background — see [Color separations](#color-separations) below.

Because the main image and the separations are built from the same strip plan and the same centering calculation, the separations always line up exactly with what's visible in the main output.

## Configuration (`config.json`)

`config.json` is gitignored and local to your checkout. [config.sample.json](config.sample.json) is the tracked template — a minimal config that omits fields with sensible defaults; run `cp config.sample.json config.json` to (re)create your working copy. The example below shows every available field, including the optional ones.

```json
{
    "output": {
        "width": 375,
        "height": 260,
        "dst": "assets/output.png",
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
| `dst` | string | Path to the main output PNG. When generating a batch (see `glitch.seeds`), each variant's seed is inserted before the extension, e.g. `assets/output.png` → `assets/output-1234.png`. |
| `canvasWidth`, `canvasHeight` | number | Optional. If set (both must be set together), the generated `width`×`height` image is placed in the upper-left corner of a larger `canvasWidth`×`canvasHeight` canvas — see [Canvas expansion](#canvas-expansion). |
| `canvasEnabled` | boolean | Only relevant when `canvasWidth`/`canvasHeight` are set. Defaults to `true`; set to `false` to keep the dimensions in the config without applying the canvas expansion. |
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
| `segments` | object \| omitted | Optional second-level glitch pass — see [Segment glitch](#segment-glitch) below. Omit entirely, or set `enabled: false`, to disable. |
| `segments.enabled` | boolean | Defaults to `false`. Set to `true` to enable the segment pass. |
| `segments.segmentCount` | number | How many equal-height horizontal segments each vertical strip is split into. Defaults to `5`. |
| `segments.maxOffset` | number | Maximum additional vertical displacement (in pixels) applied to any individual segment. Defaults to `8`. The total worst-case displacement is `maxOffset + segments.maxOffset`; the padded canvas and centred-crop logic account for both automatically. |

## Batch generation

Set `glitch.seeds` to an array to produce a whole set of variants in one run, one per seed:

```json
"glitch": { "seeds": [1234, 5678, 91011], "sliceCount": 30, "maxOffset": 16 }
```

This produces `assets/output-1234.png`, `assets/output-5678.png`, `assets/output-91011.png` (and, if separations are enabled, `assets/separations/1234/`, `assets/separations/5678/`, `assets/separations/91011/`).

If `seeds` is omitted, a single image is generated using `glitch.seed` (or a random seed if that's also omitted), written to the plain `output.dst` path with no suffix.

### Generating a batch of seeds

Rather than inventing seed numbers by hand, use `seeds.js` to fill `glitch.seeds` with N fresh, unique random values:

```sh
npm run seeds -- 10            # writes 10 random seeds into config.json
node seeds.js 10 my-config.json   # or target a different config file
```

It rewrites only the `"seeds": [...]` line in place (or inserts one into the `glitch` object if it's missing), leaving the rest of the file's formatting untouched. Run `npm run generate` afterwards to render the new batch.

## Color separations

When `output.separations` is enabled, in addition to the main composite, the script writes one pure black/white PNG per palette colour, plus one for the background:

- `background-<hex>.png` — black wherever no logo colour is present (i.e. where the background colour would be used).
- `<prefix>-1-<hex>.png`, `<prefix>-2-<hex>.png`, … — one per `palette.colors` entry, in the order they're listed, black wherever that colour appears in the glitched logo.

These separations are:
- **Pure binary** — every pixel is either pure black (`#000000`) or pure white (`#ffffff`); no grayscale or antialiasing.
- **Mutually exclusive and exhaustive** — every pixel is black in exactly one of the separation files (never zero, never more than one), so overlaying all of them reconstructs the full glitched logo with no gaps or overlaps.

This is intended for production workflows (e.g. tufting) where each colour needs its own clean stencil/mask.

## Segment glitch

When `glitch.segments.enabled` is `true`, each vertical strip is cut into `segmentCount` equal-height horizontal pieces before compositing. Every segment gets its own random vertical offset (independent of the strip's offset), so the strip appears fragmented rather than shifting as a single block.

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
- Color separations work the same way; the segment offsets are already baked into the shared shape mask from which separations are derived.

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
generate.js              # generates the glitch graphic(s) and separations
clean.js                 # removes generated output
seeds.js                 # writes N fresh random seeds into config.json
```
