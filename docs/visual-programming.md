# Visual programming: choosing the foundation

A node editor for generative design, on top of the kernel: boxes on a canvas, wires between them, sliders on the
inputs, a solid in the viewport. This page reviews what exists (the CAD node systems, the literature, and the open
source JavaScript libraries), says what each one could give us, and recommends what to adopt and what to keep as
ours. It is a decision record: nothing here is built yet.

## Recommendation in short

1. **The document and the evaluator stay ours.** The graph is a JSON document that extends the `Model` document
   (`docs/model.md`): parameters, nodes keyed by id, inputs that name the node they come from, an output. A version 1
   model document stays a valid graph. Evaluation extends `Model`'s content-hash cache, so an edit rebuilds only what
   is downstream of it, the same document always gives the same result bit for bit, and persistent face names
   survive. No library offers this, and every library's engine would have to be bypassed to get it.
2. **The editor canvas comes from a library: React Flow (`@xyflow/react`, MIT).** It is the most used and most
   actively maintained of the candidates, it is TypeScript, its nodes are DOM elements (sliders, previews and
   verdict badges are plain components), and its `{ nodes, edges }` state maps one to one onto our document. It is a
   view: the document is the truth, the editor's nodes and edges are derived from it and written back to it.
   Rete.js v2 is the runner-up (see the comparison).
3. **Hierarchy is the document calling itself.** A graph document with parameters and an output is a node: a
   `group` node that runs another document, with its parameters as the node's inputs. This is Houdini's digital
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
  engine and format, which leaves only the Vue editor: React Flow does that part better.
* **Rete.js v2** is clean, typed, modular and framework-agnostic in its core, with a dataflow engine that caches per
  node. It has no saved format (by design), its engine's cache is keyed by node id and cleared by hand (not by
  content), and its renderer plugins still need React, Vue, Angular or Svelte. It is a good second choice, and the
  one to pick if the editor must not depend on React.
* **React Flow** does one thing, the canvas, and does it best: it is the most used node canvas in JavaScript, released
  three days before this was written, MIT, TypeScript, with DOM nodes that can hold anything. It has no engine and no
  format, and here that is an advantage: ours are better suited to geometry, and nothing has to be bypassed.

## Comparison for this project

Scored 0 (none) to 3 (good) against what this project needs.

| Need | React Flow | Rete v2 | Baklava | LiteGraph | behave-graph |
|---|---|---|---|---|---|
| Our JSON stays the source of truth | 3 (pure view) | 3 (no format) | 1 (its own state) | 1 (its own, positional) | 2 (similar, but its own) |
| Content-hash caching, determinism, worker | 3 (ours, nothing to bypass) | 2 (bypass its engine) | 1 (replace its engine) | 1 (replace its loop) | 1 (replace its engine) |
| Rich node bodies: sliders, previews, verdicts | 3 (DOM components) | 3 (DOM components) | 2 (Vue components) | 2 (drawn on canvas) | 0 (no editor) |
| Hierarchy (groups) | 2 (visual; semantics ours) | 2 (scopes plugin) | 3 (graph templates) | 2 (subgraphs) | 0 |
| Ready-made math nodes usable as is | 0 | 0 | 0 | 1 (only in its loop) | 1 (only in its engine) |
| Maintenance, 2026 | 3 | 2 | 2 | 1 | 0 |
| License fit with this MIT library | 3 | 3 | 3 | 2 (fork under GPL) | 3 |
| Fits the build (esbuild, no framework today) | 2 (esbuild compiles TSX; adds React) | 2 (adds a framework) | 2 (adds Vue) | 3 (one file) | 3 |

## The document

Version 2 extends version 1; every version 1 document is a version 2 document. The node types below are
illustrative.

```json
{
  "version": 2,
  "parameters": {
    "turns": { "value": 3, "min": 1, "max": 8, "step": 1 },
    "r": 4
  },
  "nodes": {
    "pts":    { "type": "curve/helix-points", "turns": "turns", "radius": 30, "pitch": 12 },
    "rail":   { "type": "curve/interpolate", "points": "pts", "degree": 3 },
    "spring": { "type": "nodes/pipe-solid", "curve": "rail", "radius": "r", "caps": "round" },
    "base":   { "type": "primitive", "shape": "cylinder", "values": { "radius": 35, "height": 4 } },
    "join":   { "type": "union", "of": ["base", "spring"] },
    "foot":   { "type": "group", "use": "rounded-foot", "inputs": { "of": "join", "radius": "r / 2" } }
  },
  "output": "foot",
  "groups": {
    "rounded-foot": { "version": 2, "parameters": { "radius": 1 }, "inputs": { "of": "solid" }, "nodes": { }, "output": "..." }
  },
  "view": {
    "nodes": { "pts": { "x": 0, "y": 0 }, "rail": { "x": 220, "y": 0 } },
    "notes": [ { "x": 0, "y": -80, "text": "spring on a disc" } ]
  }
}
```

* **Nodes keyed by id**, as features are now (`features` stays accepted as a synonym). Ids are what persistent names
  are built from, so they are chosen by the author, not uuids.
* **Inputs live on the consumer.** A port's value is a literal, an expression over the parameters, or a reference to
  another node: `"rail"` (its only output) or `"rail.out"` (a named output). Which it is follows from the port's type
  in the registry, as `of` and `radius` are told apart today. Edges are not stored; the editor derives them. One
  fact, stored once.
* **Parameters** are a number, an expression, or `{ value, min, max, step }` (a slider). They are the document's
  inputs when it is used as a group.
* **Groups** are documents. A `group` node names one (`use`), gives its parameters and solid inputs, and returns its
  output. Its faces are named `<group node>/<inner name>`, the same rule as `transform`. Groups may sit in the file or
  be referenced by path, and may nest; recursion is refused, like parameter cycles.
* **`view` is ignored by the hash.** Moving a node or writing a note does not rebuild anything, and a review diff
  shows layout and meaning apart (Dynamo's split).

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
  them. React and `@xyflow/react` are its dev dependencies only; the published library still depends on `cdt2d`
  alone.

## Plan

1. Node registry and version 2 document in `src/model/`, with the version 1 documents of `docs/model.md` passing
   unchanged; nodes for the catalogue, `Nodes`, curves (`Make`), transforms, Booleans, round, shell, lattice, math.
   Tests: the same document gives the same hashes and the same solid; an edit rebuilds only downstream nodes; a group's
   faces keep their names.
2. Groups, with recursion refused and names nested.
3. Lists and lacing.
4. The editor: React Flow canvas, the registry as the palette, the viewport and verdict from the worker, the document
   as the file (open, save, undo by document snapshots).
5. Data trees, fields (per-vertex functions in Blender's sense, for growth and lattices), and loops (zones), as the
   models ask for them.

## Known limits of this choice

* React Flow draws nodes as DOM elements: a few hundred nodes stay smooth, thousands do not. LiteGraph's canvas
  scales further. Groups keep each canvas small, which is the answer here.
* React Flow's sub-flows group nodes on screen only; the meaning of a group is ours to implement.
* Choosing React for the editor is a choice of framework for every editor panel. Rete.js with its Lit or Svelte
  renderer is the way out if that matters more than React Flow's maturity.
