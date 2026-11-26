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
2. **The editor canvas comes from a library: React Flow (`@xyflow/react`, MIT). Chosen.** The same small editor was
   built with React Flow, Rete.js v2 and LiteGraph (see "Hands-on comparison"): React Flow and Rete both need React,
   and React Flow did the same job in less code with fewer pieces to wire; Rete gives the smaller bundle and a
   finished default look.
   Either is only a view: the document is the truth, and two functions (`toEditor`, `fromEditor`) map it onto the
   editor and back. LiteGraph is the one option without a framework.
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
  engine: then it has nothing to bypass either. See "Hands-on comparison".
* **React Flow** does one thing, the canvas, and does it best: it is the most used node canvas in JavaScript, released
  three days before this was written, MIT, TypeScript, with DOM nodes that can hold anything. It has no engine and no
  format, and here that is an advantage: ours are better suited to geometry, and nothing has to be bypassed. The
  close second.

## Hands-on comparison

The same editor was built three times on the same document and registry (a `math/add`, two cylinders and a union,
with positions from `view`): React Flow 13.0.3 with React 18, Rete 2.0.6 with its React renderer, and the LiteGraph
fork 0.17.2 with no framework. Each one draws the document, refuses a wire from a solid to a number input, writes a
new wire back as `"@size.value"`, writes a moved node's position into `view`, and edits literal inputs in place. All
three passed the same scripted test in Chromium (Playwright: drag a wrong wire, drag a right one, move a node, read the
JSON back). Bundles are esbuild, minified, React included.

| | React Flow | Rete v2 | LiteGraph (no framework) |
|---|---|---|---|
| Lines for the same editor | 45 | 70 | 51 |
| Objects to wire up | one `<ReactFlow>` component with props | editor, area, connection and render plugins, two presets, two event pipes | graph, canvas, one class per node type |
| Needs React | yes | yes (or Vue, Angular, Svelte); also `styled-components` | no |
| Packages installed | 25 (9 MB) | 24 (14 MB) | 1 (4 MB) |
| Bundle, gzipped | 136 KB | 81 KB | 88 KB |
| Default look | bare: handles over labels until styled | finished (the classic preset) | finished, dark, canvas |
| Node body | any React component (sliders, previews) | controls from the preset, or React components | widgets drawn on canvas |
| Wire type check | one `isValidConnection` function | a `connectioncreate` pipe | built in, by port type name |
| Snags met | version 13 (released 2026-11-23) removed `applyNodeChanges`, which its own docs still use | inputs with a control hide their label until wired | an input keeps its widget when wired, unless removed by hand |
| Releases | 2026-11 (fast-moving) | core 2025-06, renderers 2026-07 | fork frozen 2025-08; the live copy is in a GPL project |

What this says:

* **Rete is not the simpler one in practice.** Its model reads simply (nodes, sockets, connections), but using it
  means assembling plugins and presets and writing event pipes, and it needs React (or another framework) all the
  same, plus `styled-components`. React Flow is one component: the document goes in as nodes and edges, events come
  out as callbacks.
* **React Flow's cost is styling.** Its nodes are bare until we style them, which we would do anyway for sliders,
  previews and verdict badges. It is also the larger bundle, and it moves fast: version 13 broke an example in its
  own docs.
* **LiteGraph is the only way to have no framework**, and was as short to write. Against it: the canvas makes rich
  node bodies harder, its format and the maintained code sit in a GPL project, and the MIT fork is frozen, so we would
  own it.

## If Rete is chosen

How to use it well:

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

| Need | React Flow | Rete v2 | Baklava | LiteGraph | behave-graph |
|---|---|---|---|---|---|
| Our JSON stays the source of truth | 3 (pure view) | 3 (no format) | 1 (its own state) | 1 (its own, positional) | 2 (similar, but its own) |
| Content-hash caching, determinism, worker | 3 (ours, nothing to bypass) | 3 (its engine left out) | 1 (replace its engine) | 1 (replace its loop) | 1 (replace its engine) |
| Rich node bodies: sliders, previews, verdicts | 3 (DOM components) | 3 (DOM components) | 2 (Vue components) | 2 (drawn on canvas) | 0 (no editor) |
| Simplicity in use (measured, see above) | 3 (one component, 45 lines) | 2 (plugins, presets, pipes; 70 lines) |
| Hierarchy (groups) | 2 (visual; semantics ours) | 2 (scopes plugin; drill-down ours) | 3 (graph templates) | 2 (subgraphs) | 0 |
| Ready-made math nodes usable as is | 0 | 0 | 0 | 1 (only in its loop) | 1 (only in its engine) |
| Maintenance, 2026 | 3 | 2 | 2 | 1 | 0 |
| License fit with this MIT library | 3 | 3 | 3 | 2 (fork under GPL) | 3 |
| Fits the build (esbuild, no framework today) | 2 (esbuild compiles TSX; adds React) | 2 (adds React or Svelte) | 2 (adds Vue) | 3 (one file) | 3 |

