# Document formats

Other projects store their designs in two JSON formats, so these are the library's contract with them. This page is
the reference: what each format holds, what it means, and what may change. Both formats are checked by schemas in
`schema/` and by `test/testFormats.cjs`.

| Format | Version | Who writes it | Schema | Code |
|---|---|---|---|---|
| Graph document | 2 | people, in the node editor or by hand | `schema/graph.v2.schema.json` (made from the registry) | `Graph` (`src/model/Graph.ts`) |
| Model document | 1 | `Graph.compile`, or by hand | `schema/model.v1.schema.json` (written by hand) | `Model` (`src/model/Model.ts`, docs/model.md) |

**Store the graph document.** It is the source. A model document is what one output of a graph compiles to, the way an
object file comes from source code: a project may keep it as a cache or for review, but should regenerate it from the
graph. Model documents written by hand stay supported (they are what `docs/model.md` describes).

## Vocabulary

The words below have one meaning each, in this repository and in projects built on it. They follow STEP (ISO 10303,
whose product structure separates a definition from its occurrences), the mechanical CAD systems (Onshape, Fusion)
and USD. The key distinction is between a **definition** (what a thing is) and an **instance** (one place it is used).

| Term | Meaning | Elsewhere |
|---|---|---|
| **Document** | one JSON file: a graph document or a model document | |
| **Node** | one operation in a graph document, of a type from the registry | Grasshopper component, Dynamo node |
| **Feature** | a solid node once compiled into a model document | history-based CAD feature |
| **Body** | one closed solid, the result of a solid node | Onshape part, Fusion body |
| **Part** | a body made as one piece, exported by name from a document (an output), with a role and a process | STEP product (a part), 507 manifest `parts` |
| **Region** | a named set of a part's faces, chosen by face-name patterns, for a colour, a material or an engraving | 507 manifest `regions` |
| **Imported part** | a part whose geometry is a mesh file pinned by its hash: no named faces, so no fillet or Boolean on it | reference geometry |
| **Standard part** | a part that is bought, not made (screw, washer, standoff): listed in the bill of materials, drawn from a catalogue | purchased part, 507 `hardware` |
| **Parameter** | a number node a document exposes to whoever uses it | Onshape configuration input, Houdini promoted parameter |
| **Component** | a document used by other documents: its parameters are its inputs, its outputs are parts or placed instances | Fusion component, Grasshopper cluster, Houdini digital asset |
| **Instance** | one use of a component inside another document, with its own parameter values and placement; names nest (`crank1/rod`) | STEP occurrence, USD instance |
| **Placement** | the rigid motion (rotation, then translation) that puts an instance or a part where it goes | STEP placement, glTF node transform |
| **Assembly** | a component whose outputs are placed instances, adding no geometry of its own; a **sub-assembly** is one used as an instance | STEP assembly |
| **Variant** | a named set of parameter values of a component | Onshape configuration, USD variant, 507 `variant` |
| **Library** | a folder of components, referred to by path and pinned by content hash | |
| **Joint** | (later) a constraint between two instances (revolute, slider, gear ratio) that drives motion | Onshape mate, Fusion joint |
| **Make check** | a part checked for manufacture: closed, oriented, walls, machine (the verdict) | |
| **Fit check** | (later) an assembly checked for clearance and interference between its instances | interference detection |

Today a document has nodes, parameters (its `number` nodes, set from outside with `set`), parts (its outputs), and
instances of components (below). Placements on outputs, assemblies, variants, regions, imported parts and joints are
the planned additions, named here first so that they keep these names.

## Units

Lengths are in millimetres and angles in degrees, everywhere, with no unit field and no conversion. The
exceptions are the math nodes `math/sin` and `math/cos` and the expression functions `sin` and `cos`, which take
radians as in every programming language (`math/rad` and `rad()` convert). Volumes are reported in mm³.

## Graph document, version 2

