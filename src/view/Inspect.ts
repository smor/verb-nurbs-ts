import { NurbsCurveData, NurbsSurfaceData, Point, UV } from "../core/Data.js";
import { Vec } from "../core/Vec.js";
import { Analyze } from "../eval/Analyze.js";
import { Eval } from "../eval/Eval.js";
import { Ribbon, Transfinite } from "../eval/Transfinite.js";
import { BrepSolid } from "../solid/Brep.js";
import { BooleanResult, BrepBoolean } from "../solid/BrepBoolean.js";
import { MeshBVH } from "../solid/MeshBVH.js";
import { SurfaceLoops } from "../solid/SurfaceLoops.js";
import { TriMesh } from "../solid/TriMesh.js";

// What a viewer draws, as plain arrays: no rendering library, so it can be built in a worker or in Node and checked.
//
// A view is a set of layers that can be toggled, and a list of items that can be picked. Each layer is points, line
// segments or triangles. A triangle or segment can name the item it belongs to (`pick`); picking it shows the item's
// facts and its own overlay layers (say, the control net of one face of a B-rep).

export type LayerKind = "points" | "lines" | "mesh";

export interface ViewLayer {
    name : string;
    kind : LayerKind;
    // a colour as "#rrggbb"; meshes use it unless they carry fields or per-item colours
    color : string;
    visible : boolean;
    // vertex positions, flattened (x, y, z, x, y, z, ...)
    positions : Array<number>;
    // for "lines": pairs of vertex indices; for "mesh": triples. Points use every vertex
    indices? : Array<number>;
    // for meshes: the exact unit normal of the surface at each vertex, flattened, so shading, zebra stripes and
    // isophotes show the surface and not its tessellation
    normals? : Array<number>;
    // for each segment (lines) or triangle (mesh), the index of its item in `View.items`
    pick? : Array<number>;
    // scalar fields per vertex, by name, shown with a colour map (meshes) or as point sizes (points)
    fields? : { [name : string] : { values : Array<number>, unit : string, symmetric : boolean } };
    // for meshes: a colour per item, used when no field is shown
    itemColors? : boolean;
    // dashed lines (seams)
    dashed? : boolean;
}

// A layer that carries indices (lines and meshes), as the builders below return it.
export type IndexedLayer = ViewLayer & { indices : Array<number> };

export interface ViewItem {
    label : string;
    type : string;
    // facts to list, in order
    facts : Array<[string, string]>;
    // layers shown only while the item is picked
    overlay : Array<ViewLayer>;
}

export interface View {
    title : string;
    kind : "curve" | "surface" | "brep" | "mesh";
    layers : Array<ViewLayer>;
    items : Array<ViewItem>;
    // facts about the whole object
    facts : Array<[string, string]>;
}

/** What `Inspect.brep` draws on (#90). */
export interface BrepViewOptions {
    // a mesh of the result to draw instead of its own (as the export mesh, `GraphMesh`): its triangles, and for each
    // the index of the result's face it stands for (`GraphMesh.faceOf`)
    mesh? : { mesh : TriMesh, faceOf? : Array<number>, tolerance? : { chordal : number } | null };
    // how closely the edges and knot lines follow their curves on such a mesh (default: the mesh's own chordal
    // tolerance, or 0.1 mm); on the result's own mesh they are sampled densely, as before
    tolerance? : number;
}

export interface InspectOptions {
    // samples along a curve, or per direction on a surface (default 200 and 64)
    samples? : number;
    // length of the longest curvature comb tooth, as a fraction of the object's size (default 0.15)
    comb? : number;
}

const COLORS = {
    curve : "#1f2937", polygon : "#e07a1f", points : "#c2410c", knots : "#2563eb", comb : "#7c3aed",
    surface : "#8fb8c9", net : "#e07a1f", knotLines : "#2563eb", iso : "#64748b", normals : "#059669", poles : "#dc2626",
    trim : "#111827", natural : "#475569", seam : "#0891b2", fillet : "#d4a017", wire : "#334155", open : "#dc2626",
    nonManifold : "#db2777", thin : "#f97316"
};

export class Inspect {

    // ---------- NURBS curves ----------

