"use strict";

import powerbi from "powerbi-visuals-api";
import { formattingSettings } from "powerbi-visuals-utils-formattingmodel";

// ValidatorType is a const enum (Min=0, Max=1) in powerbi.visuals
import ValidatorType = powerbi.visuals.ValidatorType;

// ─── Nodes card ───────────────────────────────────────────────────────────────

class NodeSettingsCard extends formattingSettings.SimpleCard {
    public name: string = "nodeSettings";
    public displayName: string = "Nodes";

    public nodeWidth = new formattingSettings.NumUpDown({
        name: "nodeWidth",
        displayName: "Node Width (px)",
        description: "Width of each node rectangle",
        value: 20
    });

    public nodePadding = new formattingSettings.NumUpDown({
        name: "nodePadding",
        displayName: "Node Padding (px)",
        description: "Vertical gap between nodes in the same column",
        value: 12
    });

    public slices = [this.nodeWidth, this.nodePadding];
}

// ─── Links card ───────────────────────────────────────────────────────────────

class LinkSettingsCard extends formattingSettings.SimpleCard {
    public name: string = "linkSettings";
    public displayName: string = "Links";

    public linkOpacity = new formattingSettings.Slider({
        name: "linkOpacity",
        displayName: "Link Opacity",
        description: "Opacity of flow ribbons — 0% is fully transparent, 100% is fully solid",
        value: 45,
        options: {
            minValue: { type: ValidatorType.Min, value: 0   },
            maxValue: { type: ValidatorType.Max, value: 100 }
        }
    });

    public slices = [this.linkOpacity];
}

// ─── Labels card ──────────────────────────────────────────────────────────────

class LabelSettingsCard extends formattingSettings.SimpleCard {
    public name: string = "labelSettings";
    public displayName: string = "Labels";

    // Renders as a toggle in the card header — card collapses when off
    public show = new formattingSettings.ToggleSwitch({
        name: "show",
        displayName: "Show Labels",
        value: true
    });

    // Native PBI font control: family picker + size input + B / I / U buttons
    public fontControl = new formattingSettings.FontControl({
        name: "fontControl",
        displayName: "Font",
        fontFamily: new formattingSettings.FontPicker({
            name: "fontFamily",
            displayName: "Font",
            value: "Segoe UI, wf_segoe-ui_normal, helvetica, arial, sans-serif"
        }),
        fontSize: new formattingSettings.NumUpDown({
            name: "fontSize",
            displayName: "Text Size",
            value: 12
        }),
        bold: new formattingSettings.ToggleSwitch({
            name: "bold",
            displayName: "Bold",
            value: false
        }),
        italic: new formattingSettings.ToggleSwitch({
            name: "italic",
            displayName: "Italic",
            value: false
        }),
        underline: new formattingSettings.ToggleSwitch({
            name: "underline",
            displayName: "Underline",
            value: false
        })
    });

    public fontColor = new formattingSettings.ColorPicker({
        name: "fontColor",
        displayName: "Font Color",
        value: { value: "#333333" }
    });

    public topLevelSlice = this.show;
    public slices = [this.fontControl, this.fontColor];
}

// ─── Values card ──────────────────────────────────────────────────────────────

const positionItems = [
    { displayName: "Inside",  value: "inside"  },
    { displayName: "Outside", value: "outside" },
    { displayName: "Auto",    value: "auto"    }
];

const targetItems = [
    { displayName: "Nodes",   value: "nodes"   },
    { displayName: "Ribbons", value: "ribbons" }
];

class ValueSettingsCard extends formattingSettings.SimpleCard {
    public name:        string = "valueSettings";
    public displayName: string = "Values";

    public show = new formattingSettings.ToggleSwitch({
        name: "show",
        displayName: "Show Values",
        value: false
    });

    public target = new formattingSettings.ItemDropdown({
        name: "target",
        displayName: "Show On",
        items: targetItems,
        value: targetItems[0]     // default: Nodes
    });

