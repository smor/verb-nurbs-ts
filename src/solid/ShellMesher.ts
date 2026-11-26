import { NurbsCurveData, NurbsSurfaceData, Point, UV } from "../core/Data.js";
import { Vec } from "../core/Vec.js";
import { triangulate } from "../eval/Cdt.js";
import { Eval } from "../eval/Eval.js";
import { BrepSolid } from "./Brep.js";
import { BrepShell, ShellBuilder, ShellFace } from "./BrepShell.js";
import { TriMesh } from "./TriMesh.js";

/** How finely a shell is tessellated: by how far the mesh may stray from the exact faces, not by a grid. */
export interface MeshTolerance {
    // the largest distance from a triangle to the face it stands for (mm)
    chordal : number;
    // the largest angle between neighbouring normals along a curved direction, in degrees (default: no bound)
    angle? : number;
    // the longest edge (default: no bound)
    maxEdge? : number;
}

/** A shell's mesh: its triangles, the shell face each one stands for, and the largest deviation found. */
export interface ShellMesh {
    mesh : TriMesh;
    faceOf : Array<number>;
    // the largest distance, at the triangles' edge midpoints and centroids, from the mesh to the exact faces
    deviation : number;
}

// The presets: for printing (within 0.02 mm, under a 3D printer's resolution), for viewing (coarser, with an angle
// bound so that shading stays smooth).
const PRESETS : { [name : string] : MeshTolerance } = {
    print : { chordal : 0.02 },
    view : { chordal : 0.1, angle : 20 },
};

// Tessellation of an exact shell by tolerance (#72, section 1).
//
// * Edges first. Each edge is sampled once, adaptively: a span is split while its chord strays from the curve by more
//   than the chordal tolerance, or turns by more than the angle. Both faces of the edge use those very points, so the
//   mesh is closed and manifold by construction, without welding.
// * Faces in their parameters. A face's loops, at its edges' samples (through their p-curves), bound a constrained
//   Delaunay triangulation of its parameter rectangle, scaled to the face's lengths. Inside, a grid follows the
//   surface's curvature in each direction: the sag of a chord of length L on radius r is about L^2 / (8 r), so lines
//   are placed at equal steps of the integral of sqrt(k / (8 tol)) along the iso-curves. A planar face gets no inner
//   points (its boundary triangulated is exact), and a straight direction (the rulings of a cylinder, a cone, an
//   extrusion) gets one span.
// * Then a check. Every triangle is measured against the surface at its centroid and its inner edges' midpoints; one
//   that strays by more than the tolerance gets a point there, on the surface, and the face is triangulated again.
//
// The vertices lie on the faces (the edges' samples within the edges' tolerances), so the mesh's volume is biased low
// by about the chordal tolerance times the area, for a convex shape.
//
// After the geometry-based triangulation of Piegl and Tiller ("Geometry-based triangulation of trimmed NURBS
// surfaces", Computer-Aided Design 30(1), 1998): boundaries sampled to the tolerance first, then the inside triangulated
// in a parameter space stretched to the surface's lengths, and refined where the triangles stray.
export class ShellMesher {

    public static PRESETS = PRESETS;

    /** A tolerance from a preset's name, or the tolerance itself. */
    public static tolerance( t : "print" | "view" | MeshTolerance ) : MeshTolerance {
        if (typeof t == "string") {
            const p = PRESETS[t];
            if (p == null) throw new Error( `ShellMesher: unknown preset "${t}"` );
            return p;
        }
        if (!(t.chordal > 0)) throw new Error( "ShellMesher: the chordal tolerance must be positive" );
        return t;
    }

    // Parameters on a side of the face's domain, to rounding, put on it; and an edge's that run along a side all the way
    // (a seam, a blend's contact curve), within 1e-4 of it, too: points on one line are then exactly collinear.
    private static onSides( F : ShellFace, uv : Array<UV> ) : Array<UV> {
        const s = F.surface, d = [s.knotsU[0], s.knotsU[s.knotsU.length - 1], s.knotsV[0], s.knotsV[s.knotsV.length - 1]];
        const out = uv.map( p => [p[0], p[1]] as UV );
        for (let c = 0; c < 2; c++) for (const side of [d[2 * c], d[2 * c + 1]]) {
            const w = d[2 * c + 1] - d[2 * c];
            const all = out.every( q => Math.abs( q[c] - side ) < 1e-4 * w );
            for (const q of out) if (all || Math.abs( q[c] - side ) < 1e-9 * w) q[c] = side;
        }
        return out;
    }

