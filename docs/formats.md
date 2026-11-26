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
Graph.compile( doc, { output : "flywheel" } );            // the model document, without building it
```

`set` replaces the value of `number` nodes by id (any other node is refused) without changing the document. It is how
a project passes its own parameters (a 507 movement's `crank`, `rod`) into a part. Because evaluation is cached by
content, a part that does not read the parameter that changed is not rebuilt, and evaluating several outputs of one
document shares every feature they have in common.

## Model document, version 1

The compiled form, and the format of `docs/model.md`, which explains each feature type. In short:

| Key | Required | Meaning |
|---|---|---|
| `version` | yes | `1` |
| `parameters` | no | named numbers or expressions over each other |
| `features` | yes | features by id: `box`, `cylinder`, `pipe`, `revolve`, `primitive`, `transform`, `union`, `intersection`, `difference`, `round`, `shell`, `lattice` |
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

* groups (a document used as a node, with its inputs and outputs, names nested `<group>/<name>`);
* coloured or multi-material regions of a part (likely face-name patterns per output);
* 2D profiles, extrusion and patterns (gears, cams, slots), and curve and surface nodes;
* lists and lacing.