## The document

> This section is the design that led to the format. The format as built and settled, with its stability rules, is
> [docs/formats.md](formats.md); where the two differ, formats.md is right. In particular there is no `units` key
> (millimetres always), parameters are `number` nodes rather than a `parameters` block, and groups are not built yet.

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

## What is built

`Graph` (`src/model/Graph.ts`) and the editor (`editor/`, `npm run editor`) implement the first and fourth steps of
the plan below, without groups or lists yet.

```js
import { Graph } from "verb-nurbs-ts";

const doc = { version : 2, nodes : {
    h : { type : "number", in : { value : 24 } },
    box : { type : "primitive/box", in : { width : 60, depth : 40, height : "@h" } },
    coneShape : { type : "primitive/cone", in : { radius : 13, height : "h + 10", top_radius : 6 } },
    cone : { type : "transform/move", in : { of : "@coneShape", z : -5 } },
    cut : { type : "boolean/difference", in : { from : "@box", minus : "@cone" } },
    round : { type : "finish/round", in : { of : "@cut", radius : 3, edges : "box.*|box.*" } },
}, outputs : { solid : "@round" } };

const g = new Graph();
g.evaluate( doc ).nodes;      // { h: "parameter", box: "built", coneShape: "built", ... }
doc.nodes.box.in.width = 80;
g.evaluate( doc ).nodes;      // box, cut and round "built"; coneShape and cone "cached"
Graph.compile( doc );         // the version 1 model document it runs
```

* **Node types** (`Graph.REGISTRY`, 100 of them): `number` and `expression`; the math nodes `math/add`, `sub`, `mul`,
  `div`, `min`, `max`, `pow`, `sqrt`, `abs`, `sin`, `cos`, `rad`, `mix`, `clamp`; one `primitive/<shape>` per catalogue
  entry (`Catalog.ENTRIES`), with the catalogue's parameters as ports (`top radius` becomes the port `top_radius`);
  `transform/move`, `rotate`, `scale`; `boolean/union`, `intersection`, `difference`; `finish/round` (edge patterns,
  comma separated; circular, curvature or chamfer) and `finish/shell`; the freeform nodes `freeform/revolve`,
  `freeform/pipe` and `freeform/vessel`.
