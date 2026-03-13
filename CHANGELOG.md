# Changelog

All notable changes to DDP SanKey are documented here.

Version format: `MAJOR.MINOR.PATCH-beta.N` during pre-release development.
- **PATCH** — bug fixes
- **MINOR** — new features (backward-compatible with existing reports)
- **MAJOR** — breaking changes (data role renames, mapping changes, etc.)
- **-beta.N** label dropped when the visual is declared production-ready

The `.pbiviz` file for each release is attached to the corresponding [GitHub Release](https://github.com/illegal-request/ddp-sankey/releases).

---

## [1.2.46.0] — 2026-03-12

### Changed
- **Hide Blank Nodes — level-0 blanks now preserved** — when Hide Blank Nodes
  is on, a blank value in the first column (level 0) is no longer excluded.
  It appears as a `(Blank)` node in column 0 with its flows to non-blank
  column-1 nodes intact, so the entire dataset is accounted for in the totals.

  The previous rule skipped any link where **either** endpoint was blank.
  The new rule: skip a link only when the **target** (right side) is blank,
  or when the **source** is blank at level 1 or deeper.  Blank at level 0 is
  always kept; blanks at level 1+ still hide flows and terminate paths at the
  last real node.

---

## [1.2.45.0] — 2026-03-12

### Added
- **Color Legend data role** — a new optional field well labelled "Color Legend" accepts
  a single grouping column.  When mapped, the visual uses that column's values as the
  color keys for level-0 nodes (and any flows they colour), instead of the level-0
  field values themselves.

  **Use case:** if a co-located Pie chart (or bar/line chart) uses the same column as
  its Legend, dragging that same column into the Sankey's Color Legend well makes the
  level-0 node colors match the chart's legend slice colors exactly — the same
  cross-visual color consistency that native Power BI visuals achieve by sharing a
  Legend field.

  **Mechanism:** `colorPalette.getColor()` is report-level; the same string key always
  returns the same color within a report session.  The visual pre-registers the legend
  column's unique values with the palette in first-appearance (row) order — matching
  the registration sequence used by native visuals — before making any other
  `getColor()` calls.  A row-level map from level-0 label → legend color is then built
  so that `color(label)` returns the legend-sourced color for every level-0 label.

  All other behavior (Color by Source, Gradient Flows, default palette coloring for
  deeper nodes) is unchanged.

---

## [1.2.44.0] — 2026-03-12

### Fixed
- **Isolated source nodes** (definitive fix) — level-0 nodes that have data but
  no downstream flows (e.g. "Discontinued" products) now reliably appear as
  correctly-sized bars in column 0 when Hide Blank Nodes is on.

  Two earlier attempts both failed:
  - v1.2.42 used `fixedValue` alone with no links. d3-sankey's breadth solver is
    topology-driven; a zero-link node gets `y0 = y1 = 0` regardless of `fixedValue`.
  - v1.2.43 bypassed d3-sankey and manually injected nodes into `graph.nodes`
    after the fit-to-viewport pass. After fitting, existing nodes already fill
    `innerH`; injected nodes landed below the visible area.

  The working approach passes each isolated node to d3-sankey with two mechanisms:
  1. `fixedValue = accumulated value` — d3-sankey sizes the bar from the real row
     total rather than an empty link sum.
  2. A phantom link (value = 0.001) to a shared `__phantom_sink__` dummy node —
     gives d3-sankey enough graph topology to place the node in column 0 alongside
     other level-0 nodes and distribute it vertically with the normal proportional
     algorithm.
  The phantom sink and its links are stripped from the graph in-place immediately
  after layout (before `reStackRibbons`) and are never rendered.  The ε link value
  means the phantom sink occupies negligible space in its column.  Selection,
  cross-filtering, and tooltips on isolated nodes work as normal.

---

## [1.2.43.0] — 2026-03-12

### Fixed
- **Isolated source nodes** (intermediate attempt, superseded by v1.2.44) —
  removed isolated nodes from the d3-sankey input entirely and injected them
  into `graph.nodes` after the fit-to-viewport pass with manually computed
  y-coordinates.  Correctly avoids the zero-link sizing problem but places nodes
  below the last column-0 node; after fit-to-viewport the layout already fills
  `innerH`, so injected nodes land outside the visible area.

---

## [1.2.42-beta.1] — 2026-03-12

### Added
- **Isolated source nodes** (first attempt, superseded by v1.2.44) — introduced
  the `isolatedNodeValues` scan and `fixedValue` mechanism.  Isolated nodes were
  added to the d3-sankey graph with `fixedValue` set to their accumulated value
  but with no outgoing links.  d3-sankey's breadth solver is topology-driven and
  ignores `fixedValue` for vertical placement, so these nodes collapsed to zero
  height and were not visible.

---

## [1.2.41-beta.1] — 2026-03-12

### Fixed
- **Hide Blank Nodes** — definitive column-placement fix: added `enforceNodeColumns`
  post-layout pass that reads the level index directly from each node's key and
  forces `x0`, `x1`, `layer`, `depth`, and `height` to match.  d3-sankey's alignment
  heuristics (including `sankeyLeft`) cannot guarantee correct placement when paths
  have unequal lengths; this override removes that dependency entirely.

---

## [1.2.40-beta.1] — 2026-03-11

### Fixed
- **Hide Blank Nodes** — root cause fix: switched d3-sankey node alignment from
  `sankeyJustify` to `sankeyLeft`.  The default `sankeyJustify` places any sink
  node (no outgoing links) at the *last* column; after blank links are skipped,
  real terminal nodes incorrectly snapped to the rightmost column.  `sankeyLeft`
  places every node at its natural depth (longest incoming path), so a flow that
  ends at level 2 now stops visually at column 2 regardless of how many columns
  the chart has overall.

---

## [1.2.39-beta.1] — 2026-03-11

### Fixed
- **Hide Blank Nodes** — correct implementation: any link where either the source
  or target level is blank is now skipped entirely.  No blank node is ever drawn;
  flows terminate cleanly at the last real node in the row.

---

## [1.2.38-beta.1] — 2026-03-11

### Fixed
- **Hide Blank Nodes** — flows now terminate at the last real (non-blank) node.
  A link to a blank node is skipped unless a real value appears further ahead in
  the same row (meaning the blank is a gap to bridge, not a termination point).
  Blank nodes are never drawn as terminal endpoints.

---

## [1.2.37-beta.1] — 2026-03-10

### Fixed
- **Hide Blank Nodes** — final correction: only blank→blank links where no real
  value appears further ahead in the same row are skipped.  A real→blank link
  (flow terminates at a blank node) is always drawn.  A blank→real link (flow
  passes through a blank) is always drawn.  Only the blank→blank "tail" segments
  with nothing real following them are suppressed.

---

## [1.2.36-beta.1] — 2026-03-10

### Fixed
- **Hide Blank Nodes** — corrected the stop-flow logic.  A flow now continues
  through a blank node as long as any later level in that row has a real value
  (e.g. A → B(blank) → C(value) is fully drawn).  It only stops at a blank node
  when every subsequent level in the same row is also blank.

---

## [1.2.35-beta.1] — 2026-03-10

### Added
- **Hide Blank Nodes** toggle (Flows card) — when on, any flow whose source or
  target level is blank is excluded from the diagram.  Earlier non-blank flows
  in the same row are still drawn, so partial breakdowns in later columns are
  simply omitted rather than collapsing all upstream flows with them.

---

## [1.2.34-beta.1] — 2026-03-10

### Added
- **Landing Page** — when no Path Level columns are mapped, the visual now shows a
  friendly mini Sankey illustration with setup instructions instead of a blank or
  generic error state.  Enabled via `supportsLandingPage: true` in capabilities.
- **Native Tooltips** — nodes and flows now use the Power BI Tooltip API
  (`host.tooltipService`) instead of plain SVG `<title>` elements.  Hovering over
  a node shows its name and formatted value; hovering over a flow shows source,
  target, and value.  This enables report-page tooltips and drillthrough from
  tooltips in future.

---

## [1.2.33-beta.1] — 2026-03-10

### Added
- **Gradient Flows** (Flows card) — new toggle that fades each ribbon from its
  source node color to its target node color using an SVG `linearGradient`.
  Works in both normal and Color by Source modes.  Gradients are deduplicated
  by color pair, so the `<defs>` stays compact even for large diagrams.

---

## [1.2.32-beta.1] — 2026-03-10

### Added
- **Context menu** — right-clicking any node, flow, or the empty canvas now opens
  the native Power BI context menu (drill-through, spotlight, etc.).  Previously
  right-clicking showed the browser's default context menu with no Power BI
  actions.
- **Highlight Direction** (Nodes card) — new dropdown controlling which direction
  is emphasised when a node or flow is selected:
  - `Downstream` (default) — highlights the selected element and all nodes/flows
    reachable going forward through the diagram, matching the previous behaviour.
  - `Upstream` — highlights the selected element and all nodes/flows that feed
    into it going backward.
  - `Both` — highlights everything connected in either direction.
- **Data Label Format** (Data Labels card) — new dropdown controlling the text
  shown in node and flow value labels:
  - `Value` (default) — raw formatted number, same as before.
  - `% of Total` — value expressed as a percentage of the grand total
    (sum of all depth-0 node values).
  - `Value and %` — both the formatted number and percentage, e.g. `1.2K (34.5%)`.
  Tooltips and the node-width auto-sizing calculation both honour the chosen format.

---

## [1.2.31-beta.1] — 2026-03-10

### Added
- **Rendering events** — the visual now calls `host.eventService.renderingStarted`,
  `renderingFinished`, and `renderingFailed` at the correct lifecycle points.
  Required for reliable PDF/image export, paginated report embedding, and
  performance monitoring.  Previously missing, causing Power BI to treat the
  visual as always "pending" for export purposes.
- **Minimum Flow Value** (Flows card) — new spinner that excludes flows whose
  value is below the threshold from the diagram entirely (both the ribbon and
  its contribution to node sizing).  Defaults to 0 (all flows shown).  Useful
  for hiding noise on dense charts without having to pre-filter the data model.
- **Node Sort** (Nodes card) — new dropdown controlling the vertical ordering
  of nodes within each column: `Default` (d3-sankey natural order), `Value
  (high → low)`, `Value (low → high)`, or `Alphabetical`.  Sort is applied
  consistently in both the initial and wide-node layout passes.

---

## [1.2.30-beta.1] — 2026-03-10

### Fixed
- **Ctrl+click stacking cross-filters** — Ctrl+clicking a Sankey node or flow
  while another visual (e.g. a pie chart) has already applied a cross-filter now
  correctly stacks both filters, rather than having no effect.  The click handlers
  already passed `multiSelect = true` to `selectionManager.select()` for
  Ctrl/Cmd-clicks, but `capabilities.json` was missing
  `"supportsMultiVisualSelection": true` — the flag that tells the Power BI host
  this visual participates in cross-visual stacking selection.  Without it the
  host silently ignores the multi-select hint.
- **Color Source Column — value not persisted across renders** — the
  `colorSourceLevel` dropdown lost its selected value on every render because
  `populateFormattingSettingsModel` rebuilds the settings class from scratch and
  the freshly-created `ItemDropdown`'s items list was empty until
  `getFormattingModel()` ran.  The fix reads the raw persisted value from
  `dataView.metadata.objects` immediately after population and re-injects it into
  the dropdown, so the chosen column is honoured on every render.

---

## [1.2.29-beta.1] — 2026-03-09

### Added
- **Color Source Column** (Flows card) — new dropdown that controls which column's
  nodes drive ribbon colors when *Color by Source* is enabled.  The dropdown is
  populated dynamically with the actual field names from the Path Levels data well
  (e.g. "Region", "Product Category") so the user can pick by name rather than
  by index.  Selecting the first column reproduces the existing behaviour exactly.
  - Links at and downstream of the selected column are fully banded by the chosen
    source node, using the same forward-propagation algorithm as before.
  - Links directly feeding into the selected column (one step upstream) are rendered
    as solid single-color ribbons colored by the destination column node.
  - Links further upstream fall back to the default immediate-source coloring.

---

## [1.2.28-beta.1] — 2026-03-09

### Added
- **Display Units** (Data Labels card) — new dropdown to scale value labels for
  readability: `Auto` (picks the best unit from the data), `None`, `Thousands`
  (K), `Millions` (M), or `Billions` (B).  Auto inspects the largest node total
  after layout and selects the unit whose divisor best fits that magnitude.
- **Decimal Places** (Data Labels card) — new spinner (0–10) controlling how many
  digits appear after the decimal point on all formatted values.  Applies to node
  labels, ribbon labels, and hover tooltips consistently.

### Changed
- All value surfaces (node data labels, ribbon data labels, hover tooltips, and
  the node-width auto-sizing text-measurement pass) now use a shared `fmtVal()`
  closure so the formatted string is always identical across every element.

---

## [1.2.27-beta.1] — 2026-03-07

### Fixed
- **Follow Flow Path + Label Background — text not centred in pill** — when
  *Follow Flow Path* and *Label Background* were both enabled, the label text
  was left-aligned (outgoing nodes) or right-aligned (incoming nodes) rather
  than centred inside the pill capsule. The root cause was a unit mismatch
  between `dx="8"` (user-space units) on the `<textPath>` element and the
  `stroke-dashoffset` value (arc-length units) on the pill stroke, combined
  with `text-anchor="start"/"end"` placing the text flush against one edge of
  the pill. The fix: after the pill dasharray/dashoffset are computed, the
  textPath is switched to `text-anchor="middle"` with `dx="0"` and
  `startOffset` set to the exact arc-length percentage of the pill's midpoint,
  so the text is equidistant from both round caps. Non-pill curved labels and
  flat-mode labels are unaffected.

---

## [1.2.26-beta.1] — 2026-03-07

### Fixed
- **Follow Flow Path — labels not curving** — the v1.2.25 smart-curve threshold
  used `ribbonHalf` (half the ribbon's pixel thickness) as part of its cutoff.
  For large dominant ribbons `ribbonHalf` could be 60–80 px, making the threshold
  so wide that almost no node ever qualified for curved rendering. The threshold
  has been removed; every node with a primary link now receives a curved path.
  The horizontal-tangent bezier fix from v1.2.25 is retained, so pill centering
  remains correct.

---

## [1.2.25-beta.1] — 2026-03-07

### Fixed
- **Pill text centering** — the v1.2.24 bezier set its control-point y equal to
  `link.y0` (outgoing) or `link.y1` (incoming), which produced a diagonal tangent
  at the node endpoint. Round pill caps extended outward at that angle, shrinking
  the visible horizontal padding and making the label appear to touch the bubble's
  edge. The adjacent control point is now set to `nodeMidY` so the bezier has a
  horizontal tangent at the node end; round caps stay horizontal and the text sits
  with equal left/right padding.

### Changed
- **Smart curving threshold** — when *Follow Flow Path* is on, labels now only
  follow the bezier arc when the ribbon's centre is far enough from the node
  midpoint to make a flat label look disconnected (threshold: ribbon half-thickness
  + half font-size). Labels within that range render flat — no unnecessary
  curvature. Flat-fallback nodes still receive a pill background if that option is
  active.

---

## [1.2.24-beta.1] — 2026-03-07

### Fixed
- **Follow Flow Path — label vertical alignment** — curved labels were anchored
  to `link.y0` / `link.y1` (the ribbon's midpoint at the node edge), which could
  be anywhere within the node's height span. Labels now always appear at the node's
  vertical midpoint, matching flat mode. Each node gets its own per-node `<defs>`
  path whose start (outgoing) or end (incoming) is pinned to `nodeMidY`; the bezier
  control points remain at the ribbon's natural y-coordinates so the curve still
  flows toward the ribbon's far end.

---

## [1.2.23-beta.1] — 2026-03-07

### Changed
- **Pill background rendering** — all label background pills now use the same
  stroked-path + `stroke-linecap="round"` technique, giving flat and curved modes
  identical smooth capsule edges.
  - *Curved pills*: removed the `PILL_PAD_H` addition from the pill width
    calculation. Round end-caps now provide all horizontal visual padding,
    eliminating the excess blank space that previously appeared at each end of the
    bubble.
  - *Flat pills* (node labels, node values, ribbon values): replaced the `<rect>`
    rounded-rectangle approach with a stroked path matching the curved pill
    technique.

---

## [1.2.22-beta.1] — 2026-03-07

### Changed
- **Format pane terminology** — standardised all user-facing strings to use
  "flows" (the industry-standard Sankey term) consistently:
  - "Links" card → **Flows**; "Link Opacity" → **Flow Opacity**
  - "Follow Link Path" toggle → **Follow Flow Path**
  - "Ribbons" option in Show On dropdown → **Flows** (internal value unchanged)
  - "Values" card → **Data Labels**; "Show Values" → **Show Data Labels**
- **Labels card control order** — reordered to match Power BI conventions:
  Position → Follow Flow Path → Font → Font Color → Background →
  Background Color → Transparency.

### Removed
- **Grand Total card** — removed entirely. Will be replaced with a more useful
  variant in a future release.

---

## [1.2.21-beta.1] — 2026-03-06

### Added
- **Follow Flow Path** (Labels card) — node labels can now curve to follow the
  arc of the node's primary ribbon (largest outgoing flow for left-side nodes;
  largest incoming flow for right-side nodes) rather than staying horizontal.
  The pill background curves with the label, rendered as a partial rounded stroke
  along the same bezier path via SVG `stroke-dasharray`.

### Fixed
- **Follow Flow Path — label side consistency** — when Follow Flow Path was
  enabled, labels for middle-column nodes incorrectly switched which side of the
  node they appeared on relative to flat mode. Label side (and text anchor) is now
  determined by left-half vs. right-half position, matching the flat-mode logic.

---

## [1.2.20-beta.1] — 2026-03-06

### Added
- **Follow Link Path** — new toggle in the Values format card. When enabled,
  ribbon value labels curve to follow the ribbon's bezier arc instead of
  remaining horizontal. The background pill also curves, rendered as a
  rounded "sausage" stroke along the same arc using SVG stroke-dasharray
  to cover exactly the text span. Works with all three Alignment settings.

---

## [1.2.19-beta.1] — 2026-03-06

### Added
- **Value label alignment** — new "Alignment" dropdown in the Values format
  card (Left / Center / Right). Left anchors labels near the source node,
  Center places them at the ribbon midpoint (previous default, unchanged),
  Right anchors them near the target node. Applies to ribbon value labels only.

---

## [1.2.18-beta.1] — 2026-03-06

### Fixed
- **Color by Source — sub-ribbon band heights** — band slots are now derived
  from actual `linkDrawW` / `linkDrawW_tgt` widths rather than value-based
  `nodeContrib` fractions, eliminating overflow when `minRibbonHeight`
  inflates thin links beyond their proportional share.
- **Color by Source — capabilities.json** — `colorBySource` property
  registered so Power BI persists the toggle value across renders.
- **Color by Source — node-level source banding** — replaces per-link
  splitting with a proper node-band layout so like-source sub-ribbons are
  contiguous at every node boundary and flows trace without jumbling.

---

## [1.2.17-beta.1] — 2026-03-06

### Added
- **Color by Source** (Links card) — when enabled, each ribbon is physically
  split into sub-ribbon segments, one per first-column node that contributes
  flow to it.  Each sub-ribbon is sized proportionally to its source's
  fractional contribution and colored by that source's theme color.  Sub-ribbons
  maintain a consistent top-to-bottom stacking order at every column, so a
  flow originating from a first-column node can be visually traced as a
  continuous colored band from left to right across all columns.

---

## [1.2.16-beta.1] — 2026-03-06

### Fixed
- **No horizontal margins when labels/values are enabled** — fit-to-viewport
  no longer applies a uniform SVG scale. Instead, y-coordinates are scaled
  in-place after layout, so nodes and ribbons always span the full viewport
  width regardless of label/value font size or visibility.

---

## [1.2.15-beta.1] — 2026-03-06

### Fixed
- **Ribbon length stable when value font size changes** — the auto-expand of
  node width (to fit value labels inside nodes) is now capped so each node
  may grow to at most `innerW / numColumns − 40 px`, guaranteeing ribbons
  always retain a minimum 40 px horizontal span.  Previously, a large value
  font could push `effectiveNodeWidth` high enough that ribbons shrank to
  almost nothing.

---

## [1.2.14-beta.1] — 2026-03-06

### Fixed
- **Selection toggle** — clicking an already-selected node or ribbon now
  deselects it (clearing the cross-filter) instead of re-selecting it.
  Previously a second click called `selectionManager.select()` again, leaving
  the visual and other report elements out of sync.

---

## [1.2.13-beta.1] — 2026-03-06

### Fixed
- **`measureText` performance** — replaced per-call canvas creation with a
  module-level singleton `HTMLCanvasElement` / `CanvasRenderingContext2D`.
  Text measurement no longer allocates a new canvas element on every call.
- **Grand total scoping** — the `gtFont` string is now constructed only when
  `showGrandTotal` is true, avoiding unnecessary work on every render when the
  feature is disabled.
- **Grand total safety guard** — added a `depth0Nodes.length > 0` check before
  reading `depth0Nodes[0]`; eliminated the `Infinity` sentinels that the
  previous `reduce()` calls relied on.  `firstX0` now reads directly from
  `depth0Nodes[0].x0` (all first-column nodes share the same x-coordinate by
  construction).
- **Zoom state preserved on format-pane changes** — the fit-to-viewport
  transform is now only applied when the update type includes `Data` or
  `Resize`.  Previously, any format-pane change (e.g. tweaking a colour) would
  silently reset the user's zoom/pan position.
- **`capabilities.json` minimum pathLevels** — retained `"min": 1` in the
  `conditions` entry; Power BI locks the data well if `min` exceeds the
  current field count, preventing users from adding even the first column.
  The two-column requirement is enforced in code with a friendly error message.

---

## [1.2.12-beta.1] — 2026-03-06

### Changed
- **Column Totals replaced by Grand Total** — the per-column totals strip
  (v1.2.11) showed the same total at every stage of a balanced flow, which was
  redundant.  It is replaced by a single **Grand Total** label positioned to the
  *left* of the first column of nodes, showing the total flow volume entering
  the diagram.

  Viewers can immediately see the top-line number and then read the Sankey to
  understand how it decomposes stage by stage.

  Controls (in the new **Grand Total** format card):
  - **Show Grand Total** — header toggle; off by default.
  - **Font** — family, size (default 14), bold (default on), italic, underline.
  - **Font Color** — default dark grey (#333333).

  Implementation: the total is computed before layout by summing all link values
  whose source is at depth 0 (`linkMap` keys starting with `"0\x01"`).  The
  canvas-measured text width is used to widen the left margin so the label never
  clips, and the label is right-aligned at `firstColumn.x0 − 6 px`, vertically
  centred on the vertical extent of all first-column nodes.  When the Labels
  *Outside* mode is also active, the grand total shares the left margin with the
  leftmost node labels; the margin is sized to the wider of the two.

---

## [1.2.11-beta.1] — 2026-03-06

### Added
- **Column Totals** — optional strip of totals above or below the diagram, one
  per column.  *(Superseded by Grand Total in v1.2.12.)*

---

## [1.2.10-beta.1] — 2026-03-06

### Added
- **Auto fit-to-viewport on load** — when the Sankey diagram is taller than the
  visual container (which can happen when `resolveColumnOverlaps()` pushes nodes
  below the bottom edge to honour `nodePadding`), the initial view is now
  automatically scaled so the entire diagram is visible without the user having
  to scroll or zoom out manually.

  Behaviour:
  - After every `update()` call the renderer measures the actual bottom edge of
    the lowest node (`actualMaxY`) and computes a fit scale
    `fitK = min(1, viewportHeight / totalHeight)`.  If all content fits, `fitK`
    equals 1 and the view is unchanged.  Otherwise, the diagram is scaled down
    uniformly so the full height is visible.
  - A horizontal centering translation `fitTx = width × (1 − fitK) / 2` is
    applied at the same time so the diagram remains centred as it shrinks.
  - The fit transform is stored in `this.fitTransform` and used as the reset
    target when the user double-clicks — double-clicking always returns to the
    fit view rather than the raw 1:1 identity view.
  - The visual never scales *up* (`fitK ≤ 1`), so diagrams that fit comfortably
    are unaffected.

---

## [1.2.9-beta.1] — 2026-03-05

### Changed
- **Label Position setting replaces the forced outward layout from v1.2.8** —
  the previous release hard-coded outermost column labels to face outward.
  This is now a user choice in the **Labels** format card:
  - **Inside** *(default)* — all labels appear between node columns alongside
    the ribbons, exactly as they did before v1.2.8.  The layout uses a small
    uniform 8 px margin on all sides.
  - **Outside** — leftmost column labels face left into a canvas-measured left
    margin; rightmost column labels face right into a matching right margin;
    intermediate column labels remain inward.  The Sankey layout fills the
    space between the two outer margins so link length is independent of label
    text length.  When value labels are set to *Outside* node positioning, they
    stack below the name label in the same margin direction.

---

## [1.2.8-beta.1] — 2026-03-05

### Changed
- **Outermost column labels now face outward; links fill the full horizontal space** —
  previously all node labels went *inward* (left-half nodes labelled to the right,
  right-half nodes labelled to the left), which crowded labels into the link area
  and still left the outermost nodes near the visual edges with no guaranteed
  clearance for their text.  The new layout separates concerns:
  - **Leftmost column** labels face left, into a dedicated left margin sized to the
    widest label in that column (`labelWidth + 6 px gap + pill padding if active`).
  - **Rightmost column** labels face right, into a matching right margin.
  - **Intermediate columns** keep the existing inward behaviour (left-half → right,
    right-half → left).
  - The Sankey layout occupies the space *between* the two outer margins, so links
    span that full width independently of label length.  Adding longer node names
    widens the margin rather than squeezing the link area.

---

## [1.2.7-beta.1] — 2026-03-05

### Changed
- **Visual now fills its container** — the Sankey diagram previously reserved
  up to `max(80 px, fontSize × 7)` of empty margin on both the left and right
  sides to "make room for labels", but node-name labels always go *inward*
  (left-half nodes label to the right, right-half nodes label to the left),
  so those outer margins were never used.  The left/right margin is now a
  uniform 8 px inset (same as top and bottom), making the layout fill almost
  the entire visual bounding box.  Links are correspondingly longer and nodes
  are spread across the full width.

---

## [1.2.6-beta.1] — 2026-03-05

### Added
- **Label background** — the Labels format card now has a **Background** toggle.
  When enabled, each node-name label is wrapped in a pill-shaped background
  (rounded rectangle, `border-radius = height / 2`, matching Power BI's native
  pill style). Controls:
  - **Background Color** — color picker, default white (#ffffff)
  - **Transparency** — 0 % fully opaque → 100 % fully transparent, default 20 %
  When the background is active, `minRibbonHeight` is automatically increased
  so the pill fits inside the ribbon with a 2 px visual margin on each side.

- **Value background** — the Values format card gains the same three controls
  (**Background**, **Background Color**, **Transparency**) applying to value
  labels whether they are positioned on nodes or on ribbons.  When a value
  background is active:
  - `minRibbonHeight` expands to fit the pill (same headroom logic as labels).
  - The two-pass node-width calculation adds horizontal pill padding
    (8 px per side) when inside-positioned value labels are used, so the pill
    fits inside the node rectangle without clipping.
  - For ribbon value labels the pill is centred at the ribbon midpoint; the
    ribbon height expansion ensures there is space for it.

  Implementation: each label/value text element is now placed inside a `<g>`
  that first holds an optional `<rect class="label-pill">` / `<rect class="value-pill">`.
  After the text is inserted into the SVG DOM, `SVGTextElement.getBBox()` is
  called to get the exact rendered bounding box, and the rect is sized to
  `(bb.width + 16) × (bb.height + 6)` with `rx = ry = (bb.height + 6) / 2`.

---

## [1.2.5-beta.1] — 2026-03-05

### Removed
- **Color Value field well** — the optional second measure that drove ribbon
  color via a continuous gradient scale has been removed. The feature did not
  behave as expected: weighted-average aggregation across rows produced
  misleading colors for rate-type metrics, and the gradient legend added visual
  clutter without clear benefit. Ribbons now always use report-theme colors
  derived from the source node (existing behaviour from v1.2.3 and earlier).
  Removing the field also removes the **Color Scale** format card. Reports that
  had a Color Value field bound will silently drop that binding on next open;
  no other settings are affected.

---

## [1.2.4-beta.1] — 2026-03-05

### Fixed
- **Ribbon ends now match node height on both sides** — ribbons were previously
  rendered as a stroked cubic bezier centreline with a single uniform
  `stroke-width` sourced from the source-node-scaled drawing width.  This meant
  the ribbon looked correct where it left the source node but was the wrong
  thickness where it arrived at the target node — visually leaving gaps or
  overflowing the node face on the target side.

  The rendering pipeline now works as follows:
  - `reStackRibbons()` independently computes and stores the scaled drawing width
    for every link on **both** the source side (`linkDrawW`) and the target side
    (`linkDrawW_tgt`), keyed by `"srcName\x00tgtName"`.
  - A new `taperingRibbonPath()` helper constructs a closed SVG path with four
    distinct corner points — top-source, top-target, bottom-target, bottom-source
    — connected by two cubic bezier curves (one for the top edge, one for the
    bottom edge) whose control points sit at the horizontal midpoint between the
    two nodes.  The ribbon is `srcW` tall at the source face and `tgtW` tall at
    the target face, tapering smoothly in between.
  - Ribbons are now rendered as **filled** closed paths (`fill: ribbonColor`)
    rather than stroked centrelines, so each end is always flush with the full
    allocated height on that node face regardless of how many other ribbons share
    the same node.
  - The `sankeyLinkHorizontal` import is removed as it is no longer used.

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
