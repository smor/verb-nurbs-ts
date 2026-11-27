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

The format is specified, with its JSON Schema and stability rules, in [formats.md](formats.md). A node graph (`Graph`, [visual-programming.md](visual-programming.md)) compiles into this kind of document and runs on
the same cache.

## Features

| Type | Values | Faces |
|---|---|---|
| `box` | `min`, `max`, `divs?` | `-x +x -y +y -z +z` |
| `cylinder` | `from`, `to`, `radius`, `divs?` | `tube`, `start cap`, `end cap` |
| `pipe` | `through` (points of the rail), `radius`, `divs?`, `ends?` (`flat`, or `round`: hemispheres) | `tube`, `start cap`, `end cap` |
| `revolve` | `profile` (`[radius, height]` pairs, heights increasing), `divs?` | `wall`, `bottom`, `top` |
| `prism` | `outline` (`[x, y]` or `[x, y, r]` points in z = 0, numbers or expressions; r rounds that corner), `height`; an exact extrusion (lines and arcs), its caps planes trimmed by the outline (#99; `center?` is accepted and not read) | `bottom`, `top`, `outer.k` |
| `extrude` | `profile` (an outline: `{ outer, holes }`, see [formats.md](formats.md), Profiles), `height`, `z?`, `twist?` (degrees), `scaleTop?` | `bottom`, `top`, `outer.k`, `hole{i}.k` |
| `lathe` | `profile` (an outline in the (r, z) half-plane), `degrees?` (360) | `outer.k` |
| `primitive` | `shape` (a `Catalog` name, see [primitives.md](primitives.md)), `values?` (its parameters by name; angles in degrees) | the shape's own: `side.k`, `bottom`, `top`, `face.k`, ... |
| `transform` | `of`, `scale?` (number or per axis; negative mirrors), `rotate?` (`axis`, `degrees`, `about?`), `translate?` | its input's, behind `<transform>/` |
| `union`, `intersection` | `of` | |
| `difference` | `from`, `minus` | |
| `choose` | `when` (a number or expression), `then?`, `else?`: a switch, `then` where `when` is not 0, else `else`; a side left out is nothing | the chosen feature's |
| `round` | `of`, `rules` (`edges` pattern, `radius`), `shape?` (`circular`, `curvature`, `chamfer`), `corner?` | `round(...)`, `corner(...)` |
| `shell` | `of`, `thickness`, `open?` (face name patterns) | its input's, and the inside's as `<shell>~<face>` |
| `offset` | `of`, `distance` (negative shrinks); see [mechanics.md](mechanics.md) | written out as the features that build it |
| `sweep` | `of` (a ball for now), `along` (the points it is moved by, in turn); see [mechanics.md](mechanics.md) | a round-ended pipe's: `tube`, `start cap`, `end cap` |
| `lattice` | `of`, `pattern`, `cell`, `wall`, `skin?`, `blend?`, `grade?` (`axis`, `to`), `open?` (face name patterns), `size?` | a mesh: `ModelResult.lattice` |

**Switches.** `choose` features are resolved before anything is hashed or built (`Model.choose`), at the parameters'
values: a reference to a switch becomes the feature it chose. Nothing (a switch whose chosen side is left out) drops
out of a union and out of a difference's cutters, and a union left with one solid, or a difference with no cutter, is
that solid. A transform, round, shell or lattice of nothing, a difference from nothing and an intersection with
nothing are nothing, and an output that is nothing is refused ("switched off"). `ModelResult.chosen` says what each
switch the output reached chose. Since only what is chosen is hashed, a part switched off and on again comes back
from the cache.

Every number may be an expression over the parameters (`Expr`: arithmetic, `^`, `min`, `max`, `sqrt`, trigonometry
in radians, `rad`, `deg`, `clamp`, `lerp`, `pi`). Parameters may use other parameters; cycles are refused.
`machine` (a `Makeable.MACHINES` key or a machine) adds a fabrication check to the verdict.
`certify: true` proves every intersection of the model's Booleans complete, with no branch or small loop missed (see
[booleans.md](booleans.md), "Proving that no branch was missed"). The verdict notes the result, and pairs of faces
it cannot prove are named in `result.report.certificate`.

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
  names, so the same rules keep selecting the same edges as parameters change. A pattern `A|B` matches an edge either
  way round, so `b.*x|b.*y` is every edge between an x face and a y face of `b`, whichever name sorts first (#79).
* **The verdict** is computed from the result, the same way every time:

  | Check | Passes when |
  |---|---|
  | `closed` | every edge joins exactly two faces |
  | `outward` | the volume is positive |
  | `fillets` | every requested fillet is in place (none too large, none left sharp at a corner) |
  | `round rules` | (with a round) every rule selects at least one edge: one that matches nothing, a misspelt face, is named (#79) |
  | `makeable` | (with a machine) `Makeable.check` passes: the surface does not pass through itself, fits, no wall too thin, no sealed void on a machine that drains, and for a moulded process (`Machine.draft`) enough draft and no undercut along the best pull |
  | `wall` | (for each shell) the thinnest wall measured is the thickness asked, within `Model.WALL_TOLERANCE` (3%) |
  | `export mesh` | (in a graph evaluated with `mesh: "print"` or `"view"`) the export mesh is closed: the faces are meshed from the exact shell apart from the result's own mesh, and an open one names how many edges are open (#116) |

  Any failed check makes the model **visual**: fine to look at and render, not to fabricate. The reasons say why.
  Fillets made smaller than asked so that they keep clear of each other (`report.filletsReduced`) are in place and
  leave the model buildable; the notes say how many.

  With a machine, `verdict.makeable` is the machine's full report (the wall measured, the size, the build
  orientation, the mould's pull) for display. `Model.verdict( result, machine )` judges any B-rep result the same way,
  so recipes that build their own Booleans (the mug, the pierced vessel, the appliance) get the same verdict; the
  playground does this in its Makeable mode.

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

## Lattices

A `lattice` makes its input light: the inside becomes a lattice, inside a skin. It is the last feature, like a
`round`, and its result is a mesh (`ModelResult.lattice.mesh`, for STL), not a B-rep; `ModelResult.result` stays
the solid it fills, with its faces' names.

```js
{ type: "lattice", of: "rounded", pattern: "gyroid", cell: 10, wall: 1.5, skin: 1.6, blend: 1,
  grade: { axis: "z", to: 2.4 }, open: ["body.+z"] }
```

* **Patterns.** Sheets on triply periodic minimal surfaces: `gyroid` (Schoen), `schwarz-p` and `diamond` (Schwarz),
  `wall` thick; or struts `wall` across along the edges of a cell's graph: `bcc` (body diagonals), `octet` (face
  diagonals and edges), `cubic` (edges). `cell` is the side of the cubic cell.
* **Skin and blend.** The skin is `skin` thick, just inside the solid's surface (0: none; the lattice is cut off at
  the surface). The lattice reaches half the skin into it, and `blend` rounds the joint (a smooth union).