    public static curve( c : NurbsCurveData, title? : string, options? : InspectOptions ) : View {
        const o = options != null ? options : {};
        const n = o.samples != null ? o.samples : 200;
        const u0 = c.knots[0], u1 = c.knots[c.knots.length - 1];
        const cps = Inspect.dehomogenize( c.controlPoints );
        const weights = c.controlPoints.map( p => p[p.length - 1] );
        const size = Inspect.size( cps );

        const curve = Inspect.lines( "Curve", COLORS.curve, true );
        const comb = Inspect.lines( "Curvature comb", COLORS.comb, false );
        const kappa : Array<number> = [], pts : Array<Point> = [], normals : Array<Point> = [];
        for (let i = 0; i <= n; i++) {
            const u = u0 + (u1 - u0) * i / n;
            const d = Eval.rationalCurveDerivatives( c, u, 2 );
            pts.push( d[0] );
            const k = Inspect.curvature( d[1], d[2] );
            kappa.push( k.kappa ); normals.push( k.normal );
            if (i > 0) Inspect.segment( curve, pts[i - 1], pts[i] );
        }
        const kmax = Math.max( 1e-12, ...kappa.filter( isFinite ) );
        const scale = (o.comb != null ? o.comb : 0.15) * size / kmax;
        const tips : Array<Point> = [];
        for (let i = 0; i <= n; i++) {
            const tip = isFinite( kappa[i] ) ? Vec.sub( pts[i], Vec.mul( scale * kappa[i], normals[i] ) ) : pts[i];
            tips.push( tip );
            Inspect.segment( comb, pts[i], tip );
            if (i > 0) Inspect.segment( comb, tips[i - 1], tip );
        }

        const polygon = Inspect.lines( "Control polygon", COLORS.polygon, true );
        for (let i = 1; i < cps.length; i++) Inspect.segment( polygon, cps[i - 1], cps[i] );
        const points = Inspect.points( "Control points", COLORS.points, cps, true );
        points.fields = { weight : { values : weights, unit : "", symmetric : false } };

        const mult = Analyze.knotMultiplicities( c.knots );
        const knots = Inspect.points( "Knots", COLORS.knots, mult.map( m => Eval.rationalCurvePoint( c, m.knot ) ), true );

        const rational = weights.some( w => Math.abs( w - 1 ) > 1e-12 );
        const closed = Vec.dist( pts[0], pts[n] ) < 1e-9 * (1 + size);
        const facts : Array<[string, string]> = [
            ["Type", rational ? "Rational B-spline (NURBS) curve" : "Non-rational B-spline curve"],
            ["Degree", String( c.degree )],
            ["Control points", String( cps.length )],
            ["Knots", mult.map( m => Inspect.num( m.knot ) + (m.mult > 1 ? " ×" + m.mult : "") ).join( ", " )],
            ["Spans", String( Math.max( 1, mult.length - 1 ) )],
            ["Weights", rational ? Inspect.num( Math.min( ...weights ) ) + " to " + Inspect.num( Math.max( ...weights ) ) : "all 1"],
            ["Closed", closed ? "yes" : "no"],
            ["Length", Inspect.num( Analyze.rationalCurveArcLength( c ) )],
            ["Largest curvature", Inspect.num( kmax ) + " (radius " + Inspect.num( 1 / kmax ) + ")"],
        ];
        return { title : title != null ? title : "NURBS curve", kind : "curve", layers : [curve, polygon, points, knots, comb], items : [], facts : facts };
    }

    // ---------- NURBS surfaces ----------

    public static surface( s : NurbsSurfaceData, title? : string, options? : InspectOptions ) : View {
        const o = options != null ? options : {};
        const n = o.samples != null ? o.samples : 64;
        const item : ViewItem = { label : title != null ? title : "Surface", type : "NURBS surface", facts : Inspect.surfaceFacts( s ), overlay : [] };
        const shaded = Inspect.surfaceMesh( s, n, n );
        shaded.layer.pick = shaded.layer.indices.filter( (_, k) => k % 3 == 0 ).map( () => 0 );
        const cps = s.controlPoints.map( row => Inspect.dehomogenize( row ) );
        const size = Inspect.size( ([] as Array<Point>).concat( ...cps ) );
        const layers = [shaded.layer, Inspect.knotLines( s ), Inspect.isocurves( s, 10 ), Inspect.controlNet( s, true ), Inspect.controlPoints( s, true ),
                      Inspect.normals( s, 12, 0.06 * size ), Inspect.poles( s )];
        return { title : item.label, kind : "surface", layers : layers, items : [item], facts : item.facts };
    }

    // ---------- B-reps ----------

