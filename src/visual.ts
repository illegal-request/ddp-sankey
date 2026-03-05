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

import "./../style/visual.less";

// ─── Data types ──────────────────────────────────────────────────────────────

interface NodeDatum {
    name:  string;   // level-prefixed key, e.g. "0\x01North"  (internal, unique across levels)
    label: string;   // display name,        e.g. "North"
}

interface LinkDatum {
    source: number;
    target: number;
    value: number;
}

type LayoutNode = SankeyNode<NodeDatum, LinkDatum>;
type LayoutLink = SankeyLink<NodeDatum, LinkDatum>;
type LayoutGraph = SankeyGraph<NodeDatum, LinkDatum>;

// ─── Visual ──────────────────────────────────────────────────────────────────

export class Visual implements IVisual {
    private host: IVisualHost;
    private svg: Selection<SVGSVGElement, unknown, null, undefined>;
    private zoomLayer: Selection<SVGGElement, unknown, null, undefined>;
    private container: Selection<SVGGElement, unknown, null, undefined>;
    private errorText: Selection<SVGTextElement, unknown, null, undefined>;
    private zoomBehavior: ZoomBehavior<SVGSVGElement, unknown>;

    private formattingSettingsService: FormattingSettingsService;
    private formattingSettings: VisualFormattingSettingsModel;

    private selectionManager: powerbi.extensibility.ISelectionManager;
    private selectionType: "none" | "node" | "link" = "none";
    private selectedKey: string = "";
    private currentLinkOpacity: number = 0.45;