* **Grade.** The wall varies linearly along an axis of the solid's bounding box, from `wall` to `grade.to`: denser
  where the load is.
* **Open faces.** A sheet lattice parts space into two labyrinths, and a closed skin seals both in. On a resin or
  powder printer the uncured resin or loose powder would be trapped. The skin leaves out the `open` faces, where the
  lattice runs out to the surface and the voids drain.
* **How it is meshed.** The solid's signed distance (its mesh's, the sign from angle-weighted pseudonormals) and the
  lattice's distance (struts: to the nearest strut; sheets: to the surface, by Newton projection) combine into one
  field, meshed by marching tetrahedra (`Implicit`). Every sample is strictly inside or out, so the mesh is a closed
  2-manifold by construction. Each vertex starts as the field's root on its tet edge, so no triangle leaves its tet
  and the mesh cannot cross itself. The grid's step `size` defaults to the least of an eighth of the cell, two thirds
  of the skin and a third of the thinnest wall.
* **Smooth edges.** Where the lattice is cut by the surface (an open face, or no skin) the cut is a smooth
  intersection, rounded over one and a half grid steps, so the grid has no sharp edge to saw into steps. The mesh is
  then relaxed three times (`Implicit.relax`): each vertex moves towards its neighbours along the surface and back
  onto it, which raises the mean smallest angle of a ball's triangles from 28° to 41°. Relaxing keeps every triangle's
  vertices, so the mesh stays closed and manifold. A move that would turn a triangle over, or carry a vertex more
  than half a grid step from its tet edge, is undone. This keeps the mesh from crossing itself in practice, though it
  is no longer a proof.

