# Primitive solids

A library of parameterised solids, each a closed B-rep (`BrepSolid`) that the rest of the library takes as it is:
Booleans, fillets and chamfers of its own edges, shells, STEP export and the makeable verdict. This page is the
catalogue: every family we intend to cover, its parameters, its truncation variants, how exact its NURBS are, and
whether it is built yet.

## Conventions

* **Placement.** Every primitive is built in its own frame: the axis of symmetry (or extrusion) is +z, the base sits
  on z = 0 and the axis passes through the origin; polyhedra are centred on the origin. A `transform` feature (or
  `Primitives.transformed`) places it. Sizes are in millimetres, angles in radians in the API and in degrees in the
  catalogue and model documents.
* **Size.** Polyhedra take a `radius` (circumradius). Polygons take the circumradius of their vertices.
* **Exactness.** Each entry says which of three kinds it is:
  * **exact**: planes, bilinear patches and other polynomial surfaces, with no approximation at all;
  * **rational**: conics and quadrics as rational NURBS (circles, ellipses, spheres, cones, tori): exact, with weights;
  * **fitted**: a curve with no rational form (an egg formula, a superellipse), interpolated or approximated to a
    stated tolerance (1e-4 of the solid's size unless given).
* **Faces and names.** Faces carry names that the feature tree uses for persistent naming: `side` (or `side.0`,
  `side.1`, ... one per smooth piece), `bottom`, `top` for prisms and pyramids; the roles for solids of revolution
  (`bottom`, `side`, `top`, `cap`, `zone`, `outer`, `inner`, `surface`...); `face.k` for polyhedra.
* **What makes a valid B-rep here.** A face is a NURBS surface over its whole domain, and neighbouring faces share
  their edges sample for sample (`docs/architecture.md`). So a face is a quadrilateral, a triangle (a quad with one
  side collapsed), a polygon or closed curve capped by a "cone" from an inner point (periodic, with a pole), or a
  surface of revolution (periodic in its angle). Every primitive below is assembled from those.
* **Edges you can round.** `BrepEdges` finds an edge where a whole side of one face runs along a side of another.
  The builders put faces of up to four sides first, so every edge that touches one is found. An edge between two
  faces of five sides or more (a dodecahedron's) is not yet; that is listed under known limits.

## Using them

```js
import { Primitives, Profiles, Polyhedra, Catalog, BrepEdges, BrepBoolean, Step } from "verb-nurbs-ts";

const nut = Primitives.prism(Profiles.regular(6, 20), 10);            // a hexagonal prism, 8 faces
const heart = Primitives.prism(Profiles.heart(40), 8, { twist: 0.3 });  // twisted heart
const cone = Primitives.cone(15, 30, 5);                              // a frustum of a cone
const d20 = Primitives.platonic("icosahedron", 10);                   // circumradius 10
const tri = Primitives.platonic("dual:cuboctahedron", 10);            // the rhombic dodecahedron
const same = Catalog.build("star prism", { points: 6, outer: 20, inner: 9, height: 10 });

Primitives.volume(nut);     // exact, from the faces (divergence theorem), not from a mesh
const edges = Primitives.creases(nut).map(e => ({ solid: 0, faces: e.faces, radius: 1.5 }));
const r = BrepBoolean.evaluate([nut], f => f[0], { edges });   // every edge rounded
Step.write(r, { name: "nut" });
```

In a model document the catalogue is the `primitive` feature (`docs/model.md`):

```js
{ type: "primitive", shape: "polygon prism", values: { sides: 6, radius: "r", height: 10 } }
```

`Catalog.ENTRIES` lists every shape with its parameters, defaults and ranges; the playground's Primitives tab is
built from it.

## Building blocks

Four builders make every family. The families are thin parameter layers on top.

| Builder | Input | Output |
|---|---|---|
| `Primitives.prism` | a closed planar `Profile`, a height, and optional top scale (taper), twist and shear | one side face per smooth piece of the profile (each corner is an edge), a bottom and a top cap; top scale 0 gives a pyramid |
| `Primitives.pyramid`, `extrudePoint` | a profile and an apex | the side faces (cones to the apex) and the base |
| `Primitives.loft`, `extrude` | two compatible profiles (one the image of the other under an affine or projective map), or a profile and a direction | ruled sides and two caps |
| `Primitives.revolve` | a generatrix in the (r, z) half-plane of lines, arcs and any NURBS segment, from the axis to the axis or closed off it | one face per smooth piece, revolved exactly; points on the axis are poles |
| `Primitives.polyhedron` | vertices and faces (`PolyhedronData`) | triangles and quadrilaterals as bilinear patches, larger polygons as caps from their centroid |

Profiles (`Profiles.*`) are closed planar curves made of segments: polygons, stars, rounded polygons, hearts and the
rest of section 6. A profile keeps its corners, so the prism over it has one side face per segment between
corners, and a tangent join (a line into the arc of a rounded rectangle) stays inside one face. Polyhedra
(`Polyhedra.*`) are plain data: exact vertex coordinates (golden ratio and tribonacci constant where needed), faces
from the convex hull, and the Conway operators `dual`, `truncate`, `ambo` and `kis`.

Two measures come with them: `Primitives.volume` (exact, by Gauss–Legendre quadrature of the divergence theorem over
the faces) and `Primitives.creases` (the edges where faces meet at an angle, leaving out tangent joins).

## Checks

`test/testPrimitives.cjs` checks, for every family:

* a closed 2-manifold of the right genus, from shared samples along every edge, with no welding to hide a gap;
* the exact volume against its formula, to 1e-9 relative (most agree to 1e-15);
* polyhedra: vertex, edge and face counts, one edge length, every vertex on the circumsphere;
* rounding of every edge where `BrepEdges` finds them, and STEP export.

OpenCascade (cadquery-ocp 8.0.1, `BRepCheck_Analyzer`, `BRepGProp.VolumeProperties` at eps 1e-6) reads the STEP of
every built family as a valid solid of one shell at the exact volume, rounded ones included, with the exception in
the known limits.

## The catalogue

Status: ✅ built and tested, 🔜 next, ○ planned. Priority runs P1 (first) to P4.

### 1. Boxes and parallelepipeds

| Primitive | Parameters | Faces | Kind | Prio | Status |
|---|---|---|---|---|---|
| Box (cuboid) | `size [w, d, h]`, `centered?` | `-x +x -y +y -z +z` | exact | P1 | ✅ (`BrepSolid.box`) |
| Cube | `edge` | as box | exact | P1 | ✅ |
| Wedge (OCC-style) | `dx, dy, dz`, top `xmin, xmax` (and `zmin, zmax`) | 6 or 5 faces | exact | P1 | ✅ |
| Parallelepiped | three edge vectors | 6 quads | exact | P2 | ✅ |
| Rhombohedron | `edge`, `angle` | 6 rhombi | exact | P3 | ○ |
| Rounded box | box + `radius` (circular / G2 / chamfer) | box + fillets + corners | rational | P1 | via `round` |

### 2. Prisms and extrusions

| Primitive | Parameters | Kind | Prio | Status |
|---|---|---|---|---|
| Right prism over any profile | `profile`, `height` | exact / rational | P1 | ✅ |
| Regular n-gonal prism | `sides`, `radius`, `height` | exact | P1 | ✅ |
| Oblique prism | `shear [dx, dy]` of the top | exact | P2 | ✅ |
| Tapered prism (draft) | `scale` of the top, or `draft` angle | exact | P1 | ✅ |
| Twisted prism | `twist` angle (ruled, bilinear sides) | exact | P2 | ✅ |
| Antiprism | `sides`, `radius`, `height` | exact | P2 | ✅ |
| Hollow prism (tube of any profile) | `profile`, `wall` | exact | P2 | via `shell`, or difference |
| Helical / screw extrusion | `profile`, `pitch`, `turns` | fitted | P4 | ○ |
| Extrude along a curve | `profile`, `path` | fitted | P3 | ○ (`Sweep` exists) |

### 3. Pyramids, cones and their truncations

| Primitive | Parameters | Kind | Prio | Status |
|---|---|---|---|---|
| Pyramid over any profile | `profile`, `height`, `apex [x, y]` offset | exact | P1 | ✅ |
| Regular / square / rectangular pyramid | `sides`, `radius` or `size`, `height` | exact | P1 | ✅ |
| Frustum (parallel truncation) | `top` scale or `topRadius` | exact | P1 | ✅ |
| Obliquely truncated pyramid | cutting plane: `tilt` about x/y at `height` | exact | P2 | 🔜 (`loft` takes a projective map; no family yet) |
| Bipyramid (dipyramid) | `sides`, `radius`, `height` up and down | exact | P2 | ✅ |
| Elongated / gyroelongated bipyramid | `sides`, `radius`, `prism height` | exact | P3 | ○ |
| Cone (right circular) | `radius`, `height` | rational | P1 | ✅ |
| Truncated cone (frustum) | `radius`, `topRadius`, `height` | rational | P1 | ✅ |
| Oblique cone | `apex [x, y]` offset | rational | P2 | ✅ (`pyramid` over a circle) |
| Elliptic cone / frustum | `rx, ry` | rational | P2 | ✅ (`pyramid` / `frustum` over an ellipse) |
| Cone with a rounded tip | `tip radius` (sphere tangent to the side) | rational | P2 | ✅ |
| Cone sector (pie wedge) | `angle` | rational | P3 | ○ |
| Obliquely truncated cone | cutting plane (the top is an ellipse) | rational | P3 | ○ |
| Nose cones / ogives | tangent ogive, secant ogive, elliptical, parabolic, power series, Haack series | rational / fitted | P3 | ✅ tangent ogive (the rest ○) |

### 4. Cylinders and their cuts

| Primitive | Parameters | Kind | Prio | Status |
|---|---|---|---|---|
| Cylinder | `radius`, `height` | rational | P1 | ✅ |
| Elliptic cylinder | `rx, ry`, `height` | rational | P2 | ✅ |
| Oblique cylinder | `shear` | rational | P2 | ✅ |
| Cylinder sector (pie slice) / half cylinder | `angle` | rational | P2 | ✅ |
| Obliquely cut cylinder (ungula base) | cutting plane | rational | P3 | ○ |
| Cylindrical wedge (hoof, ungula) | chord, height | rational | P4 | ○ |
| Capsule (spherocylinder) | `radius`, `length` | rational | P1 | ✅ |
| Stadium / slot prism | `length`, `radius`, `height` | rational | P1 | ✅ |

### 5. Spheres, quadrics and lenses

| Primitive | Parameters | Kind | Prio | Status |
|---|---|---|---|---|
| Sphere | `radius` | rational | P1 | ✅ |
| Hemisphere | `radius` | rational | P1 | ✅ |
| Spherical cap (segment of one base) | `radius`, `height` | rational | P1 | ✅ |
| Spherical zone (segment of two bases) | `radius`, `z0`, `z1` | rational | P2 | ✅ |
| Spherical sector (cone + cap) | `radius`, `angle` | rational | P2 | ✅ |
| Spherical wedge (lune) | `radius`, `angle` | rational | P3 | ○ |
| Spherical shell | `radius`, `wall` | rational | P2 | via `shell` / difference |
| Ellipsoid | `rx, ry, rz` | rational | P1 | ✅ |
| Spheroid, oblate / prolate | `radius`, `height` | rational | P1 | ✅ |
| Paraboloid (solid, capped) | `radius`, `height` | rational (a parabola is a quadratic Bézier) | P2 | ✅ |
| Hyperboloid of one sheet (capped) | `waist`, `radius`, `height` | rational | P3 | ○ |
| Lens (two spherical caps) | `r1`, `r2`, `diameter` | rational | P2 | ✅ |
| Spindle / lemon (inner spindle torus) | `radius`, `height` | rational | P3 | ○ |
| Apple (outer spindle torus) | `R`, `r` | rational | P4 | ○ |

### 6. Profiles for extrusion (planar shapes)

Each is a `Profile`, closed and counter-clockwise, to extrude, taper into a pyramid, revolve (when it lies on one
side of the axis) or use as a section.

| Profile | Parameters | Kind | Prio | Status |
|---|---|---|---|---|
| Regular polygon | `sides`, `radius` (or `edge`, `inradius`), `rotation` | exact | P1 | ✅ |
| Rectangle, square | `w`, `h` | exact | P1 | ✅ |
| Rounded rectangle / rounded polygon | `corner radius` (tangent arcs) | rational | P1 | ✅ |
| Star polygon | `points`, `outer`, `inner` radius (or Schläfli `{n/k}`) | exact | P1 | ✅ |
| Rounded star | star + `corner radius` | rational | P3 | ✅ (`Profiles.rounded` over a star) |
| Circle, ellipse | `radius` / `rx, ry` | rational | P1 | ✅ |
| Stadium (slot) | `length`, `radius` | rational | P1 | ✅ |
| Heart | `width`, `height`, `lobe` | rational (two arcs and two lines) | P1 | ✅ |
| Heart, smooth (classic curve) | `size` | fitted | P3 | ○ |
| Cross / plus | `arm length`, `arm width` | exact | P2 | ✅ |
| Arrow | `length`, `shaft`, `head` | exact | P3 | ✅ |
| Structural sections: L, T, I (H), U (C), Z | flanges, web, thickness | exact | P2 | ✅ L, T, I, U (Z ○) |
| Hollow sections: RHS, CHS, annulus | outer, wall | exact / rational | P2 | as two prisms and a difference |
| Superellipse (squircle, Lamé) | `rx, ry`, `exponent` | fitted | P3 | ○ |
| Reuleaux polygon | `sides` (odd), `width` | rational | P3 | ✅ |
| Crescent, lune | `r1`, `r2`, offset | rational | P3 | ○ |
| Gear (spur, involute teeth) | `teeth`, `module`, `pressure angle` | fitted | P4 | ○ |
| Rose, epicycloid, cardioid, flower | lobes, amplitude | fitted | P4 | ○ |
| Any polyline or closed NURBS | points, curve | — | P1 | ✅ |

### 7. Tori, rings and tubes

| Primitive | Parameters | Kind | Prio | Status |
|---|---|---|---|---|
| Torus (ring) | `R` (major), `r` (minor) | rational | P1 | ✅ |
| Elliptic-section torus | `R`, `rr, rz` | rational | P3 | ✅ |
| Torus of any section (D-ring, comfort-fit) | `R`, section profile | rational | P2 | ✅ (`revolve` of a closed generatrix) |
| Torus sector (elbow, with caps) | `R`, `r`, `angle` | rational | P2 | ○ |
| Horn / spindle torus | `R ≤ r` | — | — | not a valid solid (self-touching); the spindle's lemon and apple are in section 5 |
| Tube (annular cylinder, washer) | `outer`, `inner`, `height` | rational | P1 | ✅ |
| Conical tube (hollow frustum) | radii at both ends, `wall` | rational | P2 | ✅ |
| Pipe along a path | `through`, `radius` | fitted | — | ✅ (`pipe` feature) |
| Hollow pipe, elbow tube | `outer`, `inner` | fitted / rational | P3 | ○ |
| Coil spring (helical pipe) | `radius`, `wire`, `pitch`, `turns` | fitted | P3 | ○ (sweep exists) |
| Knot tubes (torus knots) | `p, q` | fitted | — | ✅ (`SweptObjects`) |

### 8. Eggs and ovoids

| Primitive | Parameters | Kind | Prio | Status |
|---|---|---|---|---|
| Two-ellipsoid egg | `radius`, `top height`, `bottom height` (two half-spheroids, G1 at the equator) | rational | P1 | ✅ |
| Moss's egg (four arcs, pointed) | `radius` | rational | P2 | ✅ |
| Hügelschäffer egg | `a`, `b`, `w` (shift of the widest section) | fitted | P2 | ○ |
| Narushin universal egg | `L`, `B`, `w`, `D_L/4` | fitted | P4 | ○ |
| Cassini oval of revolution | `a`, `b` | fitted | P4 | ○ |

### 9. Regular and semi-regular polyhedra

All built from `Primitives.polyhedron` with exact vertex coordinates (golden ratio where needed), scaled to a
circumradius.

| Family | Members | Prio | Status |
|---|---|---|---|
| Platonic | tetrahedron, cube, octahedron, dodecahedron, icosahedron | P1 | ✅ |
| Archimedean | truncated tetrahedron, cuboctahedron, truncated cube, truncated octahedron, rhombicuboctahedron, truncated cuboctahedron, snub cube, icosidodecahedron, truncated dodecahedron, truncated icosahedron, rhombicosidodecahedron, truncated icosidodecahedron, snub dodecahedron | P2 | ✅ all but the snub dodecahedron |
| Catalan (duals) | triakis tetrahedron, rhombic dodecahedron, ..., pentagonal hexecontahedron | P3 | ✅ the 12 duals of the Archimedean solids above |
| Prisms, antiprisms, bipyramids, trapezohedra | `sides` | P2 | ✅ |
| Johnson solids | J1–J92; first the pyramids, cupolae and rotundae | P4 | ○ |
| Zonohedra | rhombic dodecahedron, rhombic triacontahedron | P3 | ✅ |
| Kepler–Poinsot, stellations | small stellated dodecahedron, stella octangula, ... | P4 | ○ (as unions of pyramids) |
| Dice | d4, d6, d8, d10 (trapezohedron), d12, d20 | P3 | ✅ |
| Convex hull of points | `points` | P2 | ✅ (`Polyhedra.hull`) |

Conway operators on a polyhedron: `dual`, `truncate(t)`, `ambo` (rectify), `kis(h)`. `chamfer` of edges is
`round` with `shape: "chamfer"` where its edges are found, and the polyhedral `c` operator otherwise (○).

### 10. Other classic solids

| Primitive | Parameters | Kind | Prio | Status |
|---|---|---|---|---|
| Sphericon | `radius`, `n` (2: classic) | rational | P3 | ○ |
| Oloid | `radius` | fitted | P4 | ○ |
| Steinmetz solids (bicylinder, tricylinder) | `radius` | rational | P3 | via intersection of cylinders |
| Reuleaux tetrahedron, Meissner bodies | `width` | rational | P4 | ○ |
| Superellipsoid, superquadric | `rx, ry, rz`, `e1`, `e2` | fitted | P4 | ○ |
| Thickened Möbius band | `R`, `width`, `thickness` | fitted | P4 | ○ |
| Gyroid / lattice infill | | mesh | — | ✅ (`lattice` feature) |

## Grasshopper-style builders

Rhino and Grasshopper's surface nodes, in `Nodes` (`src/solid/primitives/Nodes.ts`), on NURBS curves in world
coordinates. Each returns the surface Grasshopper returns; the `...Solid` variants cap it into a closed `BrepSolid`
(Grasshopper's Cap Holes) that rounds, Booleans and STEP take.

| Node | Inputs | Here | Exact? | Status |
|---|---|---|---|---|
| Plane Surface | plane (origin, x, y), x and y sizes or domains | `Nodes.plane(origin, x, y, xSize, ySize)` | yes | ✅ |
| 4Point Surface | three or four corners | `Nodes.fourPoint(a, b, c, d?)`: a bilinear patch, a triangle without `d` | yes | ✅ |
| Boundary Surfaces | closed coplanar curves | `Nodes.boundary(curves)`: one planar face per curve, a cone from the region's centroid | yes | ✅ |
| Loft | ordered sections; normal, loose, straight | `Nodes.loft(curves, {type})`; `Nodes.loftSolid` caps closed planar sections | through the sections | ✅ |
| Sweep1 | rail, section, (miter none) | `Nodes.sweep1(rail, section)`; `Nodes.sweep1Solid` caps a closed section, or closes into a ring | within 1e-3 | ✅ |
| Sweep2 | two rails, sections | `Nodes.sweep2(rail1, rail2, sections, {stations})` | at the stations | ✅ |
| Pipe | curve, radius (or start and end radii), caps none, flat, round | `Nodes.pipe(curve, r)`; `Nodes.pipeSolid(curve, r, "flat" \| "round")` | within 1e-3 | ✅ |
| Extrude | base profile, direction vector | `Primitives.extrude` (a closed base gives a capped solid) | yes | ✅ |
| Extrude Point | base profile, apex | `Primitives.extrudePoint` | yes | ✅ |
| Loft, developable | two sections | rulings matched along equal tangent planes | | ○ |
| Sweep1 with miters | a rail with corners | one sweep per smooth piece, mitred at the corners | | ○ |

```ts
import { Make, Nodes } from "verb-nurbs-ts";

const circle = (r, z) => Make.arc( [0, 0, z], [1, 0, 0], [0, 1, 0], r, 0, 2 * Math.PI );
const vase = Nodes.loftSolid( [circle( 10, 0 ), circle( 5, 10 ), circle( 10, 20 )] );   // a closed, capped loft
const handle = Nodes.pipeSolid( Make.arc( [0, 0, 0], [1, 0, 0], [0, 0, 1], 30, 0, Math.PI / 2 ), 5, "round" );
```

How each is built:

- **Boundary Surfaces** fill a curve with the cone from its region's centroid: planar and exact, but the region must be
  star-shaped about that point (convex ones, stars, hearts are). A curve inside another (a hole) is refused, since the
  faces are untrimmed.
- **Loft**: the sections are given the same degree and knots; *normal* interpolates them with a cubic across (fewer
  sections, lower degree), *loose* takes them as the control net across (through the first and last only), *straight*
  rules between consecutive ones. A loft of polygons is one face whose creases are not edges: to round a polygonal
  loft, use `Primitives.loft` on profiles instead.
- **Sweep1** expresses the section in the rotation-minimising frame at the start of the rail and sweeps it with
  `Sweep.surface`, so the section is drawn where it meets the rail, as in Grasshopper.
- **Sweep2** sets a section between the two rails at each station (24 by default): turned to keep its angle to the
  chord and the rails' tangents, scaled to the chord, and blended between the given sections either side; then lofts
  through them. A straight-railed sweep of an arc is the cylinder exactly.
- **Pipe** sweeps a circle (`Sweep.pipe`). Round caps are half-spheres built on the end ring's own control points, so
  they share the ring exactly and are within the pipe's tolerance of the sphere; a closed curve gives a ring.

## Truncation and modification variants

These apply across families, so they are parameters, not separate entries:

| Variant | Applies to | How |
|---|---|---|
| Parallel truncation (frustum) | pyramids, cones, bipyramids | top scale in `prism`, or a profile that stops short of the axis in `revolve` |
| Oblique truncation (cut by a tilted plane) | prisms, pyramids, cylinders, cones | the top section is the plane section of the sides, so it stays exact (an ellipse for a cone) |
| Double truncation | bipyramids, spheres (zones), spindles | both ends |
| Vertex truncation (Conway `t`) | any polyhedron | `Polyhedra.truncate(p, t)` |
| Rectification (Conway `a`) | any polyhedron | `Polyhedra.ambo(p)` |
| Pyramid on every face (Conway `k`) | any polyhedron | `Polyhedra.kis(p, h)` |
| Edge chamfer, edge round | any primitive whose edges are found | `round` (circular, G2, chamfer) |
| Rounded tip, rounded rim | cones, cylinders, prisms | a tangent arc in the profile (`revolve`) or `round` |
| Sector (pie) | cylinders, cones, spheres, tori | an `angle` < 360° with two planar faces |
| Hollow (shell) | any | `shell` feature, or a native `wall` parameter for tubes |
| Draft / taper | prisms | top `scale` or `draft` angle |
| Twist | prisms | `twist` angle; the sides become bilinear (hyperbolic paraboloid) patches |
| Shear (oblique) | prisms, cylinders, cones, pyramids | `shear` of the top, or `apex` offset |

## Known limits

* **Edges between two faces of five sides or more** (a dodecahedron's pentagons, a truncated icosahedron's
  hexagons) are not found by `BrepEdges`, which matches a whole side of one face against a side of the other. They
  cannot be rounded yet. Booleans, STEP and the mesh are not affected.
* **Fillet corners.** Edges that end at an apex (a pyramid's, a cone's tip) or at a vertex where four edges or more
  meet (an octahedron's, an icosahedron's) are left sharp or fail, because `FilletCorner` builds corners of three
  edges only. A tetrahedron's and an I section's corners fail too. Prisms, wedges, boxes, cylinders, cones, tubes,
  lenses, hearts and stars round completely.
* **Polyhedra built with `polyhedron`** round where their faces are all quadrilaterals or triangles (a cube, a
  wedge, a triangular prism), but not where a cap has five sides or more (a hexagonal prism given as a polyhedron):
  the corner blends expect the cap's parameter to run the way the prism builder lays it out. Use `prism` for prisms.
* **Two edges between the same two faces** (a heart's two sides meet at its point and at its dip) are found once.
* **Split caps in STEP.** A profile that is not star-shaped (the I and U sections) is capped by several coplanar
  faces. OpenCascade reads the file as valid but two of those faces lose a few percent of their area (the I section
  comes out at 8328 mm³ for 8400). The mesh, the volume and the B-rep are right; the STEP writer is being looked at.
* **Caps are cones** from an inner point, so a cap's profile must be star-shaped about it, or split (`Profiles.split`).
  Every profile here is; an arbitrary polygon is checked and refused if it is not.
* **Shells** of a `primitive` feature are not built yet (the feature tree offsets boxes, cylinders and pipes only).