    public position = new formattingSettings.ItemDropdown({
        name: "position",
        displayName: "Position",
        items: positionItems,
        value: positionItems[2]   // default: Auto
    });

    public fontControl = new formattingSettings.FontControl({
        name: "fontControl",
        displayName: "Font",
        fontFamily: new formattingSettings.FontPicker({
            name: "fontFamily",
            displayName: "Font",
            value: "Segoe UI, wf_segoe-ui_normal, helvetica, arial, sans-serif"
        }),
        fontSize: new formattingSettings.NumUpDown({
            name: "fontSize",
            displayName: "Text Size",
            value: 11
        }),
        bold: new formattingSettings.ToggleSwitch({
            name: "bold",
            displayName: "Bold",
            value: false
        }),
        italic: new formattingSettings.ToggleSwitch({
            name: "italic",
            displayName: "Italic",
            value: false
        }),
        underline: new formattingSettings.ToggleSwitch({
            name: "underline",
            displayName: "Underline",
            value: false
        })
    });

    public fontColor = new formattingSettings.ColorPicker({
        name: "fontColor",
        displayName: "Font Color",
        value: { value: "#333333" }
    });

    public topLevelSlice = this.show;
    public slices = [this.target, this.position, this.fontControl, this.fontColor];
}

// ─── Color Scale card ─────────────────────────────────────────────────────────

const schemeItems = [
    { displayName: "Sequential", value: "sequential" },
    { displayName: "Diverging",  value: "diverging"  }
];

const legendPositionItems = [
    { displayName: "Bottom Right", value: "bottom-right" },
    { displayName: "Bottom Left",  value: "bottom-left"  },
    { displayName: "Top Right",    value: "top-right"    },
    { displayName: "Top Left",     value: "top-left"     }
];

class ColorScaleSettingsCard extends formattingSettings.SimpleCard {
    public name:        string = "colorScaleSettings";
    public displayName: string = "Color Scale";

    // Card-level toggle — collapses the card when off
    public show = new formattingSettings.ToggleSwitch({
        name: "show",
        displayName: "Show Color Scale",
        description: "Apply a color gradient to ribbons based on the Color Value field",
        value: true
    });

    public scheme = new formattingSettings.ItemDropdown({
        name: "scheme",
        displayName: "Scheme",
        description: "Sequential: low → high in one direction. Diverging: low — mid — high.",
        items: schemeItems,
        value: schemeItems[0]   // default: Sequential
    });

    public lowColor = new formattingSettings.ColorPicker({
        name: "lowColor",
        displayName: "Low Color",
        description: "Color assigned to the minimum Color Value",
        value: { value: "#c6dbef" }   // light blue
    });

    public midColor = new formattingSettings.ColorPicker({
        name: "midColor",
        displayName: "Mid Color",
        description: "Midpoint color for diverging schemes",
        value: { value: "#f7f7f7" }   // near-white
    });

    public highColor = new formattingSettings.ColorPicker({
        name: "highColor",
        displayName: "High Color",
        description: "Color assigned to the maximum Color Value",
        value: { value: "#08519c" }   // dark blue
    });

    public legendPosition = new formattingSettings.ItemDropdown({
        name: "legendPosition",
        displayName: "Legend Position",
        description: "Corner of the visual where the color scale legend is displayed",
        items: legendPositionItems,
        value: legendPositionItems[0]   // default: Bottom Right
    });

    public topLevelSlice = this.show;
    public slices = [this.scheme, this.lowColor, this.midColor, this.highColor, this.legendPosition];
}

// ─── Root model ───────────────────────────────────────────────────────────────

export class VisualFormattingSettingsModel extends formattingSettings.Model {
    public nodeSettings       = new NodeSettingsCard();
    public linkSettings       = new LinkSettingsCard();
    public labelSettings      = new LabelSettingsCard();
    public valueSettings      = new ValueSettingsCard();
    public colorScaleSettings = new ColorScaleSettingsCard();

    public cards = [
        this.nodeSettings,
        this.linkSettings,
        this.labelSettings,
        this.valueSettings,
        this.colorScaleSettings
    ];
}
