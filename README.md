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
| **Color by Source** | Optionally color every ribbon by the depth-0 node it originates from, making flows visually traceable across all columns |
| **Blank value support** | Null / empty cells are shown as a `(Blank)` node rather than being silently dropped; each blank is unique to its parent path |
| **Cross-filtering** | Click a node or ribbon to filter other visuals on the page; Ctrl/Cmd-click for multi-select; click the background to clear |
| **Zoom & pan** | Scroll to zoom, drag to pan, double-click to reset |
| **Field-well ordering** | Top-to-bottom order in the Path Levels field well maps left-to-right in the visual |
| **Tapered ribbons** | Each ribbon end independently matches the allocated height on that node face; ribbons rendered as filled paths that taper smoothly between source and target widths |
| **Follow Link Path labels** | Node labels can curve to follow the arc of their primary ribbon rather than staying horizontal |
| **Grand Total** | Optional total displayed to the left of the first column, showing the top-line flow volume entering the diagram |

---

## Format pane options

### Nodes
- **Node Width (px)** — width of each node rectangle (default 20)
- **Node Padding (px)** — vertical gap between nodes in the same column (default 12)

### Links
- **Link Opacity** — ribbon transparency, 0–100 % (default 45 %)
- **Color by Source** — toggle to color all ribbons by their originating (leftmost) node

### Labels
- **Show Labels** — toggle node name labels on/off
- **Font** — family, size, bold, italic, underline
- **Font Color**
- **Position** — `Inside` (default, labels appear between columns alongside ribbons) or `Outside` (labels appear in a dedicated margin flanking the diagram)
- **Follow Link Path** — when on, each label curves to follow the arc of the node's primary ribbon; background pill curves with it
- **Background** — toggle pill-shaped background behind each label
- **Background Color** — default white
- **Transparency** — 0 % (opaque) → 100 % (invisible), default 20 %

### Values
- **Show Values** — toggle value labels on/off
- **Show On** — `Nodes` (total per node) or `Ribbons` (value per flow)
- **Position** — `Inside`, `Outside`, or `Auto` (auto picks based on node height vs font size)
- **Alignment** — `Left`, `Center` (default), or `Right` — positions ribbon value labels near the source node, mid-span, or near the target node
- **Font** — family, size, bold, italic, underline
- **Font Color**
- **Background** — toggle pill-shaped background behind each value label
- **Background Color** — default white
- **Transparency** — 0 % (opaque) → 100 % (invisible), default 20 %

### Grand Total
- **Show Grand Total** — toggle the grand total label on/off
- **Font** — family, size (default 14), bold (default on), italic, underline
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

Output: `dist\DDP_Sankey_1.2.21.0.pbiviz` (filename always matches the current version)

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
