# Primitive solids

A library of parameterised solids, each a closed B-rep (`BrepSolid`) that the rest of the library takes as it is:
Booleans, fillets and chamfers of its own edges, shells, STEP export and the makeable verdict. This page is the
catalogue: every family we intend to cover, its parameters, its truncation variants, how exact its NURBS are, and
whether it is built yet.

## Conventions

* **Placement.** Every primitive is built in its own frame: the axis of symmetry (or extrusion) is +z, the base sits
  on z = 0 and the axis passes through the origin. A `transform` (or `BrepSolid.transformed`) places it. Sizes are in
  millimetres.
* **Size.** Polyhedra take a `radius` (circumradius) by default; `edge` and `inradius` are alternatives where a
  family has them. Polygons take the circumradius of their vertices.
* **Exactness.** Each entry says which of three kinds it is:
  * **exact**: planes, bilinear patches and other polynomial surfaces, with no approximation at all;
  * **rational**: conics and quadrics as rational NURBS (circles, ellipses, spheres, cones, tori): exact, with weights;
  * **fitted**: a curve with no rational form (an egg formula, a superellipse), interpolated or approximated to a
    stated tolerance (1e-4 of the solid's size unless given).
* **Faces and names.** Faces carry names that the feature tree uses for persistent naming (`side.3`, `top`,
  `bottom`, `apex`...). Each entry lists them.
* **What makes a valid B-rep here.** A face is a NURBS surface over its whole domain, and neighbouring faces share
  their edges sample for sample (`docs/architecture.md`). So a face is a quadrilateral, a triangle (a quad with one
  side collapsed), a polygon or closed curve capped by a "cone" from an inner point (periodic, with a pole), or a
  surface of revolution (periodic in its angle). Every primitive below is assembled from those.
* **Edges you can round.** `BrepEdges` finds an edge where a whole side of one face runs along a side of another.
  Every edge of a primitive whose faces have at most four sides is found. An edge between two faces of five sides
  or more (a dodecahedron's) is not yet; that is listed under known limits.

## Building blocks

Four constructors build every family in this catalogue. The families are thin parameter layers on top.

| Builder | Input | Output |
|---|---|---|
| `Primitives.polyhedron` | vertices and faces (planar polygons, or non-planar quads as bilinear patches) | one face per polygon: triangles and quads as patches, larger polygons as caps from their centroid |
| `Primitives.prism` | a closed planar profile, a height, and optional taper (top scale), twist and shear | side faces per profile segment (each corner is an edge), a bottom and a top cap; top scale 0 gives a pyramid |
| `Primitives.revolve` | a profile in the (r, z) half-plane of lines and arcs (rational), ending on the axis or closed | one face per profile segment, revolved exactly; points on the axis are poles |
| `Primitives.loft` | closed sections, and caps | one ruled or smooth wall and two caps (later) |

Profiles (`Profiles.*`) are closed planar curves made of segments: polygons, stars, rounded polygons, hearts and
the rest of section 6. A profile keeps its corners, so the prism over it has one side face per segment.

## The catalogue

Status: ✅ built and tested, 🔜 next, ○ planned. Priority runs P1 (first) to P4.

### 1. Boxes and parallelepipeds

| Primitive | Parameters | Faces | Kind | Prio | Status |
|---|---|---|---|---|---|
| Box (cuboid) | `size [w, d, h]`, `centered?` | `-x +x -y +y -z +z` | exact | P1 | ✅ (`BrepSolid.box`) |
| Cube | `edge` | as box | exact | P1 | ○ |
| Wedge (OCC-style) | `dx, dy, dz`, top `xmin, xmax` (and `zmin, zmax`) | 6 or 5 faces | exact | P1 | ○ |
| Parallelepiped | three edge vectors | 6 quads | exact | P2 | ○ |
| Rhombohedron | `edge`, `angle` | 6 rhombi | exact | P3 | ○ |
| Rounded box | box + `radius` (circular / G2 / chamfer) | box + fillets + corners | rational | P1 | via `round` |

### 2. Prisms and extrusions

| Primitive | Parameters | Kind | Prio | Status |
|---|---|---|---|---|
| Right prism over any profile | `profile`, `height` | exact / rational | P1 | ○ |
| Regular n-gonal prism | `sides`, `radius`, `height` | exact | P1 | ○ |
| Oblique prism | `shear [dx, dy]` of the top | exact | P2 | ○ |
| Tapered prism (draft) | `scale` of the top, or `draft` angle | exact | P1 | ○ |
| Twisted prism | `twist` angle (ruled, bilinear sides) | exact | P2 | ○ |
| Antiprism | `sides`, `radius`, `height` | exact | P2 | ○ |
| Hollow prism (tube of any profile) | `profile`, `wall` | exact | P2 | via `shell`, or difference |
| Helical / screw extrusion | `profile`, `pitch`, `turns` | fitted | P4 | ○ |
| Extrude along a curve | `profile`, `path` | fitted | P3 | ○ (`Sweep` exists) |

### 3. Pyramids, cones and their truncations

| Primitive | Parameters | Kind | Prio | Status |
|---|---|---|---|---|
| Pyramid over any profile | `profile`, `height`, `apex [x, y]` offset | exact | P1 | ○ |
| Regular / square / rectangular pyramid | `sides`, `radius` or `size`, `height` | exact | P1 | ○ |
| Frustum (parallel truncation) | `top` scale or `topRadius` | exact | P1 | ○ |
| Obliquely truncated pyramid | cutting plane: `tilt` about x/y at `height` | exact | P2 | ○ |
| Bipyramid (dipyramid) | `sides`, `radius`, `height` up and down | exact | P2 | ○ |
| Elongated / gyroelongated bipyramid | `sides`, `radius`, `prism height` | exact | P3 | ○ |
| Cone (right circular) | `radius`, `height` | rational | P1 | ○ |
| Truncated cone (frustum) | `radius`, `topRadius`, `height` | rational | P1 | ○ |
| Oblique cone | `apex [x, y]` offset | rational | P2 | ○ |
| Elliptic cone / frustum | `rx, ry` | rational | P2 | ○ |
| Cone with a rounded tip | `tip radius` (sphere tangent to the side) | rational | P2 | ○ |
| Cone sector (pie wedge) | `angle` | rational | P3 | ○ |
| Obliquely truncated cone | cutting plane (the top is an ellipse) | rational | P3 | ○ |
| Nose cones / ogives | tangent ogive, secant ogive, elliptical, parabolic, power series, Haack series | rational / fitted | P3 | ○ |

### 4. Cylinders and their cuts

| Primitive | Parameters | Kind | Prio | Status |
|---|---|---|---|---|
| Cylinder | `radius`, `height` | rational | P1 | ○ |
| Elliptic cylinder | `rx, ry`, `height` | rational | P2 | ○ |
| Oblique cylinder | `shear` | rational | P2 | ○ |
| Cylinder sector (pie slice) / half cylinder | `angle` | rational | P2 | ○ |
| Obliquely cut cylinder (ungula base) | cutting plane | rational | P3 | ○ |
| Cylindrical wedge (hoof, ungula) | chord, height | rational | P4 | ○ |
| Capsule (spherocylinder) | `radius`, `length` | rational | P1 | ○ |
| Stadium / slot prism | `length`, `radius`, `height` | rational | P1 | ○ |

### 5. Spheres, quadrics and lenses

| Primitive | Parameters | Kind | Prio | Status |
|---|---|---|---|---|
| Sphere | `radius` | rational | P1 | ○ |
| Hemisphere | `radius` | rational | P1 | ○ |
| Spherical cap (segment of one base) | `radius`, `height` | rational | P1 | ○ |
| Spherical zone (segment of two bases) | `radius`, `z0`, `z1` | rational | P2 | ○ |
| Spherical sector (cone + cap) | `radius`, `angle` | rational | P2 | ○ |
| Spherical wedge (lune) | `radius`, `angle` | rational | P3 | ○ |
| Spherical shell | `radius`, `wall` | rational | P2 | via `shell` / difference |
| Ellipsoid | `rx, ry, rz` | rational | P1 | ○ |
| Spheroid, oblate / prolate | `radius`, `height` | rational | P1 | ○ |
| Paraboloid (solid, capped) | `radius`, `height` | rational (a parabola is a quadratic Bézier) | P2 | ○ |
| Hyperboloid of one sheet (capped) | `waist`, `radius`, `height` | rational | P3 | ○ |
| Lens (two spherical caps) | `r1`, `r2`, `diameter` | rational | P2 | ○ |
| Spindle / lemon (inner spindle torus) | `radius`, `height` | rational | P3 | ○ |
| Apple (outer spindle torus) | `R`, `r` | rational | P4 | ○ |

### 6. Profiles for extrusion (planar shapes)

Each is a `Profile`, closed and counter-clockwise, to extrude, taper into a pyramid, revolve (when it lies on one
side of the axis) or use as a section.

| Profile | Parameters | Kind | Prio | Status |
|---|---|---|---|---|
| Regular polygon | `sides`, `radius` (or `edge`, `inradius`), `rotation` | exact | P1 | ○ |
| Rectangle, square | `w`, `h` | exact | P1 | ○ |
| Rounded rectangle / rounded polygon | `corner radius` (tangent arcs) | rational | P1 | ○ |
| Star polygon | `points`, `outer`, `inner` radius (or Schläfli `{n/k}`) | exact | P1 | ○ |
| Rounded star | star + `corner radius` | rational | P3 | ○ |
| Circle, ellipse | `radius` / `rx, ry` | rational | P1 | ○ |
| Stadium (slot) | `length`, `radius` | rational | P1 | ○ |
| Heart | `width`, `height`, `lobe` | rational (two arcs and two lines) | P1 | ○ |
| Heart, smooth (classic curve) | `size` | fitted | P3 | ○ |
| Cross / plus | `arm length`, `arm width` | exact | P2 | ○ |
| Arrow | `length`, `shaft`, `head` | exact | P3 | ○ |
| Structural sections: L, T, I (H), U (C), Z | flanges, web, thickness | exact | P2 | ○ |
| Hollow sections: RHS, CHS, annulus | outer, wall | exact / rational | P2 | as two prisms and a difference |
| Superellipse (squircle, Lamé) | `rx, ry`, `exponent` | fitted | P3 | ○ |
| Reuleaux polygon | `sides` (odd), `width` | rational | P3 | ○ |
| Crescent, lune | `r1`, `r2`, offset | rational | P3 | ○ |
| Gear (spur, involute teeth) | `teeth`, `module`, `pressure angle` | fitted | P4 | ○ |
| Rose, epicycloid, cardioid, flower | lobes, amplitude | fitted | P4 | ○ |
| Any polyline or closed NURBS | points, curve | — | P1 | ○ |

### 7. Tori, rings and tubes

| Primitive | Parameters | Kind | Prio | Status |
|---|---|---|---|---|
| Torus (ring) | `R` (major), `r` (minor) | rational | P1 | ○ |
| Elliptic-section torus | `R`, `rr, rz` | rational | P3 | ○ |
| Torus of any section (D-ring, comfort-fit) | `R`, section profile | rational | P2 | ○ |
| Torus sector (elbow, with caps) | `R`, `r`, `angle` | rational | P2 | ○ |
| Horn / spindle torus | `R ≤ r` | — | — | not a valid solid (self-touching); the spindle's lemon and apple are in section 5 |
| Tube (annular cylinder, washer) | `outer`, `inner`, `height` | rational | P1 | ○ |
| Conical tube (hollow frustum) | radii at both ends, `wall` | rational | P2 | ○ |
| Pipe along a path | `through`, `radius` | fitted | — | ✅ (`pipe` feature) |
| Hollow pipe, elbow tube | `outer`, `inner` | fitted / rational | P3 | ○ |
| Coil spring (helical pipe) | `radius`, `wire`, `pitch`, `turns` | fitted | P3 | ○ (sweep exists) |
| Knot tubes (torus knots) | `p, q` | fitted | — | ✅ (`SweptObjects`) |

### 8. Eggs and ovoids

| Primitive | Parameters | Kind | Prio | Status |
|---|---|---|---|---|
| Two-ellipsoid egg | `radius`, `top height`, `bottom height` (two half-spheroids, G1 at the equator) | rational | P1 | ○ |
| Moss's egg (four arcs, pointed) | `radius` | rational | P2 | ○ |
| Hügelschäffer egg | `a`, `b`, `w` (shift of the widest section) | fitted | P2 | ○ |
| Narushin universal egg | `L`, `B`, `w`, `D_L/4` | fitted | P4 | ○ |
| Cassini oval of revolution | `a`, `b` | fitted | P4 | ○ |

### 9. Regular and semi-regular polyhedra

All built from `Primitives.polyhedron` with exact vertex coordinates (golden ratio where needed), scaled to a
circumradius.

| Family | Members | Prio | Status |
|---|---|---|---|
| Platonic | tetrahedron, cube, octahedron, dodecahedron, icosahedron | P1 | ○ |
| Archimedean | truncated tetrahedron, cuboctahedron, truncated cube, truncated octahedron, rhombicuboctahedron, truncated cuboctahedron, snub cube, icosidodecahedron, truncated dodecahedron, truncated icosahedron, rhombicosidodecahedron, truncated icosidodecahedron, snub dodecahedron | P2 | ○ |
| Catalan (duals) | triakis tetrahedron, rhombic dodecahedron, ..., pentagonal hexecontahedron | P3 | ○ |
| Prisms, antiprisms, bipyramids, trapezohedra | `sides` | P2 | ○ |
| Johnson solids | J1–J92; first the pyramids, cupolae and rotundae | P4 | ○ |
| Zonohedra | rhombic dodecahedron, rhombic triacontahedron | P3 | ○ |
| Kepler–Poinsot, stellations | small stellated dodecahedron, stella octangula, ... | P4 | ○ (as unions of pyramids) |
| Dice | d4, d6, d8, d10 (trapezohedron), d12, d20 | P3 | ○ |
| Convex hull of points | `points` | P2 | ○ |

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

* An edge between two faces that both have five sides or more (a dodecahedron's pentagons, a truncated
  icosahedron's hexagons) is not found by `BrepEdges`, so it cannot be rounded yet. Booleans, shells, STEP and the
  mesh are not affected.
* Caps are cones from an inner point, so a cap's profile must be star-shaped about that point. Every profile in
  section 6 is; an arbitrary polygon is checked and refused if it is not.
* Fillet corners where more than three edges meet (an octahedron's or an icosahedron's vertices, a pyramid's apex
  with more than three sides) are not built by `FilletCorner`.
