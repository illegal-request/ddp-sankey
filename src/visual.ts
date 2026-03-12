"use strict";

import powerbi from "powerbi-visuals-api";
import VisualConstructorOptions = powerbi.extensibility.visual.VisualConstructorOptions;
import VisualUpdateOptions = powerbi.extensibility.visual.VisualUpdateOptions;
import IVisual = powerbi.extensibility.visual.IVisual;
import IVisualHost    = powerbi.extensibility.visual.IVisualHost;
import VisualUpdateType = powerbi.VisualUpdateType;

import { FormattingSettingsService } from "powerbi-visuals-utils-formattingmodel";
import { VisualFormattingSettingsModel } from "./formattingSettings";

import {
    sankey,
    SankeyNode,
    SankeyLink,
    SankeyGraph
} from "d3-sankey";
import { select, Selection } from "d3-selection";
import { zoom, zoomIdentity, ZoomBehavior, ZoomTransform } from "d3-zoom";

import "./../style/visual.less";

// ─── Data types ───────────────────────────────────────────────────────────────

interface NodeDatum {
    name:  string;   // level-prefixed key, e.g. "0\x01North"  (internal, unique across levels)
    label: string;   // display name,        e.g. "North"
}

interface LinkDatum {
    source: number;
    target: number;
    value:  number;
}

type LayoutNode  = SankeyNode<NodeDatum, LinkDatum>;
type LayoutLink  = SankeyLink<NodeDatum, LinkDatum>;
type LayoutGraph = SankeyGraph<NodeDatum, LinkDatum>;

// Represents one rendered ribbon segment.  In normal mode: one per link.
// In "Color by Source" mode: one per (link × depth-0 source), sized by fraction.
interface SubRibbon {
    link:     LayoutLink;
    srcLabel: string;   // depth-0 source display label for color; "" = use link source label
    srcX1:    number;
    srcYtop:  number;
    srcYbot:  number;
    tgtX0:    number;
    tgtYtop:  number;
    tgtYbot:  number;
}

// ─── Helpers (module-level) ───────────────────────────────────────────────────

/**
 * Measure the rendered pixel width of a text string using the browser's
 * canvas 2D context (no layout side-effects, no DOM insertion needed).
 *
 * A single canvas element is reused across all calls (module-level singleton)
 * to avoid the overhead of creating a new HTMLCanvasElement every invocation.
 */
const _measureCanvas = document.createElement("canvas");
const _measureCtx    = _measureCanvas.getContext("2d");
function measureText(text: string, font: string): number {
    if (!_measureCtx) return 0;
    _measureCtx.font = font;
    return _measureCtx.measureText(text).width;
}

/** Padding inside pill-shaped label/value backgrounds (px). */
const PILL_PAD_V = 3;   // top and bottom
const PILL_PAD_H = 8;   // left and right

/**
 * Given a raw displayUnits setting ("auto"|"none"|"thousands"|"millions"|"billions")
 * and the set of all node values, return the resolved unit string (never "auto").
 */
function resolveDisplayUnit(setting: string, nodeValues: number[]): string {
    if (setting !== "auto") return setting;
    const max = nodeValues.length ? Math.max(...nodeValues.map(v => Math.abs(v))) : 0;
    if (max >= 1e9) return "billions";
    if (max >= 1e6) return "millions";
    if (max >= 1e3) return "thousands";
    return "none";
}

/**
 * Format a numeric value using the resolved display unit and decimal places.
 * "none"      — locale-formatted raw number (e.g. 1,234,567)
 * "thousands" — divided by 1 000 with "K" suffix
 * "millions"  — divided by 1 000 000 with "M" suffix
 * "billions"  — divided by 1 000 000 000 with "B" suffix
 */
function formatDataValue(v: number, unit: string, decimals: number): string {
    const locFmt = (n: number) =>
        n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    switch (unit) {
        case "thousands": return locFmt(v / 1e3) + "K";
        case "millions":  return locFmt(v / 1e6) + "M";
        case "billions":  return locFmt(v / 1e9) + "B";
        default:          return locFmt(v);
    }
}

/** Cubic-bezier ribbon path for one SubRibbon (top + bottom edges). */
function subRibbonPath(d: SubRibbon): string {
    const cx = (d.srcX1 + d.tgtX0) / 2;
    return [
        `M${d.srcX1},${d.srcYtop}`,
        `C${cx},${d.srcYtop} ${cx},${d.tgtYtop} ${d.tgtX0},${d.tgtYtop}`,
        `L${d.tgtX0},${d.tgtYbot}`,
        `C${cx},${d.tgtYbot} ${cx},${d.srcYbot} ${d.srcX1},${d.srcYbot}`,
        `Z`
    ].join(" ");
}

/**
 * Post-layout pass: re-stack ribbons within each node using their *effective*
 * widths — i.e. Math.max(minH, link.width) — and expand the node's y1 when
 * the inflated ribbons no longer fit inside the natural node height.
 *
 * d3-sankey positions ribbon centres (link.y0 / link.y1) based on the natural
 * (proportional) ribbon width.  When minRibbonHeight inflates thin ribbons,
 * those centres are no longer spaced correctly, causing ribbons to overlap at
 * the node and to overflow the node rectangle.  This function corrects both.
 *
 * Each side's ribbons are *scaled* to fill the full node height rather than
 * centred within it.  This prevents the large gaps that appeared when one side
 * had far fewer (or thinner) ribbons than the other — e.g. three ribbons
 * entering a node but only one leaving it.  The scale factor per side is:
 *   fill = nodeH / sideTotal   (≥ 1 when ribbons don't yet fill the node)
 *
 * Both sides are authoritative for their own drawing width.  Source-side scaled
 * widths are stored in `linkDrawW` and target-side in `linkDrawW_tgt` (both keyed
 * by "srcName\x00tgtName") so the ribbon path generator can taper smoothly from
 * the source-node height to the target-node height.
 */
function reStackRibbons(
    graph:         LayoutGraph,
    minH:          number,
    linkDrawW:     Map<string, number>,
    linkDrawW_tgt: Map<string, number>
): void {
    for (const nd of graph.nodes) {
        const node     = nd as LayoutNode;
        const srcLinks = (node.sourceLinks ?? []) as LayoutLink[];
        const tgtLinks = (node.targetLinks ?? []) as LayoutLink[];

        // Effective width for each ribbon (minimum enforced, not yet scaled to fill)
        const srcEW  = srcLinks.map(l => Math.max(minH, l.width ?? 1));
        const tgtEW  = tgtLinks.map(l => Math.max(minH, l.width ?? 1));
        const srcTot = srcEW.reduce((a, b) => a + b, 0);
        const tgtTot = tgtEW.reduce((a, b) => a + b, 0);

        // Expand the node downward (keeping y0 fixed) if ribbons need more room
        const natH = (node.y1 ?? 0) - (node.y0 ?? 0);
        const reqH = Math.max(natH, srcTot, tgtTot, minH);
        if (reqH > natH) {
            node.y1 = (node.y0 ?? 0) + reqH;
        }

        const nodeH = (node.y1 ?? 0) - (node.y0 ?? 0);
        const y0    = node.y0 ?? 0;

        // Scale source ribbons to fill the full node height — no centering gap.
        // Source side is authoritative: scaled drawing widths go into linkDrawW.
        if (srcLinks.length > 0) {
            const srcFill = srcTot > 0 ? nodeH / srcTot : 1;
            let y = y0;
            srcLinks.forEach((lnk, i) => {
                const dw = srcEW[i] * srcFill;
                lnk.y0 = y + dw / 2;
                y += dw;
                const src = (lnk.source as LayoutNode).name;
                const tgt = (lnk.target as LayoutNode).name;
                linkDrawW.set(`${src}\x00${tgt}`, dw);
            });
        }

        // Scale target ribbons to fill the full node height — no centering gap.
        // Target-side drawing widths are stored in linkDrawW_tgt so the path
        // generator can taper the ribbon to match the target node height.
        if (tgtLinks.length > 0) {
            const tgtFill = tgtTot > 0 ? nodeH / tgtTot : 1;
            let y = y0;
            tgtLinks.forEach((lnk, i) => {
                const dw = tgtEW[i] * tgtFill;
                lnk.y1 = y + dw / 2;
                y += dw;
                const src = (lnk.source as LayoutNode).name;
                const tgt = (lnk.target as LayoutNode).name;
                linkDrawW_tgt.set(`${src}\x00${tgt}`, dw);
            });
        }
    }
}

/**
 * After reStackRibbons() has potentially grown node heights, nodes within the
 * same column may now overlap each other.  This pass groups nodes by column,
 * sorts them top-to-bottom, and for each pair of adjacent nodes pushes the
 * lower one down (along with its ribbon endpoints) until the inter-node gap
 * is at least `padding` pixels — matching the nodePadding the user configured.
 *
 * Ribbon endpoints are translated by the same delta so that ribbons stay
 * connected to their (now-shifted) nodes.
 */
function resolveColumnOverlaps(graph: LayoutGraph, padding: number): void {
    // Group nodes by column — d3-sankey assigns the same x0 to all nodes in a column
    const columns = new Map<number, LayoutNode[]>();
    for (const nd of graph.nodes) {
        const node = nd as LayoutNode;
        const col  = Math.round(node.x0 ?? 0);   // round to avoid float-key mismatches
        if (!columns.has(col)) columns.set(col, []);
        columns.get(col)!.push(node);
    }

    columns.forEach(col => {
        // Sort top-to-bottom within the column
        col.sort((a, b) => (a.y0 ?? 0) - (b.y0 ?? 0));

        for (let i = 1; i < col.length; i++) {
            const prev  = col[i - 1];
            const curr  = col[i];
            const minY0 = (prev.y1 ?? 0) + padding;
            const delta = minY0 - (curr.y0 ?? 0);

            if (delta <= 0) continue;   // already enough space — nothing to do

            // Shift this node downward
            curr.y0 = (curr.y0 ?? 0) + delta;
            curr.y1 = (curr.y1 ?? 0) + delta;

            // Shift the ribbon endpoints that sit at this node by the same delta
            // so that ribbons remain correctly attached after the node moves.
            for (const lnk of (curr.sourceLinks ?? []) as LayoutLink[]) {
                lnk.y0 = (lnk.y0 ?? 0) + delta;
            }
            for (const lnk of (curr.targetLinks ?? []) as LayoutLink[]) {
                lnk.y1 = (lnk.y1 ?? 0) + delta;
            }
        }
    });
}

