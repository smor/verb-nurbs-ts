// The examples the viewer offers, shared by the page and its worker.

export interface Example { id : string; group : "Curves" | "Surfaces" | "B-reps" | "Meshes"; name : string; note : string }

export const EXAMPLES : Array<Example> = [
    { id : "circle", group : "Curves", name : "Exact circle", note : "A rational quadratic: nine control points, weights √2/2 at the corners. Its curvature comb is a perfect ring." },
    { id : "trefoil", group : "Curves", name : "Interpolated trefoil", note : "A cubic through 24 points of a trefoil knot. The comb shows how evenly the curvature flows." },
    { id : "superellipse", group : "Curves", name : "Fitted superellipse", note : "A periodic cubic through 32 points of a rounded square: the section of the appliance's arch." },
    { id : "rail", group : "Curves", name : "Handle rail", note : "The cubic rail the mug's sculpted grip is swept along." },
    { id : "sphere", group : "Surfaces", name : "Sphere", note : "A rational surface of revolution. Two sides of its domain collapse to the poles, shown in red; its Gaussian curvature is 1/r² everywhere." },
    { id : "torus", group : "Surfaces", name : "Torus", note : "A circle revolved: positive Gaussian curvature outside, negative inside." },
    { id : "saddle", group : "Surfaces", name : "Saddle", note : "A biquadratic patch with negative Gaussian curvature everywhere." },
    { id : "wall", group : "Surfaces", name : "Vessel wall", note : "A loft of fitted sections, periodic around: knot lines show its patches, the colour its waves." },
    { id : "grip", group : "Surfaces", name : "Sculpted grip", note : "A variable-section sweep: a superellipse that swells halfway along the rail." },
    { id : "mug", group : "B-reps", name : "Mug with filleted handle", note : "(body + handle) − cavity. Click a face to see its surface's control net. Gold lines are the fillets' contact curves." },
    { id : "boss1", group : "B-reps", name : "Boss, circular fillet (G1)", note : "A rod on a disc, its foot rounded with a circular arc. Choose zebra stripes: they kink where the fillet meets the disc and the rod (tangent continuous, curvature jumps)." },
    { id : "corners", group : "B-reps", name : "Box, G2 corners", note : "Every edge of a box rounded with curvature-continuous fillets of three radii. Where three meet, a six-sided setback patch joins them, curvature-continuous too: in zebra stripes the reflections run through the corners without a kink." },
    { id : "boss2", group : "B-reps", name : "Boss, G2 fillet", note : "The same rod and disc, rounded with a curvature-continuous section. In zebra stripes they flow through both contact curves without a kink." },
    { id : "lid", group : "B-reps", name : "Appliance lid", note : "(plate + plug) − hollow − hole, the hole's edges rounded." },
    { id : "cup", group : "B-reps", name : "Measuring cup", note : "(teardrop flange + cone) − cavity." },
    { id : "base", group : "B-reps", name : "Appliance base", note : "(block − slab − seat − key pocket) + arch: five fillets, convex and concave." },
    { id : "pipe", group : "B-reps", name : "Capped pipe", note : "A plain solid with no Boolean: a swept tube and two cone caps. Its seam runs along the tube; the caps' centres are poles." },
    { id : "baseMesh", group : "Meshes", name : "Appliance base mesh", note : "The base as triangles, coloured by wall thickness: the distance through the material along the inward normal." },
    { id : "open", group : "Meshes", name : "Mesh with holes", note : "The mug with a few triangles taken out: its open edges are shown in red." },
    { id : "nonManifold", group : "Meshes", name : "Two cubes on one edge", note : "Two cubes that share an edge: four triangles meet there, so the edge is non-manifold." },
];
