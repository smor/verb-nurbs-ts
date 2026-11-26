# Visual programming: choosing the foundation

A node editor for generative design, on top of the kernel: boxes on a canvas, wires between them, sliders on the
inputs, a solid in the viewport. This page reviews what exists (the CAD node systems, the literature, and the open
source JavaScript libraries), says what each one could give us, and recommends what to adopt and what to keep as
ours. It is a decision record: nothing here is built yet.

## Recommendation in short

1. **The document and the evaluator stay ours.** The graph is a JSON document that extends the `Model` document
   (`docs/model.md`): parameters, nodes keyed by id, inputs that reference the node they come from (`@rail`),
   outputs. A version 1 model document is still read, rewritten into version 2 on load. Evaluation extends `Model`'s content-hash cache, so an edit rebuilds only what
   is downstream of it, the same document always gives the same result bit for bit, and persistent face names
   survive. No library offers this, and every library's engine would have to be bypassed to get it.
2. **The editor canvas comes from a library: Rete.js v2 (`rete`, MIT), drawn by its React renderer.** Its core is
   small and typed (a `NodeEditor` of nodes, sockets and connections), and everything else is a plugin we pick:
   area, connections, history, context menu, minimap, auto-arrange. We use its editor and none of its engine. It is
   a view: the document is the truth, and two functions (`toEditor`, `fromEditor`) map it onto the editor and back.
   React Flow (`@xyflow/react`) was the other strong candidate (see the comparison and "Choosing Rete").
3. **Hierarchy is the document calling itself.** A graph document with an interface (inputs, outputs) is a node: a
   `group` node that runs another document, with its inputs as the node's ports. This is Houdini's digital
   asset, Blender's node group, Dynamo's custom node and Grasshopper's cluster, and it is what the design tree of
   features already is, one level deeper. Persistent names nest under the group's id, as they already nest under a
   `transform`'s.
4. **Math nodes: adopt a standard, not a library.** No library's ready-made math nodes run outside its own engine.
   We take the operation names and semantics of glTF's `KHR_interactivity` (`math/add`, `math/sin`, `math/clamp`,
   `math/mix`, ...), implement them in a few lines each on top of `Expr`, and add Grasshopper's Expression node,
   which `Expr` already is.
5. **Lists before data trees.** Wires carry single values or lists, with Dynamo's lacing (shortest, longest, cross
   product) per node. Grasshopper's data trees (paths like `{0;2}`) come later, if the list levels prove too
   flat.

## What we are building on

The repository already has most of the back half of a node system.

| Piece | Where | What it gives the graph |
|---|---|---|
| Model document | `src/model/Model.ts`, `docs/model.md` | JSON of named parameters, features keyed by id, inputs by id (`of`, `from`, `minus`), an output: a dataflow graph already |
| Expressions | `src/model/Expr.ts` | any numeric input may be an expression over the parameters; cycles refused |
| Content hashes | `Model` | each feature's hash covers its type, resolved values and its inputs' hashes; the cache rebuilds only what changed |
| Persistent names | `Model` | faces and edges named from their history (`block.+z|peg.tube`), so rules keep selecting the same edges as values change |
| Verdict | `Model.verdict` | buildable or visual, with reasons: the per-node status badge of the editor |
| Primitive catalogue | `Catalog.ENTRIES` | every primitive with its parameters, defaults, ranges, integer and angle flags: node definitions, generated |
| Grasshopper-style builders | `Nodes` (`src/solid/primitives/Nodes.ts`) | Plane Surface, 4Point, Boundary, Loft, Sweep1, Sweep2, Pipe, with capped variants: the surface nodes |
| Worker evaluation | `playground/worker.ts` | models build off the UI thread already |

What is missing is a general node registry (typed ports beyond the fixed feature types), values other than solids on
the wires (numbers, points, curves, surfaces, lists), groups, a layout block, and the editor itself.

## The CAD node systems

None of these can be used as code: they are closed, or GPL, or in another language. They are where the concepts
come from.

