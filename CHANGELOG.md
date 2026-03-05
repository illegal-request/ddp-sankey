# Changelog

All notable changes to DDP SanKey are documented here.

Version format: `MAJOR.MINOR.PATCH-beta.N` during pre-release development.
- **PATCH** — bug fixes
- **MINOR** — new features (backward-compatible with existing reports)
- **MAJOR** — breaking changes (data role renames, mapping changes, etc.)
- **-beta.N** label dropped when the visual is declared production-ready

The `.pbiviz` file for each release is attached to the corresponding [GitHub Release](https://github.com/illegal-request/ddp-sankey/releases).

---

## [1.2.3-beta.1] — 2026-03-05

### Fixed
- **Ribbon gap on asymmetric nodes** — when a node had more (or thicker) ribbons
  on one side than the other, `reStackRibbons()` centred the smaller cluster in
  the middle of the node, leaving large empty gaps above and below it (e.g. three
  ribbons entering but only one leaving).  The centering logic has been replaced
  with a *fill-scale* approach:
  - Each side's effective ribbon widths are scaled by `nodeHeight / sideTotal` so
    they always span the full node height with no gap.
  - The scale factor is computed independently per side, so an asymmetric node
    (tall because the busier side drove the height) is handled correctly on both
    the source and target faces.
  - Scaled drawing widths are stored in a `Map<string, number>` (keyed by
    `"srcName\x00tgtName"`) and used directly as the SVG `stroke-width` of each
    ribbon path, so the rendered ribbon thickness matches the layout geometry
    precisely.

---

## [1.2.2-beta.1] — 2026-03-05

### Fixed
- **Node overlap after automatic height expansion** — `reStackRibbons()` expanded
  node heights downward but did not move the nodes below out of the way, causing
  nodes in the same column to overlap when font-driven `minRibbonHeight` inflated
  any of their ribbons. A new `resolveColumnOverlaps()` pass runs immediately after
  `reStackRibbons()` and corrects this:
  - Groups nodes by column (same `x0`).
  - Sorts each column top-to-bottom.
  - For each pair of vertically adjacent nodes, if the upper node's `y1` encroaches
    on the lower node's `y0` by less than `nodePadding`, the lower node (and every
    node below it in the same column) is shifted down by exactly the amount needed
    to restore the configured gap.
  - All ribbon endpoints (`link.y0` for source links, `link.y1` for target links)
    at the shifted node are translated by the same delta so ribbons stay correctly
    attached after the node moves.
  - Node padding now behaves consistently whether or not `minRibbonHeight` is active;
    the format-pane **Node Padding** setting no longer needs to be manually increased
    to compensate for the height expansion.

---

## [1.2.1-beta.1] — 2026-03-05

### Fixed
- **Node height — ribbon overflow and overlap** — when `minRibbonHeight` inflated
  thin ribbons beyond their proportional d3-sankey width, the ribbon centres were
  too close together, causing ribbons to overlap each other at the node and spill
  outside the node rectangle. A new `reStackRibbons()` post-layout pass corrects
  this for every node:
  - Computes each ribbon's *effective* width: `max(minRibbonHeight, natural width)`.
  - Expands the node downward (`y1`) until the effective ribbons fit without overlap.
  - Re-centres the stacked ribbons (`link.y0` / `link.y1`) within the (possibly
    taller) node, balancing them on both the source and target sides.
  - Intermediate nodes (ribbons entering and leaving) are handled on both sides
    independently, so the visual mass is balanced even when the number of incoming
    and outgoing ribbons differs.

- **Node width — text overflow in inside value labels** — when value labels are
  positioned *inside* nodes (`Position: Inside` or *Auto* with a tall enough node),
  the node rectangle was sometimes narrower than the formatted number text, causing
  clipping. The layout now uses a two-pass strategy:
  - Pass 1 runs d3-sankey with the user's **Node Width** setting to obtain each
    node's flow value.
  - Those values are formatted and measured using the browser's canvas 2D API
    (same font family, size, and weight as the value label setting).
  - If any label is wider than the current node width, `effectiveNodeWidth` is set
    to the widest label plus 4 px padding on each side.
  - Pass 2 re-runs d3-sankey with `effectiveNodeWidth` so all nodes are wide enough
    to contain their labels without clipping. Nodes that do not need expansion are
    unaffected; the two-pass overhead is negligible.
  - This only applies when **Show Values** is on, **Show On** is *Nodes*, and
    **Position** is *Inside* or *Auto*. The `Outside` position places labels beyond
    the node rectangle, so no width adjustment is needed.

---

## [1.2.0-beta.1] — 2026-03-05

### Added
- **Color Value field well** — an optional second measure that drives ribbon color
  via a continuous gradient scale, independent of the primary Value that controls
  ribbon width. Typical uses: conversion rate, margin %, churn rate — any metric
  where "is the big flow also the good flow?" matters.

  When the **Color Value** field is populated:
  - Ribbons are colored by a linear gradient scale mapped to the weighted-average
    color value per link (weighted by primary flow volume, so rate-type metrics
    are aggregated correctly across rows sharing the same source → target pair).
  - Nodes retain their existing report-theme colors.
  - Hover tooltips include the color value alongside the flow volume.
  - Removing the field reverts ribbons to theme colors with no other change.

- **Color Scale format card** — controls for the color encoding:
  - **Scheme** — *Sequential* (low → high, default) or *Diverging* (low — mid — high).
  - **Low / Mid / High Color** pickers — defaults are light blue / near-white /
    dark blue; Mid Color applies only to the Diverging scheme.
  - **Legend Position** — a compact gradient legend (field name, color bar, min/max
    labels) is drawn in one of four corners: Bottom Right (default), Bottom Left,
    Top Right, or Top Left. The legend is fixed outside the zoom layer so it stays
    visible while the diagram is panned or zoomed.
  - **Show Color Scale** header toggle — disables color encoding and hides the
    legend without removing the Color Value field from the data model.

