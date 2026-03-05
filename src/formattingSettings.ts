"use strict";

import { formattingSettings } from "powerbi-visuals-utils-formattingmodel";

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

    public linkOpacity = new formattingSettings.NumUpDown({
        name: "linkOpacity",
        displayName: "Link Opacity",
        description: "Opacity of flow ribbons — 0 is transparent, 1 is solid",
        value: 0.45
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

// ─── Root model ───────────────────────────────────────────────────────────────

export class VisualFormattingSettingsModel extends formattingSettings.Model {
    public nodeSettings  = new NodeSettingsCard();
    public linkSettings  = new LinkSettingsCard();
    public labelSettings = new LabelSettingsCard();
    public valueSettings = new ValueSettingsCard();

    public cards = [this.nodeSettings, this.linkSettings, this.labelSettings, this.valueSettings];
}
