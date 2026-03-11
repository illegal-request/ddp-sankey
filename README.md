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
| **Color by Source** | Optionally color every flow by the depth-0 node it originates from, making flows visually traceable across all columns |
| **Blank value support** | Null / empty cells are shown as a `(Blank)` node rather than being silently dropped; each blank is unique to its parent path |
| **Cross-filtering** | Click a node or flow to filter other visuals on the page; Ctrl/Cmd-click while another visual is already filtered to stack both filters simultaneously; click the background to clear |
| **Zoom & pan** | Scroll to zoom, drag to pan, double-click to reset |
| **Field-well ordering** | Top-to-bottom order in the Path Levels field well maps left-to-right in the visual |
| **Tapered flows** | Each flow end independently matches the allocated height on that node face, tapering smoothly between source and target widths |
| **Follow Flow Path labels** | Node labels can curve to follow the arc of their primary flow rather than staying horizontal |
| **Gradient Flows** | Ribbons fade from source node color to target node color |
| **Context menu** | Right-click any node, flow, or the empty canvas to open the Power BI context menu (drill-through, spotlight, etc.) |
| **Highlight Direction** | Choose Downstream, Upstream, or Both when selecting nodes/flows |
| **% of Total labels** | Data labels can show raw value, percentage of grand total, or both |
| **Landing Page** | Friendly mini-diagram and instructions shown when no data fields are mapped |
| **Native Tooltips** | Hover tooltips use the Power BI Tooltip API — supports report-page tooltips |

---

## Format pane options

### Nodes
- **Node Width (px)** — width of each node rectangle (default 20)
- **Node Padding (px)** — vertical gap between nodes in the same column (default 12)
- **Node Sort** — vertical ordering within each column: `Default` (d3 natural order), `Value (high → low)`, `Value (low → high)`, or `Alphabetical`
- **Highlight Direction** — which direction to emphasise on selection: `Downstream` (default), `Upstream`, or `Both`

### Flows
- **Flow Opacity** — flow transparency, 0–100 % (default 45 %)
- **Minimum Flow Value** — flows below this value are excluded from the diagram entirely (default 0 = show all)
- **Color by Source** — toggle to color all flows by a selected column's nodes, making flows visually traceable across all stages
- **Color Source Column** — dropdown (only active when Color by Source is on) populated with the actual field names from the Path Levels well; pick any column to use as the color anchor
- **Gradient Flows** — fades each ribbon from its source node color to its target node color (compatible with Color by Source)

### Labels
- **Show Labels** — toggle node name labels on/off
- **Position** — `Inside` (default, labels appear between columns alongside flows) or `Outside` (labels appear in a dedicated margin flanking the diagram)
- **Follow Flow Path** — when on, each label curves to follow the arc of the node's primary flow; background pill curves with it
- **Font** — family, size, bold, italic, underline
- **Font Color**
- **Background** — toggle pill-shaped background behind each label
- **Background Color** — default white
- **Transparency** — 0 % (opaque) → 100 % (invisible), default 20 %

### Data Labels
- **Show Data Labels** — toggle value labels on/off
- **Show On** — `Nodes` (total per node) or `Flows` (value per flow)
- **Format** — `Value` (default), `% of Total` (as a percentage of the grand total), or `Value and %` (e.g. `1.2K (34.5%)`)
- **Position** — `Inside`, `Outside`, or `Auto` (auto picks based on node height vs font size)
- **Alignment** — `Left`, `Center` (default), or `Right` — positions flow value labels near the source node, mid-span, or near the target node
- **Display Units** — `Auto` (picks the best unit from the data), `None`, `Thousands` (K), `Millions` (M), or `Billions` (B)
- **Decimal Places** — 0–10 digits after the decimal point (default 0)
- **Font** — family, size, bold, italic, underline
- **Font Color**
- **Background** — toggle pill-shaped background behind each data label
- **Background Color** — default white
- **Transparency** — 0 % (opaque) → 100 % (invisible), default 20 %

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

Output: `dist\DDP_Sankey_1.2.34.0.pbiviz` (filename always matches the current version)

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
