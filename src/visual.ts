"use strict";

import powerbi from "powerbi-visuals-api";
import VisualConstructorOptions = powerbi.extensibility.visual.VisualConstructorOptions;
import VisualUpdateOptions = powerbi.extensibility.visual.VisualUpdateOptions;
import IVisual = powerbi.extensibility.visual.IVisual;
import IVisualHost = powerbi.extensibility.visual.IVisualHost;

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

// ─── Helpers (module-level) ───────────────────────────────────────────────────

/**
 * Measure the rendered pixel width of a text string using the browser's
 * canvas 2D context (no layout side-effects, no DOM insertion needed).
 */
function measureText(text: string, font: string): number {
    const canvas = document.createElement("canvas");
    const ctx    = canvas.getContext("2d");
    if (!ctx) return 0;
    ctx.font = font;
    return ctx.measureText(text).width;
}

/** Padding inside pill-shaped label/value backgrounds (px). */
const PILL_PAD_V = 3;   // top and bottom
const PILL_PAD_H = 8;   // left and right

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
    minH:          number
): string {
    const src  = d.source as LayoutNode;
    const tgt  = d.target as LayoutNode;
    const srcX = src.x1 ?? 0;
    const tgtX = tgt.x0 ?? 0;
    const midX = (srcX + tgtX) / 2;
    const cy0  = d.y0 ?? 0;
    const cy1  = d.y1 ?? 0;
    const key  = `${src.name}\x00${tgt.name}`;
    const srcW = linkDrawW.get(key)     ?? Math.max(minH, d.width ?? 1);
    const tgtW = linkDrawW_tgt.get(key) ?? Math.max(minH, d.width ?? 1);
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
        const linkOpacity = Math.min(1, Math.max(0, linkSettings.linkOpacity.value / 100));

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
        const valuePos    = String(valueSettings.position.value?.value  ?? "auto");
        const valueTarget = String(valueSettings.target.value?.value    ?? "nodes");
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
        const gtFont = `${gtBold ? "bold " : ""}${gtFontSize}px ${gtFontFamily}`;
        let grandTotalTextW = 0;
        if (showGrandTotal) {
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

        // ── Fit-to-viewport transform ──────────────────────────────────────────
        // reStackRibbons / resolveColumnOverlaps can push nodes below innerH.
        // Compute the actual layout bottom, then apply a zoom transform that
        // scales the whole diagram down just enough to keep everything visible.
        //
        // Horizontal content is always exactly viewport-width by construction
        // (margin.left + innerW + margin.right == width), so only vertical
        // overflow ever needs correcting.  When the content fits (fitK == 1)
        // the resulting transform is the identity — no zoom is applied.
        {
            const actualMaxY = graph.nodes.reduce((m, n) => Math.max(m, n.y1 ?? 0), 0);
            const totalH     = margin.top + actualMaxY + margin.bottom;
            const fitK       = Math.min(1, height / totalH);
            // Centre the (possibly narrower) scaled content horizontally.
            const fitTx      = width * (1 - fitK) / 2;
            this.fitTransform = zoomIdentity.translate(fitTx, 0).scale(fitK);
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

        const linkOpacityFn = (d: LayoutLink): number => {
            if (this.selectionType === "none") return linkOpacity;
            const src = (d.source as LayoutNode).name;
            const tgt = (d.target as LayoutNode).name;
            const lk  = `${src}\x00${tgt}`;
            // The clicked ribbon is always fully visible
            if (lk === this.selectedKey) return linkOpacity;
            // Any ribbon whose source is in the downstream set continues the flow
            return downstreamSet.has(src) ? linkOpacity : linkOpacity * 0.15;
        };

        // Ribbon color: theme color keyed by source node label
        const ribbonColor = (d: LayoutLink): string => color((d.source as LayoutNode).label);

        // ── Links ─────────────────────────────────────────────────────────────
        // Rendered as filled closed paths (not stroked centrelines) so the ribbon
        // naturally tapers from its source-side width to its target-side width.
        const linkPaths = this.container
            .append("g")
            .classed("links", true)
            .selectAll<SVGPathElement, LayoutLink>("path")
            .data(graph.links)
            .join("path")
            .attr("d",       d => taperingRibbonPath(d, linkDrawW, linkDrawW_tgt, minRibbonHeight))
            .attr("fill",    ribbonColor)
            .attr("opacity", d => linkOpacityFn(d))
            .style("cursor", "pointer");

        linkPaths
            .append("title")
            .text(d => `${(d.source as LayoutNode).label} \u2192 ${(d.target as LayoutNode).label}\n${d.value.toLocaleString()}`);

        linkPaths.on("click", (event: MouseEvent, d: LayoutLink) => {
            const lk = `${(d.source as LayoutNode).name}\x00${(d.target as LayoutNode).name}`;
            this.selectionType = "link";
            this.selectedKey   = lk;
            this.selectionManager.select(linkSelIds.get(lk) ?? [], event.ctrlKey || event.metaKey);
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
            this.selectionType = "node";
            this.selectedKey   = d.name;
            this.selectionManager.select(nodeSelIds.get(d.name) ?? [], event.ctrlKey || event.metaKey);
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

            // Centre the label on the ribbon midpoint
            ribbonValueGs.append("text")
                .attr("x", d => {
                    const srcX1 = (d.source as LayoutNode).x1 ?? 0;
                    const tgtX0 = (d.target as LayoutNode).x0 ?? 0;
                    return (srcX1 + tgtX0) / 2;
                })
                .attr("y",           d => (d.y0 + d.y1) / 2)
                .attr("dy",          "0.35em")
                .attr("text-anchor", "middle")
                .attr("font-family",     vFontFamily)
                .attr("font-size",       `${vFontSize}px`)
                .attr("font-weight",     vBold     ? "bold"      : "normal")
                .attr("font-style",      vItalic   ? "italic"    : "normal")
                .attr("text-decoration", vUnderline ? "underline" : "none")
                .attr("fill",            vFontColor)
                .text(d => d.value.toLocaleString());

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
            const firstX0     = depth0Nodes.reduce((m, n) => Math.min(m, n.x0 ?? 0), Infinity);
            const firstColY0  = depth0Nodes.reduce((m, n) => Math.min(m, n.y0 ?? 0), Infinity);
            const firstColY1  = depth0Nodes.reduce((m, n) => Math.max(m, n.y1 ?? 0), 0);
            const gtY         = (firstColY0 + firstColY1) / 2;   // vertical centre of first column

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