    // A B-rep: a Boolean's result (its trimmed faces, edges, seams and fillets) or a solid, which is shown as the result
    // of a Boolean of itself alone. It is drawn on the result's own mesh, or on `options.mesh` (#90): an export mesh,
    // as `Graph.evaluate( doc, { mesh : "view" } ).export`, many times lighter, with the same faces, facts, nets,
    // curvature (sampled at its vertices) and picking, its triangles mapped to the result's faces by `faceOf`.
    public static brep( b : BooleanResult | BrepSolid, title? : string, options : BrepViewOptions = {} ) : View {
        const r : BooleanResult = b instanceof BrepSolid ? BrepBoolean.evaluate( [b], f => f[0] ) : b;
        const given = options.mesh;
        if (given != null && (given.faceOf == null || given.faceOf.length != given.mesh.triangles.length || given.faceOf.some( f => !(f >= 0 && f < r.faces.length) )))
            throw new Error( "Inspect.brep: the mesh given needs faceOf, a face of the result for each of its triangles (a Graph export mesh of this result has it)" );
        const m = given != null ? given.mesh : r.mesh, faceOf = given != null ? given.faceOf as Array<number> : r.faceOf;
        const faces = Inspect.exactFaces( r, given != null ? { mesh : m, faceOf : faceOf } : undefined );
        // on a lean mesh, lines follow their curves to its tolerance, with their points shared
        const lean = given != null ? options.tolerance ?? given.tolerance?.chordal ?? 0.1 : null;

        // area per face
        const area = r.faces.map( () => 0 );
        m.triangles.forEach( (t, k) => {
            const a = m.vertices[t[0]], bb = m.vertices[t[1]], c = m.vertices[t[2]];
            area[faceOf[k]] += Vec.norm( Vec.cross( Vec.sub( bb, a ), Vec.sub( c, a ) ) ) / 2;
        } );

        // edges, from each face's boundary loops in (u, v): a segment along a periodic side of the domain is a seam,
        // along another side of the domain a natural edge, and anywhere else a trim
        const trim = Inspect.lines( "Trim edges", COLORS.trim, true );
        const natural = Inspect.lines( "Natural edges", COLORS.natural, true );
        const seam = Inspect.lines( "Seams", COLORS.seam, true ); seam.dashed = true;
        const filletEdges = Inspect.lines( "Fillets", COLORS.fillet, true );
        const items : Array<ViewItem> = r.faces.map( (f, fi) => {
            const s = f.surface;
            const d = [s.knotsU[0], s.knotsU[s.knotsU.length - 1], s.knotsV[0], s.knotsV[s.knotsV.length - 1]];
            const per = [Analyze.isRationalSurfaceClosed( s, true ), Analyze.isRationalSurfaceClosed( s, false )];
            const tol = 1e-9 * (1 + Math.abs( d[1] - d[0] ) + Math.abs( d[3] - d[2] ));
            const on = (uv : Array<number>) => [Math.abs( uv[0] - d[0] ) < tol || Math.abs( uv[0] - d[1] ) < tol,
                                              Math.abs( uv[1] - d[2] ) < tol || Math.abs( uv[1] - d[3] ) < tol];
            // sides of the domain that collapse to a point: the mesh fans out from there, and those fan edges are no edges
            const pole = (f : (t : number) => Point) => { const a = f( 0 ); for (let k = 1; k <= 6; k++) if (Vec.dist( a, f( k / 6 ) ) > 1e-9 * (1 + Vec.norm( a ))) return false; return true; };
            const poleSide = [pole( t => Eval.rationalSurfacePoint( s, d[0], d[2] + (d[3] - d[2]) * t ) ), pole( t => Eval.rationalSurfacePoint( s, d[1], d[2] + (d[3] - d[2]) * t ) ),
                            pole( t => Eval.rationalSurfacePoint( s, d[0] + (d[1] - d[0]) * t, d[2] ) ), pole( t => Eval.rationalSurfacePoint( s, d[0] + (d[1] - d[0]) * t, d[3] ) )];
            const atPole = (uv : Array<number>) => (poleSide[0] && Math.abs( uv[0] - d[0] ) < tol) || (poleSide[1] && Math.abs( uv[0] - d[1] ) < tol)
                || (poleSide[2] && Math.abs( uv[1] - d[2] ) < tol) || (poleSide[3] && Math.abs( uv[1] - d[3] ) < tol);
            const edges = { trim : 0, natural : 0, seam : 0 }; // lengths
            // (lean: each run of one kind as a polyline, thinned to the tolerance)
            let run : { layer : IndexedLayer, pts : Array<Point> } | null = null;
            const flush = () => { if (run != null && lean != null) Inspect.polyline( run.layer, Inspect.thin( run.pts, lean ) ); run = null; };
            const step = Math.max( Math.abs( d[1] - d[0] ), Math.abs( d[3] - d[2] ) ) / 96;
            for (const loop of f.loops) for (let k = 0; k < loop.length; k++) {
                const a = loop[k], c = loop[(k + 1) % loop.length];
                if (atPole( a ) || atPole( c )) continue;
                const oa = on( a ), oc = on( c );
                const alongU = oa[0] && oc[0] && Math.abs( a[0] - c[0] ) < tol, alongV = oa[1] && oc[1] && Math.abs( a[1] - c[1] ) < tol;
                const kind : "trim" | "natural" | "seam" = alongU || alongV ? ((alongU && per[0]) || (alongV && per[1]) ? "seam" : "natural") : "trim";
                // a seam is the same curve on both of its sides of the domain: draw it from the lower side only
                if (kind == "seam" && (alongU ? Math.abs( a[0] - d[1] ) < tol : Math.abs( a[1] - d[3] ) < tol)) continue;
                const layer = kind == "trim" ? trim : kind == "seam" ? seam : natural;
                // a side of the domain can be long in (u, v) and still a curve in space: sample it
                const n = Math.max( 1, Math.ceil( Math.hypot( c[0] - a[0], c[1] - a[1] ) / step ) );
                let prev = Eval.rationalSurfacePoint( s, a[0], a[1] );
                for (let j = 1; j <= n; j++) {
                    const t = j / n;
                    const p = Eval.rationalSurfacePoint( s, a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t );
                    const len = Vec.dist( prev, p );
                    if (len > 1e-12) { // nothing at a pole
                        edges[kind] += len;
                        if (lean == null) Inspect.segment( layer, prev, p );
                        else {
                            if (run == null || run.layer != layer || Vec.dist( run.pts[run.pts.length - 1], prev ) > 1e-9 * (1 + Vec.norm( prev ))) { flush(); run = { layer : layer, pts : [prev] }; }
                            run.pts.push( p );
                        }
                    }
                    prev = p;
                }
            }
            flush();
            const facts : Array<[string, string]> = [
                ["Face", f.name != "" ? f.name : "face " + f.face],
                ["From", f.solid < 0 ? "a rolling-ball fillet" : "solid " + f.solid + ", face " + f.face],
                ["Area", Inspect.num( area[fi] )],
                ["Boundary loops", String( f.loops.length )],
                ["Edge length", Inspect.num( edges.trim ) + " trimmed, " + Inspect.num( edges.natural ) + " natural, " + Inspect.num( edges.seam ) + " on seams"],
                ["Orientation", f.reversed ? "normal reversed" : "normal as dS/du × dS/dv"],
            ].concat( Inspect.surfaceFacts( s ) ) as Array<[string, string]>;
            return { label : f.name != "" ? f.name : "face " + fi, type : f.solid < 0 ? "Fillet face" : "Trimmed face", facts : facts,
                     overlay : [Inspect.controlNet( s, true ), Inspect.controlPoints( s, true ), Inspect.knotLines( s, lean ?? undefined )] };
        } );
        // the fillets' rails: the contact curves on either side
        for (const fl of r.fillets) {
            const secs = fl.blend.sections;
            for (let k = 0; k < (fl.blend.closed ? secs.length : secs.length - 1); k++) {
                const a = secs[k], b = secs[(k + 1) % secs.length];
                Inspect.segment( filletEdges, a.pa, b.pa ); Inspect.segment( filletEdges, a.pb, b.pb );
            }
        }

        const rep = r.report;
        const facts : Array<[string, string]> = [
            ["Faces", r.faces.length + " (" + r.faces.filter( f => f.solid < 0 ).length + " fillets)"],
            ["Intersection curves", String( rep.intersectionCurves )],
            ["Fillets", rep.fillets + " rounded, " + rep.filletsFailed + " too large, " + rep.filletsSkipped + " left sharp at corners"],
            ["Seam error", rep.maxCurveError.toExponential( 1 )],
            ["Watertight", rep.manifold.closedManifold ? "yes" : "no"],
            ["Genus", rep.manifold.genus != null ? String( rep.manifold.genus ) : "-"],
            ["Volume", Inspect.num( rep.volume )],
        ];
        if (given != null) facts.push( ["Drawn on", m.triangles.length + " triangles (the result's own mesh: " + r.mesh.triangles.length + ")"] );
        const view : View = { title : title != null ? title : "B-rep", kind : "brep", layers : [faces, trim, natural, seam, filletEdges], items : items, facts : facts };
        // a lean view's numbers to what can be seen: positions to a micrometre, normals and fields to four digits
        if (lean != null) {
            const um = (x : number) => Math.round( x * 1e3 ) / 1e3, four = (x : number) => isFinite( x ) ? Number( x.toPrecision( 4 ) ) : x;
            for (const l of view.layers.concat( ...items.map( it => it.overlay ) )) {
                l.positions = l.positions.map( um );
                if (l.normals != null) l.normals = l.normals.map( four );
                if (l.fields != null) for (const k in l.fields) l.fields[k].values = l.fields[k].values.map( four );
            }
        }
        return view;
    }

