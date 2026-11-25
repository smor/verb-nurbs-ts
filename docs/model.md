# Models: a deterministic feature tree

`Model` turns a **document** into a solid. The document is plain JSON: named parameters, features keyed by id, and
the feature that is the output. The same document always gives the same solid, bit for bit. Every face of the
solid has a **persistent name** that comes from its history, and every result carries a **verdict**: buildable or
visual, with the reason.

```js
import { Model } from "verb-nurbs-ts";

const doc = {
  version: 1,
  parameters: { w: 40, d: 28, h: 20, r: "min(w, d) / 6", hole: 4, foot: 2, rim: 1 },
  features: {
    block:   { type: "box", min: [0, 0, 0], max: ["w", "d", "h"] },
    peg:     { type: "cylinder", from: ["w/2", "d/2", "h - 5"], to: ["w/2", "d/2", "h + 12"], radius: "r" },
    bore:    { type: "cylinder", from: ["w/5", "d/2", -5], to: ["w/5", "d/2", "h + 5"], radius: "hole" },
    solid:   { type: "union", of: ["block", "peg"] },
    body:    { type: "difference", from: "solid", minus: ["bore"] },
    rounded: { type: "round", of: "body", rules: [
      { edges: "block.+z|peg.tube", radius: "foot" },
      { edges: "block.+z|bore.tube", radius: "rim" } ] },
  },
  output: "rounded",
};

const model = new Model();
const r = model.evaluate(doc);
r.verdict;     // { kind: "buildable", reasons: ["passes every check"], checks: [...] }
r.faceNames;   // ["block.-x", ..., "peg.tube", "round(block.+z|peg.tube)", ...]
r.result;      // the BooleanResult: mesh, trimmed faces, fillets (STEP export takes it as is)

doc.parameters.rim = 0.8;
model.evaluate(doc).features;  // only "rounded" is rebuilt; the rest comes from the cache
```

## Features

| Type | Values | Faces |
|---|---|---|
| `box` | `min`, `max`, `divs?` | `-x +x -y +y -z +z` |
| `cylinder` | `from`, `to`, `radius`, `divs?` | `tube`, `start cap`, `end cap` |
| `pipe` | `through` (points of the rail), `radius`, `divs?` | `tube`, `start cap`, `end cap` |
| `revolve` | `profile` (`[radius, height]` pairs, heights increasing), `divs?` | `wall`, `bottom`, `top` |
| `transform` | `of`, `scale?` (number or per axis; negative mirrors), `rotate?` (`axis`, `degrees`, `about?`), `translate?` | its input's, behind `<transform>/` |
| `union`, `intersection` | `of` | |
| `difference` | `from`, `minus` | |
| `round` | `of`, `rules` (`edges` pattern, `radius`), `shape?` (`circular`, `curvature`, `chamfer`), `corner?` | `round(...)`, `corner(...)` |
| `shell` | `of`, `thickness`, `open?` (face name patterns) | its input's, and the inside's as `<shell>~<face>` |

Every number may be an expression over the parameters (`Expr`: arithmetic, `^`, `min`, `max`, `sqrt`, trigonometry
in radians, `rad`, `deg`, `clamp`, `lerp`, `pi`). Parameters may use other parameters; cycles are refused.
`machine` (a `Makeable.MACHINES` key or a machine) adds a fabrication check to the verdict.

## How it works

* **One Boolean per tree.** The CSG features of a tree compile into a single N-ary Boolean over its primitives
  (`BrepBoolean.evaluate`), with the tree's expression. A tree of any depth is cut once, with one set of seams,
  which is what keeps the result watertight by construction.
* **Content hashes.** Each feature's hash covers its type, its resolved values and its inputs' hashes (canonical
  JSON, 64-bit FNV-1a). A model caches what it built by hash, so an edit rebuilds exactly the features downstream of
  it. Equal hashes mean equal results: nothing else goes in.
* **Persistent names**, after J. Kripac, "A mechanism for persistently naming topological entities in history-based
  parametric solid models", *CAD* 29(2), 1997, and V. Capoyleas, X. Chen, C. M. Hoffmann, "Generic naming in
  generative, constraint-based design", *CAD* 28(1), 1996:
  * a primitive's face: `<feature>.<face>`; behind transforms, `<transform>/.../<feature>.<face>`;
  * a fillet: `round(<face>|<face>)`, after the two faces whose edge it rounds;
  * a corner: `corner(<face>|<face>|<face>)`, after the faces its fillets join (`.0` to `.5` for the parts of a
    setback corner);
  * pieces of one face split by a Boolean: `#1`, `#2`, ... by decreasing area, then by centroid.
  Edges are named by their two faces, sorted: `block.+z|peg.tube`. Rules select edges by glob patterns over those
  names, so the same rules keep selecting the same edges as parameters change.
