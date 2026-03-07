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
    }

    public update(options: VisualUpdateOptions): void {
        const width  = options.viewport.width;
        const height = options.viewport.height;

        this.svg.attr("width", width).attr("height", height);
        this.container.selectAll("*").remove();
        this.errorText.text("");

        // ── Populate formatting settings from the format pane ──────────────────
        this.formattingSettings = this.formattingSettingsService
            .populateFormattingSettingsModel(VisualFormattingSettingsModel, options.dataViews[0]);

        const {
            nodeSettings, linkSettings, labelSettings,
            valueSettings, grandTotal: gtSettings
        } = this.formattingSettings;

        const nodeWidth   = Math.max(4, nodeSettings.nodeWidth.value);
        const nodePadding = Math.max(2, nodeSettings.nodePadding.value);
        const linkOpacity    = Math.min(1, Math.max(0, linkSettings.linkOpacity.value / 100));
        const colorBySource  = linkSettings.colorBySource.value;

        const showLabels  = labelSettings.show.value;
        const fontFamily  = labelSettings.fontControl.fontFamily.value;
        const fontSize    = Math.max(8, labelSettings.fontControl.fontSize.value);
        const bold        = labelSettings.fontControl.bold?.value      ?? false;
        const italic      = labelSettings.fontControl.italic?.value    ?? false;
        const underline   = labelSettings.fontControl.underline?.value ?? false;
        const fontColor   = labelSettings.fontColor.value?.value       ?? "#333333";
        const labelPos    = String(labelSettings.position.value?.value  ?? "inside");
        const labelOutside = labelPos === "outside";

        const showValues  = valueSettings.show.value;
        const valuePos    = String(valueSettings.position.value?.value    ?? "auto");
        const valueTarget = String(valueSettings.target.value?.value      ?? "nodes");
        const valueAlign  = String(valueSettings.alignment.value?.value   ?? "center");
        const followPath  = (valueSettings.followPath.value ?? false) && valueTarget === "ribbons";
        const vFontFamily = valueSettings.fontControl.fontFamily.value;
        const vFontSize   = Math.max(8, valueSettings.fontControl.fontSize.value);
        const vBold       = valueSettings.fontControl.bold?.value      ?? false;
        const vItalic     = valueSettings.fontControl.italic?.value    ?? false;
        const vUnderline  = valueSettings.fontControl.underline?.value ?? false;
        const vFontColor  = valueSettings.fontColor.value?.value       ?? "#333333";

        const showGrandTotal = gtSettings.show.value;
        const gtFontFamily   = gtSettings.fontControl.fontFamily.value;
        const gtFontSize     = Math.max(8, gtSettings.fontControl.fontSize.value);
        const gtBold         = gtSettings.fontControl.bold?.value      ?? true;
        const gtItalic       = gtSettings.fontControl.italic?.value    ?? false;
        const gtUnderline    = gtSettings.fontControl.underline?.value ?? false;
        const gtFontColor    = gtSettings.fontColor.value?.value       ?? "#333333";

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

        if (!categorical?.categories?.length || !categorical.values?.length) {
            this.showError(width, height, "Add 2 or more Path Level columns and a Value to get started.");
            return;
        }

        // categorical.categories is ordered by field-well position (top → left in visual)
        const levelCats = categorical.categories;
        if (levelCats.length < 2) {
            this.showError(width, height, "Add at least 2 Path Level columns and a Value.");
            return;
        }

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
            if (val <= 0) continue;

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
        // computed from the raw linkMap — before layout — so we can size the left
        // margin to fit the formatted number string.
        let grandTotalValue = 0;
        let grandTotalTextW = 0;
        if (showGrandTotal) {
            const gtFont = `${gtBold ? "bold " : ""}${gtFontSize}px ${gtFontFamily}`;
            linkMap.forEach((value, key) => {
                const srcKey = key.slice(0, key.indexOf("\x00"));
                if (srcKey.startsWith("0\x01")) grandTotalValue += value;
            });
            grandTotalTextW = measureText(grandTotalValue.toLocaleString(), gtFont);
        }

        const lbExtra  = labelBgActive ? PILL_PAD_H : 0;
        // Grand total sits to the left of the first column, right-aligned at
        // (firstCol.x0 - labelGap).  Its reserved left margin = text width + gap.
        const gtPad    = showGrandTotal ? grandTotalTextW + labelGap * 2 : 0;
        const leftPad  = Math.max(
            (showLabels && labelOutside) ? leftLabelMaxW  + labelGap + lbExtra : 8,
            showGrandTotal               ? gtPad                               : 8
        );
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

        // Pass 1: run d3-sankey with the user's nodeWidth to obtain node values.
        // We need node.value for text measurement before we can set the final width.
        let graph: LayoutGraph;
        try {
            graph = sankey<NodeDatum, LinkDatum>()
                .nodeWidth(nodeWidth)
                .nodePadding(nodePadding)
                .extent([[0, 0], [innerW, innerH]])({
                    nodes: nodes.map(d => ({ ...d })),
                    links: links.map(d => ({ ...d }))
                });
        } catch (e) {
            this.showError(width, height, "Could not compute layout. Check for circular references.");
            return;
        }

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
                const tw = measureText((nd.value ?? 0).toLocaleString(), font);
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
                graph = sankey<NodeDatum, LinkDatum>()
                    .nodeWidth(effectiveNodeWidth)
                    .nodePadding(nodePadding)
                    .extent([[0, 0], [innerW, innerH]])({
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

        // ── Downstream selection helpers ───────────────────────────────────────
        //
        // When a node is clicked: emphasise the node + every node/ribbon reachable
        //   by following links forward (downstream).
        // When a ribbon is clicked: emphasise the ribbon's source node, the ribbon
        //   itself, and every node/ribbon downstream of the ribbon's target node.
        // Everything else de-emphasises to 15 % opacity.
        //
        // downstreamSet  – names of all nodes in the highlighted downstream path
        // linkSourceNode – for a ribbon click, the source node (upstream of BFS start
        //   but still highlighted)

        let downstreamSet  = new Set<string>();
        let linkSourceNode = "";

        const refreshDownstream = (): void => {
            downstreamSet  = new Set<string>();
            linkSourceNode = "";
            if (this.selectionType === "none") return;

            let startName: string;
            if (this.selectionType === "node") {
                startName = this.selectedKey;
            } else {
                // Link: BFS from the target; remember the source separately
                const parts    = this.selectedKey.split("\x00");
                linkSourceNode = parts[0];
                startName      = parts[1];
            }

            // BFS forward through sourceLinks to collect all downstream nodes
            const queue: LayoutNode[] = [];
            const start = graph.nodes.find(n => n.name === startName);
            if (start) queue.push(start);
            while (queue.length > 0) {
                const n = queue.shift()!;
                if (downstreamSet.has(n.name)) continue;
                downstreamSet.add(n.name);
                for (const lnk of (n.sourceLinks ?? [])) {
                    queue.push(lnk.target as LayoutNode);
                }
            }
        };

        // Seed with any selection state carried over from the previous render
        refreshDownstream();

        const nodeOpacity = (d: LayoutNode): number => {
            if (this.selectionType === "none") return 1;
            // For a ribbon click the source node is upstream but still highlighted
            if (d.name === linkSourceNode) return 1;
            return downstreamSet.has(d.name) ? 1 : 0.15;
        };

        // ── Source contribution propagation ────────────────────────────────────
        // nodeContrib: node.name → Map<depth0NodeName, fraction>
        // Propagated in topological order so each downstream node inherits the
        // weighted mix of depth-0 sources that flow into it.
        const nodeContrib = new Map<string, Map<string, number>>();
        const depth0Lbl   = new Map<string, string>();   // depth-0 node.name → label

        for (const nd of ([...graph.nodes as LayoutNode[]]
                          .sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0)))) {
            if ((nd.depth ?? 0) === 0) {
                nodeContrib.set(nd.name, new Map([[nd.name, 1.0]]));
                depth0Lbl.set(nd.name, nd.label);
            } else {
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
        }

        // Canonical stacking order: depth-0 nodes sorted top-to-bottom by y0.
        const depth0Order = new Map<string, number>(
            ([...graph.nodes as LayoutNode[]]
                .filter(n => (n.depth ?? 0) === 0)
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

            for (const nd of ([...graph.nodes as LayoutNode[]]
                              .sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0)))) {
                const nodeH    = (nd.y1 ?? 0) - (nd.y0 ?? 0);
                const srcLinks = (nd.sourceLinks ?? []) as LayoutLink[];
                const tgtLinks = (nd.targetLinks ?? []) as LayoutLink[];
                const ndSrcs   = [...(nodeContrib.get(nd.name) ?? new Map<string, number>()).entries()]
                    .sort((a, b) => (depth0Order.get(a[0]) ?? 0) - (depth0Order.get(b[0]) ?? 0));

                // ── Right side: source-side positions of outgoing links ────────
                // Band heights derived from actual linkDrawW values (same reason
                // as left side — minRibbonHeight inflation must be accounted for).
                const outBandH = new Map<string, number>(ndSrcs.map(([s]) => [s, 0] as [string, number]));
                for (const lnk of srcLinks) {
                    const key2  = `${nd.name}\x00${(lnk.target as LayoutNode).name}`;
                    const fullW2 = linkDrawW.get(key2) ?? Math.max(minRibbonHeight, lnk.width ?? 1) * fitK;
                    for (const [s, frac] of ndSrcs) { outBandH.set(s, (outBandH.get(s) ?? 0) + fullW2 * frac); }
                }
                const outCursor = new Map<string, number>();
                { let y = nd.y0 ?? 0;
                  for (const [s] of ndSrcs) { outCursor.set(s, y); y += outBandH.get(s) ?? 0; } }

                for (const lnk of srcLinks) {
                    const key  = `${nd.name}\x00${(lnk.target as LayoutNode).name}`;
                    const fullW = linkDrawW.get(key) ?? Math.max(minRibbonHeight, lnk.width ?? 1) * fitK;
                    for (const [s, frac] of ndSrcs) {
                        const subW = fullW * frac;
                        const cur  = outCursor.get(s) ?? 0;
                        srcPos.set(`${key}\x00${s}`, {top: cur, bot: cur + subW});
                        outCursor.set(s, cur + subW);
                    }
                }

                // ── Left side: target-side positions of incoming links ─────────
                // Band heights are derived from the actual linkDrawW_tgt values,
                // NOT from nodeContrib fractions × nodeH.  When minRibbonHeight
                // inflates a thin link's draw width, using the value-based fraction
                // would produce a band smaller than the inflated ribbon, causing
                // sub-ribbons to overflow into adjacent bands and visually overlap.
                const inBandH = new Map<string, number>(ndSrcs.map(([s]) => [s, 0] as [string, number]));
                for (const lnk of tgtLinks) {
                    const srcNd2  = lnk.source as LayoutNode;
                    const key2    = `${srcNd2.name}\x00${nd.name}`;
                    const fullW2  = linkDrawW_tgt.get(key2) ?? Math.max(minRibbonHeight, lnk.width ?? 1) * fitK;
                    const lnkC    = nodeContrib.get(srcNd2.name) ?? new Map<string, number>();
                    for (const [s] of ndSrcs) {
                        inBandH.set(s, (inBandH.get(s) ?? 0) + fullW2 * (lnkC.get(s) ?? 0));
                    }
                }
                const inCursor = new Map<string, number>();
                { let y = nd.y0 ?? 0;
                  for (const [s] of ndSrcs) { inCursor.set(s, y); y += inBandH.get(s) ?? 0; } }

                for (const lnk of tgtLinks) {
                    const srcNd      = lnk.source as LayoutNode;
                    const key        = `${srcNd.name}\x00${nd.name}`;
                    const fullW      = linkDrawW_tgt.get(key) ?? Math.max(minRibbonHeight, lnk.width ?? 1) * fitK;
                    const lnkContrib = nodeContrib.get(srcNd.name) ?? new Map<string, number>();
                    for (const [s, _frac] of ndSrcs) {
                        const subW = fullW * (lnkContrib.get(s) ?? 0);
                        const cur  = inCursor.get(s) ?? 0;
                        tgtPos.set(`${key}\x00${s}`, {top: cur, bot: cur + subW});
                        inCursor.set(s, cur + subW);
                    }
                }
            }

            // Build SubRibbon array from the position maps
            for (const lnk of graph.links as LayoutLink[]) {
                const srcNd = lnk.source as LayoutNode;
                const tgtNd = lnk.target as LayoutNode;
                const key   = `${srcNd.name}\x00${tgtNd.name}`;
                const srcs  = [...(nodeContrib.get(srcNd.name) ?? new Map<string, number>()).entries()]
                    .sort((a, b) => (depth0Order.get(a[0]) ?? 0) - (depth0Order.get(b[0]) ?? 0));
                for (const [s, frac] of srcs) {
                    if (frac < 0.0001) continue;
                    const sp = srcPos.get(`${key}\x00${s}`);
                    const tp = tgtPos.get(`${key}\x00${s}`);
                    if (!sp || !tp) continue;
                    subRibbons.push({
                        link: lnk, srcLabel: depth0Lbl.get(s) ?? srcNd.label,
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
            return downstreamSet.has(src) ? linkOpacity : linkOpacity * 0.15;
        };

        // Ribbon color: depth-0 source label (colorBySource) or immediate source label.
        const ribbonColor = (d: SubRibbon): string =>
            color(d.srcLabel || (d.link.source as LayoutNode).label);

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
            .attr("fill",    d => ribbonColor(d))
            .attr("opacity", d => linkOpacityFn(d))
            .style("cursor", "pointer");

        linkPaths
            .append("title")
            .text(d => `${(d.link.source as LayoutNode).label} \u2192 ${(d.link.target as LayoutNode).label}\n${d.link.value.toLocaleString()}`);

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
            refreshDownstream();
            nodeGroups.select<SVGRectElement>("rect").attr("opacity", nodeOpacity);
            linkPaths.attr("opacity", linkOpacityFn);
            event.stopPropagation();
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
            .attr("opacity", nodeOpacity)
            .append("title")
            .text(d => `${d.label}\n${(d.value ?? 0).toLocaleString()}`);

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
            refreshDownstream();
            nodeGroups.select<SVGRectElement>("rect").attr("opacity", nodeOpacity);
            linkPaths.attr("opacity", linkOpacityFn);
            event.stopPropagation();
        });

        // ── Name labels ───────────────────────────────────────────────────────
        if (showLabels) {
            const labelGs = nodeGroups
                .append("g")
                .classed("label-group", true)
                .attr("pointer-events", "none");

            // Placeholder pill rect — sized after text is in the DOM
            if (labelBgActive) {
                labelGs.append("rect")
                    .classed("label-pill", true)
                    .attr("fill",    labelBgColor)
                    .attr("opacity", labelBgOpacity);
            }

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

            // Size each pill to its text's bounding box now that the text is in the DOM
            if (labelBgActive) {
                labelGs.each(function () {
                    const grp    = select(this);
                    const textEl = grp.select<SVGTextElement>("text").node();
                    if (!textEl) return;
                    const bb = textEl.getBBox();
                    grp.select<SVGRectElement>("rect.label-pill")
                        .attr("x",      bb.x - PILL_PAD_H)
                        .attr("y",      bb.y - PILL_PAD_V)
                        .attr("width",  bb.width  + PILL_PAD_H * 2)
                        .attr("height", bb.height + PILL_PAD_V * 2)
                        .attr("rx",    (bb.height + PILL_PAD_V * 2) / 2)
                        .attr("ry",    (bb.height + PILL_PAD_V * 2) / 2);
                });
            }
        }

        // ── Value labels — nodes ───────────────────────────────────────────────
        if (showValues && valueTarget === "nodes") {
            const valueGs = nodeGroups
                .append("g")
                .classed("value-group", true)
                .attr("pointer-events", "none");

            if (valueBgActive) {
                valueGs.append("rect")
                    .classed("value-pill", true)
                    .attr("fill",    valueBgColor)
                    .attr("opacity", valueBgOpacity);
            }

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
                .text(d => (d.value ?? 0).toLocaleString());

            if (valueBgActive) {
                valueGs.each(function () {
                    const grp    = select(this);
                    const textEl = grp.select<SVGTextElement>("text").node();
                    if (!textEl) return;
                    const bb = textEl.getBBox();
                    grp.select<SVGRectElement>("rect.value-pill")
                        .attr("x",      bb.x - PILL_PAD_H)
                        .attr("y",      bb.y - PILL_PAD_V)
                        .attr("width",  bb.width  + PILL_PAD_H * 2)
                        .attr("height", bb.height + PILL_PAD_V * 2)
                        .attr("rx",    (bb.height + PILL_PAD_V * 2) / 2)
                        .attr("ry",    (bb.height + PILL_PAD_V * 2) / 2);
                });
            }
        }

        // ── Value labels — ribbons ─────────────────────────────────────────────
        if (showValues && valueTarget === "ribbons") {
            const pillH = vFontSize + PILL_PAD_V * 2;

            if (followPath) {
                // ── Curved mode ────────────────────────────────────────────────
                // Text follows the ribbon's cubic-bezier centerline via <textPath>.
                // The background pill is rendered as a partial stroke along the
                // same path using stroke-dasharray to cover only the text span.

                // Centerline paths stored in <defs> (never rendered directly).
                // IDs are prefixed with this.instanceUid to avoid collisions across
                // multiple visual instances on the same report page.
                // linkIds maps each LayoutLink to its unique defs path ID so D3
                // callbacks can look up the id by datum without needing the index.
                const defs    = this.container.append("defs");
                const linkIds = new Map<LayoutLink, string>();
                graph.links.forEach((d: LayoutLink, i: number) => {
                    const id    = `${this.instanceUid}-cl-${i}`;
                    const srcX1 = (d.source as LayoutNode).x1 ?? 0;
                    const tgtX0 = (d.target as LayoutNode).x0 ?? 0;
                    const cx    = (srcX1 + tgtX0) / 2;
                    linkIds.set(d, id);
                    defs.append("path")
                        .attr("id", id)
                        .attr("d", `M${srcX1},${d.y0} C${cx},${d.y0} ${cx},${d.y1} ${tgtX0},${d.y1}`);
                });

                // Alignment → textPath attributes
                const startOffset = valueAlign === "left" ? "0%"   : valueAlign === "right" ? "100%" : "50%";
                const textAnchor  = valueAlign === "left" ? "start" : valueAlign === "right" ? "end"  : "middle";
                const dxShift     = valueAlign === "left" ? "8"    : valueAlign === "right" ? "-8"   : "0";

                const ribbonValueGs = this.container
                    .append("g")
                    .classed("link-labels", true)
                    .attr("pointer-events", "none")
                    .selectAll<SVGGElement, LayoutLink>("g")
                    .data(graph.links)
                    .join("g");

                // Curved pill: a partial stroke along the centerline path.
                // stroke-dasharray / dashoffset are set after text measurement below.
                if (valueBgActive) {
                    ribbonValueGs.append("path")
                        .classed("value-pill-path", true)
                        .attr("d", (d: LayoutLink) => {
                            const srcX1 = (d.source as LayoutNode).x1 ?? 0;
                            const tgtX0 = (d.target as LayoutNode).x0 ?? 0;
                            const cx    = (srcX1 + tgtX0) / 2;
                            return `M${srcX1},${d.y0} C${cx},${d.y0} ${cx},${d.y1} ${tgtX0},${d.y1}`;
                        })
                        .attr("fill",           "none")
                        .attr("stroke",         valueBgColor)
                        .attr("stroke-opacity", valueBgOpacity)
                        .attr("stroke-width",   pillH)
                        .attr("stroke-linecap", "round");
                }

                // Text on path
                ribbonValueGs.append("text")
                    .attr("dominant-baseline", "central")
                    .attr("font-family",       vFontFamily)
                    .attr("font-size",         `${vFontSize}px`)
                    .attr("font-weight",       vBold      ? "bold"      : "normal")
                    .attr("font-style",        vItalic    ? "italic"    : "normal")
                    .attr("text-decoration",   vUnderline ? "underline" : "none")
                    .attr("fill",              vFontColor)
                    .append("textPath")
                    .attr("href",        (d: LayoutLink) => `#${linkIds.get(d) ?? ""}`)
                    .attr("startOffset", startOffset)
                    .attr("text-anchor", textAnchor)
                    .attr("dx",          dxShift)
                    .text((d: LayoutLink) => d.value.toLocaleString());

                // Measure text length and position the pill dash accordingly
                if (valueBgActive) {
                    // valueAlign is captured from the outer lexical scope via closure
                    ribbonValueGs.each(function () {
                        const grp        = select(this);
                        const tpEl       = grp.select<SVGTextPathElement>("textPath").node();
                        const pillPathEl = grp.select<SVGPathElement>("path.value-pill-path").node();
                        if (!tpEl || !pillPathEl) return;

                        const textLen = tpEl.getComputedTextLength();
                        const pathLen = pillPathEl.getTotalLength();
                        const pillW   = textLen + PILL_PAD_H * 2;

                        // Compute where along the arc the pill dash should start.
                        // Matches the text position implied by startOffset + dx + text-anchor.
                        let pillStart: number;
                        if (valueAlign === "left") {
                            // text starts at dx=8 from path origin; pill left-pads by PILL_PAD_H
                            pillStart = Math.max(0, 8 - PILL_PAD_H);
                        } else if (valueAlign === "right") {
                            // text end-anchor at pathLen, pulled back by dx=8
                            pillStart = pathLen - 8 - textLen - PILL_PAD_H;
                        } else {
                            // centred at pathLen / 2
                            pillStart = pathLen / 2 - pillW / 2;
                        }
                        pillStart = Math.max(0, pillStart);

                        grp.select<SVGPathElement>("path.value-pill-path")
                            .attr("stroke-dasharray",  `${pillW},99999`)
                            .attr("stroke-dashoffset", -pillStart);
                    });
                }

            } else {
                // ── Flat mode: horizontal text + rounded-rect pill (original) ──
                const ribbonValueGs = this.container
                    .append("g")
                    .classed("link-labels", true)
                    .attr("pointer-events", "none")
                    .selectAll<SVGGElement, LayoutLink>("g")
                    .data(graph.links)
                    .join("g");

                if (valueBgActive) {
                    ribbonValueGs.append("rect")
                        .classed("value-pill", true)
                        .attr("fill",    valueBgColor)
                        .attr("opacity", valueBgOpacity);
                }

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
                    .text((d: LayoutLink) => d.value.toLocaleString());

                if (valueBgActive) {
                    ribbonValueGs.each(function () {
                        const grp    = select(this);
                        const textEl = grp.select<SVGTextElement>("text").node();
                        if (!textEl) return;
                        const bb = textEl.getBBox();
                        grp.select<SVGRectElement>("rect.value-pill")
                            .attr("x",      bb.x - PILL_PAD_H)
                            .attr("y",      bb.y - PILL_PAD_V)
                            .attr("width",  bb.width  + PILL_PAD_H * 2)
                            .attr("height", bb.height + PILL_PAD_V * 2)
                            .attr("rx",    (bb.height + PILL_PAD_V * 2) / 2)
                            .attr("ry",    (bb.height + PILL_PAD_V * 2) / 2);
                    });
                }
            }
        }

        // ── Grand total ────────────────────────────────────────────────────────
        // Renders a single formatted total to the LEFT of the first column of
        // nodes, right-aligned against the node face and vertically centred on
        // the first column's vertical extent.
        //
        // The value (grandTotalValue) was computed before layout from the raw
        // linkMap (sum of all flows leaving depth-0 nodes) and is already set.
        // The left margin was expanded accordingly, so the text fits cleanly.
        if (showGrandTotal) {
            const depth0Nodes = graph.nodes.filter(n => (n.depth ?? 0) === 0);
            if (depth0Nodes.length > 0) {
                // All depth-0 nodes share the same x0 by construction; use index [0]
                // to avoid the Infinity sentinel that reduce() would require otherwise.
                const firstX0    = depth0Nodes[0].x0 ?? 0;
                const firstColY0 = depth0Nodes.reduce((m, n) => Math.min(m, n.y0 ?? 0), depth0Nodes[0].y0 ?? 0);
                const firstColY1 = depth0Nodes.reduce((m, n) => Math.max(m, n.y1 ?? 0), 0);
                const gtY        = (firstColY0 + firstColY1) / 2;   // vertical centre of first column

                this.container
                    .append("text")
                    .classed("grand-total", true)
                    .attr("pointer-events", "none")
                    .attr("x",                 firstX0 - labelGap)
                    .attr("y",                 gtY)
                    .attr("text-anchor",       "end")
                    .attr("dominant-baseline", "middle")
                    .attr("font-family",       gtFontFamily)
                    .attr("font-size",         `${gtFontSize}px`)
                    .attr("font-weight",       gtBold      ? "bold"      : "normal")
                    .attr("font-style",        gtItalic    ? "italic"    : "normal")
                    .attr("text-decoration",   gtUnderline ? "underline" : "none")
                    .attr("fill",              gtFontColor)
                    .text(grandTotalValue.toLocaleString());
            }
        }

    }

    // ── Format pane ───────────────────────────────────────────────────────────

    public getFormattingModel(): powerbi.visuals.FormattingModel {
        return this.formattingSettingsService.buildFormattingModel(this.formattingSettings);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private showError(width: number, height: number, message: string): void {
        this.errorText
            .attr("x", width / 2)
            .attr("y", height / 2)
            .text(message);
    }
}