    // The faces of a B-rep as one mesh layer with a vertex per triangle corner (a vertex on an edge belongs to two
    // faces, with two normals), carrying each corner's exact normal and its Gaussian and mean curvature. Trimmed faces
    // know their corners' parameters; the meshes of fillets and corners are built in space, so their vertices are
    // projected onto their surfaces.
    // (On another mesh than the result's, `on`, every corner is projected: the parameters the Boolean kept are its own
    // mesh's.)
    public static exactFaces( r : BooleanResult, on? : { mesh : TriMesh, faceOf : Array<number> } ) : IndexedLayer {
        const m = on != null ? on.mesh : r.mesh, faceOf = on != null ? on.faceOf : r.faceOf;
        const l : IndexedLayer = { name : "Faces", kind : "mesh", color : COLORS.surface, visible : true, positions : [], indices : [] };
        l.pick = faceOf.slice();
        l.itemColors = true;
        const normals : Array<number> = [], gauss : Array<number> = [], mean : Array<number> = [];
        const projected = new Map<string, UV>();
        const seeds = new Map<number, Array<{ uv : UV, p : Point }>>();
        const uvOf = (fi : number, vi : number) : UV | null => {
            const key = fi + ":" + vi;
            const known = projected.get( key );
            if (known != null) return known;
            const s = r.faces[fi].surface, p = m.vertices[vi];
            let sd = seeds.get( fi );
            if (sd == null) {
                sd = [];
                const d = [s.knotsU[0], s.knotsU[s.knotsU.length - 1], s.knotsV[0], s.knotsV[s.knotsV.length - 1]];
                for (let i = 0; i <= 16; i++) for (let j = 0; j <= 16; j++) {
                    const uv : UV = [d[0] + (d[1] - d[0]) * i / 16, d[2] + (d[3] - d[2]) * j / 16];
                    sd.push( { uv : uv, p : Eval.rationalSurfacePoint( s, uv[0], uv[1] ) } );
                }
                seeds.set( fi, sd );
            }
            let best = sd[0];
            for (const x of sd) if (Vec.distSquared( x.p, p ) < Vec.distSquared( best.p, p )) best = x;
            // a closed blend (a fillet all the way round) wraps across its seam instead of stopping at it
            const periodic : [boolean, boolean] = [Analyze.isRationalSurfaceClosed( s, true ), Analyze.isRationalSurfaceClosed( s, false )];
            const uv = SurfaceLoops.project( { surface : s, periodic : periodic }, p, best.uv );
            if (uv != null) projected.set( key, uv );
            return uv;
        };
        // setback corners: the exact transfinite patch, by face
        const patchOf = new Map<number, Array<Ribbon>>();
        for (const c of r.corners) if (c.ribbons != null) for (const fi of c.faces) patchOf.set( fi, c.ribbons );
        m.triangles.forEach( (t, k) => {
            const fi = faceOf[k], f = r.faces[fi];
            const a = m.vertices[t[0]], b = m.vertices[t[1]], c = m.vertices[t[2]];
            const flat = Vec.normalized( Vec.cross( Vec.sub( b, a ), Vec.sub( c, a ) ) );
            const cuv = on == null && r.cornerUV != null ? r.cornerUV[k] : null;
            const xy = on == null && r.patchXY != null ? r.patchXY[k] : null, ribbons = patchOf.get( fi );
            for (let x = 0; x < 3; x++) {
                const p = m.vertices[t[x]];
                l.indices.push( l.positions.length / 3 );
                l.positions.push( p[0], p[1], p[2] );
                let n = flat, g = NaN, h = NaN;
                // a setback corner's derivatives from its exact patch; any other face's from its surface
                const uv = xy != null || cuv != null ? (cuv != null ? cuv[x] : null) : uvOf( fi, t[x] );
                const d = xy != null && ribbons != null ? Inspect.patchDerivatives( ribbons, xy[x] )
                    : uv != null ? Eval.rationalSurfaceDerivatives( f.surface, uv[0], uv[1], 2 ) : null;
                if (d != null) {
                    const raw = Vec.cross( d[1][0], d[0][1] ), ln = Vec.norm( raw );
                    if (ln > 1e-12 * (Vec.dot( d[1][0], d[1][0] ) + Vec.dot( d[0][1], d[0][1] ))) {
                        // the face's outward side: its surface normal, or the opposite for a reversed face; checked
                        // against the triangle so a face whose orientation flag disagrees still shades right
                        n = Vec.mul( 1 / ln, raw );
                        if (Vec.dot( n, flat ) < 0) n = Vec.mul( -1, n );
                        const cv = Inspect.surfaceCurvature( d );
                        g = cv.gauss;
                        // mean curvature, signed for the outward normal (positive where the surface bulges out)
                        h = Vec.dot( Vec.normalized( raw ), n ) > 0 ? -cv.mean : cv.mean;
                    }
                }
                normals.push( n[0], n[1], n[2] );
                gauss.push( g ); mean.push( h );
            }
        } );
        l.normals = normals;
        l.fields = {
            "Gaussian curvature" : { values : gauss, unit : "1/mm²", symmetric : true },
            "mean curvature" : { values : mean, unit : "1/mm", symmetric : true },
        };
        return l;
    }

