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
| `components` | no | the document's own components, by name: graph documents its `"#name"` instances use ([Components](#components)) |
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
| points | a closed outline, points `"x, y; x, y, r; ..."` (`freeform/prism`); each value a number or an expression over number nodes, an optional third value rounding that corner |
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
they stay put as parameters change. A circle's side is built as two exact halves, so that no face meets itself along a
seam (the Booleans don't cut a face against itself there, #122). The two halves keep the circle's one name. They are
numbered `#1`, `#2`, ... like the pieces of any face only once a Boolean splits one of them. The solid is a shell of trimmed faces, an operand of any Boolean. A round over an
extrusion is not built yet: rounding the edges of a trimmed solid is step A5 of docs/exact-booleans.md.

`twist` (degrees, default 0) turns the top about the z axis, and `scaleTop` (default 1) scales it about the origin, so a
worm's tooth is `twist = 360 × height / lead` and a tapered boss is `scaleTop < 1`. Both stay exact: the top is the
bottom moved by a rotation and scale, so its edges and cap are those of the bottom, moved. Without twist the sides are
ruled between the two. With twist each side is its segment swept along a cubic path that follows the turn, fitted every
5° with its ends exact (a twist of 90° gives a volume within 1e-7 of exact; a worm of three turns within 2e-7).
The volume reported is the shell's, in closed form: each section is the profile turned and scaled, so the volume is
the profile's area times the integral of the path's squared scale up its height (`rect(20, 2)` twisted 360° over 10:
399.99995, #117). A result that is one extrusion, as it is, keeps its shell: its export mesh is that shell's mesh,
not a shell fitted back to the result (a 60-cubic worm turned 1 375° at `print`: 84 s before, about 4 s, #117).

`profile/revolve` turns the same outline, drawn in the (r, z) half-plane (x is the radius, y the height), a full turn
about the z axis (`Lathe`; #87): lines become planes, cylinders and cones, arcs spheres and tori, cubics their exact
surfaces of revolution, and a circle a torus (a belt groove to subtract). A segment along the axis (x = 0 at both ends)
is the axis itself and makes no face; a path off the axis makes a solid with a hole through it (a pulley and its
bore). Faces are `outer.k` for segment k. `degrees` must be 360 for now, and the outline has no holes (revolve each
and subtract it): a part turn needs its end caps, which are not built yet.

### Sweeps

`profile/sweep` (#134) sweeps the same outline, drawn in the section's (u, v) plane, along a rail: the curve through
(x(t), y(t), z(t)) at `samples` evenly spaced values of t from 0 to 1 (a cubic spline through them, `ProfileSweep`).
The section stays normal to the rail. Its v axis is held by the `frame`:

* `radial`: pointing away from the `axis` (through the origin). A barrel cam's groove, its cutter's axis pointing
  at the drum's.
* `up`: along the axis, less its part along the rail.
* `rotation-minimizing`: from the axis at the start, carried along without spin (Wang et al. 2008).

u is v × t, so a counter-clockwise outline faces out. The faces are exact. The rail and the frame's two axes are
interpolated on the same knots, and a section segment sweeps the tensor product C(t) + x U(t) + y V(t): its control
points are the segment's and the splines'. So every section along the rail is the outline's exact curve.

* **Closed rails.** With `rail` set to `closed` (t = 1 back at t = 0, the first point not repeated), the sweep is a
  ring with no caps, built as two halves that keep one name. A rotation-minimizing frame's twist after one loop is
  spread along it, so the section meets itself exactly.
* **Open rails.** An open rail is capped flat at both ends: faces `start` and `end`. The faces round the sides are
  `outer.k` and `hole{i}.k`, as for an extrusion.
* **Volume.** The volume is in closed form: the integral of det(U, V, C' + x U' + y V') over the section and the rail.
* **End outputs.** The node also gives each end's point, unit tangent and u and v axes as numbers (`start_x` ...
  `end_vz`), for `transform/place`. They are expressions over the rail's functions: the derivative is taken by
  fourth-order one-sided differences, and the sweep takes the same derivatives at its ends, so its caps lie in the
  planes they give. A rotation-minimizing frame at the end is carried along the whole rail, so it is not an expression,
  and the node does not give `end_u*` or `end_v*` then.

**Two rails** (`profile/sweep2`, #159, Grasshopper's Sweep2). The section rides on two rails, (x, y, z) and (x2, y2,
z2) of t, sampled at the same t. It is drawn with the first rail at u = 0 and the second at u = the rails' distance at
the start (so at the start it is as drawn), and stretched along u to the rails' distance as it goes; across, v is
scaled the same (`height` `scale`, the default: the section grows as a whole) or kept (`keep`: only its width
follows the rails). Its plane is spanned by the line from the first rail to the second and the direction square to
that line and to the mean of the rails' unit tangents (v = t × u). It is the same tensor product, C(t) + x U(t) +
y V(t), with C the first rail, U the line to the second over the start's distance and V the scaled v axis, so the
faces, the caps, the volume in closed form and the fold check are those above: a rectangle on parallel straight
rails is a box, a circle on diverging straight rails a frustum (or with its height kept a truncated elliptic cone),
to rounding. Its end outputs are the first rail's point, the unit mean tangent, u and v at each end, and the second
rail's point (`start_x2` ... `end_z2`). The rails have as many samples each, and may not meet. `ProfileSweep` takes
the second rail as `rail2` (and `height`, `startTangent2`, `endTangent2`).

**Limits.**

* **Folds.** A section that reaches further towards the centre of a bend than the bend's radius folds over there:
  the swept shape passes through itself, so it encloses no well-defined solid. It is built all the same, a shape to
  look at, and its folds are said: `ProfileSweep.build` gives them (`SweepFold`: where, the bend's radius, how far the
  section reaches towards its centre), and a model or graph with such a sweep is **visual**, with a failed `fold`
  check and the folds in `verdict.defects` (`ModelDefect`), for a program to read and try other values. The check is
  a proof either way: on each knot span of the rail the Jacobian of the sweep is a polynomial in t, and its Bernstein
  coefficients at the corners of the section's control polygons bound it (all positive: no fold); a negative value at
  a point of the section proves a fold; what neither settles is halved, 12 times at most, and what is left is said as
  not proven free of folds (`proven: false`), which makes the model visual too. The other checks do not see a fold: a
  folded sweep is closed and outward. For example, ~167's heart-cam groove with 10° blends: the rail turns with a
  radius of 4.7 mm at the reversals, and the section reaches 6.3 mm towards the bend's centre (the groove is 5.9 to
  6.9 mm wide on each side of the rail). 13° still folds; 14° and 15° are proven free of folds. A cutter's swept
  volume there is wider than its section swept.
* **Passing through itself further along.** The fold check is local. A sweep whose rail comes back near itself (a
  helix whose pitch is less than the section's height) passes through itself without folding. That is proven not to
  happen only where every section lies in one of a family of parallel planes that the rail rises through (the frame's
  U and V square to one direction for every t, and the rail's rate along it positive on every knot span by its
  Bernstein coefficients): a box, a frustum, a loft between parallel planes, which are then buildable. Elsewhere the
  `self-contact` check passes unproven: with a machine, `Makeable.check` finds a crossing on the mesh
  (`selfIntersections`).
* **Cutters turning with a drum.** A cone turning with a drum also reaches further than its section past the rim: the
  cone's sides, ahead and behind, are further from the drum's axis than its axial section. Inside the drum, the
  section's sweep is the cones' union: within 0.035 mm for ~167's groove with 15° blends, against the exact union.
  507's hull-of-cones build is itself up to 0.025 mm off the exact union, so the two builds differ by up to 0.075 mm
  at the reversals.
* **Parts placed at an end.** A part placed at an end that carries the sweep's faces on exactly (the cutter cone
  itself) meets them along the end section: the end cap's rim lies on the cone, the cone's flat tip on the sweep's
  floor, and the cone crosses the sweep's sides at a grazing angle beside it. The Booleans close this (#163: 507's
  cutter on an arc, and ~167's open groove with a cone at each end cut from the drum, within 0.05 mm of the cones'
  union). Give the part a runout of its own beyond the section's (the test's cone runs out to v = 2 where the
  section stops at 1). Keep a revolved part's seam out of the end section's plane: turn it about its axis first
  (90° or 30° closes; a seam in the plane, 0° or 180°, does not yet). A part moved off the end by a few hundredths
  does not close either: its faces then cross the sweep's within that distance.

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
An open result (its Booleans' mesh has open edges, as where a folded sweep cuts) has no exact shell: its export is
its own mesh, as it is (`tolerance` and `deviation` null), and the `export mesh` check fails, so the result is visual
with its checks and defects rather than an exception (#162).
The graph keeps each result's shell and meshes, so asking again, or for another tolerance, does not rebuild the shell.
A result that is one solid made from an exact shell (an extrusion), with nothing cut or rounded, uses that
shell itself, and reports its exact volume (#117).
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
* **The document's own components.** `use: "#name"` is an instance of `components.name`, a graph document kept in
  the using document's top-level `components`. A file, a shared link or a browser's copy then carries its components
  with it, and nothing needs resolving. A component of the library has no library of its own: its own `"#name"`
  instances are of the same one, so components can use each other (not themselves). `Graph.hash` covers the library
  (each entry's hash, so moving a node inside a component does not change it); a document without one keeps the hash
  it had.

  ```json
  { "version": 2,
    "nodes": { "w": { "type": "number", "in": { "value": 40 } },
               "p": { "type": "component", "use": "#Plate", "in": { "w": "@w" } } },
    "outputs": { "plate": "@p.body" },
    "components": { "Plate": { "version": 2, "nodes": { "w": { "type": "number", "in": { "value": 10 } }, "...": {} },
                               "outputs": { "body": "@d" } } } }
  ```
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
* **What is refused:** a component that uses itself (directly or not), a `use` with nothing to resolve it, a
  `"#name"` the document's components do not have, a component of the library with a library of its own, a pinned
  hash that does not match, an input or an output the component does not have, `use` or `hash` on another node, and
  a number node whose id is already an instance's compiled parameter name (`crank1__rod`).
* **Limits.** A component whose output is a round can be moved, rotated and uniformly scaled, but not yet combined
  in a further Boolean, since a round is the last feature of a model (docs/model.md, "Limits", says why and what
  it would take); a lattice cannot be moved either. The node editor makes, edits and unpacks the document's own
  components (docs/visual-programming.md); an instance of a file (`use` a path) shows as a broken node there.

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