* **The verdict** is computed from the result, the same way every time:

  | Check | Passes when |
  |---|---|
  | `closed` | every edge joins exactly two faces |
  | `outward` | the volume is positive |
  | `fillets` | every requested fillet is in place (none too large, none left sharp at a corner) |
  | `makeable` | (with a machine) `Makeable.check` passes: fits, no wall too thin |
  | `wall` | (for each shell) the thinnest wall measured is the thickness asked, within `Model.WALL_TOLERANCE` (3%) |

  Any failed check makes the model **visual**: fine to look at and render, not to fabricate. The reasons say why.

## Shells

A `shell` hollows a solid: it keeps the solid less its **inside**, the solid offset inward by `thickness`. Faces
named by `open` (patterns, as for edges, over the face names of `of`) are left open: the inside goes through them.

```js
features: {
  cup:    { type: "cylinder", from: [0, 0, 0], to: [0, 0, 40], radius: 15 },
  handle: { type: "pipe", through: [[8, 0, 30], [24, 0, 29], [27, 0, 19], [8, 0, 12]], radius: 3 },
  body:   { type: "union", of: ["cup", "handle"] },
  mug:    { type: "shell", of: "body", thickness: 2, open: ["cup.end cap"] },
  rounded: { type: "round", of: "mug", rules: [
    { edges: "cup.end cap|*", radius: 0.8 },                    // the rim, both edges
    { edges: "cup.start cap|cup.tube", radius: 4 },             // outside of the base
    { edges: "mug~cup.start cap|mug~cup.tube", radius: 2 },     // inside: 4 - 2, so the wall stays 2
    { edges: "cup.tube|handle.tube", radius: 2 } ] },
}
```

How the inside is built, after J. R. Rossignac and A. A. G. Requicha, "Offsetting operations in solid modelling",
*CAGD* 3(2), 1986:

* **Offsets of the CSG tree, not of the boundary.** The inside of a Boolean is a Boolean of offset primitives:
  shrinking an intersection shrinks each operand; shrinking `A - B` shrinks `A` and grows `B`; shrinking a union
  shrinks each operand and takes their union. Growing is the same with the roles swapped.
* **Never too thin.** Each offset comes out no larger than the exact one when shrinking and no smaller when growing:
  a box or cylinder shrunk stays a box or cylinder (exact); grown, it is mitred, with sharp edges where the exact
  offset is round (it contains the exact one); a union shrunk is the union of the shrunk operands (exact away from
  the seams, smaller at concave ones). So the inside is within the exact one, and every wall is at least
  `thickness`: thicker where a union of solids meets, never thinner.
* **One Boolean.** The shell is `X && !inside(X)` in the tree's single N-ary Boolean, so a `round` can still follow
  it, on outside edges (`box.*`), inside edges (`<shell>~box.*`) or both. An outside radius equal to the inside
  radius plus the thickness keeps the wall even round a corner; a sharp inside under a round outside makes it thinner
  (`4 - 2√2` for a radius of 4 and a wall of 2), and the `wall` check says so.
* **Open faces** are offset outward by the thickness instead of inward, so the inside goes through them.
* **The wall is measured**, not assumed: the smallest distance from the inside faces' mesh vertices to the outside
  faces' triangles (open faces, and fillets along them, left out). The mesh's chords cut inside curved faces, so it
  reads a little thin there; the check allows `Model.WALL_TOLERANCE`.

## Limits

* A `round` is the last feature on its branch: a rounded solid is not yet an operand of a further Boolean.
* Shells offset boxes, cylinders, pipes (a curved pipe's ends can only move in, so not an open end or a pipe taken
  away), Booleans and rigid or uniformly scaled transforms. Revolves, and a shell of a shell, are refused with a
  message. An open face's offset goes `thickness` past it: a feature standing over an open face is cut there (the
  wall check reports it).
* A fillet that runs out onto a face (an edge ending where two sharp edges meet, such as the vertical edges of a
  box under an open top) is left sharp, and the verdict says so.
* The same primitive cannot appear twice in one Boolean without a transform (its faces' names would clash).
* Fillets on a Boolean's new edges can still fail for some placements, such as a bore's rim on some positions and
  radii. The verdict reports these as visual (open edges). Making the Boolean and fillet engine robust there is the
  next piece of work.
