# Changelog

All notable changes to DDP SanKey are documented here.

Version format: `MAJOR.MINOR.PATCH-beta.N` during pre-release development.
- **PATCH** — bug fixes
- **MINOR** — new features (backward-compatible with existing reports)
- **MAJOR** — breaking changes (data role renames, mapping changes, etc.)
- **-beta.N** label dropped when the visual is declared production-ready

The `.pbiviz` file for each release is attached to the corresponding [GitHub Release](https://github.com/illegal-request/ddp-sankey/releases).

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