---

## [1.1.0-beta.1] — 2026-03-05

### Changed
- **Selection highlighting — downstream emphasis** — clicking a node or ribbon
  now emphasises the selected element and every node and ribbon that lies
  downstream (reachable by following links forward), while de-emphasising
  everything else to 15 % opacity. Previously, only the clicked element and
  its immediate neighbours were affected.

  Behaviour by click target:
  - **Node click** — the node and all downstream nodes are fully opaque;
    all ribbons whose source is in that downstream set are fully opaque;
    everything else fades to 15 %.
  - **Ribbon click** — the ribbon, its source node, and all nodes/ribbons
    downstream of the ribbon's target are fully opaque; everything else fades.
  - **Background click** — clears the selection; all elements return to
    full opacity (existing behaviour unchanged).

  Cross-filtering of other report visuals is unchanged — the selection IDs
  sent to Power BI are the same as before; only the visual emphasis logic
  has changed.

  Implementation: a `refreshDownstream()` BFS helper walks `sourceLinks`
  forward from the selection start point and stores reachable node names
  in a `Set<string>`. The set is seeded once after layout (to handle any
  carried-over selection state) and refreshed in both click handlers before
  the opacity attributes are re-applied.

---

## [1.0.4-beta.1] — 2026-03-05

### Changed
- **Version visible in hover tooltip** — hovering over the visual icon in
  Power BI's visualizations pane now shows the version number at the start of
  the description (e.g. "v1.0.4.0 - Sankey flow diagram..."). The version is
  injected into the description by `build.ps1` at package time and restored
  immediately after, so `pbiviz.json` stays clean and git never sees the
  change. The `try/finally` block ensures the restore happens even if the
  build fails.

---

## [1.0.3-beta.1] — 2026-03-05

### Changed
- **Output filename** — the built `.pbiviz` file is now named
  `DDP_Sankey_{version}.pbiviz` (e.g. `DDP_Sankey_1.0.3.0.pbiviz`) instead
  of the internal GUID-prefixed name. `build.ps1` renames the file immediately
  after the pbiviz packager finishes.
- **Visual GUID** — changed from `SankeyVisual1A2B3C4D5E6F7A8B9C0D1E2F` to
  `DDP_Sankey`. ⚠️ This is a one-time breaking change: Power BI uses the GUID
  to identify a visual, so any report using a previous version will need the
  visual removed and re-added from the new `.pbiviz`.

---

## [1.0.2-beta.1] — 2026-03-05

### Changed
- **Minimum ribbon height** — ribbons now have a minimum vertical thickness
  equal to the larger of the label font size and the value font size (whichever
  is active), plus 4 px of padding (2 px each side). Previously, low-value
  flows could produce ribbons too thin to read text against. Ribbon proportions
  are intentionally relaxed for small-value flows that fall below the minimum —
  the user explicitly does not require strict value-proportional widths.
  Adjusting either font size in the format pane will dynamically update the
  floor for all ribbons.

---

## [1.0.1-beta.1] — 2026-03-05

### Changed
- **Link Opacity control** — replaced the decimal number input (0–1) with a
  percentage slider (0–100 %). The slider is easier to read and drag to a
  precise value. The default is unchanged at 45 %. Stored values from
  v1.0.0-beta.1 will need to be reset in the format pane (the old decimal
  value, e.g. 0.45, is now interpreted as 0.45 % rather than 45 %).

---

## [1.0.0-beta.1] — 2026-03-05

First tagged pre-release. Establishes the baseline feature set built during
initial development.

### Added
- **Multi-column path levels** — drag 2 or more columns into Path Levels; each
  consecutive pair becomes a column of nodes with proportional ribbons between them
- **Theme-aware node colours** — colours are drawn from `host.colorPalette` so
  they automatically match the active Power BI report theme
- **Blank value support** — null / empty cells at any level are displayed as a
  `(Blank)` node rather than being silently dropped; blanks are unique per parent
  path so sibling blanks never merge into a single node
- **Cross-filtering** — clicking a node or ribbon filters all other visuals on the
  page; Ctrl/Cmd-click for multi-select; clicking the background clears the filter
- **Zoom & pan** — scroll wheel to zoom, drag to pan, double-click to reset to
  the original view
- **Field-well ordering** — top-to-bottom column order in the Path Levels field
  well maps directly to left-to-right layout in the visual
- **Format pane — Nodes card** — Node Width (px), Node Padding (px)
- **Format pane — Links card** — Link Opacity (0–1)
- **Format pane — Labels card** — Show/Hide toggle, font family/size/bold/italic/
  underline, font colour
- **Format pane — Values card** — Show/Hide toggle, Show On (Nodes or Ribbons),
  Position (Inside / Outside / Auto), font family/size/bold/italic/underline,
  font colour

### Fixed
- Column reordering in the field well was not reflected in the visual layout;
  resolved by switching from `table` to `categorical` dataViewMapping which
  preserves field-well column order
- Nodes with the same display name at different hierarchy levels were incorrectly
  merged by d3-sankey; resolved by prefixing all internal node keys with their
  level index (`${level}\x01${label}`)
- `(Blank)` nodes at the same level but under different parent paths were merged
  into a single node; resolved by embedding the parent's disambiguated key into
  the blank node's internal key while keeping the display label as `(Blank)`

---

<!-- Template for future entries:

## [X.Y.Z-beta.N] — YYYY-MM-DD

### Added
-

### Changed
-

### Fixed
-

### Removed
-

-->