    // Derivatives of a transfinite patch at a point of its polygon, in the layout of
    // `Eval.rationalSurfaceDerivatives` (d[i][j]: i times along x, j times along y), by central differences. A point
    // on the boundary is first moved a step inside, where the patch is defined on both sides; a vertex of the polygon,
    // where Kato's blends are singular (0/0), a larger step (1% of a side).
    private static patchDerivatives( ribbons : Array<Ribbon>, at : [number, number] ) : Array<Array<Point>> {
        const P = Transfinite.polygon( ribbons.length );
        const h = 1e-4;
        const near = Transfinite.distances( P, at ).filter( v => v < 1e-9 ).length;
        const step = near >= 2 ? 1e-2 : 3 * h;
        const cx = P.reduce( (s, v) => s + v[0], 0 ) / P.length, cy = P.reduce( (s, v) => s + v[1], 0 ) / P.length;
        const toC = Math.hypot( cx - at[0], cy - at[1] );
        const x0 = toC > step ? at[0] + step * (cx - at[0]) / toC : at[0], y0 = toC > step ? at[1] + step * (cy - at[1]) / toC : at[1];
        const E = (dx : number, dy : number) => Transfinite.evaluate( ribbons, [x0 + dx * h, y0 + dy * h], P );
        const c = E( 0, 0 ), xp = E( 1, 0 ), xm = E( -1, 0 ), yp = E( 0, 1 ), ym = E( 0, -1 );
        const pp = E( 1, 1 ), pm = E( 1, -1 ), mp = E( -1, 1 ), mm = E( -1, -1 );
        const Su = Vec.mul( 0.5 / h, Vec.sub( xp, xm ) ), Sv = Vec.mul( 0.5 / h, Vec.sub( yp, ym ) );
        const Suu = Vec.mul( 1 / (h * h), Vec.add( Vec.sub( xp, Vec.mul( 2, c ) ), xm ) );
        const Svv = Vec.mul( 1 / (h * h), Vec.add( Vec.sub( yp, Vec.mul( 2, c ) ), ym ) );
        const Suv = Vec.mul( 0.25 / (h * h), Vec.sub( Vec.add( pp, mm ), Vec.add( pm, mp ) ) );
        return [[c, Sv, Svv], [Su, Suv], [Suu]];
    }

    // ---------- meshes ----------

    // A triangle mesh: its wireframe, open and non-manifold edges, and its wall thickness at each vertex (the distance
    // to the opposite wall along the inward normal).
    public static mesh( m : TriMesh, title? : string, options? : { thickness? : boolean } ) : View {
        const shaded = Inspect.meshLayer( "Mesh", COLORS.surface, m );
        const wire = Inspect.lines( "Wireframe", COLORS.wire, false );
        const open = Inspect.lines( "Open edges", COLORS.open, true );
        const bad = Inspect.lines( "Non-manifold edges", COLORS.nonManifold, true );
        for (const l of [wire, open, bad]) l.positions = shaded.positions;
        const count = new Map<string, Array<number>>();
        for (const t of m.triangles) for (let k = 0; k < 3; k++) {
            const a = t[k], b = t[(k + 1) % 3];
            const key = a < b ? a + "," + b : b + "," + a;
            let e = count.get( key );
            if (e == null) { e = [Math.min( a, b ), Math.max( a, b ), 0]; count.set( key, e ); }
            e[2]++;
        }
        let nOpen = 0, nBad = 0;
        count.forEach( e => {
            wire.indices.push( e[0], e[1] );
            if (e[2] == 1) { open.indices.push( e[0], e[1] ); nOpen++; }
            else if (e[2] > 2) { bad.indices.push( e[0], e[1] ); nBad++; }
        } );

        const layers = [shaded, wire, open, bad];
        const rep = m.checkClosedManifold();
        const bb = m.boundingBox();
        const facts : Array<[string, string]> = [
            ["Vertices", String( m.vertices.length )],
            ["Triangles", String( m.triangles.length )],
            ["Open edges", String( nOpen )],
            ["Non-manifold edges", String( nBad )],
            ["Watertight", rep.closedManifold ? "yes" : "no"],
            ["Genus", rep.genus != null && isFinite( rep.genus ) ? String( rep.genus ) : "-"],
            ["Volume", rep.closedManifold ? Inspect.num( m.signedVolume() ) : "- (not closed)"],
            ["Area", Inspect.num( m.area() )],
            ["Size", [0, 1, 2].map( k => Inspect.num( bb.max[k] - bb.min[k] ) ).join( " × " )],
        ];
        if (options == null || options.thickness !== false) {
            const th = Inspect.thickness( m );
            shaded.fields = { thickness : { values : th, unit : "mm", symmetric : false } };
            const fin = th.filter( isFinite ).sort( (a, b) => a - b );
            if (fin.length > 0) facts.push( ["Wall thickness", Inspect.num( fin[0] ) + " to " + Inspect.num( fin[fin.length - 1] ) + ", median " + Inspect.num( fin[fin.length >> 1] )] );
        }
        return { title : title != null ? title : "Mesh", kind : "mesh", layers : layers, items : [], facts : facts };
    }