| System | License | File | What we take from it |
|---|---|---|---|
| **Grasshopper** (McNeel, in Rhino) | proprietary | `.gh` (binary GH_IO chunks), `.ghx` (the same as XML) | the component vocabulary (our `Nodes` already follow it); **data trees**: every wire carries a tree of lists addressed by paths `{0;1}`, and components match lists by longest list, shortest list or cross reference; clusters (a sub-graph as a component); per-component status colours (grey, orange warning, red error); the Expression component |
| **Dynamo** (Autodesk) | Apache-2.0 (C#) | `.dyn`, plain **JSON** since 2.0 | the clearest file format of the lot: `Nodes` (id, type, input and output ports with ids), `Connectors` (start port, end port), graph-level `Inputs` and `Outputs` (the nodes exposed as parameters), and a separate `View` block with node positions, notes and groups. Layout lives apart from meaning. **Lacing** per node (auto, shortest, longest, cross product) and list levels (`@L2`). Custom nodes (`.dyf`): a graph saved as a node |
| **Blender geometry nodes** | GPL | inside `.blend` | **node groups** with an interface (the hierarchy); **fields**: a function input evaluated later over a geometry's points or faces (a per-vertex offset without a loop); **zones** (repeat, for-each element, simulation) for loops inside a dataflow graph; a lazy evaluator that computes only the outputs something uses |
| **Houdini** (SideFX) | proprietary | `.hip`, `.hda` | **cook on demand**: the displayed node pulls, dirty flags push; parameters as **expressions** that reference other parameters (`ch("../size")`), which is what our `Expr` parameters are; **digital assets**: a subnet with a promoted parameter interface, versioned and reused; bypass and display flags |
| **Sverchok** (Blender add-on) | GPL-3.0 | inside `.blend` | nested list levels in the Grasshopper manner, in Python; NURBS nodes on the same kind of kernel |
| **Möbius Modeller** (NUS, P. Janssen) | MIT | JSON | a web-based modeller that mixes a dataflow graph with procedures inside nodes; dormant since 2022 |
| **Flood** (P. Boyer) | open source | JSON | a Dynamo-like visual language for the web, built on verb by the author of the library we forked. Dormant for a decade, but proof that this kernel was meant to sit under a graph |

## The literature

* **Dataflow languages.** W. M. Johnston, J. R. P. Hanna, R. J. Millar, "Advances in dataflow programming languages",
  *ACM Computing Surveys* 36(1), 2004; D. D. Hils, "Visual languages and computing survey: data flow visual
  programming languages", *J. Visual Languages and Computing* 3(1), 1992. Pull (demand-driven) against push
  (data-driven) evaluation, and why a pure graph can be cached and run in parallel.
* **Classification and usability.** M. M. Burnett, M. J. Baker, "A classification system for visual programming
  languages", *J. Visual Languages and Computing* 5(3), 1994; T. R. G. Green, M. Petre, "Usability analysis of
  visual programming environments: a 'cognitive dimensions' framework", *J. Visual Languages and Computing* 7(2),
  1996. The "viscosity" and "hidden dependencies" of large wired graphs are what groups and expressions are for.
* **Parametric design.** R. Woodbury, *Elements of Parametric Design*, Routledge, 2010 (patterns for parametric
  models); R. Aish, R. Woodbury, "Multi-level interaction in parametric design", *Smart Graphics*, LNCS 3638, 2005
  (GenerativeComponents: graph, script and direct manipulation over the same model); P. Janssen, K. W. Chen,
  "Visual dataflow modelling: a comparison of three systems", *CAAD Futures* 2011 (Houdini, GenerativeComponents and
  Grasshopper compared: iteration and hierarchy are where they differ most).
* **Modularity in practice.** D. Davis, J. Burry, M. Burry, "Untangling parametric schemata: enhancing collaboration
  through modular programming", *CAAD Futures* 2011; D. Davis, *Modelled on Software Engineering: Flexible
  Parametric Models in the Practice of Architecture*, PhD thesis, RMIT, 2013. Large Grasshopper models become
  unreadable without clusters and naming; modular ones are understood and changed faster. The case for groups from
  the first version.
* **Incremental rebuilds.** A. Mokhov, N. Mitchell, S. Peyton Jones, "Build systems à la carte", *ICFP* 2018:
  `Model`'s cache is a build system with constructive traces keyed by content hashes, the strongest kind (it allows
  early cut-off: a node whose inputs changed but whose result did not stops the rebuild). M. A. Hammer et al.,
  "Adapton: composable, demand-driven incremental computation", *PLDI* 2014: demand-driven, so only what the
  viewport shows is computed.
* **Persistent naming**, already cited in `docs/model.md` (Kripac 1997; Capoyleas, Chen, Hoffmann 1996): it is what
  lets a downstream node keep pointing at "the top edge of the block" while upstream values change.