```json
{
  "version": 2,
  "meta": { "name": "Crank and connecting rod" },
  "nodes": {
    "crank":     { "type": "number", "in": { "value": 20 }, "label": "Crank radius" },
    "pinR":      { "type": "number", "in": { "value": 2.5 } },
    "clearance": { "type": "number", "in": { "value": 0.2 } },
    "disc":      { "type": "primitive/cylinder", "in": { "radius": 35, "height": 6 } },
    "boreShape": { "type": "primitive/cylinder", "in": { "radius": "pinR + clearance", "height": 8 } },
    "bore":      { "type": "transform/move", "in": { "of": "@boreShape", "z": -1 } },
    "flywheel":  { "type": "boolean/difference", "in": { "from": "@disc", "minus": "@bore" } }
  },
  "outputs": { "flywheel": "@flywheel" },
  "machine": "fdm",
  "view": { "nodes": { "crank": { "x": 0, "y": 0 } } }
}
```

`test/fixtures/formats/` has complete examples: `cone-cut.graph.json` (the editor's sample) and `crank.graph.json`
(two printed parts with fit clearances), each with the model documents it compiles to.

### Top level

| Key | Required | Meaning |
|---|---|---|
| `version` | yes | `2` |
| `nodes` | yes | the nodes, by id |
| `outputs` | yes | the solids the document exports, by name; at least one |
| `meta` | no | about the document: `name`, `description`, anything else; never read by the evaluator |
| `machine` | no | the machine every output is checked against for its verdict: a key of `Makeable.MACHINES` (`"fdm"`, `"sla"`, ...) or a machine object |
| `view` | no | the editor's state: `nodes` (positions by id), `show` (the node on display), anything else |

Any other top-level key is refused. `meta` and `view` never change what is built: editing them rebuilds nothing.

### Nodes

A node is `{ "type": ..., "in": { port: value }, "label": ... }`.

* **The id** (the key in `nodes`) is a name: letters, digits and `_`, not starting with a digit. It is permanent:
  number nodes are named by it in expressions, and the faces a solid node makes are named after it (`disc.top`,
  `round(box.-x|box.-y)`), which is what edge and face patterns select. Number node ids must not be an expression
  function or constant (`pi`, `sin`, `round`).
* **`type`** is a key of `Graph.REGISTRY`. The schema lists every type with its ports, kinds and defaults.
* **`in`** holds input values by port. A port left out takes its default. A port the type does not have is refused.
* **`label`** is free text for the canvas. It is never used in names, so renaming a node on screen changes no face
  name.

An input value is one of:

| Port kind | Value |
|---|---|
| number | a number (`24`); an expression over number nodes (`"h + 10"`, `"@h * 2"`); or a wire from a number node (`"@h"`) |
| solid | a wire from a solid node, `"@cut"`; required |
| choice | one of the type's options (`"circular"`) |
| text | text that is not an expression: edge or face patterns, comma separated (`"box.*\|box.*"`) |
| function | an expression of the variable `t` (0 to 1) and of number nodes, sampled by the node (`"a + 2 * sin(pi * t)"`); the freeform nodes' radius and coordinates |
| profile | a half-section, points `"r z; r z; ..."` in millimetres from the base up (`freeform/vessel`); empty for none where the port allows it |
| outline | a planar region as JSON, `{ "outer": path, "holes": [path, ...] }` (`profile/extrude`; see Profiles below) |

#### Profiles

An outline is 507's profile JSON, taken as it is:

```json
{ "outer": { "kind": "path", "start": [0, 0], "segments": [
    { "type": "line", "to": [30, 0] },
    { "type": "arc", "via": [38, 10], "to": [30, 20] },
    { "type": "cubic", "c1": [20, 26], "c2": [10, 26], "to": [0, 20] },
    { "type": "line", "to": [0, 0] } ] },
  "holes": [ { "kind": "circle", "center": [12, 10], "r": 4 } ] }
```

A path starts at `start`, and each segment runs from where the last one ended. A `line` goes to `to`. An `arc` goes
through `via` to `to`, as a circle through three points. A `cubic` is a Bézier curve with control points `c1` and `c2`.
The last segment ends at `start`. A `circle` has a `center` and a radius `r`. Paths can run either way round. Holes lie
inside the outer path and don't overlap. Coordinates are millimetres in the x, y plane.

`profile/extrude` makes the solid between `z` and `z + height` over the outline, with every face exact: lines, arcs
and circles are rational, cubics are Bézier curves, and the sides are ruled surfaces over them (`Extrusion`). Its
faces are `bottom`, `top`, `outer.k` for the outer path's segment k, and `hole{i}.k` for hole i's, both counted from
0, so `gear.outer.12` or `plate.hole0.0`. Names follow the segments as written, whichever way round the path runs, so
they stay put as parameters change. The solid is a shell of trimmed faces, an operand of any Boolean. A round over an
extrusion is not built yet: rounding the edges of a trimmed solid is step A5 of docs/exact-booleans.md.

`profile/revolve` turns the same outline, drawn in the (r, z) half-plane (x is the radius, y the height), a full turn
about the z axis (`Lathe`; #87): lines become planes, cylinders and cones, arcs spheres and tori, cubics their exact
surfaces of revolution, and a circle a torus (a belt groove to subtract). A segment along the axis (x = 0 at both ends)
is the axis itself and makes no face; a path off the axis makes a solid with a hole through it (a pulley and its
bore). Faces are `outer.k` for segment k. `degrees` must be 360 for now, and the outline has no holes (revolve each
and subtract it): a part turn needs its end caps, which are not built yet.

A wire is `"@id"` (the node's first output) or `"@id.port"`. Wires are typed: a number cannot go into a solid input or
the reverse. Number nodes (`number`, `expression`, the `math/` nodes) form an acyclic graph of parameters; a cycle is
refused.

### Outputs

`outputs` maps names to wires from solid nodes: `{ "flywheel": "@flywheel", "connecting-rod": "@connectingRod" }`.
Output names may also hold `-`, to match part names elsewhere, since they never appear in expressions. The first
output is the default. Every output is checked whichever one is evaluated, so a broken output is noticed even when
nobody asks for it.

### Evaluating

```js
import { Graph } from "verb-nurbs-ts";

const g = new Graph();                                    // keeps its cache between calls
g.evaluate( doc );                                        // the first output
g.evaluate( doc, { output : "connecting-rod" } );         // another
g.evaluate( doc, { output : "connecting-rod", set : { rod : 90 } } );  // a number node set from outside
g.evaluate( doc, { output : "@bar" } );                   // any solid node, to preview it
g.evaluate( doc, { mesh : "print" } );                    // with an export mesh within 0.02 mm (r.export)
Graph.compile( doc, { output : "flywheel" } );            // the model document, without building it
```

`set` replaces the value of `number` nodes by id (any other node is refused) without changing the document. It is how
a project passes its own parameters (a 507 movement's `crank`, `rod`) into a part. Because evaluation is cached by
content, a part that does not read the parameter that changed is not rebuilt, and evaluating several outputs of one
document shares every feature they have in common.

`mesh` asks for an export mesh besides the result, tessellated from the result's exact shell within a tolerance
([booleans.md, Export mesh](booleans.md#export-mesh)): `"print"` (0.02 mm), `"view"` (0.1 mm, normals within 20°),
`{ chordal, angle?, maxEdge? }`, or `"analysis"` for the Boolean's own dense mesh as it is. It is an evaluation option,
not part of the document, so one document gives a print mesh and a viewer mesh. `r.export` holds the `mesh` (a closed
2-manifold), `faceNames` (the persistent name of each triangle's face), `faceOf` (the index of that face in
`r.result.faces`, which `Inspect.brep( r.result, title, { mesh : r.export } )` draws on), the `tolerance` and the
`deviation` measured.
The graph keeps each result's shell and meshes, so asking again, or for another tolerance, does not rebuild the shell.
A lattice output has no exact shell: its export is the lattice mesh itself (`r.lattice.mesh`, at the lattice's own
grid step), with every triangle named `lattice` and no deviation, whatever `mesh` asks for.

#### A face name per triangle

Every triangle a graph evaluation returns has the persistent name of the face it lies on. This is a contract: 507
colours, selects and reports parts by these names, so they are tested on every fixture (`test/testFaceNames.cjs`).

* **Where.** For the export mesh, `r.export.faceNames[t]` is the name of triangle `t` of `r.export.mesh`. For the
  analysis mesh, it is `r.faceNames[r.result.faceOf[t]]`. `r.faceIndex[name]` is the face a name stands for. No two
  faces of a result share a name.
* **What.** The grammar is [docs/model.md, "Persistent names"](model.md): `<feature>.<face>` for a primitive's face,
  behind transforms `<transform>/.../<feature>.<face>`, `round(<face>|<face>)` for a fillet,
  `corner(<face>|<face>|<face>)` for a corner, and `#1`, `#2`, ... for the pieces of one face a Boolean split.
* **Through components.** Every feature id of an instance carries the instance's id first ([Components](#components)):
  the connecting rod's bar in `crank2`, moved by `rod2`, is `rod2/crank2/bar/crank2/barShape.+x`. Two instances of one
  component never share a name.
* **Stable.** A name comes from the feature history, not from indices: changing a parameter keeps every name that still
  stands for a face. A lattice output's triangles are all named `lattice`.

Evaluation is deterministic: the same document, `set` and `mesh` give the same bytes (every vertex to the last bit,
the triangles and the face names) in every run, whatever the graph evaluated before, on every machine and Node version
CI covers. Nothing in the library draws random numbers: where an algorithm only needs to avoid a symmetric split, it
takes a value hashed from its inputs (`src/core/Jitter.ts`). `test/testDeterminism.cjs` builds ~92's crank and rod and
507's slotted block in two processes and compares them with hashes checked in (`test/fixtures/mesh-hashes.json`); a
change that moves a mesh on purpose regenerates them with `node test/support/meshHash.cjs`.

#### Failures

A document that cannot be evaluated throws a `GraphError` (exported with `Graph`), whose message is written for a
person and whose fields say where, for a caller to report (`test/testGraphErrors.cjs`):

| Field | |
|---|---|
| `stage` | `"document"`: the document as a whole (its version, a top-level key, an output, a `set`); `"node"`: a node's own definition (its type, a port, a wire, an expression); `"build"`: building the solid failed |
| `node` | the node at fault, as a path of ids through component instances: `crank1/disc` is the node `disc` inside the instance `crank1`; an instance itself, for its own inputs or a component pinned at another hash |
| `type` | the node's type (`primitive/cylinder`, `component`) |
| `port` | the port at fault, for a node's failure about one |
| `output` | the output at fault, for a document's failure about one |
| `cause` | for a build, the error from inside the kernel |

```js
try { g.evaluate( doc, { resolve } ); }
catch (e) { if (e instanceof GraphError) report( e.node, e.type, e.message ); }
```

A model document's own failures are `ModelError`s, with the `feature` at fault and its `type`.

### Components

Any graph document is a component: another document uses it through a node of type `component`, one instance per
node.

```json
"nodes": {
  "throw":  { "type": "number", "in": { "value": 25 } },
  "crank1": { "type": "component", "use": "crank.graph.json", "hash": "ab48366aa4f650ee" },
  "crank2": { "type": "component", "use": "crank.graph.json", "hash": "ab48366aa4f650ee",
              "in": { "crank": "@throw", "rod": "throw * 3" } },
  "rod2":   { "type": "transform/move", "in": { "of": "@crank2.connecting-rod", "y": 60 } }
},
"outputs": { "flywheel-1": "@crank1.flywheel", "rod-2": "@rod2" }
```

(`test/fixtures/formats/crank-pair.graph.json`.)

* **`use`** names the component's document. The library never reads files itself: the caller passes
  `resolve( use, from )` in the options, which returns the document (`from` is the `use` of the document the node is
  in, `null` at the top, so relative paths can be resolved). The same document may be used by any number of instances.
* **`hash`** (optional, recommended for anything shared) pins the component's content: `Graph.hash( doc )`, which
  leaves out `meta` and `view`. If the component changed since, the instance is refused with both hashes in the
  message, so a change is noticed and accepted on purpose (update the hash), never picked up silently.
* **Inputs are the component's parameters**: its `number` nodes, by id. An instance sets them in `in` like any number
  input (a literal, an expression over its own document's number nodes, or a wire); those it leaves out keep the
  component's values.
* **Outputs are the component's outputs**, by name: `"@crank2.connecting-rod"` is a solid wire like any other, and can
  be an output of the using document (`"flywheel-1": "@crank1.flywheel"`).
* **Names nest.** Each feature of an instance is named after the instance first: `crank1/disc`, so its faces are
  `crank1/disc.top`, and through a transform every feature id on the path carries it (`part/cone/part/coneShape.side`).
  Edge and face patterns inside the component are renamed the same way, so a component's own fillets select the same
  edges in every instance. The instance's parameters become `crank1__crank` in the compiled model document.
* **What is refused:** a component that uses itself (directly or not), a `use` with nothing to resolve it, a pinned
  hash that does not match, an input or an output the component does not have, `use` or `hash` on another node, and
  a number node whose id is already an instance's compiled parameter name (`crank1__rod`).
* **Limits.** A component whose output is a round can be moved, rotated and uniformly scaled, but not yet combined
  in a further Boolean, since a round is the last feature of a model (docs/model.md, "Limits", says why and what
  it would take); a lattice cannot be moved either. The node editor shows
  components' outputs in files it opens but cannot open their documents yet.

## Model document, version 1

The compiled form, and the format of `docs/model.md`, which explains each feature type. In short:

| Key | Required | Meaning |
|---|---|---|
| `version` | yes | `1` |
| `parameters` | no | named numbers or expressions over each other |
| `features` | yes | features by id: `box`, `cylinder`, `pipe`, `revolve`, `extrude`, `primitive`, `transform`, `union`, `intersection`, `difference`, `round`, `shell`, `lattice` |
| `output` | yes | the feature the model's solid is |
| `machine` | no | as in a graph |
| `certify` | no | prove every Boolean intersection complete (slower) |

A graph compiles to it this way: number nodes become parameters with the node's id; solid nodes become features with
the node's id; `primitive/box` and `primitive/cylinder` become the native `box` and `cylinder` features (placed on
z = 0, centred on the z axis), the other primitives `primitive` features; an expression input is kept in parentheses
(`"(h + 10)"`). The checked-in `*.models.json` fixtures lock this down: a change to the compiled form fails a test,
because it changes what saved files build.

## Stability

These rules let another project depend on the formats by path or by version and know what may break.

* **Within a version, changes only add.** A new node type, a new optional port, a new optional top-level key, a new
  option in a choice, a new output kind: allowed. Removing or renaming a node type or port, changing a port's kind,
  a default value, an option, or what a node builds: not allowed. Such a change needs a new version.
* **Defaults are part of the format.** A port left out takes its default, so changing a default changes saved
  files. That includes the catalogue's parameter defaults (`Catalog.ENTRIES`), which the primitive nodes take as
  theirs.
* **The ratchet.** `schema/graph.v2.schema.json` is generated from the registry (`npm run build && npm run schema`)
  and checked in. A test requires it to match the registry, and another requires every type, port, kind, option and
  default in it to be unchanged, so the file can only grow. Editing it by hand to get past that test is the same as
  lowering a gate (AGENTS.md).
* **A new version comes with an upgrade.** `Graph.evaluate` keeps reading the older versions it supports (model
  documents version 1 today), and a version 3 would come with a function that rewrites version 2 documents into it.
  A reader refuses a version it does not know rather than guessing.
* **Reading is strict.** Unknown keys at the top level, unknown node types and unknown ports are refused, not
  ignored, so a typo never builds something else silently. `meta` and `view` are the places for free-form data.

## Using the formats from another project

* Validate files without the kernel with any JSON Schema (draft 2020-12) validator. The schemas ship in the package
  (`verb-nurbs-ts/schema/graph.v2.schema.json`). With Ajv, use `ajv/dist/2020` with `allowUnionTypes`.
* Validate and build with the kernel through `Graph` as above. Linking the repository by path works while both move
  together; the fixtures and schema tests here are what keeps that link safe.
* A `Graph` keeps everything it has built for as long as it lives, which is what makes switching outputs and
  parameters cheap. A batch build over many documents should use a new `Graph` per document, or per few, to bound
  memory.
* Motion, assemblies, bills of materials and hardware stay with the project: a graph describes the parts, and a
  project places them. Parts are built once and moved, never rebuilt per frame.

## Not yet in the format

These will be added without breaking version 2 documents:

* placements on outputs, and assemblies of placed instances, with a fit check;
* variants (named sets of a component's parameter values);
* imported parts (meshes pinned by hash);
* coloured or multi-material regions of a part (likely face-name patterns per output);
* patterns (circular and linear), revolving and twisting profiles, and curve and surface nodes;
* lists and lacing.