* **Freeform nodes** take *function* ports: an expression of `t`, from 0 to 1, and of number nodes. `freeform/revolve`
  turns a radius function about z (circles at `samples` evenly spaced values of t, lofted, the model's `revolve`);
  `freeform/pipe` runs a round tube along the smooth curve through (x(t), y(t), z(t)) (the model's `pipe`). Both
  are exact NURBS. Each sample compiles to the expression with `t` replaced by its value, so the number nodes stay
  parameters of the model: `"a + 2 * sin(pi * t)"` at t = 0.5 is `"(a + 2 * sin(pi * (0.5)))"`. `samples` is a whole
  number written in the document, since it decides how many points the model has. Inside a function, `t` hides a
  number node with the id `t`.
* **Vessels** (`freeform/vessel`) take *profile* ports: a half-section as an archaeologist draws it, points
  `"r z; r z; ..."` in millimetres from the base up. The outer profile is turned about z (the model's `revolve`), less
  the cavity (from its floor to above the rim, so the mouth is open) and the hollow under a foot, each a revolve of its
  own under the node's id (`v/body`, `v/cavity`, `v/foot`). `scripts/aippd.mjs` makes such vessels from AIPPD, the
  Ancient Italy Pottery Profiles Dataset (Cardarelli 2024), and wrote the editor's pottery collection
  (`editor/samples/ceramics`, with its sources).
* **How it compiles.** Number and math nodes become model parameters named by their ids, so an expression may name
  them (`"h + 10"`) and a wire to one (`"@h"`) is just its name. Solid nodes become features with the same ids, so
  persistent face names are the node ids (`box.+z`, `round(box.-x|box.-y)`, `cone/coneShape.side`).
  `primitive/box` and `primitive/cylinder` compile into the model's own `box` and `cylinder` features, which `shell`
  can offset; the other primitives into `primitive` features.
* **What it refuses**, naming the node and port: an unknown type or port, a reference to a missing node or output,
  a number wired into a solid input or the reverse, an unconnected solid input, an expression naming something that
  is not a number node, a number node whose id is a function or constant of `Expr` (`pi`, `round`), and cycles.
* **The editor** opens with the art nouveau vase; **Open a sample** offers the freeform showcases of `editor/samples`
  (the vase, a vine column, a fern sprout, a tulip lamp) and mechanisms from the test fixtures (the crank, three of
  the 507 project's parts). Nodes without a place in `view` are laid out in columns by the longest chain of wires
  leading to them, and the 3D view frames each document it opens. **Shelf** shows every output at once, side by
  side at their true sizes, in the rows and columns a document gives in `view.shelf` (`editor/shelf.ts`; otherwise
  a square grid), with each piece's documentation (`meta.items`) on hover; the worker sends each piece as it is
  built and drops a shelf when an edit arrives. **Large view** widens the 3D view. A palette adds any node type; wires are typed (orange for numbers, grey for
  solids) and a wrong one cannot be drawn; number inputs take a slider, a value or an expression; **Show** picks the
  solid on display; the side panel has the 3D view, the verdict, the volume, which nodes were rebuilt and which came
  from the cache, and the graph and model documents as JSON. **Save** and **Open** read and write the graph file.
  Evaluation runs in a worker with one `Graph`, so its cache lasts the session.
* **Several outputs**, by name, each a part (`{ "flywheel": "@flywheel", "connecting-rod": "@rod" }`); `evaluate`
  and `compile` take `{ output, set }` to pick one and to set number nodes from outside. The editor's **Make output**
  adds or removes a solid node from them, and **Show** displays any solid node without changing the outputs.
* **Components**: any graph document can be used as a node of type `component` (`use`, an optional pinning `hash`,
  its number nodes as inputs, its outputs as outputs, names nested under the instance's id); this is the design's
  group, specified in docs/formats.md.
* **Undo and redo** (`editor/history.ts`): a snapshot of the graph document after each edit, so an undone document is
  byte for byte the earlier one, and the evaluator's cache rebuilds nothing for it. Everything one action does (a
  node deleted with its wires) is one step, a slider drag is one step while it keeps moving (`COALESCE_MS`), moving
  nodes and Open and New are steps too, and the last 200 are kept. Ctrl+Z or Cmd+Z, and Shift+Ctrl+Z, Cmd+Shift+Z or
  Ctrl+Y, or the toolbar's buttons; a text field keeps its own undo while it has the focus.
* **Not yet:** components in the editor, lists and lacing, curve and surface nodes (`Nodes`, `Make`), and
  renaming a node on the canvas (edit `label` in the file). Curves are not yet wires: a pipe's curve lives in its own
  node, so two nodes cannot share one. A pipe's radius is constant along it, and `finish/shell` cannot yet offset a
  revolve (the samples hollow the vase with a second revolve instead). Vessels have no handles or decoration yet:
  AIPPD's profiles are drawn without them. On the shelf, the labels of narrow columns can crowd each other.

## Where it lives

* The registry, the version 2 document and the evaluator: `src/model/` (the `model` layer, beside `Model`), with no
  new runtime dependency.
* The editor: a new app beside `playground/` and `viewer/` (`editor/`), built with esbuild into one HTML file like
  them. React and the canvas library are its dev dependencies only; the published library still depends on `cdt2d`
  alone.

## Plan

1. (Built, without curves and lattices.) Node registry and version 2 document in `src/model/`, with the version 1 documents of `docs/model.md` passing
   unchanged; nodes for the catalogue, `Nodes`, curves (`Make`), transforms, Booleans, round, shell, lattice, math.
   Tests: the same document gives the same hashes and the same solid; an edit rebuilds only downstream nodes; a group's
   faces keep their names.
2. Groups, with recursion refused and names nested.
3. Lists and lacing.
4. (Built.) The editor: React Flow, the registry as the palette, the viewport and verdict from the
   worker, the document as the file (open, save, undo by document snapshots).
5. Data trees, fields (per-vertex functions in Blender's sense, for growth and lattices), and loops (zones), as the
   models ask for them.

## Known limits of this choice

* React Flow draws nodes as DOM elements: a few hundred nodes stay smooth, thousands do not. LiteGraph's canvas scales
  further. Groups keep each canvas small, which is the answer here.
* React Flow moves fast: version 13 (November 2026) removed helpers its own docs still use. The editor pins 13.0.3.
  Since the document is ours and React Flow only the view, a change of canvas would rewrite `editor/main.tsx`, not
  the format or the evaluator.
* React is the editor's framework; it is a dev dependency of the editor only, never of the library.