## The JavaScript and TypeScript libraries

Checked on npm on 2026-11-26 (latest version and its date).

| Library | License | Latest | Renders with | Engine | Saved as | Built-in nodes | Hierarchy |
|---|---|---|---|---|---|---|---|
| **React Flow** `@xyflow/react` | MIT | 13.0.3, 2026-11-23 | React, DOM | none (a "computing flows" guide; you bring it) | `toObject()`: `{ nodes: [{id, type, position, data}], edges: [{source, sourceHandle, target, targetHandle}], viewport }` | none | sub-flows (`parentId`): visual grouping only |
| **Svelte Flow** `@xyflow/svelte` | MIT | 2.0.3, 2026-11-23 | Svelte, DOM | none | as React Flow | none | as React Flow |
| **Rete.js v2** `rete` | MIT | 2.0.6, 2025-06 (plugins 2026-07) | React, Vue, Angular, Svelte, Lit plugins | `rete-engine`: dataflow (pull, cached per node id, `reset` by hand) and control flow | none built in; you write import and export | none | scopes (nested nodes) plugin |
| **Baklava.js v2** | MIT | 2.8.1, 2025-11 | Vue 3 | dependency engine (recomputes the graph) and forward engine | `IEditorState`: graph plus **graph templates**, connections between interface uuids | none (interface types: number, text, select, checkbox) | **graph templates**: real subgraphs with inputs and outputs |
| **LiteGraph.js** (original) | MIT | 0.7.18, 2024-01 | Canvas 2D | its own: a step loop, `onExecute` per frame | `serialize()`: nodes with positional `inputs`/`outputs`, links as arrays `[id, from, slot, to, slot, type]` | about 200: 24 `math/*`, 21 `math3d/*`, logic, strings, audio, MIDI, textures | subgraph node |
| **LiteGraph (ComfyUI fork)** `@comfyorg/litegraph` | MIT | 0.17.2, 2025-08 | Canvas 2D, TypeScript | as above | as above, sorted by id | stripped | subgraphs |
| **behave-graph** | ISC | 0.9.10, 2022-11 (`@behave-graph/core` 0.9.13, 2022-12) | none (headless; a React Flow editor sample) | its own: event flow plus pure functions | JSON: nodes with `parameters` that hold a value or a `link` to `{nodeId, socket}` | about 300: `math/add/float`, ... for float, integer, boolean, vec2 to vec4, quat, mat3, mat4, colour, easing | none |
| **Node-RED** | Apache-2.0 | 5.0.10, 2026-11 | its own editor (jQuery) | message passing, server side | flows JSON: nodes with `wires` | many, for I/O and services | subflows |
| **Flume** | MIT | 1.2.0, 2025-11 | React | its own root engine, pulls from one root node | JSON of nodes with connections | none | none |
| **Vue Flow** `@vue-flow/core` | MIT | 1.48.2, 2026-01 | Vue 3, DOM | none | as React Flow | none | sub-flows |
| **Drawflow**, **jsPlumb**, **AntV X6** | MIT; MIT or GPL-2.0; MIT | | DOM / SVG | none | their own | none | no |

How they fall out:

* **Node-RED, Drawflow, jsPlumb, X6** are out. Node-RED moves messages through a server: it does not cache, cannot run
  in a worker beside the viewport, and its semantics are events, not functions. The other three are diagram kits
  with no notion of evaluation.
* **behave-graph** is the closest in spirit to our document: inputs hold either a value or a link to another node's
  socket, which is exactly how `of: "block"` works today. Its node library is the largest and it follows glTF's
  `KHR_interactivity` (submitted to Khronos for ratification in June 2025). But it has not been published since
  December 2022, its nodes run only inside its own engine (event flow, fibers, a registry of value types), and the
  engine has no content cache. We take its naming, not its code.
* **LiteGraph** has the best canvas performance (thousands of nodes; ComfyUI proves it) and ready-made math nodes.
  But those nodes read inputs through `getInputData(slot)` inside LiteGraph's per-frame loop, so they are not usable
  outside it; the saved format is positional arrays that cannot be written by hand or diffed in review; the original
  is unmaintained since January 2024; and the maintained copy now lives inside the ComfyUI frontend, whose packages
  are published under GPL-3.0 (`@comfyorg/comfyui-frontend-types`). Taking code from there would need a file-by-file
  license check.