    // The wall thickness at each vertex: cast a ray from just inside the surface along the inward vertex normal
    public static thickness( m : TriMesh ) : Array<number> {
        const bvh = new MeshBVH( m );
        const nrm = m.vertices.map( () => [0, 0, 0] as Point );
        // angle-weighted vertex normals, which do not depend on how the faces are split into triangles
        for (const t of m.triangles) {
            const p = [m.vertices[t[0]], m.vertices[t[1]], m.vertices[t[2]]];
            const fn = Vec.cross( Vec.sub( p[1], p[0] ), Vec.sub( p[2], p[0] ) );
            const l = Vec.norm( fn );
            if (l == 0) continue;
            for (let k = 0; k < 3; k++) {
                const e1 = Vec.normalized( Vec.sub( p[(k + 1) % 3], p[k] ) ), e2 = Vec.normalized( Vec.sub( p[(k + 2) % 3], p[k] ) );
                const angle = Math.acos( Math.max( -1, Math.min( 1, Vec.dot( e1, e2 ) ) ) );
                nrm[t[k]] = Vec.add( nrm[t[k]], Vec.mul( angle / l, fn ) );
            }
        }
        const bb = m.boundingBox();
        const eps = Vec.dist( bb.min, bb.max ) * 1e-6;
        return m.vertices.map( (p, i) => {
            const l = Vec.norm( nrm[i] );
            if (l == 0) return Infinity;
            const d = Vec.mul( -1 / l, nrm[i] );
            const t = bvh.raycast( Vec.add( p, Vec.mul( eps, d ) ), d, 0 );
            return isFinite( t ) ? t + eps : Infinity;
        } );
    }

    // ---------- pieces ----------

    // Facts about one NURBS surface
    public static surfaceFacts( s : NurbsSurfaceData ) : Array<[string, string]> {
        const w = ([] as Array<number>).concat( ...s.controlPoints.map( row => row.map( p => p[p.length - 1] ) ) );
        const rational = w.some( x => Math.abs( x - 1 ) > 1e-12 );
        const mu = Analyze.knotMultiplicities( s.knotsU ), mv = Analyze.knotMultiplicities( s.knotsV );
        const k = (m : Array<{ knot : number, mult : number }>) => m.length <= 12
            ? m.map( x => Inspect.num( x.knot ) + (x.mult > 1 ? " ×" + x.mult : "") ).join( ", " )
            : m.length + " distinct, " + Inspect.num( m[0].knot ) + " to " + Inspect.num( m[m.length - 1].knot );
        const closedU = Analyze.isRationalSurfaceClosed( s, true ), closedV = Analyze.isRationalSurfaceClosed( s, false );
        return [
            ["Surface", rational ? "rational (NURBS)" : "non-rational B-spline"],
            ["Degree (u, v)", s.degreeU + ", " + s.degreeV],
            ["Control points", s.controlPoints.length + " × " + s.controlPoints[0].length],
            ["Knots u", k( mu )],
            ["Knots v", k( mv )],
            ["Weights", rational ? Inspect.num( Math.min( ...w ) ) + " to " + Inspect.num( Math.max( ...w ) ) : "all 1"],
            ["Closed", closedU && closedV ? "in u and v" : closedU ? "in u" : closedV ? "in v" : "no"],
        ];
    }