    /** The shell's mesh within the tolerance. */
    public static mesh( shell : BrepShell, given : "print" | "view" | MeshTolerance ) : ShellMesh {
        const T = ShellMesher.tolerance( given );
        const tol = T.chordal, angle = T.angle != null ? T.angle * Math.PI / 180 : Infinity, maxEdge = T.maxEdge ?? Infinity;
        const mesh = new TriMesh();
        const vertexOf = shell.vertices.map( p => mesh.addVertex( p ) );
        // each edge's samples: parameters on its curve, and the mesh vertices (its ends are the shell's)
        const samples = shell.edges.map( e => {
            const ts = ShellMesher.sampleCurve( e.curve, tol, angle, maxEdge );
            const ids = ts.map( (t, k) => k == 0 ? vertexOf[e.start] : k == ts.length - 1 ? vertexOf[e.end] : mesh.addVertex( Eval.rationalCurvePoint( e.curve, t ) ) );
            return { ts : ts, ids : ids };
        } );
        const faceOf : Array<number> = [];
        let deviation = 0;
        shell.faces.forEach( (F, fi) => {
            // the loops, as polygons of (uv, vertex) in the face's parameters
            const loops : Array<Array<{ uv : UV, id : number }>> = [];
            for (const loop of F.loops) {
                const poly : Array<{ uv : UV, id : number }> = [];
                for (const [ei, fwd] of loop.edges) {
                    const e = shell.edges[ei], s = samples[ei], pc = e.pcurves[fwd ? 0 : 1];
                    const run = ShellMesher.onSides( F, s.ts.map( t => Eval.rationalCurvePoint( pc, t ) as UV ) ).map( (uv, k) => ({ uv : uv, id : s.ids[k] }) );
                    if (!fwd) run.reverse();
                    // each edge's last point is the next one's first
                    poly.push( ...run.slice( 0, run.length - 1 ) );
                }
                if (poly.length >= 2) loops.push( poly );
            }
            // (the face's edges lie within their own tolerances of it: a triangle on an edge is off by that much more)
            let slack = 0;
            for (const loop of F.loops) for (const [ei] of loop.edges) slack = Math.max( slack, shell.edges[ei].tolerance );
            const r = ShellMesher.face( F, loops, mesh, tol, angle, maxEdge, slack );
            deviation = Math.max( deviation, r.deviation );
            for (const t of r.triangles) { mesh.addTriangle( t[0], t[1], t[2] ); faceOf.push( fi ); }
        } );
        return { mesh : mesh, faceOf : faceOf, deviation : deviation };
    }

    // Parameters along a curve: its knot spans halved, then each span split while its chord strays from the curve at
    // its middle (or at its quarters) by more than tol, turns by more than the angle, or is longer than maxEdge.
    private static sampleCurve( c : NurbsCurveData, tol : number, angle : number, maxEdge : number ) : Array<number> {
        const ks = c.knots.filter( (k, i) => i == 0 || k > c.knots[i - 1] );
        const out : Array<number> = [ks[0]];
        const P = (t : number) => Eval.rationalCurvePoint( c, t );
        const D = (t : number) => Eval.rationalCurveDerivatives( c, t, 1 )[1];
        const split = (a : number, b : number, pa : Point, pb : Point, depth : number) => {
            const m = 0.5 * (a + b);
            let need = false;
            if (depth < 24) {
                const chord = Vec.dist( pa, pb );
                for (const f of [0.25, 0.5, 0.75]) {
                    const q = P( a + f * (b - a) ), l = Vec.lerp( f, pb, pa );
                    if (Vec.dist( q, l ) > tol) { need = true; break; }
                }
                if (!need && chord > maxEdge) need = true;
                if (!need && angle < Infinity) {
                    const da = D( a ), db = D( b ), na = Vec.norm( da ), nb = Vec.norm( db );
                    if (na > 0 && nb > 0 && Math.acos( Math.max( -1, Math.min( 1, Vec.dot( da, db ) / (na * nb) ) ) ) > angle) need = true;
                }
            }
            if (need) { const pm = P( m ); split( a, m, pa, pm, depth + 1 ); split( m, b, pm, pb, depth + 1 ); }
            else out.push( b );
        };
        for (let i = 0; i + 1 < ks.length; i++) {
            const a = ks[i], b = ks[i + 1], m = 0.5 * (a + b);
            const pa = P( a ), pm = P( m ), pb = P( b );
            split( a, m, pa, pm, 0 ); split( m, b, pm, pb, 0 );
        }
        return ShellMesher.thin( c, out, tol, angle, maxEdge );
    }