/**
 * Generates an SVG path for a ribbon that tapers between two different widths —
 * `srcW` at the source node's right edge and `tgtW` at the target node's left
 * edge.  The four corners are connected with two cubic bezier curves (one for
 * the top edge, one for the bottom edge) whose control points sit at the
 * horizontal midpoint so the curvature matches the classic Sankey aesthetic.
 *
 * Rendering as a *filled* closed path (rather than a stroked centreline) means
 * the ribbon naturally hugs each node face at the correct height on both ends.
 */
function taperingRibbonPath(
    d:             LayoutLink,
    linkDrawW:     Map<string, number>,
    linkDrawW_tgt: Map<string, number>,
    minH:          number,
    fitK:          number
): string {
    const src  = d.source as LayoutNode;
    const tgt  = d.target as LayoutNode;
    const srcX = src.x1 ?? 0;
    const tgtX = tgt.x0 ?? 0;
    const midX = (srcX + tgtX) / 2;
    const cy0  = d.y0 ?? 0;
    const cy1  = d.y1 ?? 0;
    const key  = `${src.name}\x00${tgt.name}`;
    // linkDrawW values are pre-scaled by fitK; the fallback d.width also needs scaling.
    const srcW = linkDrawW.get(key)     ?? Math.max(minH, d.width ?? 1) * fitK;
    const tgtW = linkDrawW_tgt.get(key) ?? Math.max(minH, d.width ?? 1) * fitK;
    const hs   = srcW / 2;   // half-height at source
    const ht   = tgtW / 2;   // half-height at target
    return (
        `M ${srcX} ${cy0 - hs}` +
        ` C ${midX} ${cy0 - hs},${midX} ${cy1 - ht},${tgtX} ${cy1 - ht}` +
        ` L ${tgtX} ${cy1 + ht}` +
        ` C ${midX} ${cy1 + ht},${midX} ${cy0 + hs},${srcX} ${cy0 + hs}` +
        ` Z`
    );
}

// ─── Visual ───────────────────────────────────────────────────────────────────

export class Visual implements IVisual {
    private host:        IVisualHost;
    private svg:         Selection<SVGSVGElement,  unknown, null, undefined>;
    private zoomLayer:   Selection<SVGGElement,    unknown, null, undefined>;
    private container:   Selection<SVGGElement,    unknown, null, undefined>;
    private errorText:   Selection<SVGTextElement, unknown, null, undefined>;
    private landingLayer: Selection<SVGGElement, unknown, null, undefined>;
    private zoomBehavior: ZoomBehavior<SVGSVGElement, unknown>;

    private formattingSettingsService: FormattingSettingsService;
    private formattingSettings: VisualFormattingSettingsModel;

    private selectionManager:  powerbi.extensibility.ISelectionManager;
    private selectionType:     "none" | "node" | "link" = "none";
    private selectedKey:       string = "";
    private currentLinkOpacity: number = 0.45;
    // Per-instance ID prefix so <defs> path IDs don't collide when multiple
    // instances of this visual appear on the same report page.
    // window.crypto.getRandomValues() used per linter requirement (insecure-random).
    private readonly instanceUid: string = (() => {
        const a = new Uint32Array(2);
        window.crypto.getRandomValues(a);
        return `sk${a[0].toString(36)}${a[1].toString(36)}`;
    })();
    // Most-recent fit-to-viewport transform — updated on every render and used
    // as the initial zoom state and the double-click reset target.
    private fitTransform: ZoomTransform = zoomIdentity;
    // Column display names from the Path Levels field well, in left-to-right
    // order.  Populated on every update() and used by getFormattingModel() to
    // inject dynamic items into the Color Source Column dropdown.
    private pathColumnNames: string[] = [];

    constructor(options: VisualConstructorOptions) {
        this.host = options.host;
        this.formattingSettingsService = new FormattingSettingsService();
        this.formattingSettings        = new VisualFormattingSettingsModel();
        this.selectionManager          = options.host.createSelectionManager();

        this.svg = select(options.element)
            .append<SVGSVGElement>("svg")
            .classed("sankeyVisual", true);

        // zoomLayer receives the d3-zoom transform; container receives the margin translate
        this.zoomLayer = this.svg
            .append<SVGGElement>("g")
            .classed("zoomLayer", true);

        this.container = this.zoomLayer
            .append<SVGGElement>("g")
            .classed("container", true);

        this.errorText = this.svg
            .append<SVGTextElement>("text")
            .classed("errorText", true)
            .attr("text-anchor",      "middle")
            .attr("dominant-baseline", "middle")
            .attr("fill",       "#999")
            .attr("font-size",  "14px")
            .attr("font-family", "sans-serif");

        this.landingLayer = this.svg
            .append<SVGGElement>("g")
            .classed("landingLayer", true);

        // Zoom: scroll to zoom, drag to pan, double-click to reset
        this.zoomBehavior = zoom<SVGSVGElement, unknown>()
            .scaleExtent([0.1, 10])
            .on("zoom", (event) => {
                this.zoomLayer.attr("transform", event.transform.toString());
            });

        this.svg.call(this.zoomBehavior);

        this.svg.on("dblclick.zoom", () => {
            this.svg.call(this.zoomBehavior.transform, this.fitTransform);
        });

        // Clear cross-filter when user clicks empty canvas
        this.svg.on("click", () => {
            this.selectionType = "none";
            this.selectedKey   = "";
            this.selectionManager.clear();
            this.container.selectAll<SVGRectElement, LayoutNode>(".node rect").attr("opacity", 1);
            this.container.selectAll<SVGPathElement, LayoutLink>(".links path")
                .attr("opacity", this.currentLinkOpacity);
        });

        // Context menu on empty canvas
        this.svg.on("contextmenu", (event: MouseEvent) => {
            event.preventDefault();
            this.selectionManager.showContextMenu(
                {} as powerbi.extensibility.ISelectionId,
                { x: event.clientX, y: event.clientY }
            );
        });
    }

    public update(options: VisualUpdateOptions): void {
        this.host.eventService.renderingStarted(options);
        let renderFailed = false;
        try {
        this._update(options);
        } catch (e) {
            renderFailed = true;
            this.host.eventService.renderingFailed(options, String(e));
        } finally {
            if (!renderFailed) this.host.eventService.renderingFinished(options);
        }
    }

