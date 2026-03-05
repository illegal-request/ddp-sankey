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
    sankeyLinkHorizontal,
    SankeyNode,
    SankeyLink,
    SankeyGraph
} from "d3-sankey";
import { select, Selection } from "d3-selection";
import { zoom, zoomIdentity, ZoomBehavior } from "d3-zoom";
import { scaleLinear } from "d3-scale";

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
 * Ribbons are centred within the (possibly expanded) node so that the visual
 * mass is balanced on both the source and target sides.
 */
function reStackRibbons(graph: LayoutGraph, minH: number): void {
    for (const nd of graph.nodes) {
        const node     = nd as LayoutNode;
        const srcLinks = (node.sourceLinks ?? []) as LayoutLink[];
        const tgtLinks = (node.targetLinks ?? []) as LayoutLink[];

        // Effective width for each ribbon
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

        // Re-centre source ribbons vertically within the node
        if (srcLinks.length > 0) {
            let y = y0 + (nodeH - srcTot) / 2;
            srcLinks.forEach((lnk, i) => {
                lnk.y0 = y + srcEW[i] / 2;
                y += srcEW[i];
            });
        }

        // Re-centre target ribbons vertically within the node
        if (tgtLinks.length > 0) {
            let y = y0 + (nodeH - tgtTot) / 2;
            tgtLinks.forEach((lnk, i) => {
                lnk.y1 = y + tgtEW[i] / 2;
                y += tgtEW[i];
            });
        }
    }
}

// ─── Visual ───────────────────────────────────────────────────────────────────

export class Visual implements IVisual {
    private host:        IVisualHost;
    private svg:         Selection<SVGSVGElement,  unknown, null, undefined>;
    private zoomLayer:   Selection<SVGGElement,    unknown, null, undefined>;
    private container:   Selection<SVGGElement,    unknown, null, undefined>;
    private legendLayer: Selection<SVGGElement,    unknown, null, undefined>;
    private errorText:   Selection<SVGTextElement, unknown, null, undefined>;
    private zoomBehavior: ZoomBehavior<SVGSVGElement, unknown>;

    private formattingSettingsService: FormattingSettingsService;
    private formattingSettings: VisualFormattingSettingsModel;

    private selectionManager:  powerbi.extensibility.ISelectionManager;
    private selectionType:     "none" | "node" | "link" = "none";
    private selectedKey:       string = "";
    private currentLinkOpacity: number = 0.45;

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

        // legendLayer sits outside zoomLayer so it stays fixed while the diagram pans/zooms
        this.legendLayer = this.svg
            .append<SVGGElement>("g")
            .classed("legendLayer", true);

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
            this.svg.call(this.zoomBehavior.transform, zoomIdentity);
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
        this.legendLayer.selectAll("*").remove();
        this.errorText.text("");

        // ── Populate formatting settings from the format pane ──────────────────
        this.formattingSettings = this.formattingSettingsService
            .populateFormattingSettingsModel(VisualFormattingSettingsModel, options.dataViews[0]);