    // Samples that a coarser polyline can do without: a straight edge whose knot spans were halved needs only its
    // ends. A sample is dropped while the chord over it still meets the tolerance (greedy, from the start).
    private static thin( c : NurbsCurveData, ts : Array<number>, tol : number, angle : number, maxEdge : number ) : Array<number> {
        if (ts.length <= 2) return ts;
        const P = (t : number) => Eval.rationalCurvePoint( c, t );
        const out = [ts[0]];
        let a = 0;
        while (a < ts.length - 1) {
            let b = a + 1;
            // reach as far as the chord from a stays within the tolerance of every sample and midpoint in between
            while (b + 1 < ts.length) {
                const pa = P( ts[a] ), pb = P( ts[b + 1] );
                if (Vec.dist( pa, pb ) > maxEdge) break;
                let ok = true;
                for (let k = a; k <= b && ok; k++) for (const t of [ts[k], 0.5 * (ts[k] + ts[k + 1])]) {
                    const f = (t - ts[a]) / (ts[b + 1] - ts[a]);
                    if (Vec.dist( P( t ), Vec.lerp( f, pb, pa ) ) > tol) { ok = false; break; }
                }
                if (ok && angle < Infinity) {
                    const da = Eval.rationalCurveDerivatives( c, ts[a], 1 )[1], db = Eval.rationalCurveDerivatives( c, ts[b + 1], 1 )[1];
                    const na = Vec.norm( da ), nb = Vec.norm( db );
                    if (na > 0 && nb > 0 && Math.acos( Math.max( -1, Math.min( 1, Vec.dot( da, db ) / (na * nb) ) ) ) > angle) ok = false;
                }
                if (!ok) break;
                b++;
            }
            out.push( ts[b] );
            a = b;
        }
        return out;
    }