The verdict judges the mesh:

| Check | Passes when |
|---|---|
| `closed` | the mesh is a closed 2-manifold (its genus is given) |
| `outward` | the volume is positive (with the share of the solid kept) |
| `resolution` | the grid is no coarser than half the thinnest wall, so no wall can fall between samples |
| `one piece` | one body: no loose parts |
| `drains` | no sealed void, or a machine that does not mind them (`Machine.drains`: resin, powder, slip) |
| `lattice wall`, `makeable` | with a `machine`: the walls are at least its minimum, and `Makeable.check` passes |

`Makeable.check` reports sealed voids for any mesh (`voids`), and counts them as an issue on machines that drain,
so a shell with no open face fails on a resin printer too.

It also finds where a closed surface passes through itself (`selfIntersections`, `crossings`; `TriMesh.selfIntersections`
bins triangles in a grid and tests each nearby pair that shares no vertex, edge against triangle). A mesh can be
closed, oriented and of the right genus and still cross itself, a sweep folded in a tight bend for example, and then
it encloses no well-defined solid: slicers and Booleans each guess differently. Any crossing is an issue. Lattices
and grown solids are meshed so that they cannot cross (marching tetrahedra keeps each triangle in its tet, and the
relaxation that follows undoes any move that makes two triangles cross).

Fabrication notes. `ModelVerdict.notes` lists what is worth knowing without making the model visual. For a printer
with an `overhang` limit (FDM and resin: 45°), it gives the build direction, of the six axes, that leaves the least
area overhanging, and whether supports are still needed (`Makeable.orient`). For slip casting (`draft`: 1°), the
pull direction is chosen the same way (`Makeable.release`), and too little draft or an undercut is an issue: the cast
would stick or could not leave a two-part mould.

## Limits

* A `round` can be an operand of a further Boolean. It is evaluated as a stage of its own, cached like any feature:
  its result is made an exact shell and the shell is the next Boolean's operand ([exact-booleans.md](exact-booleans.md),
  steps A3 and A4). Its faces keep the names the round gave them (`round(body.+x|body.+y)`); behind a transform they
  get its path (`placed/round(body.+x|body.+y)`). Moving a hole through a rounded part rebuilds the hole and the cut,
  not the round. A rounded output moved by transforms is still rewritten as the round of the moved part
  (`Model.liftRound`), its patterns and fillet names prefixed with the transforms' path
  (`round(placed/block.+z|placed/peg.tube)`), its radii scaled with it; a scale that differs along the axes now goes
  through the stage instead (the rounded part built, then stretched, fillets and all). Not yet: a round over a rounded
  operand (rounding the edges a Boolean makes on a shell, step A5), or a shell (hollowing) of one.
* Shells offset boxes, cylinders, pipes (a curved pipe's ends can only move in, so not an open end or a pipe taken
  away), Booleans and rigid or uniformly scaled transforms. Revolves, and a shell of a shell, are refused with a
  message. An open face's offset goes `thickness` past it: a feature standing over an open face is cut there (the
  wall check reports it).
* A fillet that runs out onto a face is cut by it (see `docs/booleans.md`), unless the face would have to be carried on
  past its edge to take it (a fillet at the foot of a narrow step): that edge is left sharp, and the verdict says so.
* A lattice is a mesh: it exports as STL, not STEP, and cannot be an operand of a Boolean. The skin's outer surface
  is the solid's mesh met by the grid: sharp edges come out cut by about one grid step (round them first).
* The same primitive cannot appear twice in one Boolean without a transform (its faces' names would clash).
* Fillets on a Boolean's new edges can still fail for some placements, such as a bore's rim on some positions and
  radii. The verdict reports these as visual (open edges). Making the Boolean and fillet engine robust there is the
  next piece of work.