* **Baklava** is the only one with format, engine, editor and real subgraphs in one package, which makes it tempting.
  Its engine recomputes rather than caches by content, its saved state names every interface by a fresh uuid (not
  hand-writable, and every save diffs), and it ties the editor to Vue. We would keep its core's ideas and replace its
  engine and format, which leaves only the Vue editor: Rete does that part with less tied to it.
* **Rete.js v2** is clean, typed, modular and framework-agnostic in its core, with a dataflow engine that caches per
  node. It has no saved format (by design), its engine's cache is keyed by node id and cleared by hand (not by
  content), and its renderer plugins still need React, Vue, Angular or Svelte. We take the editor and leave the
  engine: then it has nothing to bypass either. Chosen; see "Choosing Rete".
* **React Flow** does one thing, the canvas, and does it best: it is the most used node canvas in JavaScript, released
  three days before this was written, MIT, TypeScript, with DOM nodes that can hold anything. It has no engine and no
  format, and here that is an advantage: ours are better suited to geometry, and nothing has to be bypassed. The
  close second.

## Choosing Rete

React Flow and Rete score almost the same here (table below); Rete was chosen for its simpler model. How to use it
well:

* **Editor only.** Install `rete`, `rete-area-plugin`, `rete-connection-plugin`, `rete-react-plugin` (React 18 or
  later), `rete-history-plugin`, `rete-context-menu-plugin`, `rete-minimap-plugin`, `rete-auto-arrange-plugin`
  (ELK layout). Do not use `rete-engine`: evaluation is the worker's, by content hash.
* **Renderer.** The official renderers are React, Vue, Angular and Svelte (all released 2026-07). The Lit renderer is
  a third-party one, not released since 2023: avoid it. React is the simplest with our build, since esbuild compiles
  TSX with no plugin. Svelte is smaller but needs `esbuild-svelte`.
* **The document is the truth.** On every user edit (add a node, connect, change a control) the editor is read back
  into the document (`fromEditor`), the document goes to the worker, and statuses come back as node badges. Rete
  has no saved format, so nothing competes with ours. Undo is a stack of documents, or `rete-history-plugin` with a
  document write after each step.
* **Sockets are typed from the registry.** One `ClassicPreset.Socket` per port type (`number`, `curve`, `solid`, ...);
  the connection plugin refuses a wire between types that do not convert. Controls (`ClassicPreset.InputControl`,
  or our own React slider) edit literals and expressions.
* **Groups: drill down, not nest.** `rete-scopes-plugin` draws nodes inside a parent node on one canvas, which gets
  crowded fast and has not been released since 2024. Open a group in its own editor instead (double click, with a
  breadcrumb back), as Houdini does with subnets. One `NodeEditor` per open group.
* **Scale.** Nodes are DOM elements, as in React Flow: a few hundred per canvas stay smooth. Groups keep canvases
  small.

## Comparison for this project

Scored 0 (none) to 3 (good) against what this project needs.

| Need | React Flow | Rete v2 (chosen) | Baklava | LiteGraph | behave-graph |
|---|---|---|---|---|---|
| Our JSON stays the source of truth | 3 (pure view) | 3 (no format) | 1 (its own state) | 1 (its own, positional) | 2 (similar, but its own) |
| Content-hash caching, determinism, worker | 3 (ours, nothing to bypass) | 3 (its engine left out) | 1 (replace its engine) | 1 (replace its loop) | 1 (replace its engine) |
| Rich node bodies: sliders, previews, verdicts | 3 (DOM components) | 3 (DOM components) | 2 (Vue components) | 2 (drawn on canvas) | 0 (no editor) |
| Simplicity of the model | 2 (nodes, edges, hooks) | 3 (nodes, sockets, connections, plugins) |
| Hierarchy (groups) | 2 (visual; semantics ours) | 2 (scopes plugin; drill-down ours) | 3 (graph templates) | 2 (subgraphs) | 0 |
| Ready-made math nodes usable as is | 0 | 0 | 0 | 1 (only in its loop) | 1 (only in its engine) |
| Maintenance, 2026 | 3 | 2 | 2 | 1 | 0 |
| License fit with this MIT library | 3 | 3 | 3 | 2 (fork under GPL) | 3 |
| Fits the build (esbuild, no framework today) | 2 (esbuild compiles TSX; adds React) | 2 (adds React or Svelte) | 2 (adds Vue) | 3 (one file) | 3 |