        const {
            nodeSettings, linkSettings, labelSettings,
            valueSettings, colorScaleSettings
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

        const showValues  = valueSettings.show.value;
        const valuePos    = String(valueSettings.position.value?.value  ?? "auto");
        const valueTarget = String(valueSettings.target.value?.value    ?? "nodes");
        const vFontFamily = valueSettings.fontControl.fontFamily.value;
        const vFontSize   = Math.max(8, valueSettings.fontControl.fontSize.value);
        const vBold       = valueSettings.fontControl.bold?.value      ?? false;
        const vItalic     = valueSettings.fontControl.italic?.value    ?? false;
        const vUnderline  = valueSettings.fontControl.underline?.value ?? false;
        const vFontColor  = valueSettings.fontColor.value?.value       ?? "#333333";

        const showColorScale = colorScaleSettings.show.value;
        const colorScheme    = String(colorScaleSettings.scheme.value?.value         ?? "sequential");
        const csLowColor     = colorScaleSettings.lowColor.value?.value              ?? "#c6dbef";
        const csMidColor     = colorScaleSettings.midColor.value?.value              ?? "#f7f7f7";
        const csHighColor    = colorScaleSettings.highColor.value?.value             ?? "#08519c";
        const legendPos      = String(colorScaleSettings.legendPosition.value?.value ?? "bottom-right");

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

        // Identify value series by data role — colorValue is optional
        let valueSeries: powerbi.DataViewValueColumn | undefined;
        let colorSeries: powerbi.DataViewValueColumn | undefined;
        for (const s of categorical.values) {
            if (s.source.roles?.["value"])      valueSeries = s;
            if (s.source.roles?.["colorValue"]) colorSeries = s;
        }

        if (!valueSeries) {
            this.showError(width, height, "Add 2 or more Path Level columns and a Value to get started.");
            return;
        }

        // ── Parse rows → aggregate links, build selection ID maps ──────────────
        // Blank/null values are treated as the label "(Blank)" rather than dropped.
        const linkMap            = new Map<string, number>();
        const nodeSet            = new Set<string>();
        const nodeSelIds         = new Map<string, powerbi.visuals.ISelectionId[]>();
        const linkSelIds         = new Map<string, powerbi.visuals.ISelectionId[]>();
        // For color value: accumulate weighted sum + total weight (= primary value)
        // so the per-link color value is a weighted average (weight = flow volume).
        const linkColorWeightSum = new Map<string, number>();
        const linkColorWeight    = new Map<string, number>();
        const rowCount           = levelCats[0].values.length;

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

                // Accumulate color value (weighted average by primary flow volume)
                if (colorSeries) {
                    const cv = Number(colorSeries.values[r]);
                    if (!isNaN(cv)) {
                        linkColorWeightSum.set(lnkKey, (linkColorWeightSum.get(lnkKey) ?? 0) + cv * val);
                        linkColorWeight.set(lnkKey,    (linkColorWeight.get(lnkKey)    ?? 0) + val);
                    }
                }
            }
        }

        if (linkMap.size === 0) {
            this.showError(width, height, "No valid flows found. Ensure Value > 0 and consecutive levels differ.");
            return;
        }

        // Compute weighted-average color value per link key
        const linkColorMap = new Map<string, number>();
        linkColorWeightSum.forEach((wsum, key) => {
            const wtotal = linkColorWeight.get(key) ?? 0;
            if (wtotal > 0) linkColorMap.set(key, wsum / wtotal);
        });

        // ── Build color scale ──────────────────────────────────────────────────
        const hasColorScale = !!colorSeries && showColorScale && linkColorMap.size > 0;
        let colorScaleFn: ((v: number) => string) | undefined;
        let colorMin = 0;
        let colorMax = 1;

        if (hasColorScale) {
            const cvals = Array.from(linkColorMap.values());
            colorMin = Math.min(...cvals);
            colorMax = Math.max(...cvals);
            if (colorMin === colorMax) colorMax = colorMin + 1; // avoid degenerate scale

            if (colorScheme === "diverging") {
                const mid = (colorMin + colorMax) / 2;
                const sc  = scaleLinear<string>()
                    .domain([colorMin, mid, colorMax])
                    .range([csLowColor, csMidColor, csHighColor]);
                colorScaleFn = v => sc(v);
            } else {
                const sc = scaleLinear<string>()
                    .domain([colorMin, colorMax])
                    .range([csLowColor, csHighColor]);
                colorScaleFn = v => sc(v);
            }
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
        // Declared here (before layout) because reStackRibbons uses it post-layout.
        const minRibbonHeight = Math.max(
            1,
            showLabels ? fontSize  + 4 : 1,
            showValues ? vFontSize + 4 : 1
        );

        // ── Layout ────────────────────────────────────────────────────────────
        const labelPad = showLabels ? Math.max(80, fontSize * 7) : 10;
        const margin   = { top: 10, right: labelPad, bottom: 10, left: labelPad };
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
            const font = `${vBold ? "bold " : ""}${vFontSize}px ${vFontFamily}`;
            for (const nd of graph.nodes) {
                const tw = measureText((nd.value ?? 0).toLocaleString(), font);
                if (tw + 8 > effectiveNodeWidth) effectiveNodeWidth = tw + 8; // 4 px each side
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
        //   • re-centring link.y0 / link.y1 within the (possibly taller) node
        // This runs whenever minRibbonHeight could actually inflate something.
        if (minRibbonHeight > 1) {
            reStackRibbons(graph, minRibbonHeight);
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

        // Ribbon stroke color: color scale (if active) else theme color by source label
        const ribbonColor = (d: LayoutLink): string => {
            if (colorScaleFn) {
                const src = (d.source as LayoutNode).name;
                const tgt = (d.target as LayoutNode).name;
                const cv  = linkColorMap.get(`${src}\x00${tgt}`);
                if (cv !== undefined) return colorScaleFn(cv);
            }
            return color((d.source as LayoutNode).label);
        };

        // ── Links ─────────────────────────────────────────────────────────────
        const linkPaths = this.container
            .append("g")
            .classed("links", true)
            .attr("fill", "none")
            .selectAll<SVGPathElement, LayoutLink>("path")
            .data(graph.links)
            .join("path")
            .attr("d", sankeyLinkHorizontal())
            .attr("stroke",       ribbonColor)
            .attr("stroke-width", d => Math.max(minRibbonHeight, d.width ?? 1))
            .attr("opacity",      d => linkOpacityFn(d))
            .style("cursor", "pointer");

        linkPaths
            .append("title")
            .text(d => {
                const src  = (d.source as LayoutNode).name;
                const tgt  = (d.target as LayoutNode).name;
                const cv   = linkColorMap.get(`${src}\x00${tgt}`);
                const base = `${(d.source as LayoutNode).label} \u2192 ${(d.target as LayoutNode).label}\n${d.value.toLocaleString()}`;
                if (cv !== undefined && colorSeries) {
                    return `${base}\n${colorSeries.source.displayName}: ${cv.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
                }
                return base;
            });

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
            nodeGroups
                .append("text")
                .attr("x",  d => (d.x0 ?? 0) < innerW / 2 ? (d.x1 ?? 0) + 6 : (d.x0 ?? 0) - 6)
                .attr("y",  d => ((d.y0 ?? 0) + (d.y1 ?? 0)) / 2)
                .attr("dy",              "0.35em")
                .attr("text-anchor",     d => (d.x0 ?? 0) < innerW / 2 ? "start" : "end")
                .attr("font-family",     fontFamily)
                .attr("font-size",       `${fontSize}px`)
                .attr("font-weight",     bold      ? "bold"      : "normal")
                .attr("font-style",      italic    ? "italic"    : "normal")
                .attr("text-decoration", underline ? "underline" : "none")
                .attr("fill",            fontColor)
                .attr("pointer-events",  "none")
                .text(d => d.label);
        }

        // ── Value labels — nodes ───────────────────────────────────────────────
        if (showValues && valueTarget === "nodes") {
            nodeGroups
                .append("text")
                .attr("x", d => {
                    const nh     = (d.y1 ?? 0) - (d.y0 ?? 0);
                    const inside = valuePos === "inside" || (valuePos === "auto" && nh >= vFontSize * 1.5);
                    if (inside) return ((d.x0 ?? 0) + (d.x1 ?? 0)) / 2;
                    return (d.x0 ?? 0) < innerW / 2 ? (d.x1 ?? 0) + 6 : (d.x0 ?? 0) - 6;
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
                    return (d.x0 ?? 0) < innerW / 2 ? "start" : "end";
                })
                .attr("font-family",     vFontFamily)
                .attr("font-size",       `${vFontSize}px`)
                .attr("font-weight",     vBold     ? "bold"      : "normal")
                .attr("font-style",      vItalic   ? "italic"    : "normal")
                .attr("text-decoration", vUnderline ? "underline" : "none")
                .attr("fill",            vFontColor)
                .attr("pointer-events",  "none")
                .text(d => (d.value ?? 0).toLocaleString());
        }

        // ── Value labels — ribbons ─────────────────────────────────────────────
        if (showValues && valueTarget === "ribbons") {
            this.container
                .append("g")
                .classed("link-labels", true)
                .attr("pointer-events", "none")
                .selectAll<SVGTextElement, LayoutLink>("text")
                .data(graph.links)
                .join("text")
                // Centre the label on the ribbon midpoint
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
        }

        // ── Color scale legend ─────────────────────────────────────────────────
        if (hasColorScale && colorScaleFn) {
            const fieldName = colorSeries!.source.displayName;
            const barW      = 150;
            const barH      = 14;
            const lPad      = 8;
            const legendW   = barW + lPad * 2;
            const titleH    = 13;
            const labelH    = 12;
            const legendH   = lPad + titleH + 4 + barH + 4 + labelH + lPad;

            let lx: number, ly: number;
            switch (legendPos) {
                case "top-left":    lx = 8;                   ly = 8;                    break;
                case "top-right":   lx = width - legendW - 8; ly = 8;                    break;
                case "bottom-left": lx = 8;                   ly = height - legendH - 8; break;
                default:            lx = width - legendW - 8; ly = height - legendH - 8; break; // bottom-right
            }

            // SVG gradient definition
            const gradId = "colorScaleGrad";
            const defs   = this.legendLayer.append("defs");
            const grad   = defs.append("linearGradient")
                .attr("id", gradId)
                .attr("x1", "0%").attr("x2", "100%")
                .attr("y1", "0%").attr("y2", "0%");

            // 11 colour stops across the full range
            for (let i = 0; i <= 10; i++) {
                const t = i / 10;
                const v = colorMin + t * (colorMax - colorMin);
                grad.append("stop")
                    .attr("offset",     `${i * 10}%`)
                    .attr("stop-color", colorScaleFn(v));
            }

            const legendG = this.legendLayer
                .append("g")
                .attr("transform", `translate(${lx},${ly})`);

            // Background panel
            legendG.append("rect")
                .attr("width",        legendW)
                .attr("height",       legendH)
                .attr("rx",           4)
                .attr("fill",         "white")
                .attr("fill-opacity", 0.85)
                .attr("stroke",       "#ccc")
                .attr("stroke-width", 0.5);

            // Field name title
            legendG.append("text")
                .attr("x",           legendW / 2)
                .attr("y",           lPad + titleH - 2)
                .attr("text-anchor", "middle")
                .attr("font-family", "sans-serif")
                .attr("font-size",   "11px")
                .attr("fill",        "#333")
                .text(fieldName);

            // Gradient bar
            const barY = lPad + titleH + 4;
            legendG.append("rect")
                .attr("x",      lPad)
                .attr("y",      barY)
                .attr("width",  barW)
                .attr("height", barH)
                .attr("fill",   `url(#${gradId})`)
                .attr("rx",     2);

            // Min / max value labels
            const labelY = barY + barH + 4 + labelH - 2;

            legendG.append("text")
                .attr("x",           lPad)
                .attr("y",           labelY)
                .attr("text-anchor", "start")
                .attr("font-family", "sans-serif")
                .attr("font-size",   "10px")
                .attr("fill",        "#555")
                .text(colorMin.toLocaleString(undefined, { maximumFractionDigits: 2 }));

            legendG.append("text")
                .attr("x",           lPad + barW)
                .attr("y",           labelY)
                .attr("text-anchor", "end")
                .attr("font-family", "sans-serif")
                .attr("font-size",   "10px")
                .attr("fill",        "#555")
                .text(colorMax.toLocaleString(undefined, { maximumFractionDigits: 2 }));
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
