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

    public colorBySource = new formattingSettings.ToggleSwitch({
        name: "colorBySource",
        displayName: "Color by Source",
        description: "Color each ribbon by the first-column node it originates from, making flows visually traceable from left to right across all columns",
        value: false
    });

    public slices = [this.linkOpacity, this.colorBySource];
}

// ─── Labels card ──────────────────────────────────────────────────────────────

const labelPositionItems = [
    { displayName: "Inside",  value: "inside"  },
    { displayName: "Outside", value: "outside" }
];

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

    public position = new formattingSettings.ItemDropdown({
        name: "position",
        displayName: "Position",
        description: "Inside — labels appear between node columns alongside the ribbons.  Outside — labels appear in a dedicated margin flanking the diagram.",
        items: labelPositionItems,
        value: labelPositionItems[0]   // default: Inside
    });

    public showBackground = new formattingSettings.ToggleSwitch({
        name: "showBackground",
        displayName: "Background",
        value: false
    });

    public backgroundColor = new formattingSettings.ColorPicker({
        name: "backgroundColor",
        displayName: "Background Color",
        value: { value: "#ffffff" }
    });

    public backgroundTransparency = new formattingSettings.Slider({
        name: "backgroundTransparency",
        displayName: "Transparency",
        description: "Pill background transparency — 0 % is fully opaque, 100 % is fully transparent",
        value: 20,
        options: {
            minValue: { type: ValidatorType.Min, value: 0   },
            maxValue: { type: ValidatorType.Max, value: 100 }
        }
    });

    public topLevelSlice = this.show;
    public slices = [this.fontControl, this.fontColor, this.position, this.showBackground, this.backgroundColor, this.backgroundTransparency];
}

// ─── Values card ──────────────────────────────────────────────────────────────

const positionItems = [
    { displayName: "Inside",  value: "inside"  },
    { displayName: "Outside", value: "outside" },
    { displayName: "Auto",    value: "auto"    }
];

const alignmentItems = [
    { displayName: "Left",   value: "left"   },
    { displayName: "Center", value: "center" },
    { displayName: "Right",  value: "right"  }
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

    public alignment = new formattingSettings.ItemDropdown({
        name: "alignment",
        displayName: "Alignment",
        description: "Horizontal alignment of value labels on ribbons — Left anchors near the source node, Center places them mid-span, Right anchors near the target node",
        items: alignmentItems,
        value: alignmentItems[1]   // default: Center
    });

    public followPath = new formattingSettings.ToggleSwitch({
        name: "followPath",
        displayName: "Follow Link Path",
        description: "Curve value labels (and their background pills) to follow the arc of each ribbon rather than remaining horizontal. Applies to ribbon labels only.",
        value: false
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

    public showBackground = new formattingSettings.ToggleSwitch({
        name: "showBackground",
        displayName: "Background",
        value: false
    });

    public backgroundColor = new formattingSettings.ColorPicker({
        name: "backgroundColor",
        displayName: "Background Color",
        value: { value: "#ffffff" }
    });

    public backgroundTransparency = new formattingSettings.Slider({
        name: "backgroundTransparency",
        displayName: "Transparency",
        description: "Pill background transparency — 0 % is fully opaque, 100 % is fully transparent",
        value: 20,
        options: {
            minValue: { type: ValidatorType.Min, value: 0   },
            maxValue: { type: ValidatorType.Max, value: 100 }
        }
    });

    public topLevelSlice = this.show;
    public slices = [this.target, this.position, this.alignment, this.followPath, this.fontControl, this.fontColor, this.showBackground, this.backgroundColor, this.backgroundTransparency];
}

// ─── Grand Total card ─────────────────────────────────────────────────────────
//
// Displays a single total value to the left of the first column of nodes,
// showing the total flow volume entering the diagram.

class GrandTotalSettingsCard extends formattingSettings.SimpleCard {
    public name: string = "grandTotal";
    public displayName: string = "Grand Total";

    public show = new formattingSettings.ToggleSwitch({
        name: "show",
        displayName: "Show Grand Total",
        value: false
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
            value: 14
        }),
        bold: new formattingSettings.ToggleSwitch({
            name: "bold",
            displayName: "Bold",
            value: true
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

// ─── Root model ───────────────────────────────────────────────────────────────

export class VisualFormattingSettingsModel extends formattingSettings.Model {
    public nodeSettings   = new NodeSettingsCard();
    public linkSettings   = new LinkSettingsCard();
    public labelSettings  = new LabelSettingsCard();
    public valueSettings  = new ValueSettingsCard();
    public grandTotal     = new GrandTotalSettingsCard();

    public cards = [
        this.nodeSettings,
        this.linkSettings,
        this.labelSettings,
        this.valueSettings,
        this.grandTotal
    ];
}