    private _update(options: VisualUpdateOptions): void {
        const width  = options.viewport.width;
        const height = options.viewport.height;

        this.svg.attr("width", width).attr("height", height);
        this.container.selectAll("*").remove();
        this.errorText.text("");
        this.landingLayer.selectAll("*").remove();

        // ── Populate formatting settings from the format pane ──────────────────
        this.formattingSettings = this.formattingSettingsService
            .populateFormattingSettingsModel(VisualFormattingSettingsModel, options.dataViews[0]);

        // Fix up the Color Source Column dropdown immediately after population.
        // populateFormattingSettingsModel creates a fresh class instance whose
        // colorSourceLevel.items contains only the static placeholder
        // ("__default__"), so it cannot match a stored column name like "Region"
        // and silently reverts to the placeholder.  We rebuild the items list
        // from the raw categorical metadata and re-read the stored string value
        // directly from dataView.metadata.objects so the correct column is set.
        {
            const rawCats = options.dataViews[0]?.categorical?.categories;
            if (rawCats && rawCats.length >= 2) {
                const dynItems = (rawCats as powerbi.DataViewCategoryColumn[]).map(c => ({
                    displayName: String(c.source.displayName),
                    value:       String(c.source.displayName)
                }));
                this.formattingSettings.linkSettings.colorSourceLevel.items = dynItems;

                // Raw stored value is the enum string written by persistProperties.
                // Handle both plain-string and {value: string} shapes defensively.
                const rawProp = (options.dataViews[0]?.metadata?.objects?.['linkSettings'] as powerbi.DataViewObject | undefined)
                    ?.['colorSourceLevel'];
                const rawStored = typeof rawProp === 'string'
                    ? rawProp
                    : (rawProp != null && typeof (rawProp as {value?: unknown}).value === 'string'
                        ? (rawProp as {value: string}).value
                        : '');

                this.formattingSettings.linkSettings.colorSourceLevel.value =
                    dynItems.find(i => i.value === rawStored) ?? dynItems[0];
            }
        }

        const {
            nodeSettings, linkSettings, labelSettings, valueSettings
        } = this.formattingSettings;

        const nodeWidth   = Math.max(4, nodeSettings.nodeWidth.value);
        const nodePadding = Math.max(2, nodeSettings.nodePadding.value);
        const nodeSortStr    = String(nodeSettings.nodeSort.value?.value    ?? "default");
        const highlightDirStr = String(nodeSettings.highlightDir.value?.value ?? "downstream");
        const nodeSortFn: ((a: LayoutNode, b: LayoutNode) => number) | undefined =
            nodeSortStr === "value-desc" ? (a, b) => (b.value ?? 0) - (a.value ?? 0) :
            nodeSortStr === "value-asc"  ? (a, b) => (a.value ?? 0) - (b.value ?? 0) :
            nodeSortStr === "alpha"      ? (a, b) => a.label.localeCompare(b.label)   :
            undefined;

        const linkOpacity    = Math.min(1, Math.max(0, linkSettings.linkOpacity.value / 100));
        const minFlowValue   = Math.max(0, linkSettings.minFlowValue.value ?? 0);
        const colorBySource  = linkSettings.colorBySource.value;
        const gradientFlows  = linkSettings.gradientFlows.value ?? false;
        const skipBlanks     = linkSettings.skipBlanks.value ?? false;

        const showLabels  = labelSettings.show.value;
        const fontFamily  = labelSettings.fontControl.fontFamily.value;
        const fontSize    = Math.max(8, labelSettings.fontControl.fontSize.value);
        const bold        = labelSettings.fontControl.bold?.value      ?? false;
        const italic      = labelSettings.fontControl.italic?.value    ?? false;
        const underline   = labelSettings.fontControl.underline?.value ?? false;
        const fontColor   = labelSettings.fontColor.value?.value       ?? "#333333";
        const labelPos      = String(labelSettings.position.value?.value  ?? "inside");
        const labelOutside   = labelPos === "outside";
        const labelFollowPath = (labelSettings.followPath.value ?? false);

        const showValues      = valueSettings.show.value;
        const valuePos        = String(valueSettings.position.value?.value    ?? "auto");
        const valueTarget     = String(valueSettings.target.value?.value      ?? "nodes");
        const valueAlign      = String(valueSettings.alignment.value?.value   ?? "center");
        const labelFormatStr  = String(valueSettings.labelFormat.value?.value ?? "value");
        const vDisplayUnits   = String(valueSettings.displayUnits.value?.value ?? "auto");
        const vDecimalPlaces  = Math.max(0, Math.min(10, valueSettings.decimalPlaces.value ?? 0));
        const vFontFamily     = valueSettings.fontControl.fontFamily.value;
        const vFontSize   = Math.max(8, valueSettings.fontControl.fontSize.value);
        const vBold       = valueSettings.fontControl.bold?.value      ?? false;
        const vItalic     = valueSettings.fontControl.italic?.value    ?? false;
        const vUnderline  = valueSettings.fontControl.underline?.value ?? false;
        const vFontColor  = valueSettings.fontColor.value?.value       ?? "#333333";

        const labelBg             = labelSettings.showBackground.value;
        const labelBgColor        = labelSettings.backgroundColor.value?.value  ?? "#ffffff";
        const labelBgTransparency = labelSettings.backgroundTransparency.value;
        const labelBgOpacity      = 1 - labelBgTransparency / 100;

        const valueBg             = valueSettings.showBackground.value;
        const valueBgColor        = valueSettings.backgroundColor.value?.value  ?? "#ffffff";
        const valueBgTransparency = valueSettings.backgroundTransparency.value;
        const valueBgOpacity      = 1 - valueBgTransparency / 100;

        // A pill background is "active" only when the parent text toggle is also on
        const labelBgActive = showLabels && labelBg;
        const valueBgActive = showValues && valueBg;

        this.currentLinkOpacity = linkOpacity;

        // ── Guard: no data ─────────────────────────────────────────────────────
        const dataView    = options.dataViews?.[0];
        const categorical = dataView?.categorical;

        // No Path Levels mapped at all — show landing page
        if (!categorical?.categories?.length) {
            this.showLandingPage(width, height);
            return;
        }
        // Path Levels present but no Value measure yet — show inline guidance
        if (!categorical.values?.length) {
            this.showError(width, height, "Add a Value field to show flows.");
            return;
        }

        // categorical.categories is ordered by field-well position (top → left in visual)
        const levelCats = categorical.categories;
        if (levelCats.length < 2) {
            this.showError(width, height, "Add at least 2 Path Level columns and a Value.");
            return;
        }

        // Store column names for the Color Source Column dropdown
        this.pathColumnNames = levelCats.map(c => c.source.displayName);

        // Resolve which column index to use as the color source (used later in
        // the colorBySource sub-ribbon block; 0 = leftmost = original behaviour).
        const colorSrcColName = String(linkSettings.colorSourceLevel.value?.value ?? "");
        const colorSrcIdx     = this.pathColumnNames.indexOf(colorSrcColName);
        const sourceDepth     = colorSrcIdx >= 0 ? colorSrcIdx : 0;

        // Identify the value series by data role
        let valueSeries: powerbi.DataViewValueColumn | undefined;
        for (const s of categorical.values) {
            if (s.source.roles?.["value"]) valueSeries = s;
        }

        if (!valueSeries) {
            this.showError(width, height, "Add 2 or more Path Level columns and a Value to get started.");
            return;
        }

        // ── Parse rows → aggregate links, build selection ID maps ──────────────
        // Blank/null values are treated as the label "(Blank)" rather than dropped.
        const linkMap    = new Map<string, number>();
        const nodeSet    = new Set<string>();
        const nodeSelIds = new Map<string, powerbi.visuals.ISelectionId[]>();
        const linkSelIds = new Map<string, powerbi.visuals.ISelectionId[]>();
        const rowCount   = levelCats[0].values.length;

        for (let r = 0; r < rowCount; r++) {
            const val = Number(valueSeries.values[r]) || 0;
            if (val <= 0 || val < minFlowValue) continue;

            // Build a selection ID that identifies this unique row combination
            let idBuilder = this.host.createSelectionIdBuilder();
            for (const cat of levelCats) {
                idBuilder = idBuilder.withCategory(cat, r);
            }
            const selId = idBuilder.createSelectionId();

            // Pre-compute a disambiguated node key for every level in this row.
            // Non-blank: "${level}\x01${label}"            — same label at same level merges (intentional)
            // Blank:     "${level}\x01(Blank)\x02${parentKey}" — unique per parent path
            const levelKeys: string[]        = [];
            const levelRaws: (string|null)[] = [];
            for (let lvl = 0; lvl < levelCats.length; lvl++) {
                const raw = (String(levelCats[lvl].values[r] ?? "").trim()) || null;
                levelRaws[lvl] = raw;
                if (raw !== null) {
                    levelKeys[lvl] = `${lvl}\x01${raw}`;
                } else {
                    const parentKey = lvl > 0 ? levelKeys[lvl - 1] : "root";
                    levelKeys[lvl]  = `${lvl}\x01(Blank)\x02${parentKey}`;
                }
            }

            for (let i = 0; i < levelCats.length - 1; i++) {
                // Skip degenerate links where the same non-blank label appears at consecutive levels
                if (levelRaws[i] !== null && levelRaws[i] === levelRaws[i + 1]) continue;
                // Hide Blank Nodes: skip any link where either endpoint is blank.
                // This means no blank node is ever drawn — flows terminate cleanly
                // at the last real node in the row.
                if (skipBlanks && (levelRaws[i] === null || levelRaws[i + 1] === null)) continue;

                const srcKey = levelKeys[i];
                const tgtKey = levelKeys[i + 1];
                const lnkKey = `${srcKey}\x00${tgtKey}`;

                linkMap.set(lnkKey, (linkMap.get(lnkKey) ?? 0) + val);
                nodeSet.add(srcKey);
                nodeSet.add(tgtKey);

                // Accumulate selection IDs for each node and each link
                if (!nodeSelIds.has(srcKey)) nodeSelIds.set(srcKey, []);
                nodeSelIds.get(srcKey)!.push(selId);
                if (!nodeSelIds.has(tgtKey)) nodeSelIds.set(tgtKey, []);
                nodeSelIds.get(tgtKey)!.push(selId);
                if (!linkSelIds.has(lnkKey)) linkSelIds.set(lnkKey, []);
                linkSelIds.get(lnkKey)!.push(selId);

            }
        }

        if (linkMap.size === 0) {
            this.showError(width, height, "No valid flows found. Ensure Value > 0 and consecutive levels differ.");
            return;
        }

        // ── Build Sankey input ─────────────────────────────────────────────────
        const nodeArray = Array.from(nodeSet);
        const nodeIndex = new Map<string, number>(nodeArray.map((n, i) => [n, i]));

        const nodes: NodeDatum[] = nodeArray.map(key => {
            const afterLevel = key.slice(key.indexOf("\x01") + 1);
            // Blank keys are suffixed with \x02parentKey for disambiguation — strip it
            const blankSep = afterLevel.indexOf("\x02");
            return {
                name:  key,
                label: blankSep === -1 ? afterLevel : afterLevel.slice(0, blankSep)
            };
        });

        const links: LinkDatum[] = [];
        linkMap.forEach((value, key) => {
            const sep    = key.indexOf("\x00");
            const srcKey = key.slice(0, sep);
            const tgtKey = key.slice(sep + 1);
            links.push({ source: nodeIndex.get(srcKey)!, target: nodeIndex.get(tgtKey)!, value });
        });

        // Minimum ribbon height: tall enough to contain the largest active text label.
        // When a pill background is enabled the ribbon must also accommodate the pill
        // (font + PILL_PAD_V each side + 2 px visual margin each side = PILL_PAD_V*2+4).
        // Declared here (before layout) because reStackRibbons uses it post-layout.
        const pillH = (PILL_PAD_V + 2) * 2;   // extra headroom vs the plain-text baseline of 4 px
        const minRibbonHeight = Math.max(
            1,
            showLabels ? fontSize  + (labelBgActive ? pillH : 4) : 1,
            showValues ? vFontSize + (valueBgActive ? pillH : 4) : 1
        );

        // ── Layout margins ────────────────────────────────────────────────────
        // "Outside" label mode: outermost column labels face into dedicated
        // side margins sized by canvas-measuring those labels, so links fill
        // the remaining inner width independently of label length.
        // "Inside" label mode: all labels go inward between columns; a small
        // uniform margin is sufficient.
        const labelGap = 6;   // px gap between node face and label
        let leftLabelMaxW  = 0;
        let rightLabelMaxW = 0;
        if (showLabels && labelOutside) {
            const lbFont  = `${bold ? "bold " : ""}${fontSize}px ${fontFamily}`;
            const numLvls = levelCats.length;
            for (const n of nodes) {
                const lvl = parseInt(n.name.slice(0, n.name.indexOf("\x01")));
                const w   = measureText(n.label, lbFont);
                if (lvl === 0)           leftLabelMaxW  = Math.max(leftLabelMaxW,  w);
                if (lvl === numLvls - 1) rightLabelMaxW = Math.max(rightLabelMaxW, w);
            }
        }
        // ── Grand total pre-computation ───────────────────────────────────────
        // The grand total = sum of all link values leaving the first column
        // (depth-0 sources, identified by the "0\x01" key prefix).  This can be
        const lbExtra  = labelBgActive ? PILL_PAD_H : 0;
        const leftPad  = (showLabels && labelOutside) ? leftLabelMaxW + labelGap + lbExtra : 8;
        const rightPad = (showLabels && labelOutside) ? rightLabelMaxW + labelGap + lbExtra : 8;
        const margin   = {
            top:    8,
            right:  Math.max(8, rightPad),
            bottom: 8,
            left:   Math.max(8, leftPad)
        };
        const innerW   = Math.max(10, width  - margin.left - margin.right);
        const innerH   = Math.max(10, height - margin.top  - margin.bottom);

        this.container.attr("transform", `translate(${margin.left},${margin.top})`);

        // Reusable sankey factory — applies node sort and padding consistently in both passes.
        const makeSankeyLayout = (nw: number) => {
            const sk = sankey<NodeDatum, LinkDatum>()
                .nodeWidth(nw)
                .nodePadding(nodePadding)
                .extent([[0, 0], [innerW, innerH]]);
            if (nodeSortFn) sk.nodeSort(nodeSortFn);
            return sk;
        };

        // Pass 1: run d3-sankey with the user's nodeWidth to obtain node values.
        // We need node.value for text measurement before we can set the final width.
        let graph: LayoutGraph;
        try {
            graph = makeSankeyLayout(nodeWidth)({
                nodes: nodes.map(d => ({ ...d })),
                links: links.map(d => ({ ...d }))
            });
        } catch (e) {
            this.showError(width, height, "Could not compute layout. Check for circular references.");
            return;
        }

        // ── Value formatter ───────────────────────────────────────────────────
        // Resolve "auto" unit once using the full set of node values, then build
        // convenience wrappers used everywhere a data value is rendered.
        const resolvedUnit = resolveDisplayUnit(vDisplayUnits, graph.nodes.map(n => n.value ?? 0));
        const fmtVal = (v: number) => formatDataValue(v, resolvedUnit, vDecimalPlaces);

        // Grand total = sum of all depth-0 (leftmost column) node values.
        // Used for percentage calculations in data labels.
        const totalValue = (graph.nodes as LayoutNode[])
            .filter(n => (n.depth ?? 0) === 0)
            .reduce((s, n) => s + (n.value ?? 0), 0);

        const fmtPct = (v: number): string => {
            const pct = totalValue > 0 ? v / totalValue * 100 : 0;
            return `${pct.toLocaleString(undefined, { minimumFractionDigits: vDecimalPlaces, maximumFractionDigits: vDecimalPlaces })}%`;
        };

        const fmtLabel = (v: number): string => {
            if (labelFormatStr === "percent") return fmtPct(v);
            if (labelFormatStr === "both")    return `${fmtVal(v)} (${fmtPct(v)})`;
            return fmtVal(v);
        };

        // ── Effective node width (minimum to hold value label text) ───────────
        // When value labels are positioned inside a node, the node must be at
        // least wide enough to contain the formatted number string.  Measure
        // every node's label with the canvas API and take the widest.
        let effectiveNodeWidth = nodeWidth;
        if (showValues && valueTarget === "nodes" && valuePos !== "outside") {
            const font     = `${vBold ? "bold " : ""}${vFontSize}px ${vFontFamily}`;
            // When a pill background is active, node must also accommodate horizontal pill padding
            const nodePad  = valueBgActive ? PILL_PAD_H * 2 : 8; // pill: 8 px each side; plain: 4 px
            for (const nd of graph.nodes) {
                const tw = measureText(fmtLabel(nd.value ?? 0), font);
                if (tw + nodePad > effectiveNodeWidth) effectiveNodeWidth = tw + nodePad;
            }
            // Cap expansion so ribbons stay at least 40 px wide regardless of font size.
            // Each of the (numCols) node columns may grow to at most (innerW/numCols - 40) px.
            const numCols = levelCats.length;
            if (numCols > 1) {
                const maxNodeW = Math.max(nodeWidth, innerW / numCols - 40);
                effectiveNodeWidth = Math.min(effectiveNodeWidth, maxNodeW);
            }
        }

        // Pass 2: re-run layout with the wider node if text measurement required it.
        if (effectiveNodeWidth > nodeWidth) {
            try {
                graph = makeSankeyLayout(effectiveNodeWidth)({
                    nodes: nodes.map(d => ({ ...d })),
                    links: links.map(d => ({ ...d }))
                });
            } catch (e) {
                this.showError(width, height, "Could not compute layout. Check for circular references.");
                return;
            }
        }

        // ── Re-stack ribbons to honour minRibbonHeight ────────────────────────
        // d3-sankey spaces ribbon centres based on natural (proportional) widths.
        // minRibbonHeight inflates thin ribbons beyond their proportional share,
        // so the natural centres are too close together — ribbons overlap at the
        // node and overflow the node rectangle.  reStackRibbons corrects this by:
        //   • computing effective ribbon widths: max(minRibbonHeight, natural width)
        //   • expanding node.y1 when the inflated ribbons no longer fit
        //   • re-stacking link.y0 / link.y1 within the (possibly taller) node
        // linkDrawW / linkDrawW_tgt: per-link scaled drawing widths (source-side and
        // target-side respectively) keyed by "srcName\x00tgtName".  Both maps are
        // consumed by taperingRibbonPath() to draw correctly-tapered ribbons.
        const linkDrawW     = new Map<string, number>();
        const linkDrawW_tgt = new Map<string, number>();
        if (minRibbonHeight > 1) {
            reStackRibbons(graph, minRibbonHeight, linkDrawW, linkDrawW_tgt);
            // After nodes are expanded, nodes in the same column may overlap.
            // Resolve by pushing lower nodes down (with their ribbon endpoints).
            resolveColumnOverlaps(graph, nodePadding);
        }

        // ── Fit-to-viewport (vertical only) ───────────────────────────────────
        // reStackRibbons / resolveColumnOverlaps can push nodes below innerH.
        // Rather than applying a uniform SVG zoom (which also compresses the
        // horizontal axis and introduces left/right margins), we scale only the
        // y-coordinates directly in the graph data before rendering.  Horizontal
        // positions are always exact by construction and are never touched.
        const actualMaxY = graph.nodes.reduce((m, n) => Math.max(m, n.y1 ?? 0), 0);
        const fitK       = actualMaxY > 0 ? Math.min(1, innerH / actualMaxY) : 1;
        if (fitK < 1) {
            for (const nd of graph.nodes) {
                const node = nd as LayoutNode;
                node.y0 = (node.y0 ?? 0) * fitK;
                node.y1 = (node.y1 ?? 0) * fitK;
                for (const lnk of (node.sourceLinks ?? []) as LayoutLink[]) {
                    lnk.y0 = (lnk.y0 ?? 0) * fitK;
                }
                for (const lnk of (node.targetLinks ?? []) as LayoutLink[]) {
                    lnk.y1 = (lnk.y1 ?? 0) * fitK;
                }
            }
            // Scale ribbon drawing-width maps so ribbon heights match node heights.
            linkDrawW.forEach((w, k)     => linkDrawW.set(k, w * fitK));
            linkDrawW_tgt.forEach((w, k) => linkDrawW_tgt.set(k, w * fitK));
        }
        // y-coordinates are pre-scaled — no SVG transform needed for fit-to-viewport.
        // fitTransform is the identity; double-click reset returns to the natural fit.
        // Only snap the zoom on data or resize (not format-pane-only) updates.
        this.fitTransform = zoomIdentity;
        if (options.type & (VisualUpdateType.Data | VisualUpdateType.Resize)) {
            this.svg.call(this.zoomBehavior.transform, this.fitTransform);
        }

        // Use report theme colours keyed by display label so the same name gets the same colour
        const color = (label: string): string => this.host.colorPalette.getColor(label).value;

        // ── Selection highlight helpers ────────────────────────────────────────
        //
        // When a node or ribbon is clicked, nodes/ribbons in the highlighted
        // direction are shown at full opacity; everything else dims to 15%.
        //
        // highlightDirStr controls direction: "downstream", "upstream", or "both".
        // highlightSet    – names of all highlighted nodes.
        // linkAnchorNode  – for a ribbon click, the node on the non-BFS end
        //   (e.g. source for downstream, target for upstream) kept at full opacity.

        let highlightSet   = new Set<string>();
        let linkAnchorNode = "";

        // BFS helpers — defined here so they close over `graph`
        const bfsForward = (startName: string): Set<string> => {
            const result = new Set<string>();
            const queue: LayoutNode[] = [];
            const startNd = (graph.nodes as LayoutNode[]).find(x => x.name === startName);
            if (startNd) queue.push(startNd);
            while (queue.length > 0) {
                const n = queue.shift()!;
                if (result.has(n.name)) continue;
                result.add(n.name);
                for (const lnk of (n.sourceLinks ?? []) as LayoutLink[]) {
                    queue.push(lnk.target as LayoutNode);
                }
            }
            return result;
        };

        const bfsBackward = (startName: string): Set<string> => {
            const result = new Set<string>();
            const queue: LayoutNode[] = [];
            const startNd = (graph.nodes as LayoutNode[]).find(x => x.name === startName);
            if (startNd) queue.push(startNd);
            while (queue.length > 0) {
                const n = queue.shift()!;
                if (result.has(n.name)) continue;
                result.add(n.name);
                for (const lnk of (n.targetLinks ?? []) as LayoutLink[]) {
                    queue.push(lnk.source as LayoutNode);
                }
            }
            return result;
        };

        const refreshHighlight = (): void => {
            highlightSet   = new Set<string>();
            linkAnchorNode = "";
            if (this.selectionType === "none") return;

            if (this.selectionType === "node") {
                // Always include the clicked node itself
                highlightSet.add(this.selectedKey);
                if (highlightDirStr !== "upstream") {
                    for (const v of bfsForward(this.selectedKey))  highlightSet.add(v);
                }
                if (highlightDirStr !== "downstream") {
                    for (const v of bfsBackward(this.selectedKey)) highlightSet.add(v);
                }
            } else {
                // Link click: BFS from the appropriate end, anchor the other end
                const sep     = this.selectedKey.indexOf("\x00");
                const srcName = this.selectedKey.slice(0, sep);
                const tgtName = this.selectedKey.slice(sep + 1);
                if (highlightDirStr === "downstream") {
                    linkAnchorNode = srcName;
                    for (const v of bfsForward(tgtName))  highlightSet.add(v);
                } else if (highlightDirStr === "upstream") {
                    linkAnchorNode = tgtName;
                    for (const v of bfsBackward(srcName)) highlightSet.add(v);
                } else {
                    // both: BFS in both directions from both ends
                    for (const v of bfsForward(tgtName))  highlightSet.add(v);
                    for (const v of bfsBackward(srcName)) highlightSet.add(v);
                    highlightSet.add(srcName);
                    highlightSet.add(tgtName);
                }
            }
        };

        // Seed with any selection state carried over from the previous render
        refreshHighlight();

        const nodeOpacity = (d: LayoutNode): number => {
            if (this.selectionType === "none") return 1;
            if (d.name === linkAnchorNode) return 1;
            return highlightSet.has(d.name) ? 1 : 0.15;
        };

        // ── Source contribution propagation ────────────────────────────────────
        // nodeContrib: node.name → Map<colorSrcNodeName, fraction>
        // Seeded at depth `sourceDepth` (default 0 = leftmost column) and
        // propagated forward so each downstream node inherits the weighted mix
        // of color-source nodes that flow into it.
        // Nodes shallower than sourceDepth have no entry (rendered as plain
        // single-color ribbons using the immediate-source fallback).
        const nodeContrib  = new Map<string, Map<string, number>>();
        const colorSrcLbl  = new Map<string, string>();   // colorSrc node.name → label

        for (const nd of ([...graph.nodes as LayoutNode[]]
                          .sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0)))) {
            if ((nd.depth ?? 0) === sourceDepth) {
                nodeContrib.set(nd.name, new Map([[nd.name, 1.0]]));
                colorSrcLbl.set(nd.name, nd.label);
            } else if ((nd.depth ?? 0) > sourceDepth) {
                const m    = new Map<string, number>();
                const totV = nd.value ?? 0;
                if (totV > 0) {
                    for (const lnk of (nd.targetLinks ?? []) as LayoutLink[]) {
                        const src  = lnk.source as LayoutNode;
                        const frac = (lnk.value ?? 0) / totV;
                        (nodeContrib.get(src.name) ?? new Map()).forEach(
                            (f, s) => m.set(s, (m.get(s) ?? 0) + f * frac)
                        );
                    }
                }
                nodeContrib.set(nd.name, m);
            }
            // depth < sourceDepth: no entry — handled as simple ribbons below
        }

        // Canonical stacking order: color-source nodes sorted top-to-bottom.
        const colorSrcOrder = new Map<string, number>(
            ([...graph.nodes as LayoutNode[]]
                .filter(n => (n.depth ?? 0) === sourceDepth)
                .sort((a, b) => (a.y0 ?? 0) - (b.y0 ?? 0))
                .map((n, i) => [n.name, i] as [string, number]))
        );

        // ── Sub-ribbon data ────────────────────────────────────────────────────
        // Normal mode: one SubRibbon per link (full ribbon width).
        // Color by Source mode: node-level source banding.
        //   Each node's [y0, y1] is divided into per-source bands (sized by
        //   fractional contribution, ordered by depth0Order).  Both the right side
        //   (outgoing links) and left side (incoming links) of every node use the
        //   same band layout, so like-source sub-ribbons are always contiguous and
        //   flows trace smoothly through every intermediate node without jumbling.
        const subRibbons: SubRibbon[] = [];
        if (!colorBySource) {
            for (const lnk of graph.links as LayoutLink[]) {
                const srcNd = lnk.source as LayoutNode;
                const tgtNd = lnk.target as LayoutNode;
                const key   = `${srcNd.name}\x00${tgtNd.name}`;
                const srcW  = linkDrawW.get(key)     ?? Math.max(minRibbonHeight, lnk.width ?? 1) * fitK;
                const tgtW  = linkDrawW_tgt.get(key) ?? Math.max(minRibbonHeight, lnk.width ?? 1) * fitK;
                subRibbons.push({
                    link: lnk, srcLabel: "",
                    srcX1: srcNd.x1 ?? 0, srcYtop: (lnk.y0 ?? 0) - srcW / 2, srcYbot: (lnk.y0 ?? 0) + srcW / 2,
                    tgtX0: tgtNd.x0 ?? 0, tgtYtop: (lnk.y1 ?? 0) - tgtW / 2, tgtYbot: (lnk.y1 ?? 0) + tgtW / 2,
                });
            }
        } else {
            // srcPos / tgtPos: keyed by "srcName\x00tgtName\x00depth0Name"
            const srcPos = new Map<string, {top: number; bot: number}>();
            const tgtPos = new Map<string, {top: number; bot: number}>();

            // nodeDrawFrac: draw-width-based source fractions, propagated in
            // depth order.  Unlike nodeContrib (which uses link *values*),
            // these fractions reflect the actual pixel draw widths, so that
            // minRibbonHeight inflation on thin links is honoured at every
            // downstream node.  We compute incoming bands first, derive
            // ndDrawFrac, then use it for outgoing bands — keeping both sides
            // of every node consistent and preventing hairline sub-ribbons.
            const nodeDrawFrac = new Map<string, Map<string, number>>();

            for (const nd of ([...graph.nodes as LayoutNode[]]
                              .sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0)))) {
                // Nodes shallower than the color-source depth have no contribution
                // entries and are rendered as simple single-color ribbons separately.
                if ((nd.depth ?? 0) < sourceDepth) continue;

                const srcLinks = (nd.sourceLinks ?? []) as LayoutLink[];
                const tgtLinks = (nd.targetLinks ?? []) as LayoutLink[];
                const ndSrcs   = [...(nodeContrib.get(nd.name) ?? new Map<string, number>()).entries()]
                    .sort((a, b) => (colorSrcOrder.get(a[0]) ?? 0) - (colorSrcOrder.get(b[0]) ?? 0));

                // ── Left side first: derive draw-width fractions ───────────────
                // Incoming band heights use the actual linkDrawW_tgt values and
                // the source node's draw-width fractions (nodeDrawFrac, already
                // computed for earlier depth levels).  This correctly propagates
                // minRibbonHeight inflation through every section of the chart.
                const inBandH = new Map<string, number>(ndSrcs.map(([s]) => [s, 0] as [string, number]));
                for (const lnk of tgtLinks) {
                    const srcNd2  = lnk.source as LayoutNode;
                    const key2    = `${srcNd2.name}\x00${nd.name}`;
                    const fullW2  = linkDrawW_tgt.get(key2) ?? Math.max(minRibbonHeight, lnk.width ?? 1) * fitK;
                    // Use draw-width fracs from the source node (falls back to
                    // nodeContrib for depth-0 nodes not yet in nodeDrawFrac).
                    const lnkC   = nodeDrawFrac.get(srcNd2.name) ?? nodeContrib.get(srcNd2.name) ?? new Map<string, number>();
                    for (const [s] of ndSrcs) {
                        inBandH.set(s, (inBandH.get(s) ?? 0) + fullW2 * (lnkC.get(s) ?? 0));
                    }
                }

                // Normalise inBandH to fractions.  Depth-0 nodes have no
                // incoming links (totalInBandH = 0) so fall back to nodeContrib
                // ({self: 1.0}), which is always exact for source nodes.
                const totalInBandH = [...inBandH.values()].reduce((a, b) => a + b, 0);
                const ndDrawFrac: Map<string, number> = totalInBandH > 0
                    ? new Map<string, number>([...inBandH.entries()].map(([s, h]) => [s, h / totalInBandH]))
                    : new Map<string, number>(ndSrcs.map(([s, f]) => [s, f]));
                nodeDrawFrac.set(nd.name, ndDrawFrac);

                // tgtPos: position each incoming link's sub-ribbons within
                // the per-source bands derived above.
                const inCursor = new Map<string, number>();
                { let y = nd.y0 ?? 0;
                  for (const [s] of ndSrcs) { inCursor.set(s, y); y += inBandH.get(s) ?? 0; } }

                for (const lnk of tgtLinks) {
                    const srcNd      = lnk.source as LayoutNode;
                    const key        = `${srcNd.name}\x00${nd.name}`;
                    const fullW      = linkDrawW_tgt.get(key) ?? Math.max(minRibbonHeight, lnk.width ?? 1) * fitK;
                    const lnkContrib = nodeDrawFrac.get(srcNd.name) ?? nodeContrib.get(srcNd.name) ?? new Map<string, number>();
                    for (const [s] of ndSrcs) {
                        const subW = fullW * (lnkContrib.get(s) ?? 0);
                        const cur  = inCursor.get(s) ?? 0;
                        tgtPos.set(`${key}\x00${s}`, {top: cur, bot: cur + subW});
                        inCursor.set(s, cur + subW);
                    }
                }

                // ── Right side: source-side positions of outgoing links ────────
                // Band heights use ndDrawFrac (draw-width-based) so the outgoing
                // source bands match the incoming bands computed above.  This
                // makes the coloured bands continuous across each node and
                // prevents subsequent sections from rendering as hairlines.
                const outBandH = new Map<string, number>(ndSrcs.map(([s]) => [s, 0] as [string, number]));
                for (const lnk of srcLinks) {
                    const key2   = `${nd.name}\x00${(lnk.target as LayoutNode).name}`;
                    const fullW2 = linkDrawW.get(key2) ?? Math.max(minRibbonHeight, lnk.width ?? 1) * fitK;
                    for (const [s] of ndSrcs) { outBandH.set(s, (outBandH.get(s) ?? 0) + fullW2 * (ndDrawFrac.get(s) ?? 0)); }
                }
                const outCursor = new Map<string, number>();
                { let y = nd.y0 ?? 0;
                  for (const [s] of ndSrcs) { outCursor.set(s, y); y += outBandH.get(s) ?? 0; } }

                for (const lnk of srcLinks) {
                    const key  = `${nd.name}\x00${(lnk.target as LayoutNode).name}`;
                    const fullW = linkDrawW.get(key) ?? Math.max(minRibbonHeight, lnk.width ?? 1) * fitK;
                    for (const [s] of ndSrcs) {
                        const subW = fullW * (ndDrawFrac.get(s) ?? 0);
                        const cur  = outCursor.get(s) ?? 0;
                        srcPos.set(`${key}\x00${s}`, {top: cur, bot: cur + subW});
                        outCursor.set(s, cur + subW);
                    }
                }
            }

            // Build SubRibbon array from the position maps.
            // Use draw-width fracs for the visibility filter so that a source
            // with a tiny value contribution but an inflated draw width still
            // gets a correctly-sized ribbon rather than being silently dropped.
            for (const lnk of graph.links as LayoutLink[]) {
                const srcNd = lnk.source as LayoutNode;
                const tgtNd = lnk.target as LayoutNode;
                const key   = `${srcNd.name}\x00${tgtNd.name}`;

                if ((srcNd.depth ?? 0) < sourceDepth) {
                    // ── Pre / boundary links ───────────────────────────────────
                    // Links whose source is shallower than the color-source depth
                    // are not split into sub-ribbons.  Boundary links (srcDepth
                    // = sourceDepth − 1) are colored by the depth-N destination
                    // node they connect to; links further upstream fall back to
                    // the default immediate-source color (srcLabel = "").
                    const srcW = linkDrawW.get(key)     ?? Math.max(minRibbonHeight, lnk.width ?? 1) * fitK;
                    const tgtW = linkDrawW_tgt.get(key) ?? srcW;
                    const label = (srcNd.depth ?? 0) === sourceDepth - 1
                        ? (colorSrcLbl.get(tgtNd.name) ?? "")
                        : "";
                    subRibbons.push({
                        link: lnk, srcLabel: label,
                        srcX1: srcNd.x1 ?? 0, srcYtop: (lnk.y0 ?? 0) - srcW / 2, srcYbot: (lnk.y0 ?? 0) + srcW / 2,
                        tgtX0: tgtNd.x0 ?? 0, tgtYtop: (lnk.y1 ?? 0) - tgtW / 2, tgtYbot: (lnk.y1 ?? 0) + tgtW / 2,
                    });
                    continue;
                }

                const drawFracs = nodeDrawFrac.get(srcNd.name);
                const srcs      = [...(nodeContrib.get(srcNd.name) ?? new Map<string, number>()).entries()]
                    .sort((a, b) => (colorSrcOrder.get(a[0]) ?? 0) - (colorSrcOrder.get(b[0]) ?? 0));
                for (const [s, valueFrac] of srcs) {
                    const drawF = drawFracs?.get(s) ?? valueFrac;
                    if (drawF < 0.0001) continue;
                    const sp = srcPos.get(`${key}\x00${s}`);
                    const tp = tgtPos.get(`${key}\x00${s}`);
                    if (!sp || !tp) continue;
                    subRibbons.push({
                        link: lnk, srcLabel: colorSrcLbl.get(s) ?? srcNd.label,
                        srcX1: srcNd.x1 ?? 0, srcYtop: sp.top, srcYbot: sp.bot,
                        tgtX0: tgtNd.x0 ?? 0, tgtYtop: tp.top, tgtYbot: tp.bot,
                    });
                }
            }
        }

        const linkOpacityFn = (d: SubRibbon): number => {
            if (this.selectionType === "none") return linkOpacity;
            const src = (d.link.source as LayoutNode).name;
            const tgt = (d.link.target as LayoutNode).name;
            const lk  = `${src}\x00${tgt}`;
            if (lk === this.selectedKey) return linkOpacity;
            // Show link only when both its endpoints are in the highlight set
            return (highlightSet.has(src) && highlightSet.has(tgt)) ? linkOpacity : linkOpacity * 0.15;
        };

        // Ribbon color: color-source column label (colorBySource) or immediate source label.
        const ribbonColor = (d: SubRibbon): string =>
            color(d.srcLabel || (d.link.source as LayoutNode).label);

        // ── Flow gradient fills ────────────────────────────────────────────────
        // When gradientFlows is on each ribbon gets an SVG linearGradient that
        // fades from its source color (left edge) to its target node color (right
        // edge).  Gradients are deduplicated by (srcColor, tgtColor) and stored
        // in a shared <defs> element prepended to the container.
        // gradientUnits="objectBoundingBox" keeps the direction correct regardless
        // of the ribbon's position or height in the viewport.
        const gradMap  = new Map<string, string>();
        let   gradIdx  = 0;
        const gradDefs = gradientFlows
            ? this.container.append<SVGDefsElement>("defs")
            : null;

        const getFillAttr = (d: SubRibbon): string => {
            const srcColor = ribbonColor(d);
            if (!gradDefs) return srcColor;
            const tgtColor = color((d.link.target as LayoutNode).label);
            if (srcColor === tgtColor) return srcColor;
            const key = `${srcColor}|${tgtColor}`;
            if (!gradMap.has(key)) {
                const id = `${this.instanceUid}-gr-${gradIdx++}`;
                gradMap.set(key, id);
                const g = gradDefs.append("linearGradient")
                    .attr("id",            id)
                    .attr("x1",            "0%")
                    .attr("y1",            "0%")
                    .attr("x2",            "100%")
                    .attr("y2",            "0%")
                    .attr("gradientUnits", "objectBoundingBox");
                g.append("stop").attr("offset", "0%")  .attr("stop-color", srcColor);
                g.append("stop").attr("offset", "100%").attr("stop-color", tgtColor);
            }
            return `url(#${gradMap.get(key)!})`;
        };

        // ── Links ─────────────────────────────────────────────────────────────
        // Each SubRibbon is one filled closed path.  In normal mode this is one
        // path per link; in "Color by Source" mode each link emits N paths so
        // flows are visually split and traceable from the leftmost column onward.
        const linkPaths = this.container
            .append("g")
            .classed("links", true)
            .selectAll<SVGPathElement, SubRibbon>("path")
            .data(subRibbons)
            .join("path")
            .attr("d",       d => subRibbonPath(d))
            .attr("fill",    d => getFillAttr(d))
            .attr("opacity", d => linkOpacityFn(d))
            .style("cursor", "pointer");

        linkPaths.on("mouseenter", (event: MouseEvent, d: SubRibbon) => {
            const srcNd = d.link.source as LayoutNode;
            const tgtNd = d.link.target as LayoutNode;
            const lk    = `${srcNd.name}\x00${tgtNd.name}`;
            this.host.tooltipService.show({
                dataItems: [{
                    header:      `${srcNd.label} \u2192 ${tgtNd.label}`,
                    displayName: "Value",
                    value:       fmtLabel(d.link.value),
                    color:       ribbonColor(d)
                }],
                identities:  linkSelIds.get(lk) ?? [],
                coordinates: [event.clientX, event.clientY],
                isTouchEvent: false
            });
        });
        linkPaths.on("mousemove", (event: MouseEvent) => {
            this.host.tooltipService.move({ coordinates: [event.clientX, event.clientY], isTouchEvent: false, identities: [] });
        });
        linkPaths.on("mouseleave", () => {
            this.host.tooltipService.hide({ immediately: false, isTouchEvent: false });
        });

        linkPaths.on("click", (event: MouseEvent, d: SubRibbon) => {
            const lk = `${(d.link.source as LayoutNode).name}\x00${(d.link.target as LayoutNode).name}`;
            if (this.selectionType === "link" && this.selectedKey === lk) {
                // Second click on the same ribbon — deselect
                this.selectionType = "none";
                this.selectedKey   = "";
                this.selectionManager.clear();
            } else {
                this.selectionType = "link";
                this.selectedKey   = lk;
                this.selectionManager.select(linkSelIds.get(lk) ?? [], event.ctrlKey || event.metaKey);
            }
            refreshHighlight();
            nodeGroups.select<SVGRectElement>("rect").attr("opacity", nodeOpacity);
            linkPaths.attr("opacity", linkOpacityFn);
            event.stopPropagation();
        });

        linkPaths.on("contextmenu", (event: MouseEvent, d: SubRibbon) => {
            event.preventDefault();
            event.stopPropagation();
            const lk  = `${(d.link.source as LayoutNode).name}\x00${(d.link.target as LayoutNode).name}`;
            const ids = linkSelIds.get(lk) ?? [];
            this.selectionManager.showContextMenu(
                ids[0] ?? {} as powerbi.extensibility.ISelectionId,
                { x: event.clientX, y: event.clientY }
            );
        });

        // ── Nodes ─────────────────────────────────────────────────────────────
        const nodeGroups = this.container
            .append("g")
            .classed("nodes", true)
            .selectAll<SVGGElement, LayoutNode>("g")
            .data(graph.nodes)
            .join("g")
            .classed("node", true)
            .style("cursor", "pointer");

        nodeGroups
            .append("rect")
            .attr("x",      d => d.x0 ?? 0)
            .attr("y",      d => d.y0 ?? 0)
            .attr("width",  d => (d.x1 ?? 0) - (d.x0 ?? 0))
            .attr("height", d => Math.max(1, (d.y1 ?? 0) - (d.y0 ?? 0)))
            .attr("fill",   d => color(d.label))
            .attr("stroke", "#333")
            .attr("stroke-width", 0.5)
            .attr("opacity", nodeOpacity);

        nodeGroups.on("click", (event: MouseEvent, d: LayoutNode) => {
            if (this.selectionType === "node" && this.selectedKey === d.name) {
                // Second click on the same node — deselect
                this.selectionType = "none";
                this.selectedKey   = "";
                this.selectionManager.clear();
            } else {
                this.selectionType = "node";
                this.selectedKey   = d.name;
                this.selectionManager.select(nodeSelIds.get(d.name) ?? [], event.ctrlKey || event.metaKey);
            }
            refreshHighlight();
            nodeGroups.select<SVGRectElement>("rect").attr("opacity", nodeOpacity);
            linkPaths.attr("opacity", linkOpacityFn);
            event.stopPropagation();
        });

        nodeGroups.on("contextmenu", (event: MouseEvent, d: LayoutNode) => {
            event.preventDefault();
            event.stopPropagation();
            const ids = nodeSelIds.get(d.name) ?? [];
            this.selectionManager.showContextMenu(
                ids[0] ?? {} as powerbi.extensibility.ISelectionId,
                { x: event.clientX, y: event.clientY }
            );
        });

        nodeGroups.on("mouseenter", (event: MouseEvent, d: LayoutNode) => {
            this.host.tooltipService.show({
                dataItems: [{
                    header:      d.label,
                    displayName: "Value",
                    value:       fmtLabel(d.value ?? 0),
                    color:       color(d.label)
                }],
                identities:  nodeSelIds.get(d.name) ?? [],
                coordinates: [event.clientX, event.clientY],
                isTouchEvent: false
            });
        });
        nodeGroups.on("mousemove", (event: MouseEvent) => {
            this.host.tooltipService.move({ coordinates: [event.clientX, event.clientY], isTouchEvent: false, identities: [] });
        });
        nodeGroups.on("mouseleave", () => {
            this.host.tooltipService.hide({ immediately: false, isTouchEvent: false });
        });

        // ── Name labels ───────────────────────────────────────────────────────
        if (showLabels) {
            const labelGs = nodeGroups
                .append("g")
                .classed("label-group", true)
                .attr("pointer-events", "none");

            if (labelFollowPath) {
                // ── Curved mode: labels follow their primary ribbon ────────────
                // Each node's label rides its primary ribbon's bezier centreline
                // via <textPath>.  Primary = largest outgoing ribbon for depth-0
                // nodes, largest incoming ribbon for all others.  The background
                // pill (when enabled) is a partial stroke along the same path.

                // 1. Determine the primary link for every node.
                const nodePrimaryLink = new Map<LayoutNode, LayoutLink>();

                for (const nd of graph.nodes as LayoutNode[]) {
                    // Mirror flat-mode side logic: left-half (or no incoming) → outgoing ribbon
                    // so label appears to the right of the node; right-half → incoming ribbon
                    // so label appears to the left.  Keeps curved labels on the same side as flat.
                    const isLeftHalf  = (nd.x0 ?? 0) < innerW / 2;
                    const hasIncoming = ((nd.targetLinks ?? []) as LayoutLink[]).length > 0;
                    const links = (
                        (isLeftHalf || !hasIncoming)
                            ? (nd.sourceLinks ?? [])
                            : (nd.targetLinks  ?? [])
                    ) as LayoutLink[];
                    if (links.length === 0) continue;
                    const primary = links.reduce((best, l) =>
                        ((l.value ?? 0) > (best.value ?? 0) ? l : best));
                    nodePrimaryLink.set(nd, primary);
                }

                // 2. Register a per-node label path in <defs>.
                //    Every node with a primary link gets a curved path. The node-side
                //    control point is set to nodeMidY so the bezier has a HORIZONTAL
                //    tangent at the node endpoint — this keeps the round pill caps
                //    horizontal and gives even left/right text padding.
                const nodeLabelIds = new Map<LayoutNode, string>();
                const defs = this.container.append("defs");
                let pathIdx = 0;
                for (const [nd, link] of nodePrimaryLink.entries()) {
                    const id       = `${this.instanceUid}-lb-${pathIdx++}`;
                    const srcX1    = (link.source as LayoutNode).x1 ?? 0;
                    const tgtX0    = (link.target as LayoutNode).x0 ?? 0;
                    const cx       = (srcX1 + tgtX0) / 2;
                    const usesOut  = (nd.x0 ?? 0) < innerW / 2 || ((nd.targetLinks ?? []) as LayoutLink[]).length === 0;
                    const nodeMidY = ((nd.y0 ?? 0) + (nd.y1 ?? 0)) / 2;
                    // Horizontal tangent at the node-side endpoint: match the
                    // adjacent control point y to nodeMidY.
                    const pathD    = usesOut
                        ? `M${srcX1},${nodeMidY} C${cx},${nodeMidY} ${cx},${link.y1} ${tgtX0},${link.y1}`
                        : `M${srcX1},${link.y0} C${cx},${link.y0} ${cx},${nodeMidY} ${tgtX0},${nodeMidY}`;
                    nodeLabelIds.set(nd, id);
                    defs.append("path")
                        .attr("id", id)
                        .attr("d", pathD);
                }

                // 3. Curved pill stroke paths — one per node that has a primary link.
                //    Nodes with no primary link (isolated, no ribbons) get their pill
                //    in step 5's flat-fallback branch instead.
                if (labelBgActive) {
                    labelGs.each(function (d: LayoutNode) {
                        if (!nodeLabelIds.get(d)) return; // flat-fallback node
                        const link = nodePrimaryLink.get(d);
                        if (!link) return;
                        const srcX1    = (link.source as LayoutNode).x1 ?? 0;
                        const tgtX0    = (link.target as LayoutNode).x0 ?? 0;
                        const cx       = (srcX1 + tgtX0) / 2;
                        const usesOut  = (d.x0 ?? 0) < innerW / 2 || ((d.targetLinks ?? []) as LayoutLink[]).length === 0;
                        const nodeMidY = ((d.y0 ?? 0) + (d.y1 ?? 0)) / 2;
                        // Same horizontal-tangent bezier used in the defs path.
                        const pathD    = usesOut
                            ? `M${srcX1},${nodeMidY} C${cx},${nodeMidY} ${cx},${link.y1} ${tgtX0},${link.y1}`
                            : `M${srcX1},${link.y0} C${cx},${link.y0} ${cx},${nodeMidY} ${tgtX0},${nodeMidY}`;
                        select(this).append("path")
                            .classed("label-pill-path", true)
                            .attr("d", pathD)
                            .attr("fill",           "none")
                            .attr("stroke",         labelBgColor)
                            .attr("stroke-opacity", labelBgOpacity)
                            .attr("stroke-width",   fontSize + PILL_PAD_V * 2)
                            .attr("stroke-linecap", "round");
                    });
                }

                // 4. Text on path.  Depth-0 nodes anchor at the source (left) end;
                //    all others anchor at the target (right) end, hugging their node.
                labelGs.each(function (d: LayoutNode) {
                    const pathId = nodeLabelIds.get(d);

                    if (!pathId) {
                        // Fallback for nodes with no primary ribbon: flat horizontal label.
                        const isLeft = (d.x0 ?? 0) < innerW / 2;
                        select(this).append("text")
                            .attr("x",           isLeft ? (d.x1 ?? 0) + labelGap : (d.x0 ?? 0) - labelGap)
                            .attr("y",           ((d.y0 ?? 0) + (d.y1 ?? 0)) / 2)
                            .attr("dy",          "0.35em")
                            .attr("text-anchor", isLeft ? "start" : "end")
                            .attr("font-family",     fontFamily)
                            .attr("font-size",       `${fontSize}px`)
                            .attr("font-weight",     bold      ? "bold"      : "normal")
                            .attr("font-style",      italic    ? "italic"    : "normal")
                            .attr("text-decoration", underline ? "underline" : "none")
                            .attr("fill",            fontColor)
                            .text(d.label);
                        return;
                    }

                    const usesOutgoing = (d.x0 ?? 0) < innerW / 2 || ((d.targetLinks ?? []) as LayoutLink[]).length === 0;
                    const startOffset  = usesOutgoing ? "0%"   : "100%";
                    const textAnchor   = usesOutgoing ? "start" : "end";
                    const dxShift      = usesOutgoing ? "8"    : "-8";

                    select(this).append("text")
                        .attr("dominant-baseline", "central")
                        .attr("font-family",     fontFamily)
                        .attr("font-size",       `${fontSize}px`)
                        .attr("font-weight",     bold      ? "bold"      : "normal")
                        .attr("font-style",      italic    ? "italic"    : "normal")
                        .attr("text-decoration", underline ? "underline" : "none")
                        .attr("fill",            fontColor)
                        .append("textPath")
                        .attr("href",        `#${pathId}`)
                        .attr("startOffset", startOffset)
                        .attr("text-anchor", textAnchor)
                        .attr("dx",          dxShift)
                        .text(d.label);
                });

                // 5. Finalise pill backgrounds.
                //    • Curved nodes  → size the dasharray on the pill-path stroke.
                //    • Flat-fallback → insert a flat stroked-path pill before the text.
                if (labelBgActive) {
                    labelGs.each(function (d: LayoutNode) {
                        const grp  = select(this);
                        const tpEl = grp.select<SVGTextPathElement>("textPath").node();

                        if (tpEl) {
                            // ── Curved node: position the dash on the pill stroke ──
                            const pillPathEl = grp.select<SVGPathElement>("path.label-pill-path").node();
                            if (!pillPathEl) return;
                            const usesOutgoing = (d.x0 ?? 0) < innerW / 2 || ((d.targetLinks ?? []) as LayoutLink[]).length === 0;
                            const textLen      = tpEl.getComputedTextLength();
                            const pathLen      = pillPathEl.getTotalLength();
                            // Round end-caps provide the visual horizontal padding —
                            // pill width equals text length exactly.
                            const pillW = textLen;
                            // Text starts at dx=8 from the path origin (outgoing) or
                            // ends at pathLen-8 (incoming); align pill to match.
                            let pillStart = usesOutgoing ? 8 : pathLen - 8 - textLen;
                            pillStart = Math.max(0, pillStart);
                            grp.select<SVGPathElement>("path.label-pill-path")
                                .attr("stroke-dasharray",  `${pillW},99999`)
                                .attr("stroke-dashoffset", -pillStart);
                            // Centre the text label within the pill.
                            // Switch to middle-anchor at the pill's arc midpoint so
                            // the text is equidistant from both round caps.
                            const pillCentre = (pillStart + textLen / 2) / pathLen * 100;
                            grp.select<SVGTextPathElement>("textPath")
                                .attr("text-anchor", "middle")
                                .attr("dx",          "0")
                                .attr("startOffset", `${pillCentre}%`);
                        } else {
                            // ── Flat-fallback node: insert a flat pill behind the text ──
                            const textEl = grp.select<SVGTextElement>("text").node();
                            if (!textEl) return;
                            const bb = textEl.getBBox();
                            select(this).insert("path", "text")
                                .classed("label-pill", true)
                                .attr("d",              `M${bb.x},${bb.y + bb.height / 2} H${bb.x + bb.width}`)
                                .attr("fill",           "none")
                                .attr("stroke",         labelBgColor)
                                .attr("stroke-opacity", labelBgOpacity)
                                .attr("stroke-width",   bb.height + PILL_PAD_V * 2)
                                .attr("stroke-linecap", "round");
                        }
                    });
                }

            } else {
                // ── Flat mode: horizontal text + rounded-rect pill (original) ──

                labelGs.append("text")
                    .attr("x", d => {
                        if (labelOutside) {
                            // Outside: outermost columns face into their dedicated margin
                            if ((d.depth  ?? 0) === 0) return (d.x0 ?? 0) - labelGap;  // leftmost → left
                            if ((d.height ?? 0) === 0) return (d.x1 ?? 0) + labelGap;  // rightmost → right
                        }
                        // Inside (or intermediate outside): go inward between adjacent columns
                        return (d.x0 ?? 0) < innerW / 2 ? (d.x1 ?? 0) + labelGap : (d.x0 ?? 0) - labelGap;
                    })
                    .attr("y",  d => ((d.y0 ?? 0) + (d.y1 ?? 0)) / 2)
                    .attr("dy",              "0.35em")
                    .attr("text-anchor", d => {
                        if (labelOutside) {
                            if ((d.depth  ?? 0) === 0) return "end";    // leftmost → text extends left
                            if ((d.height ?? 0) === 0) return "start";  // rightmost → text extends right
                        }
                        return (d.x0 ?? 0) < innerW / 2 ? "start" : "end";
                    })
                    .attr("font-family",     fontFamily)
                    .attr("font-size",       `${fontSize}px`)
                    .attr("font-weight",     bold      ? "bold"      : "normal")
                    .attr("font-style",      italic    ? "italic"    : "normal")
                    .attr("text-decoration", underline ? "underline" : "none")
                    .attr("fill",            fontColor)
                    .text(d => d.label);

                // Insert a stroked-path pill behind the text (same round-cap
                // technique as curved mode, so both look identical in quality).
                if (labelBgActive) {
                    labelGs.each(function () {
                        const grp    = select(this);
                        const textEl = grp.select<SVGTextElement>("text").node();
                        if (!textEl) return;
                        const bb = textEl.getBBox();
                        select(this).insert("path", "text")
                            .classed("label-pill", true)
                            .attr("d",              `M${bb.x},${bb.y + bb.height / 2} H${bb.x + bb.width}`)
                            .attr("fill",           "none")
                            .attr("stroke",         labelBgColor)
                            .attr("stroke-opacity", labelBgOpacity)
                            .attr("stroke-width",   bb.height + PILL_PAD_V * 2)
                            .attr("stroke-linecap", "round");
                    });
                }
            }
        }

        // ── Value labels — nodes ───────────────────────────────────────────────
        if (showValues && valueTarget === "nodes") {
            const valueGs = nodeGroups
                .append("g")
                .classed("value-group", true)
                .attr("pointer-events", "none");

            valueGs.append("text")
                .attr("x", d => {
                    const nh     = (d.y1 ?? 0) - (d.y0 ?? 0);
                    const inside = valuePos === "inside" || (valuePos === "auto" && nh >= vFontSize * 1.5);
                    if (inside) return ((d.x0 ?? 0) + (d.x1 ?? 0)) / 2;
                    // Outside: follow the Labels Position setting so values stack
                    // neatly beneath their corresponding name label
                    if (labelOutside) {
                        if ((d.depth  ?? 0) === 0) return (d.x0 ?? 0) - labelGap;
                        if ((d.height ?? 0) === 0) return (d.x1 ?? 0) + labelGap;
                    }
                    return (d.x0 ?? 0) < innerW / 2 ? (d.x1 ?? 0) + labelGap : (d.x0 ?? 0) - labelGap;
                })
                .attr("y", d => {
                    const nh     = (d.y1 ?? 0) - (d.y0 ?? 0);
                    const inside = valuePos === "inside" || (valuePos === "auto" && nh >= vFontSize * 1.5);
                    const midY   = ((d.y0 ?? 0) + (d.y1 ?? 0)) / 2;
                    if (inside) return midY;
                    return showLabels ? midY + fontSize + 4 : midY;
                })
                .attr("dy",          "0.35em")
                .attr("text-anchor", d => {
                    const nh     = (d.y1 ?? 0) - (d.y0 ?? 0);
                    const inside = valuePos === "inside" || (valuePos === "auto" && nh >= vFontSize * 1.5);
                    if (inside) return "middle";
                    if (labelOutside) {
                        if ((d.depth  ?? 0) === 0) return "end";
                        if ((d.height ?? 0) === 0) return "start";
                    }
                    return (d.x0 ?? 0) < innerW / 2 ? "start" : "end";
                })
                .attr("font-family",     vFontFamily)
                .attr("font-size",       `${vFontSize}px`)
                .attr("font-weight",     vBold     ? "bold"      : "normal")
                .attr("font-style",      vItalic   ? "italic"    : "normal")
                .attr("text-decoration", vUnderline ? "underline" : "none")
                .attr("fill",            vFontColor)
                .text(d => fmtLabel(d.value ?? 0));

            if (valueBgActive) {
                valueGs.each(function () {
                    const grp    = select(this);
                    const textEl = grp.select<SVGTextElement>("text").node();
                    if (!textEl) return;
                    const bb = textEl.getBBox();
                    select(this).insert("path", "text")
                        .classed("value-pill", true)
                        .attr("d",              `M${bb.x},${bb.y + bb.height / 2} H${bb.x + bb.width}`)
                        .attr("fill",           "none")
                        .attr("stroke",         valueBgColor)
                        .attr("stroke-opacity", valueBgOpacity)
                        .attr("stroke-width",   bb.height + PILL_PAD_V * 2)
                        .attr("stroke-linecap", "round");
                });
            }
        }

        // ── Value labels — ribbons ─────────────────────────────────────────────
        if (showValues && valueTarget === "ribbons") {
            const ribbonValueGs = this.container
                .append("g")
                .classed("link-labels", true)
                .attr("pointer-events", "none")
                .selectAll<SVGGElement, LayoutLink>("g")
                .data(graph.links)
                .join("g");

            // Position the label along the ribbon span according to alignment
            ribbonValueGs.append("text")
                .attr("x", (d: LayoutLink) => {
                    const srcX1 = (d.source as LayoutNode).x1 ?? 0;
                    const tgtX0 = (d.target as LayoutNode).x0 ?? 0;
                    if (valueAlign === "left")  return srcX1 + 4;
                    if (valueAlign === "right") return tgtX0 - 4;
                    return (srcX1 + tgtX0) / 2;
                })
                .attr("y",           (d: LayoutLink) => (d.y0 + d.y1) / 2)
                .attr("dy",          "0.35em")
                .attr("text-anchor", valueAlign === "left" ? "start" : valueAlign === "right" ? "end" : "middle")
                .attr("font-family",     vFontFamily)
                .attr("font-size",       `${vFontSize}px`)
                .attr("font-weight",     vBold     ? "bold"      : "normal")
                .attr("font-style",      vItalic   ? "italic"    : "normal")
                .attr("text-decoration", vUnderline ? "underline" : "none")
                .attr("fill",            vFontColor)
                .text((d: LayoutLink) => fmtLabel(d.value));

            if (valueBgActive) {
                ribbonValueGs.each(function () {
                    const grp    = select(this);
                    const textEl = grp.select<SVGTextElement>("text").node();
                    if (!textEl) return;
                    const bb = textEl.getBBox();
                    select(this).insert("path", "text")
                        .classed("value-pill", true)
                        .attr("d",              `M${bb.x},${bb.y + bb.height / 2} H${bb.x + bb.width}`)
                        .attr("fill",           "none")
                        .attr("stroke",         valueBgColor)
                        .attr("stroke-opacity", valueBgOpacity)
                        .attr("stroke-width",   bb.height + PILL_PAD_V * 2)
                        .attr("stroke-linecap", "round");
                });
            }
        }

    }

    // ── Format pane ───────────────────────────────────────────────────────────

    public getFormattingModel(): powerbi.visuals.FormattingModel {
        // Inject dynamic column names into the Color Source Column dropdown so
        // the user sees actual field names (e.g. "Region", "Category") rather
        // than a static placeholder.
        if (this.pathColumnNames.length > 0) {
            const items = this.pathColumnNames.map(name => ({ displayName: name, value: name }));
            this.formattingSettings.linkSettings.colorSourceLevel.items = items;
            // If the stored value no longer matches any current column name
            // (e.g. after a data refresh that removed a column), reset to the
            // first column so the visual stays in a valid state.
            const cur = this.formattingSettings.linkSettings.colorSourceLevel.value?.value;
            if (!items.find(i => i.value === cur)) {
                this.formattingSettings.linkSettings.colorSourceLevel.value = items[0];
            }
        }
        return this.formattingSettingsService.buildFormattingModel(this.formattingSettings);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private showLandingPage(width: number, height: number): void {
        const cx = width  / 2;
        const cy = height / 2;

        // ── Mini Sankey illustration ───────────────────────────────────────────
        const nW  = 10;
        const lX  = cx - 55,  lX1 = lX + nW;   // left column
        const rX  = cx + 45,  rX0 = rX;          // right column
        const mx  = (lX1 + rX0) / 2;             // bezier midpoint (= cx)

        // Left nodes
        const tl0 = cy - 52,  tl1 = tl0 + 30;   // top-left  (blue,   h=30)
        const bl0 = tl1  + 8, bl1 = bl0 + 20;   // bottom-left (orange, h=20)
        // Right node spans the full height of both left nodes + gap (= 58 px)
        const rr0 = cy - 52,  rr1 = rr0 + 58;
        // Ribbon split on right — proportional to left heights (30 of 50 → 35 of 58)
        const r1rbot = rr0 + 35;

        // Ribbon 1 (blue)
        this.landingLayer.append("path")
            .attr("d",
                `M${lX1},${tl0} C${mx},${tl0} ${mx},${rr0} ${rX0},${rr0}` +
                ` L${rX0},${r1rbot} C${mx},${r1rbot} ${mx},${tl1} ${lX1},${tl1} Z`)
            .attr("fill", "rgba(68,114,196,0.30)");

        // Ribbon 2 (orange)
        this.landingLayer.append("path")
            .attr("d",
                `M${lX1},${bl0} C${mx},${bl0} ${mx},${r1rbot} ${rX0},${r1rbot}` +
                ` L${rX0},${rr1} C${mx},${rr1} ${mx},${bl1} ${lX1},${bl1} Z`)
            .attr("fill", "rgba(237,125,49,0.30)");

        // Node rects (on top of ribbons)
        this.landingLayer.append("rect")
            .attr("x", lX).attr("y", tl0).attr("width", nW).attr("height", tl1 - tl0)
            .attr("fill", "#4472C4").attr("rx", 2);
        this.landingLayer.append("rect")
            .attr("x", lX).attr("y", bl0).attr("width", nW).attr("height", bl1 - bl0)
            .attr("fill", "#ED7D31").attr("rx", 2);
        this.landingLayer.append("rect")
            .attr("x", rX).attr("y", rr0).attr("width", nW).attr("height", rr1 - rr0)
            .attr("fill", "#A5A5A5").attr("rx", 2);

        // ── Title ─────────────────────────────────────────────────────────────
        this.landingLayer.append("text")
            .attr("x", cx).attr("y", cy + 20)
            .attr("text-anchor", "middle")
            .attr("font-family", "Segoe UI, sans-serif")
            .attr("font-size", "15px").attr("font-weight", "600").attr("fill", "#555")
            .text("Sankey Visual");

        // ── Instructions ──────────────────────────────────────────────────────
        this.landingLayer.append("text")
            .attr("x", cx).attr("y", cy + 40)
            .attr("text-anchor", "middle")
            .attr("font-family", "Segoe UI, sans-serif")
            .attr("font-size", "12px").attr("fill", "#999")
            .text("Add 2+ Path Level columns and a Value field to visualize flows.");
    }

    private showError(width: number, height: number, message: string): void {
        this.errorText
            .attr("x", width / 2)
            .attr("y", height / 2)
            .text(message);
    }
}