    // The shaded surface on a regular grid, with Gaussian and mean curvature per vertex
    public static surfaceMesh( s : NurbsSurfaceData, nu : number, nv : number ) : { layer : IndexedLayer } {
        const layer : IndexedLayer = { name : "Surface", kind : "mesh", color : COLORS.surface, visible : true, positions : [], indices : [] };
        const gauss : Array<number> = [], mean : Array<number> = [], normals : Array<number> = [];
        const u0 = s.knotsU[0], u1 = s.knotsU[s.knotsU.length - 1], v0 = s.knotsV[0], v1 = s.knotsV[s.knotsV.length - 1];
        for (let i = 0; i <= nu; i++) for (let j = 0; j <= nv; j++) {
            const d = Eval.rationalSurfaceDerivatives( s, u0 + (u1 - u0) * i / nu, v0 + (v1 - v0) * j / nv, 2 );
            layer.positions.push( d[0][0][0], d[0][0][1], d[0][0][2] );
            const nrm = Vec.cross( d[1][0], d[0][1] ), ln = Vec.norm( nrm );
            normals.push( ...(ln > 1e-300 ? Vec.mul( 1 / ln, nrm ) : [NaN, NaN, NaN]) );
            const c = Inspect.surfaceCurvature( d );
            gauss.push( c.gauss ); mean.push( c.mean );
        }
        // at a pole the curvature is undefined: take a neighbour's
        const fill = (f : Array<number>) => { for (let k = 0; k < f.length; k++) if (!isFinite( f[k] )) {
            const i = Math.floor( k / (nv + 1) ), j = k % (nv + 1);
            const nb = [i > 0 ? k - (nv + 1) : -1, i < nu ? k + (nv + 1) : -1, j > 0 ? k - 1 : -1, j < nv ? k + 1 : -1].filter( x => x >= 0 && isFinite( f[x] ) );
            f[k] = nb.length > 0 ? f[nb[0]] : 0;
        } };
        fill( gauss ); fill( mean );
        // at a pole the normal is undefined too: the viewer falls back to the mesh's own normals there
        if (normals.every( x => isFinite( x ) )) layer.normals = normals;
        for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
            const a = i * (nv + 1) + j, b = a + nv + 1;
            layer.indices.push( a, b, b + 1, a, b + 1, a + 1 );
        }
        layer.fields = {
            "Gaussian curvature" : { values : gauss, unit : "1/mm²", symmetric : true },
            "mean curvature" : { values : mean, unit : "1/mm", symmetric : true },
        };
        return { layer : layer };
    }

    public static controlNet( s : NurbsSurfaceData, visible : boolean ) : ViewLayer {
        const l = Inspect.lines( "Control net", COLORS.net, visible );
        const cps = s.controlPoints.map( row => Inspect.dehomogenize( row ) );
        for (let i = 0; i < cps.length; i++) for (let j = 0; j < cps[i].length; j++) {
            if (i + 1 < cps.length) Inspect.segment( l, cps[i][j], cps[i + 1][j] );
            if (j + 1 < cps[i].length) Inspect.segment( l, cps[i][j], cps[i][j + 1] );
        }
        return l;
    }

    public static controlPoints( s : NurbsSurfaceData, visible : boolean ) : ViewLayer {
        const pts = ([] as Array<Point>).concat( ...s.controlPoints.map( row => Inspect.dehomogenize( row ) ) );
        const l = Inspect.points( "Control points", COLORS.points, pts, visible );
        l.fields = { weight : { values : ([] as Array<number>).concat( ...s.controlPoints.map( row => row.map( p => p[p.length - 1] ) ) ), unit : "", symmetric : false } };
        return l;
    }

    // isocurves at the distinct interior knots: the edges of the surface's polynomial patches
    // (tol: each line sampled to within tol of its curve, its points shared; otherwise 48 points a line)
    public static knotLines( s : NurbsSurfaceData, tol? : number ) : ViewLayer {
        const l = Inspect.lines( "Knot lines", COLORS.knotLines, true );
        const ku = Analyze.knotMultiplicities( s.knotsU ).map( m => m.knot ), kv = Analyze.knotMultiplicities( s.knotsV ).map( m => m.knot );
        if (tol == null) { Inspect.isoLines( l, s, ku, kv, 48 ); return l; }
        for (const u of ku) Inspect.polyline( l, Inspect.adaptive( t => Eval.rationalSurfacePoint( s, u, t ), kv, tol ) );
        for (const v of kv) Inspect.polyline( l, Inspect.adaptive( t => Eval.rationalSurfacePoint( s, t, v ), ku, tol ) );
        return l;
    }

    // Points along a curve c(t) over the breaks (in order), each span halved while its chord strays from the curve by
    // more than tol at its quarters or middle.
    private static adaptive( c : (t : number) => Point, breaks : Array<number>, tol : number ) : Array<Point> {
        const out : Array<Point> = [c( breaks[0] )];
        const split = (a : number, b : number, pa : Point, pb : Point, depth : number) => {
            let need = false;
            if (depth < 12) for (const f of [0.25, 0.5, 0.75]) if (Vec.dist( c( a + f * (b - a) ), Vec.lerp( f, pb, pa ) ) > tol) { need = true; break; }
            if (!need) { out.push( pb ); return; }
            const m = 0.5 * (a + b), pm = c( m );
            split( a, m, pa, pm, depth + 1 ); split( m, b, pm, pb, depth + 1 );
        };
        for (let k = 0; k + 1 < breaks.length; k++) split( breaks[k], breaks[k + 1], out[out.length - 1], c( breaks[k + 1] ), 0 );
        return Inspect.thin( out, tol );
    }

    // A polyline thinned (Douglas and Peucker): the points it can do without, staying within tol of the rest.
    private static thin( pts : Array<Point>, tol : number ) : Array<Point> {
        if (pts.length <= 2) return pts;
        const keep = pts.map( (_, k) => k == 0 || k == pts.length - 1 );
        const stack : Array<[number, number]> = [[0, pts.length - 1]];
        while (stack.length > 0) {
            const [a, b] = stack.pop() as [number, number];
            const A = pts[a], AB = Vec.sub( pts[b], A ), l2 = Vec.dot( AB, AB );
            let worst = -1, wd = tol;
            for (let k = a + 1; k < b; k++) {
                const AP = Vec.sub( pts[k], A ), t = l2 > 0 ? Math.max( 0, Math.min( 1, Vec.dot( AP, AB ) / l2 ) ) : 0;
                const dd = Vec.norm( Vec.sub( AP, Vec.mul( t, AB ) ) );
                if (dd > wd) { wd = dd; worst = k; }
            }
            if (worst >= 0) { keep[worst] = true; stack.push( [a, worst], [worst, b] ); }
        }
        return pts.filter( (_, k) => keep[k] );
    }

    // A polyline into a lines layer, each point once.
    private static polyline( l : IndexedLayer, pts : Array<Point> ) {
        const k0 = l.positions.length / 3;
        for (const p of pts) l.positions.push( p[0], p[1], p[2] );
        for (let k = 1; k < pts.length; k++) l.indices.push( k0 + k - 1, k0 + k );
    }

    public static isocurves( s : NurbsSurfaceData, n : number ) : ViewLayer {
        const l = Inspect.lines( "Isocurves", COLORS.iso, false );
        const u0 = s.knotsU[0], u1 = s.knotsU[s.knotsU.length - 1], v0 = s.knotsV[0], v1 = s.knotsV[s.knotsV.length - 1];
        const us : Array<number> = [], vs : Array<number> = [];
        for (let i = 0; i <= n; i++) { us.push( u0 + (u1 - u0) * i / n ); vs.push( v0 + (v1 - v0) * i / n ); }
        Inspect.isoLines( l, s, us, vs, 64 );
        return l;
    }

    public static normals( s : NurbsSurfaceData, n : number, length : number ) : ViewLayer {
        const l = Inspect.lines( "Normals", COLORS.normals, false );
        const u0 = s.knotsU[0], u1 = s.knotsU[s.knotsU.length - 1], v0 = s.knotsV[0], v1 = s.knotsV[s.knotsV.length - 1];
        for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) {
            const d = Eval.rationalSurfaceDerivatives( s, u0 + (u1 - u0) * (i + 0.5) / (n + 1), v0 + (v1 - v0) * (j + 0.5) / (n + 1), 1 );
            const nr = Vec.cross( d[1][0], d[0][1] );
            const ln = Vec.norm( nr );
            if (ln > 0) Inspect.segment( l, d[0][0], Vec.add( d[0][0], Vec.mul( length / ln, nr ) ) );
        }
        return l;
    }

    // sides of the domain that collapse to a point (the poles of a sphere, the tip of a cone)
    public static poles( s : NurbsSurfaceData ) : ViewLayer {
        const u0 = s.knotsU[0], u1 = s.knotsU[s.knotsU.length - 1], v0 = s.knotsV[0], v1 = s.knotsV[s.knotsV.length - 1];
        const found : Array<Point> = [];
        const side = (f : (t : number) => Point) => {
            const a = f( 0 );
            let len = 0;
            for (let k = 1; k <= 8; k++) len = Math.max( len, Vec.dist( a, f( k / 8 ) ) );
            if (len < 1e-9 * (1 + Vec.norm( a ))) found.push( a );
        };
        side( t => Eval.rationalSurfacePoint( s, u0, v0 + (v1 - v0) * t ) );
        side( t => Eval.rationalSurfacePoint( s, u1, v0 + (v1 - v0) * t ) );
        side( t => Eval.rationalSurfacePoint( s, u0 + (u1 - u0) * t, v0 ) );
        side( t => Eval.rationalSurfacePoint( s, u0 + (u1 - u0) * t, v1 ) );
        return Inspect.points( "Poles", COLORS.poles, found, true );
    }

    // curvature of a curve from its first two derivatives, and the principal normal
    public static curvature( d1 : Point, d2 : Point ) : { kappa : number, normal : Point } {
        const l = Vec.norm( d1 );
        if (l == 0) return { kappa : NaN, normal : [0, 0, 0] };
        const t = Vec.mul( 1 / l, d1 );
        const k = Vec.norm( Vec.cross( d1, d2 ) ) / (l * l * l);
        const nrm = Vec.sub( d2, Vec.mul( Vec.dot( d2, t ), t ) );
        const ln = Vec.norm( nrm );
        return { kappa : k, normal : ln > 0 ? Vec.mul( 1 / ln, nrm ) : [0, 0, 0] };
    }

    // Gaussian and mean curvature from the derivatives SKL[k][l] (k in u, l in v) up to order 2
    public static surfaceCurvature( d : Array<Array<Point>> ) : { gauss : number, mean : number } {
        const su = d[1][0], sv = d[0][1], suu = d[2][0], suv = d[1][1], svv = d[0][2];
        let n = Vec.cross( su, sv );
        const ln = Vec.norm( n );
        const E = Vec.dot( su, su ), F = Vec.dot( su, sv ), G = Vec.dot( sv, sv );
        if (ln < 1e-8 * (E + G)) return { gauss : NaN, mean : NaN }; // degenerate: a pole
        n = Vec.mul( 1 / ln, n );
        const L = Vec.dot( suu, n ), M = Vec.dot( suv, n ), N = Vec.dot( svv, n );
        const den = E * G - F * F;
        return { gauss : (L * N - M * M) / den, mean : (E * N - 2 * F * M + G * L) / (2 * den) };
    }

    // ---------- helpers ----------

    private static isoLines( l : IndexedLayer, s : NurbsSurfaceData, us : Array<number>, vs : Array<number>, n : number ) {
        const u0 = s.knotsU[0], u1 = s.knotsU[s.knotsU.length - 1], v0 = s.knotsV[0], v1 = s.knotsV[s.knotsV.length - 1];
        for (const u of us) {
            let prev : Point | null = null;
            for (let k = 0; k <= n; k++) { const p = Eval.rationalSurfacePoint( s, u, v0 + (v1 - v0) * k / n ); if (prev != null) Inspect.segment( l, prev, p ); prev = p; }
        }
        for (const v of vs) {
            let prev : Point | null = null;
            for (let k = 0; k <= n; k++) { const p = Eval.rationalSurfacePoint( s, u0 + (u1 - u0) * k / n, v ); if (prev != null) Inspect.segment( l, prev, p ); prev = p; }
        }
    }

    private static meshLayer( name : string, color : string, m : TriMesh ) : IndexedLayer {
        const l : IndexedLayer = { name : name, kind : "mesh", color : color, visible : true, positions : [], indices : [] };
        for (const v of m.vertices) l.positions.push( v[0], v[1], v[2] );
        for (const t of m.triangles) l.indices.push( t[0], t[1], t[2] );
        return l;
    }

    private static lines( name : string, color : string, visible : boolean ) : IndexedLayer {
        return { name : name, kind : "lines", color : color, visible : visible, positions : [], indices : [] };
    }

    private static points( name : string, color : string, pts : Array<Point>, visible : boolean ) : ViewLayer {
        const l : ViewLayer = { name : name, kind : "points", color : color, visible : visible, positions : [] };
        for (const p of pts) l.positions.push( p[0], p[1], p[2] );
        return l;
    }

    private static segment( l : IndexedLayer, a : Point, b : Point ) {
        const k = l.positions.length / 3;
        l.positions.push( a[0], a[1], a[2], b[0], b[1], b[2] );
        l.indices.push( k, k + 1 );
    }

    private static dehomogenize( pts : Array<Array<number>> ) : Array<Point> {
        return pts.map( p => { const w = p[p.length - 1]; return [p[0] / w, p[1] / w, p[2] / w]; } );
    }

    private static size( pts : Array<Point> ) : number {
        const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
        for (const p of pts) for (let k = 0; k < 3; k++) { lo[k] = Math.min( lo[k], p[k] ); hi[k] = Math.max( hi[k], p[k] ); }
        return Vec.dist( lo, hi );
    }

    private static num( x : number ) : string {
        if (!isFinite( x )) return String( x );
        const a = Math.abs( x );
        return a != 0 && (a < 1e-3 || a >= 1e6) ? x.toExponential( 2 ) : String( Math.round( x * 1000 ) / 1000 );
    }
}