    constructor(options: VisualConstructorOptions) {
        this.host = options.host;
        this.formattingSettingsService = new FormattingSettingsService();
        this.formattingSettings = new VisualFormattingSettingsModel();
        this.selectionManager = options.host.createSelectionManager();

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
            .attr("text-anchor", "middle")
            .attr("dominant-baseline", "middle")
            .attr("fill", "#999")
            .attr("font-size", "14px")
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
        this.errorText.text("");

        // ── Populate formatting settings from the format pane ─────────────────
        this.formattingSettings = this.formattingSettingsService
            .populateFormattingSettingsModel(VisualFormattingSettingsModel, options.dataViews[0]);

        const { nodeSettings, linkSettings, labelSettings, valueSettings } = this.formattingSettings;
        const nodeWidth   = Math.max(4,  nodeSettings.nodeWidth.value);
        const nodePadding = Math.max(2,  nodeSettings.nodePadding.value);
        const linkOpacity = Math.min(1, Math.max(0, linkSettings.linkOpacity.value / 100));
        const showLabels  = labelSettings.show.value;
        const fontFamily  = labelSettings.fontControl.fontFamily.value;
        const fontSize    = Math.max(8, labelSettings.fontControl.fontSize.value);
        const bold        = labelSettings.fontControl.bold?.value    ?? false;
        const italic      = labelSettings.fontControl.italic?.value  ?? false;
        const underline   = labelSettings.fontControl.underline?.value ?? false;
        const fontColor   = labelSettings.fontColor.value?.value ?? "#333333";

        const showValues  = valueSettings.show.value;
        const valuePos    = String(valueSettings.position.value?.value  ?? "auto");
        const valueTarget = String(valueSettings.target.value?.value    ?? "nodes");
        const vFontFamily = valueSettings.fontControl.fontFamily.value;
        const vFontSize   = Math.max(8, valueSettings.fontControl.fontSize.value);
        const vBold       = valueSettings.fontControl.bold?.value    ?? false;
        const vItalic     = valueSettings.fontControl.italic?.value  ?? false;
        const vUnderline  = valueSettings.fontControl.underline?.value ?? false;
        const vFontColor  = valueSettings.fontColor.value?.value ?? "#333333";

        this.currentLinkOpacity = linkOpacity;

        // ── Guard: no data ────────────────────────────────────────────────────
        const dataView   = options.dataViews?.[0];
        const categorical = dataView?.categorical;

        if (!categorical?.categories?.length || !categorical.values?.length) {
            this.showError(width, height, "Add 2 or more Path Level columns and a Value to get started.");
            return;
        }

        // categorical.categories is ordered by field-well position (top → left in visual)
        const levelCats   = categorical.categories;
        const valueSeries = categorical.values[0];

        if (levelCats.length < 2) {
            this.showError(width, height, "Add at least 2 Path Level columns and a Value.");
            return;
        }

        // ── Parse rows → aggregate links, build selection ID maps ─────────────
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
            const levelKeys: string[] = [];
            const levelRaws: (string | null)[] = [];
            for (let lvl = 0; lvl < levelCats.length; lvl++) {
                const raw = (String(levelCats[lvl].values[r] ?? "").trim()) || null;
                levelRaws[lvl] = raw;
                if (raw !== null) {
                    levelKeys[lvl] = `${lvl}\x01${raw}`;
                } else {
                    const parentKey = lvl > 0 ? levelKeys[lvl - 1] : "root";
                    levelKeys[lvl] = `${lvl}\x01(Blank)\x02${parentKey}`;
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

        // ── Build Sankey input ────────────────────────────────────────────────
        const nodeArray = Array.from(nodeSet);
        const nodeIndex = new Map<string, number>(nodeArray.map((n, i) => [n, i]));

        const nodes: NodeDatum[] = nodeArray.map(key => {
            const afterLevel = key.slice(key.indexOf("\x01") + 1);
            // Blank keys are suffixed with \x02parentKey for parent-path disambiguation — strip it
            const blankSep   = afterLevel.indexOf("\x02");
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

        // ── Layout ────────────────────────────────────────────────────────────
        const labelPad = showLabels ? Math.max(80, fontSize * 7) : 10;
        const margin   = { top: 10, right: labelPad, bottom: 10, left: labelPad };
        const innerW   = Math.max(10, width  - margin.left - margin.right);
        const innerH   = Math.max(10, height - margin.top  - margin.bottom);

        this.container.attr("transform", `translate(${margin.left},${margin.top})`);

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

        // Use report theme colours keyed by display label so the same name gets the same colour
        const color = (label: string): string => this.host.colorPalette.getColor(label).value;

        // ── Downstream selection helpers ──────────────────────────────────────
        //
        // When a node is clicked:  emphasise the node + every node/ribbon
        //   reachable by following links forward (downstream).
        // When a ribbon is clicked: emphasise the ribbon's source node, the
        //   ribbon itself, and every node/ribbon downstream of the target node.
        // Everything else is de-emphasised to 15 % opacity.
        //
        // downstreamSet  – names of all nodes in the highlighted downstream path
        // linkSourceNode – for a ribbon click, the name of its source node
        //   (kept separate because it is upstream of the BFS start)

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
                const parts   = this.selectedKey.split("\x00");
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

        // Minimum ribbon height: tall enough to contain the largest active text.
        // Uses the label font size (if labels are on) and/or the value font size
        // (if values are on), plus 4 px padding (2 px each side), so text never
        // appears clipped inside a thin ribbon. Ribbon proportionality is
        // intentionally relaxed — small-value flows are scaled up to this floor.
        const minRibbonHeight = Math.max(
            1,
            showLabels ? fontSize  + 4 : 1,
            showValues ? vFontSize + 4 : 1
        );

        // ── Links ─────────────────────────────────────────────────────────────
        const linkPaths = this.container
            .append("g")
            .classed("links", true)
            .attr("fill", "none")
            .selectAll<SVGPathElement, LayoutLink>("path")
            .data(graph.links)
            .join("path")
            .attr("d", sankeyLinkHorizontal())
            .attr("stroke", d => color((d.source as LayoutNode).label))
            .attr("stroke-width", d => Math.max(minRibbonHeight, d.width ?? 1))
            .attr("opacity", d => linkOpacityFn(d))
            .style("cursor", "pointer");

        linkPaths
            .append("title")
            .text(d =>
                `${(d.source as LayoutNode).label} → ${(d.target as LayoutNode).label}\n${d.value.toLocaleString()}`
            );

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
                .attr("x", d => (d.x0 ?? 0) < innerW / 2 ? (d.x1 ?? 0) + 6 : (d.x0 ?? 0) - 6)
                .attr("y", d => ((d.y0 ?? 0) + (d.y1 ?? 0)) / 2)
                .attr("dy",              "0.35em")
                .attr("text-anchor",     d => (d.x0 ?? 0) < innerW / 2 ? "start" : "end")
                .attr("font-family",     fontFamily)
                .attr("font-size",       `${fontSize}px`)
                .attr("font-weight",     bold    ? "bold"      : "normal")
                .attr("font-style",      italic  ? "italic"    : "normal")
                .attr("text-decoration", underline ? "underline" : "none")
                .attr("fill",            fontColor)
                .attr("pointer-events",  "none")
                .text(d => d.label);
        }

        // ── Value labels — nodes ──────────────────────────────────────────────
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
                .attr("dy",              "0.35em")
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

        // ── Value labels — ribbons ────────────────────────────────────────────
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
                .attr("y", d => (d.y0 + d.y1) / 2)
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