## The document

Version 2 extends version 1: `Model` reads a version 1 document by rewriting it into version 2 on load (its `of`,
`from` and `minus` become references), so every document in `docs/model.md` keeps working. The node types below are
illustrative.

```json
{
  "version": 2,
  "units": "mm",
  "parameters": {
    "turns": { "value": 3, "min": 1, "max": 8, "step": 1 },
    "r": 4
  },
  "nodes": {
    "pts":    { "type": "curve/helix-points", "in": { "turns": "turns", "radius": 30, "pitch": 12 } },
    "rail":   { "type": "curve/interpolate", "in": { "points": "@pts", "degree": 3 } },
    "spring": { "type": "nodes/pipe-solid", "in": { "curve": "@rail", "radius": "r", "caps": "round" },
                "label": "Spring" },
    "base":   { "type": "primitive/cylinder", "in": { "radius": 35, "height": 4 } },
    "join":   { "type": "csg/union", "in": { "of": ["@base", "@spring"] } },
    "foot":   { "type": "group", "use": "rounded-foot", "in": { "solid": "@join", "radius": "r / 2" } }
  },
  "outputs": { "solid": "@foot.solid" },
  "groups": {
    "rounded-foot": {
      "interface": {
        "inputs":  { "solid": { "type": "solid" }, "radius": { "type": "number", "value": 1, "min": 0.1, "max": 10 } },
        "outputs": { "solid": "@round" }
      },
      "nodes": { "round": { "type": "round", "in": { "of": "@solid", "rules": [ { "edges": "*.start cap|*", "radius": "radius" } ] } } }
    }
  },
  "view": {
    "nodes": { "pts": { "x": 0, "y": 0 }, "rail": { "x": 220, "y": 0 } },
    "notes": [ { "x": 0, "y": -80, "text": "spring on a disc" } ]
  }
}
```

What changes from version 1, and why none of it gets in the way of hierarchy:

* **References say they are references.** `"@rail"` is the node `rail` (its only output), `"@rail.points"` a named
  output; a plain string is an expression over the parameters, and inside an expression `@count.n` reads a numeric
  output (`"@count.n * 2"`). In version 1 the field's name told the two apart (`of` is a reference, `radius` an
  expression), so a tool had to know every feature type to draw the wires. With the `@`, the validator, the editor
  and a diff can find every wire from the JSON alone. Inside a group, `@` names the group's own nodes and inputs:
  names are local, so a group can be copied into any document unchanged.
* **Values sit under `in`.** Ports are kept apart from the node's own keys (`type`, `label`, `lacing`, `use`), so a
  port can never clash with a reserved word, and the registry can check `in` against the type's ports.
* **Ids and labels are separate.** The id (`spring`) is what persistent names are built from and never changes once
  set; `label` is free text for the canvas. Renaming a box on screen does not rename a face, so rules that select
  edges by name keep working.
* **A group has an explicit interface.** `inputs` with types, defaults and ranges (the sliders a group node shows),
  and `outputs`, several if need be, each a reference. This is Blender's group interface and Houdini's promoted
  parameters. The top-level document follows the same rule: its `parameters` are its numeric inputs and `outputs` its
  results (`output` stays accepted as a shorthand for one). So any document can be used as a group as it is: the
  hierarchy is the format applied recursively, with nothing special at the top.
* **Groups by value or by reference.** In the file (`groups`), or from a library: `"use": "lib/rounded-foot.json#3f9c..."`,
  where the suffix is the group's content hash. A changed library group is then noticed, not silently picked up, and
  the cache stays exact. Recursion is refused, like parameter cycles.
* **Names nest.** A face made inside the group node `foot` is named `foot/round(...)`, the rule `transform` already
  follows. Rules outside a group can select inside it by that prefix, and rules inside it never see outside names.
* **Units and lacing are declared.** `units` at the top (millimetres by default, as now); `lacing` on a node that maps
  over lists (`shortest`, `longest`, `cross`).
