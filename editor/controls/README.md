# Parameter controls

Number, switch and choice controls for node editors and parameter panels, made for parametric CAD. The values are
dimensions in millimetres, and rebuilding takes anywhere from 50 ms to a minute. They use only React and the
arithmetic in `math.ts`, and import nothing from the editor around them. That keeps them separable: they could be
proposed to React Flow (xyflow) as node-UI building blocks, or published on their own.

## What they do

| Control | In a node (`compact`) | In a panel |
|---|---|---|
| `NumberField` | label (drag it to scrub), value with a bar showing where it sits in its range, unit | label, −, slider with preset ticks, +, value, unit, ⋯ (settings); preset chips under it |
| `ToggleField` | a switch (0 or 1) | the same |
| `ChoiceField` | segmented buttons up to 3 options, a select beyond | segmented up to 5 |
| `ParamMenu` | | the settings popover: soft min and max, step, unit, default, presets or options, and how it shows |

**Gestures and keys**, the same everywhere:
- Scrub: drag the label horizontally, one step per 4 px past a 3 px dead zone. Shift steps ×10, Alt ÷10. Escape during a scrub reverts.
- − and +: one step a click, with the same modifiers. Held, they repeat after 400 ms, every 80 ms, then every 40 ms after 1.5 s. They're out of the tab order, since arrow keys do the same.
- In the field:
  - ↑ and ↓ step, with the same modifiers;
  - Home and End go to the range's ends;
  - Enter commits, Escape reverts;
  - a typed expression (`h + 10`) shows as `ƒ h + 10 → 34`, with no slider or stepper.
- Double-click the label to go back to the default.
- Right-click or ⋯ opens the settings.

**One commit per gesture.** A gesture produces *preview* values while it lasts and one *commit* at its end. The host chooses what a preview does. `live()` is asked at the start of each gesture: when the host's rebuilds are quick, previews rebuild; when they're slow, previews only move the number, the field turns dashed, and `onHolding(true)` lets the host say "Release to rebuild".

**Soft ranges.** The range is a guide, not a limit. A value typed outside it is kept, marked "Outside 1.2–6 mm (allowed)", and the slider widens to include it. Hard limits (`hard`: whole numbers, a minimum count) are enforced silently.

**Ranges at the value's scale** (`math.ts`, `defaults` and `resolve`). With no range given, a value gets 0 to about three times itself, rounded to 1, 2 or 5 × 10ⁿ, by about a hundredth of that. So a 3 mm wall slides 0–10 by 0.1, not 0–200. A catalogue range far wider than the value (a 0.01–1000 width for a 20 mm part) is tamed the same way. Stepping snaps to the step's grid without floating-point drift: thirty steps of 0.1 land on 3 exactly.

## Accessibility

- The value is a `spinbutton` with `aria-valuetext` ("3.1 mm"; for an expression, "h + 10, equals 34 mm").
- The panel's slider is a native range input.
- − and + have labels ("Increase Wall thickness").
- A switch is `role="switch"`; choices are a `radiogroup` that arrow keys move through.
- Every pointer gesture has a key equivalent, and focus is always visible.

## In this editor

`main.tsx` keeps each number node's presentation in the graph's `view.params[id]` (`min`, `max`, `step`, `unit`, `default`, `kind`, `presets`, `group`). `view` never changes what is built. The **Customize** tab lists every number node by group, and opens first when the graph has any. Its rebuild policy: live below 120 ms (the median of the last three rebuilds), on release above 250 ms. After a commit that leaves the part unbuildable, it offers "Back to the last buildable values".

## As a proposal to React Flow

React Flow ships nodes, edges and a few UI pieces (`Controls`, `MiniMap`, `NodeToolbar`, `NodeResizer`), but no inputs for the data in nodes. Every node editor rebuilds a slider-and-field row. What these controls would add there:
- the preview/commit split, so a host can make expensive recomputation follow the gesture;
- scrubbing that coexists with node dragging (the label is `nodrag`, with pointer capture and a dead zone);
- soft ranges with value-scaled defaults;
- keyboard parity.

Before proposing them, they would need theming through CSS variables named like React Flow's own (`--xy-…`) instead of this editor's, and their texts made configurable.
