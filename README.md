# DDP SanKey — Power BI Custom Visual

A custom Sankey diagram visual for Power BI, built with the pbiviz SDK, d3-sankey, and d3-zoom.

---

## What it does

Visualises flow or volume data as a Sankey (ribbon) diagram.
Drag two or more columns into **Path Levels** and a numeric measure into **Value** — the visual automatically builds the left-to-right hierarchy and draws proportional ribbons between nodes.

---

## Features

| Feature | Details |
|---|---|
| **Multi-level paths** | Drag any number of columns into Path Levels; each consecutive pair becomes a column of nodes |
| **Theme-aware colours** | Nodes use `host.colorPalette` so they match your report's theme automatically |
| **Blank value support** | Null / empty cells are shown as a `(Blank)` node rather than being silently dropped; each blank is unique to its parent path |
| **Cross-filtering** | Click a node or ribbon to filter other visuals on the page; Ctrl/Cmd-click for multi-select; click the background to clear |
| **Zoom & pan** | Scroll to zoom, drag to pan, double-click to reset |
| **Field-well ordering** | Top-to-bottom order in the Path Levels field well maps left-to-right in the visual |

---

## Format pane options

### Nodes
- **Node Width (px)** — width of each node rectangle (default 20)
- **Node Padding (px)** — vertical gap between nodes in the same column (default 12)

### Links
- **Link Opacity** — ribbon transparency, 0–1 (default 0.45)

### Labels
- **Show Labels** — toggle node name labels on/off
- **Font** — family, size, bold, italic, underline
- **Font Color**

### Values
- **Show Values** — toggle value labels on/off
- **Show On** — `Nodes` (total per node) or `Ribbons` (value per flow)
- **Position** — `Inside`, `Outside`, or `Auto` (auto picks based on node height vs font size)
- **Font** — family, size, bold, italic, underline
- **Font Color**

---

## Data roles

| Role | Kind | Notes |
|---|---|---|
| **Path Levels** | Grouping (multi-column) | Minimum 2 columns; order determines left→right layout |
| **Value** | Measure | Flow weight / volume; rows with Value ≤ 0 are ignored |

---

## Building

Node.js is required. npm is not in the default shell PATH on the build machine, so all builds go through `build.ps1`:

```powershell
powershell.exe -ExecutionPolicy Bypass -File "build.ps1"
```

Output: `dist\DDP_Sankey_1.0.2.0.pbiviz` (filename always matches the current version)

Install the `.pbiviz` in Power BI Desktop via **Home → Import a visual from a file**.

---

## Dependencies

| Package | Version | Purpose |
|---|---|---|
| `powerbi-visuals-api` | ~5.9 | Power BI visual SDK |
| `powerbi-visuals-utils-formattingmodel` | ^6.0 | Format pane model (FontControl, ColorPicker, etc.) |
| `d3-sankey` | ^0.12.3 | Sankey layout engine |
| `d3-selection` | ^3.0 | DOM manipulation |
| `d3-zoom` | ^3.0 | Zoom / pan behaviour |
| `d3-scale-chromatic` | ^3.0 | Colour scale utilities |

---

## Known limitations

- **No circular references** — d3-sankey does not support cycles in the flow graph
- **No highlight support** — Power BI report-level highlight (cross-highlight) is not implemented; cross-filter (hard selection) is used instead
- **No tooltip API** — tooltips are native SVG `<title>` elements, not the Power BI tooltip panel
- **Single measure** — only one Value measure is supported at a time

---

## Author

James Gleason