    // A face's triangles, oriented so that they face out of the solid, and their deviation from the surface.
    private static face( F : ShellFace, loops : Array<Array<{ uv : UV, id : number }>>, mesh : TriMesh, tol : number, angle : number, maxEdge : number, slack : number )
        : { triangles : Array<[number, number, number]>, deviation : number } {
        const s = F.surface;
        const d = [s.knotsU[0], s.knotsU[s.knotsU.length - 1], s.knotsV[0], s.knotsV[s.knotsV.length - 1]];
        const S = (uv : UV) => Eval.rationalSurfacePoint( s, uv[0], uv[1] );
        let projector : ((p : Point) => { uv : UV, p : Point }) | null = null;
        const project = (p : Point) => { if (projector == null) projector = ShellBuilder.projector( s ); return projector( p ); };
        // the parameter plane scaled to the face's mean lengths, so that triangles are not stretched by it; a planar
        // face is triangulated in its plane instead, where a triangle of its boundary points is exact (in parameters
        // that are not affine, as a disc's polar ones, it need not be)
        const planar = ShellMesher.planar( s );
        if (planar) return { triangles : ShellMesher.flat( F, loops, mesh ), deviation : 0 };
        // the parameters mapped by the measure of how many steps each direction needs (`lines`): in those coordinates
        // a step is about 1 each way, so Delaunay triangles there are the right shape on the surface, and along a
        // straight ruling (a direction that needs one step) they run straight across
        // (each direction needs at least its length over the face's larger one, so that a straight stretch keeps its
        // share of the plane, and a whole flat direction is one step)
        const L = ShellMesher.lengths( s, d ), Lref = Math.max( L[0], L[1] );
        const MU = ShellMesher.lines( s, d, 0, tol, angle, maxEdge, Lref ), MV = ShellMesher.lines( s, d, 1, tol, angle, maxEdge, Lref );
        const X = (uv : UV) : [number, number] => [MU.at( uv[0] ), MV.at( uv[1] )];
        // points: the loops' (a point repeated at the same parameters is one point), then inner ones
        const uv : Array<UV> = [], ids : Array<number> = [], key = new Map<string, number>();
        const add = (p : UV, id : number) => {
            const k = Math.round( p[0] * 1e12 ) + ":" + Math.round( p[1] * 1e12 );
            const i = key.get( k );
            if (i != null) return i;
            uv.push( p ); ids.push( id ); key.set( k, uv.length - 1 );
            return uv.length - 1;
        };
        const edges : Array<[number, number]> = [];
        const trims : Array<Array<UV>> = [];
        for (const loop of loops) {
            const idx = loop.map( x => add( x.uv, x.id ) );
            for (let k = 0; k < idx.length; k++) { const a = idx[k], b = idx[(k + 1) % idx.length]; if (a != b) edges.push( [a, b] ); }
            trims.push( loop.map( x => x.uv ) );
        }
        // the boundary segments, scaled, for keeping inner points clear of them
        const segs = edges.map( e => [X( uv[e[0]] ), X( uv[e[1]] )] );
        const clear = (p : UV, r : number) => {
            const x = X( p );
            for (const [a, b] of segs) {
                const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
                const t = l2 > 0 ? Math.max( 0, Math.min( 1, ((x[0] - a[0]) * dx + (x[1] - a[1]) * dy) / l2 ) ) : 0;
                const ex = a[0] + t * dx - x[0], ey = a[1] + t * dy - x[1];
                if (ex * ex + ey * ey < r * r) return false;
            }
            return true;
        };
        // the inner grid, at the lines, clear of the boundary by 0.4 of a step
        for (const u of MU.lines) for (const v of MV.lines) {
            const p : UV = [u, v];
            if (BrepSolid.insideTrims( trims, p ) && clear( p, 0.4 )) add( p, mesh.addVertex( S( p ) ) );
        }
        // triangulate, keep what lies inside the loops, check against the surface, and again with the points added
        let tris : Array<[number, number, number]> = [];
        let worst = 0;
        for (let round = 0; round < 12; round++) {
            // (inside by the parity of the loops crossed from outside, across the triangulation: a centroid's own test
            // can misjudge a sliver along a loop)
            const all = triangulate( uv.map( X ), edges, { exterior : false } );
            tris = [];
            for (const t of all) {
                // (two points of the triangle at one vertex: a sliver along a pole or a seam, which covers nothing; and
                // three points on one side of the domain, a flat triangle along an edge that runs there)
                if (ids[t[0]] == ids[t[1]] || ids[t[1]] == ids[t[2]] || ids[t[2]] == ids[t[0]]) continue;
                const xa = X( uv[t[0]] ), xb = X( uv[t[1]] ), xc = X( uv[t[2]] );
                if ((xb[0] - xa[0]) * (xc[1] - xa[1]) - (xb[1] - xa[1]) * (xc[0] - xa[0]) == 0) continue;
                tris.push( t );
            }
            // the triangles' deviation from the surface, at the centroid and at the midpoints of inner edges
            const constrained = new Set( edges.map( e => Math.min( e[0], e[1] ) + ":" + Math.max( e[0], e[1] ) ) );
            const extra : Array<UV> = [];
            const seen = new Set<string>();
            worst = 0;
            for (const t of tris) {
                const P = t.map( i => mesh.vertices[ids[i]] );
                const probes : Array<{ uv : UV, p : Point }> = [{ uv : [(uv[t[0]][0] + uv[t[1]][0] + uv[t[2]][0]) / 3, (uv[t[0]][1] + uv[t[1]][1] + uv[t[2]][1]) / 3],
                                                                   p : Vec.mul( 1 / 3, Vec.add( P[0], Vec.add( P[1], P[2] ) ) ) }];
                for (let k = 0; k < 3; k++) {
                    const a = t[k], b = t[(k + 1) % 3], ek = Math.min( a, b ) + ":" + Math.max( a, b );
                    if (constrained.has( ek ) || seen.has( ek )) continue;
                    seen.add( ek );
                    probes.push( { uv : [0.5 * (uv[a][0] + uv[b][0]), 0.5 * (uv[a][1] + uv[b][1])], p : Vec.mul( 0.5, Vec.add( P[k], P[(k + 1) % 3] ) ) } );
                }
                let bad : UV | null = null, bd = tol + slack;
                for (const x of probes) {
                    // the distance to the surface point at the probe's parameters bounds the distance to the surface
                    // from above; where that is too far (parameters whose speed changes across the triangle, as at a
                    // breakpoint between an arc and a straight side), the nearest point is found
                    let e = Vec.dist( S( x.uv ), x.p );
                    if (e > tol) e = Math.min( e, Vec.dist( project( x.p ).p, x.p ) );
                    worst = Math.max( worst, e );
                    if (e > bd) { bd = e; bad = x.uv; }
                }
                if (bad == null && maxEdge < Infinity) {
                    for (let k = 0; k < 3; k++) if (Vec.dist( P[k], P[(k + 1) % 3] ) > maxEdge) { bad = probes[0].uv; break; }
                }
                if (bad != null && BrepSolid.insideTrims( trims, bad )) extra.push( bad );
            }
            if (extra.length == 0) break;
            let added = 0;
            for (const p of extra) { const n = uv.length; add( p, -1 ); if (uv.length > n) { ids[n] = mesh.addVertex( S( p ) ); added++; } }
            if (added == 0) break;
        }
        // outward: counter-clockwise in the (scaled) parameters is along dS/du x dS/dv
        const out = tris.map( t => {
            const a = X( uv[t[0]] ), b = X( uv[t[1]] ), c = X( uv[t[2]] );
            const ccw = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) > 0;
            const tri = ccw == F.sameSense ? [t[0], t[1], t[2]] : [t[0], t[2], t[1]];
            return [ids[tri[0]], ids[tri[1]], ids[tri[2]]] as [number, number, number];
        } );
        return { triangles : out, deviation : worst };
    }

    // A planar face's triangles: its loops' vertices in a frame of its plane (a vertex once, though a seam visits it
    // twice), triangulated with the loops as constraints, those inside kept (by parity: a seam's two sides cancel).
    private static flat( F : ShellFace, loops : Array<Array<{ uv : UV, id : number }>>, mesh : TriMesh ) : Array<[number, number, number]> {
        let n = ShellMesher.normal( F.surface );
        n = Vec.normalized( n );
        const ex = Vec.normalized( Math.abs( n[0] ) < 0.9 ? Vec.cross( n, [1, 0, 0] ) : Vec.cross( n, [0, 1, 0] ) ), ey = Vec.cross( n, ex );
        const at = new Map<number, number>(), xy : Array<[number, number]> = [], ids : Array<number> = [];
        const idx = (id : number) => {
            let k = at.get( id );
            if (k == null) { const p = mesh.vertices[id]; k = xy.length; xy.push( [Vec.dot( p, ex ), Vec.dot( p, ey )] ); ids.push( id ); at.set( id, k ); }
            return k;
        };
        // the loops' segments, less those a seam visits twice (once each way): in the plane a seam is no boundary
        const count = new Map<string, number>(), pairs : Array<[number, number]> = [];
        for (const loop of loops) {
            const ks = loop.map( x => idx( x.id ) );
            for (let i = 0; i < ks.length; i++) {
                const a = ks[i], b = ks[(i + 1) % ks.length], key = Math.min( a, b ) + ":" + Math.max( a, b );
                if (a == b) continue;
                if (!count.has( key )) pairs.push( [a, b] );
                count.set( key, (count.get( key ) ?? 0) + 1 );
            }
        }
        const edges = pairs.filter( e => count.get( Math.min( e[0], e[1] ) + ":" + Math.max( e[0], e[1] ) ) == 1 );
        const out : Array<[number, number, number]> = [];
        for (const t of triangulate( xy, edges, { exterior : false } )) {
            const a = xy[t[0]], b = xy[t[1]], c = xy[t[2]];
            const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
            if (area == 0) continue;
            // counter-clockwise about n is along n
            const up = (area > 0) == ShellMesher.alongNormal( F, n );
            out.push( up ? [ids[t[0]], ids[t[1]], ids[t[2]]] : [ids[t[0]], ids[t[2]], ids[t[1]]] );
        }
        return out;
    }

    // Whether the outward normal of a planar face is +n (n: a unit normal of its plane).
    private static alongNormal( F : ShellFace, n : Point ) : boolean {
        const s = F.surface, d = [s.knotsU[0], s.knotsU[s.knotsU.length - 1], s.knotsV[0], s.knotsV[s.knotsV.length - 1]];
        // the surface's own normal at some regular point
        for (const f of [0.5, 0.3, 0.7, 0.1, 0.9]) for (const g of [0.5, 0.3, 0.7, 0.1, 0.9]) {
            const D = Eval.rationalSurfaceDerivatives( s, d[0] + f * (d[1] - d[0]), d[2] + g * (d[3] - d[2]), 1 );
            const m = Vec.cross( D[1][0], D[0][1] );
            if (Vec.norm( m ) > 1e-12 * (Vec.norm( D[1][0] ) * Vec.norm( D[0][1] ) + 1e-300)) return (Vec.dot( m, n ) > 0) == F.sameSense;
        }
        return F.sameSense;
    }

    // A normal of a planar surface's control points.
    private static normal( s : NurbsSurfaceData ) : Point {
        const pts = ([] as Array<Point>).concat( ...s.controlPoints.map( row => row.map( h => [h[0] / h[3], h[1] / h[3], h[2] / h[3]] as Point ) ) );
        let far = pts[0];
        for (const p of pts) if (Vec.dist( p, pts[0] ) > Vec.dist( far, pts[0] )) far = p;
        const ax = Vec.sub( far, pts[0] );
        let n : Point = [0, 0, 1], best = 0;
        for (const p of pts) { const c = Vec.cross( ax, Vec.sub( p, pts[0] ) ), m = Vec.norm( c ); if (m > best) { best = m; n = c; } }
        return n;
    }

    // Whether a surface is planar: its control points within rounding of the plane through three of them.
    private static planar( s : NurbsSurfaceData ) : boolean {
        const pts = ([] as Array<Point>).concat( ...s.controlPoints.map( row => row.map( h => [h[0] / h[3], h[1] / h[3], h[2] / h[3]] as Point ) ) );
        let size = 0;
        for (const p of pts) size = Math.max( size, Vec.dist( p, pts[0] ) );
        // the normal from the point farthest from the first and the one farthest from that line
        let far = pts[0];
        for (const p of pts) if (Vec.dist( p, pts[0] ) > Vec.dist( far, pts[0] )) far = p;
        const ax = Vec.sub( far, pts[0] );
        let n : Point = [0, 0, 0], best = 0;
        for (const p of pts) { const c = Vec.cross( ax, Vec.sub( p, pts[0] ) ), m = Vec.norm( c ); if (m > best) { best = m; n = c; } }
        if (best <= 1e-14 * size * size) return true;
        n = Vec.mul( 1 / best, n );
        return pts.every( p => Math.abs( Vec.dot( Vec.sub( p, pts[0] ), n ) ) < 1e-9 * Math.max( 1, size ) );
    }

    // The inner grid lines across direction c (0: values of u, 1: values of v): at equal steps of the integral, along
    // the iso-curves in that direction, of the density each tolerance asks for (sqrt(k / (8 tol)) for the chord's sag,
    // k / angle for the normals' turn, 1 / maxEdge), its largest over five iso-curves across.
    private static lines( s : NurbsSurfaceData, d : Array<number>, c : number, tol : number, angle : number, maxEdge : number, Lref : number )
        : { lines : Array<number>, at : (t : number) => number } {
        const ks = (c == 0 ? s.knotsU : s.knotsV).filter( (k, i, a) => i == 0 || k > a[i - 1] );
        const a = d[2 * c], b = d[2 * c + 1];
        // parameters along: eight in each knot span, at least 64
        const ts : Array<number> = [];
        const per = Math.max( 8, Math.ceil( 64 / Math.max( 1, ks.length - 1 ) ) );
        for (let i = 0; i + 1 < ks.length; i++) for (let k = 0; k < per; k++) ts.push( ks[i] + (ks[i + 1] - ks[i]) * k / per );
        ts.push( b );
        const across = [0.02, 0.25, 0.5, 0.75, 0.98].map( f => d[2 * (1 - c)] + f * (d[2 * (1 - c) + 1] - d[2 * (1 - c)]) );
        const density = ts.map( _ => 0 );
        for (const w of across) ts.forEach( (t, k) => {
            const D = c == 0 ? Eval.rationalSurfaceDerivatives( s, t, w, 2 ) : Eval.rationalSurfaceDerivatives( s, w, t, 2 );
            const d1 = c == 0 ? D[1][0] : D[0][1], d2 = c == 0 ? D[2][0] : D[0][2];
            const sp = Vec.norm( d1 );
            if (!(sp > 1e-300)) return;
            const kappa = Vec.norm( Vec.cross( d1, d2 ) ) / (sp * sp * sp);
            let rho = Math.sqrt( kappa / (8 * tol) );
            if (angle < Infinity) rho = Math.max( rho, kappa / angle );
            if (maxEdge < Infinity) rho = Math.max( rho, 1 / maxEdge );
            // a curvature of rounding (a straight ruling) asks for nothing but its share
            if (kappa < 1e-9) rho = maxEdge < Infinity ? 1 / maxEdge : 0;
            density[k] = Math.max( density[k], Math.max( rho, 0.999 / Lref ) * sp );
        } );
        // the cumulative measure (density per unit of parameter, integrated), and lines at its whole steps
        const cum = [0];
        for (let k = 1; k < ts.length; k++) cum.push( cum[k - 1] + 0.5 * (density[k] + density[k - 1]) * (ts[k] - ts[k - 1]) );
        let total = cum[cum.length - 1];
        // the measure as a map of the parameter: strictly increasing (a floor of a thousandth of a step across the
        // whole direction, where the direction collapses to a point), and at least one step long
        const floor = 1e-3 * Math.max( 1, total ) / (b - a);
        for (let k = 1; k < ts.length; k++) cum[k] += floor * (ts[k] - a);
        total = cum[cum.length - 1];
        if (total < 1) for (let k = 0; k < cum.length; k++) cum[k] /= total;
        const at = (t : number) => {
            if (t <= ts[0]) return cum[0];
            if (t >= ts[ts.length - 1]) return cum[cum.length - 1];
            let lo = 0, hi = ts.length - 1;
            while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ts[m] <= t) lo = m; else hi = m; }
            return cum[lo] + (cum[hi] - cum[lo]) * (t - ts[lo]) / (ts[hi] - ts[lo]);
        };
        total = cum[cum.length - 1];
        const n = Math.ceil( total - 1e-6 );
        if (n <= 1) return { lines : [], at : at };
        const out : Array<number> = [];
        for (let j = 1; j < n; j++) {
            const target = total * j / n;
            let k = 1;
            while (k < cum.length - 1 && cum[k] < target) k++;
            const f = cum[k] > cum[k - 1] ? (target - cum[k - 1]) / (cum[k] - cum[k - 1]) : 0;
            out.push( ts[k - 1] + f * (ts[k] - ts[k - 1]) );
        }
        return { lines : out, at : at };
    }

    // mean length of the u and v iso-curves
    private static lengths( s : NurbsSurfaceData, d : Array<number> ) : [number, number] {
        const n = 24, m = 5;
        let lu = 0.0, lv = 0.0;
        for (let k = 0; k < m; k++) {
            const t = (k + 0.5) / m;
            let pu = Eval.rationalSurfacePoint( s, d[0], d[2] + (d[3] - d[2]) * t ), pv = Eval.rationalSurfacePoint( s, d[0] + (d[1] - d[0]) * t, d[2] );
            for (let i = 1; i <= n; i++) {
                const qu = Eval.rationalSurfacePoint( s, d[0] + (d[1] - d[0]) * i / n, d[2] + (d[3] - d[2]) * t );
                const qv = Eval.rationalSurfacePoint( s, d[0] + (d[1] - d[0]) * t, d[2] + (d[3] - d[2]) * i / n );
                lu += Vec.dist( pu, qu ); lv += Vec.dist( pv, qv );
                pu = qu; pv = qv;
            }
        }
        return [Math.max( lu / m, 1e-9 ), Math.max( lv / m, 1e-9 )];
    }
}