* **`view` is ignored by the hash.** Moving a node or writing a note does not rebuild anything, and a review diff
  shows layout and meaning apart (Dynamo's split). Positions are kept per document, so each group has its own
  layout.
* **A schema from the registry.** The registry writes a JSON Schema of the format (each type's ports and their
  types), for validation in tests and autocompletion in an editor.

## The evaluator

* **A node registry**, one entry per type: input and output ports with types (`number`, `integer`, `angle`, `point`,
  `vector`, `curve`, `surface`, `solid`, `mesh`, `list<T>`), defaults and ranges, a category, a one-line help and the
  function. The editor's palette, the document validator and the evaluator read the same table. `Catalog.ENTRIES`
  and `Nodes` generate their entries.
* **Pull evaluation with content hashes.** The output (or any node the viewport shows) pulls its inputs; each node's
  hash covers its type, resolved values and its inputs' hashes; a hit in the cache is returned as is. Early cut-off:
  a node whose recomputed result has the same hash as before stops the rebuild there.
* **CSG stays one Boolean per tree.** Boolean nodes pass a CSG expression downstream rather than a cut solid, and
  the evaluator compiles a connected run of them into one N-ary Boolean, as `Model` does now. A node that needs the
  boundary (round, shell, STEP, a face query) forces it.
* **Lists and lacing.** A port of type `T` given a `list<T>` maps the node over the list; two lists are matched by the
  node's lacing (`shortest`, `longest`, `cross`), as in Dynamo. Data trees are a later step.
* **Status per node**: ok, warning (a fillet made smaller, a verdict note), error (with the message the kernel threw),
  and the verdict on solids. The editor colours nodes from it.
* **Determinism and workers.** Evaluation runs in the existing worker; node functions are pure and take explicit
  tolerances (`AGENTS.md`).

## Math nodes

No library's math nodes can be lifted as is: LiteGraph's and behave-graph's read their inputs through their own
engines. What can be reused is a naming standard. The math nodes follow `KHR_interactivity`'s operations, on
numbers and on 3-vectors:

| Group | Nodes |
|---|---|
| Arithmetic | `math/add`, `sub`, `mul`, `div`, `rem`, `neg`, `abs`, `sign`, `min`, `max`, `clamp`, `mix`, `floor`, `ceil`, `round`, `pow`, `sqrt`, `exp`, `log` |
| Trigonometry | `math/sin`, `cos`, `tan`, `asin`, `acos`, `atan2`, `rad`, `deg` |
| Comparison and logic | `math/eq`, `lt`, `le`, `gt`, `ge`, `select`, `and`, `or`, `not` |
| Vectors | `math/combine3`, `extract3`, `length`, `normalize`, `dot`, `cross` |
| Constants | `math/pi`, `math/e` |
| Ours | `expression` (an `Expr` with named inputs, Grasshopper's Expression), `series`, `range`, `random` (seeded), `remap` |

Each is a line or two over `Expr` and `Vec`, so owning them costs less than adapting a foreign runtime would.

## Where it lives

* The registry, the version 2 document and the evaluator: `src/model/` (the `model` layer, beside `Model`), with no
  new runtime dependency.
* The editor: a new app beside `playground/` and `viewer/` (`editor/`), built with esbuild into one HTML file like
  them. React, `rete` and its plugins are its dev dependencies only; the published library still depends on `cdt2d`
  alone.

## Plan

1. Node registry and version 2 document in `src/model/`, with the version 1 documents of `docs/model.md` passing
   unchanged; nodes for the catalogue, `Nodes`, curves (`Make`), transforms, Booleans, round, shell, lattice, math.
   Tests: the same document gives the same hashes and the same solid; an edit rebuilds only downstream nodes; a group's
   faces keep their names.
2. Groups, with recursion refused and names nested.
3. Lists and lacing.
4. The editor: Rete canvas with the React renderer, the registry as the palette, the viewport and verdict from the worker, the document
   as the file (open, save, undo by document snapshots).
5. Data trees, fields (per-vertex functions in Blender's sense, for growth and lattices), and loops (zones), as the
   models ask for them.

## Known limits of this choice

* Rete draws nodes as DOM elements: a few hundred nodes stay smooth, thousands do not. LiteGraph's canvas scales
  further. Groups keep each canvas small, which is the answer here.
* Rete's core was last released in June 2025 (its renderers and area plugin in July 2026); several plugins (scopes,
  auto-arrange, connection) date from 2024. It is stable rather than fast-moving. Since the document is ours and Rete
  is only the view, moving to React Flow later would mean rewriting `toEditor`, `fromEditor` and the node bodies,
  not the format or the evaluator.
* Choosing React for the editor's renderer is a choice of framework for every editor panel; Svelte is the
  alternative.
