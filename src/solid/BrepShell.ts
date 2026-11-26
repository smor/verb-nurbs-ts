import { NurbsCurveData, NurbsSurfaceData, Point, UV } from "../core/Data.js";
import { Vec } from "../core/Vec.js";
import { Analyze } from "../eval/Analyze.js";
import { Eval } from "../eval/Eval.js";
import { Fit } from "../eval/Fit.js";
import { BrepFace, BrepSolid, TrimEdge } from "./Brep.js";
import { BooleanResult } from "./BrepBoolean.js";
import { TriMesh } from "./TriMesh.js";
import { SurfaceLoops } from "./SurfaceLoops.js";
import { SeamEdge, SeamFace, SeamLoop, Seams } from "./Seams.js";

export interface ShellOptions {
    // the model's length uncertainty (default 0.01, in the model's units, taken as millimetres): edge curves are
    // fitted to half of it
    tolerance? : number;
}

// The topology of a B-rep result, recovered from its welded mesh: the edges between faces, as chains of mesh vertices,
// and each face's boundary loops as cycles of oriented edges.
export interface ShellTopology {
    // chain end points (mesh vertex indices): where three or more faces meet, or one point of a closed chain
    vertices : Array<number>;
    // each edge: its chain of mesh vertices (first and last are in `vertices`; equal for a closed chain), and the faces
    // on its left and right when walked from first to last, seen from outside
    edges : Array<{ chain : Array<number>, left : number, right : number }>;
    // for each face, its loops: lists of [edge, forward] in order round the loop, the face on the left
    loops : Array<Array<Array<[number, boolean]>>>;
}

// An edge of a shell: its curve, from its start vertex to its end vertex (ends exactly at them), the faces on its left
// and right (seen from outside, walked from start to end; a seam has the same face on both), its curve in each of
// those faces' parameters over the same parameter as `curve` (p-curves: the left face's, then the right face's), and
// its tolerance: the largest distance, over the edge, from the curve to either face's surface at its p-curve. The
// tolerance is the edge's own, as in Parasolid (Jackson, "Boundary representation modelling with local tolerances",
// ACM Symposium on Solid Modeling and Applications, 1995): small where both faces are exact, as large as their gap
// where one is fitted (a setback corner's parts, fitted to a thousandth of its radius).
export interface ShellEdge {
    curve : NurbsCurveData;
    start : number;
    end : number;
    left : number;
    right : number;
    pcurves : [NurbsCurveData, NurbsCurveData];
    tolerance : number;
}

// A face of a shell: its surface, whether the surface's normal points out of the solid, whether the surface is closed
// in u and in v, its loops of oriented edges (the face on their left; one outer where the surface has a parameter
// rectangle to bound), and the face of the Boolean result it comes from (`source`, with its `name`). A face that its
// surface's seam cuts into several regions is a face per region, with the same source.
export interface ShellFace {
    surface : NurbsSurfaceData;
    sameSense : boolean;
    closed : [boolean, boolean];
    loops : Array<SeamLoop>;
    source : number;
    name : string;
}

// A closed shell of trimmed NURBS faces with exact topology: vertices, edges (curves with p-curves and tolerances)
// and faces bounded by loops of edges. Each edge is used once each way by the loops: twice by one face for a seam.
export interface BrepShell {
    vertices : Array<Point>;
    edges : Array<ShellEdge>;
    faces : Array<ShellFace>;
    // the uncertainty the edges were fitted to (`ShellOptions.tolerance`)
    tolerance : number;
}

// `ShellBuilder` makes a Boolean result's exact topology.
//
// The faces are the result's surfaces (operands' faces, fillets, corner patches). The edges are recovered from the
// welded mesh, where neighbouring faces share their boundary vertices exactly: each run of mesh edges between the same
// two faces, from a point where three or more faces meet to the next, is one edge (`topology`). Its curve follows the
// faces' intersection, not the mesh: the run is refined by alternating projections onto the two surfaces until its
// chords stray from them by less than a quarter of the tolerance, then a cubic B-spline is fitted to it within another
// quarter, so the curve lies within half the tolerance of both faces wherever they meet (where they do not quite
// meet, as a fitted patch beside an exact one, within half the tolerance plus their gap). Faces on surfaces closed in
// one direction are cut along their seams (`Seams`). Each edge's p-curves are the curve projected onto its faces and
// fitted over the curve's own parameter (the "same parameter" property exchange formats and kernels expect); a seam
// edge's are the seam's two sides, exactly. Edges are shared by construction, so the shell is closed exactly when the
// mesh is (`report.manifold.closedManifold`).
export class ShellBuilder {

    public static fromResult( r : BooleanResult, options? : ShellOptions ) : BrepShell {
        const tol = options != null && options.tolerance != null ? options.tolerance : 0.01;
        const T = ShellBuilder.topology( r );
        const faces : Array<SeamFace> = r.faces.map( (f, fi) => ({ surface : f.surface, sameSense : ShellBuilder.sameSense( r, fi ), project : ShellBuilder.projector( f.surface ) }) );
        const on = faces.map( F => (p : Point) => F.project( p ).p );
        const onBoth = (e : { left : number, right : number }, p : Point) => { let q = p; for (let k = 0; k < 4; k++) q = on[e.right]( on[e.left]( q ) ); return q; };
        const vertices : Array<Point> = [], index = new Map<number, number>();
        const vertexOf = (m : number) => {
            let k = index.get( m );
            if (k == null) { k = vertices.length; vertices.push( r.mesh.vertices[m] ); index.set( m, k ); }
            return k;
        };
        const edges : Array<SeamEdge> = T.edges.map( e => ({
            pts : ShellBuilder.refine( e.chain.map( i => r.mesh.vertices[i] ), on[e.left], on[e.right], 0.25 * tol ),
            start : vertexOf( e.chain[0] ), end : vertexOf( e.chain[e.chain.length - 1] ), left : e.left, right : e.right,
        }) );
        const cut = Seams.cut( faces, edges, vertices, T.loops, tol, onBoth );
        // only the vertices that edges use, renumbered in order
        const used = new Map<number, number>(), vs : Array<Point> = [];
        const keep = (v : number) => { let k = used.get( v ); if (k == null) { k = vs.length; vs.push( vertices[v] ); used.set( v, k ); } return k; };
        const curves = cut.edges.map( e => {
            const curve = e.curve != null ? e.curve : ShellBuilder.fitChain( e.pts, 0.25 * tol );
            // the ends exactly at the vertices (clamped: the end control points are the ends)
            const cp = curve.controlPoints, a = vertices[e.start], b = vertices[e.end];
            const at = (p : Point, w : number) => cp[0].length == 4 ? [p[0] * w, p[1] * w, p[2] * w, w] : p.slice();
            cp[0] = at( a, cp[0].length == 4 ? cp[0][3] : 1 );
            cp[cp.length - 1] = at( b, cp[0].length == 4 ? cp[cp.length - 1][3] : 1 );
            return curve;
        } );
        // a face that its seam cut into several regions becomes a face per region; its edges' sides follow
        const left = cut.edges.map( e => e.left ), right = cut.edges.map( e => e.right );
        const shellFaces : Array<ShellFace> = [];
        faces.forEach( (F, fi) => {
            const closed = [Analyze.isRationalSurfaceClosed( F.surface, true ), Analyze.isRationalSurfaceClosed( F.surface, false )] as [boolean, boolean];
            const regions = Math.max( 0, ...cut.loops[fi].map( l => l.region ) ) + 1;
            for (let g = 0; g < regions; g++) {
                const loops = cut.loops[fi].filter( l => l.region == g );
                const nf = shellFaces.length;
                for (const l of loops) for (const [e, fwd] of l.edges) { if (fwd) left[e] = nf; else right[e] = nf; }
                shellFaces.push( { surface : F.surface, sameSense : F.sameSense, closed : closed, loops : loops, source : fi, name : r.faces[fi].name } );
            }
        } );
        const shellEdges : Array<ShellEdge> = cut.edges.map( (e, k) => {
            const curve = curves[k];
            const pcurves : [NurbsCurveData, NurbsCurveData] = e.pcurves != null ? e.pcurves
                : [ShellBuilder.pcurve( curve, shellFaces[left[k]], faces[e.left].project, tol ),
                   ShellBuilder.pcurve( curve, shellFaces[right[k]], faces[e.right].project, tol )];
            const tolerance = Math.max( ShellBuilder.deviation( curve, shellFaces[left[k]].surface, pcurves[0] ),
                                        ShellBuilder.deviation( curve, shellFaces[right[k]].surface, pcurves[1] ) );
            return { curve : curve, start : keep( e.start ), end : keep( e.end ), left : left[k], right : right[k], pcurves : pcurves, tolerance : tolerance };
        } );
        return { vertices : vs, edges : shellEdges, faces : shellFaces, tolerance : tol };
    }

    // A shell as an operand of a Boolean (route A, step A3): a solid whose faces are the shell's, on their whole
    // surfaces but trimmed by their loops (`BrepFace.trims`), with the shell's edges between them (`BrepSolid.edges`,
    // each sampled once, so both faces share its points) and its mesh for telling inside from outside. Faces are open
    // in both directions: the shell's faces on closed surfaces are already cut at their seams, and a seam edge runs
    // along a side of the domain. `spacing` is the length of an edge's segments and of a face's grid cells (default:
    // the shell's size over 48).
    public static solid( shell : BrepShell, mesh : TriMesh, spacing? : number ) : BrepSolid {
        const bb = mesh.boundingBox();
        const h = spacing != null ? spacing : Vec.dist( bb.min, bb.max ) / 48;
        const faces : Array<BrepFace> = shell.faces.map( F => {
            const s = F.surface, d = [s.knotsU[0], s.knotsU[s.knotsU.length - 1], s.knotsV[0], s.knotsV[s.knotsV.length - 1]];
            // the surface's extent each way, along its middle iso-curves
            const len = (alongU : boolean) => {
                let L = 0, prev : Point | null = null;
                for (let i = 0; i <= 32; i++) {
                    const t = i / 32, p = alongU ? Eval.rationalSurfacePoint( s, d[0] + t * (d[1] - d[0]), 0.5 * (d[2] + d[3]) )
                        : Eval.rationalSurfacePoint( s, 0.5 * (d[0] + d[1]), d[2] + t * (d[3] - d[2]) );
                    if (prev != null) L += Vec.dist( prev, p );
                    prev = p;
                }
                return L;
            };
            const divs : [number, number] = [Math.max( 4, Math.min( 96, Math.ceil( len( true ) / h ) ) ), Math.max( 4, Math.min( 96, Math.ceil( len( false ) / h ) ) )];
            return { surface : s, periodic : [false, false], divs : divs, reversed : !F.sameSense, name : F.name, trims : [] };
        } );
        // each edge sampled by its length; its points and their parameters on its two faces, at the same parameters
        const edges : Array<TrimEdge> = shell.edges.map( e => {
            const a = e.curve.knots[0], b = e.curve.knots[e.curve.knots.length - 1];
            let L = 0, prev = Eval.rationalCurvePoint( e.curve, a );
            for (let i = 1; i <= 64; i++) { const p = Eval.rationalCurvePoint( e.curve, a + (b - a) * i / 64 ); L += Vec.dist( prev, p ); prev = p; }
            const n = Math.max( 4, Math.min( 400, Math.ceil( 2 * L / h ) ) );
            const ts = Array.from( { length : n + 1 }, (_, i) => a + (b - a) * i / n );
            const points = ts.map( t => Eval.rationalCurvePoint( e.curve, t ) );
            points[0] = shell.vertices[e.start]; points[n] = shell.vertices[e.end];
            const closed = e.start == e.end && n > 2;
            // parameters within rounding of a side of the domain are on it (an edge along a side, as a blend's contact
            // curve, then runs along it, and the face's mesh takes its points as the side's)
            const uvOf = (pc : NurbsCurveData, fi : number) => {
                const sf = shell.faces[fi].surface, d = [sf.knotsU[0], sf.knotsU[sf.knotsU.length - 1], sf.knotsV[0], sf.knotsV[sf.knotsV.length - 1]];
                const snap = (x : number, c : number) => {
                    const lo = d[2 * c], hi = d[2 * c + 1], w = 1e-7 * (hi - lo);
                    return Math.abs( x - lo ) < w ? lo : Math.abs( x - hi ) < w ? hi : x;
                };
                const uv = ts.map( t => { const x = Eval.rationalCurvePoint( pc, t ); return [snap( x[0], 0 ), snap( x[1], 1 )] as UV; } );
                // an edge that runs along a side all the way is on it, though a fit's gap (a setback corner's parts are
                // fits within 1e-3 of the radius) puts its p-curve a little inside: the mesh would split it there
                for (let c = 0; c < 2; c++) for (const side of [d[2 * c], d[2 * c + 1]]) {
                    const w = 1e-4 * (d[2 * c + 1] - d[2 * c]);
                    if (uv.every( q => Math.abs( q[c] - side ) < w )) for (const q of uv) q[c] = side;
                }
                return uv;
            };
            const uvA = uvOf( e.pcurves[0], e.left ), uvB = uvOf( e.pcurves[1], e.right );
            // a closed edge drops its repeated last point
            if (closed) { points.pop(); uvA.pop(); uvB.pop(); }
            return { faces : [e.left, e.right], points : points, uvA : uvA, uvB : uvB, closed : closed };
        } );
        // each face's trims: its loops, walked along their edges' parameters on it
        shell.faces.forEach( (F, fi) => {
            for (const loop of F.loops) {
                const poly : Array<UV> = [];
                for (const [ei, fwd] of loop.edges) {
                    const E = edges[ei], uv = (fwd ? E.uvA : E.uvB).slice();
                    if (E.closed) uv.push( uv[0] );
                    const run = fwd ? uv : uv.reverse();
                    poly.push( ...run.slice( 0, run.length - 1 ) );
                }
                if (poly.length >= 3) (faces[fi].trims as Array<Array<UV>>).push( poly );
            }
        } );
        const solid = new BrepSolid( faces );
        solid.edges = edges;
        solid.boundary = mesh;
        return solid;
    }

    // The largest distance between a curve and a surface at the curve's p-curve on it, at the same parameter: sampled
    // uniformly and eight times in each knot span of either curve, then the largest sample's neighbourhood searched by
    // golden sections (the distance between samples can rise above the samples).
    public static deviation( curve : NurbsCurveData, surface : NurbsSurfaceData, pcurve : NurbsCurveData, samples : number = 64 ) : number {
        const a = curve.knots[0], b = curve.knots[curve.knots.length - 1];
        const dist = (t : number) => {
            const uv = Eval.rationalCurvePoint( pcurve, t );
            return Vec.dist( Eval.rationalSurfacePoint( surface, uv[0], uv[1] ), Eval.rationalCurvePoint( curve, t ) );
        };
        const ts : Array<number> = [];
        for (let i = 0; i <= samples; i++) ts.push( a + (b - a) * i / samples );
        for (const ks of [curve.knots, pcurve.knots]) for (let i = 0; i + 1 < ks.length; i++) {
            if (ks[i + 1] > ks[i]) for (let k = 1; k < 8; k++) ts.push( ks[i] + (ks[i + 1] - ks[i]) * k / 8 );
        }
        ts.sort( (x, y) => x - y );
        const ds = ts.map( dist );
        let worst = Math.max( ...ds );
        const g = (Math.sqrt( 5 ) - 1) / 2;
        // each local maximum of the samples within half of the largest
        for (let m = 0; m < ds.length; m++) {
            if (ds[m] < 0.5 * worst || (m > 0 && ds[m - 1] > ds[m]) || (m + 1 < ds.length && ds[m + 1] > ds[m])) continue;
            let lo = ts[Math.max( 0, m - 1 )], hi = ts[Math.min( ts.length - 1, m + 1 )];
            let x1 = hi - g * (hi - lo), x2 = lo + g * (hi - lo), f1 = dist( x1 ), f2 = dist( x2 );
            for (let it = 0; it < 30; it++) {
                if (f1 > f2) { hi = x2; x2 = x1; f2 = f1; x1 = hi - g * (hi - lo); f1 = dist( x1 ); }
                else { lo = x1; x1 = x2; f1 = f2; x2 = lo + g * (hi - lo); f2 = dist( x2 ); }
            }
            worst = Math.max( worst, f1, f2 );
        }
        return worst;
    }

    // An edge's curve in a face's parameters, over the curve's parameter: the curve's points projected onto the
    // surface, each from the last (one branch of the parameters, kept continuous across a closed surface's seam), the
    // branch shifted by whole periods so that the face, on the edge's left in its parameters, lies in the domain, then
    // fitted within a twentieth of the tolerance (measured on the surface).
    private static pcurve( curve : NurbsCurveData, F : ShellFace, project : (p : Point) => { uv : UV, p : Point }, tol : number ) : NurbsCurveData {
        const s = F.surface, periodic = F.closed;
        const d = [s.knotsU[0], s.knotsU[s.knotsU.length - 1], s.knotsV[0], s.knotsV[s.knotsV.length - 1]];
        const per = [d[1] - d[0], d[3] - d[2]];
        const a = curve.knots[0], b = curve.knots[curve.knots.length - 1];
        const n = Math.max( 16, 4 * curve.controlPoints.length );
        const ts : Array<number> = [], uvs : Array<UV> = [];
        const B = { surface : s, periodic : periodic };
        const near = (p : Point, seed : UV) : UV => {
            // Newton from the seed, unless it lands off the edge (the curve is within the tolerance of the face)
            const uv = SurfaceLoops.project( B, p, seed, 12 );
            const x : UV = uv != null && Vec.dist( Eval.rationalSurfacePoint( s, uv[0], uv[1] ), p ) <= tol ? uv.slice() as UV : project( p ).uv.slice() as UV;
            // the branch nearest the seed
            for (let c = 0; c < 2; c++) if (periodic[c]) x[c] += Math.round( (seed[c] - x[c]) / per[c] ) * per[c];
            return x;
        };
        for (let i = 0; i <= n; i++) {
            const t = a + (b - a) * i / n, p = Eval.rationalCurvePoint( curve, t );
            ts.push( t );
            uvs.push( i == 0 ? project( p ).uv : near( p, uvs[i - 1] ) );
        }
        // the face's side: just left of the edge's middle (right where the surface's normal points into the solid)
        const shift = [0, 0];
        const m = n >> 1, du = Vec.sub( uvs[m + 1], uvs[m - 1] ), sg = F.sameSense ? 1 : -1;
        const nl = [-du[1] * sg, du[0] * sg], ln = Math.hypot( nl[0], nl[1] );
        for (let c = 0; c < 2; c++) {
            if (!periodic[c]) continue;
            const x = uvs[m][c] + (ln > 0 ? 1e-6 * per[c] * nl[c] / ln : 0);
            shift[c] = -Math.floor( (x - d[2 * c]) / per[c] ) * per[c];
        }
        for (const uv of uvs) { uv[0] += shift[0]; uv[1] += shift[1]; }
        const f = (t : number) : Point => {
            const k = Math.max( 0, Math.min( n, Math.round( (t - a) / (b - a) * n ) ) );
            return near( Eval.rationalCurvePoint( curve, t ), uvs[k] );
        };
        // the tolerance in parameters: by the surface's largest first derivative along the edge
        let scale = 0;
        for (const uv of uvs) {
            const dd = Eval.rationalSurfaceDerivatives( s, Math.max( d[0], Math.min( d[1], uv[0] ) ), Math.max( d[2], Math.min( d[3], uv[1] ) ), 1 );
            scale = Math.max( scale, Vec.norm( dd[1][0] ), Vec.norm( dd[0][1] ) );
        }
        const spans = Math.max( 1, Math.min( 32, n >> 2 ) );
        const inner : Array<number> = [];
        for (let k = 1; k < spans; k++) inner.push( a + (b - a) * k / spans );
        // where the edge crosses a breakpoint of the surface (a knot of full multiplicity, where it is only C0) its
        // parameters turn a corner: a triple knot there lets the p-curve turn it too
        const breaks = [ShellBuilder.breakpoints( s.knotsU, s.degreeU ), ShellBuilder.breakpoints( s.knotsV, s.degreeV )];
        const corners : Array<number> = [];
        for (let i = 0; i < n; i++) for (let c = 0; c < 2; c++) for (const k of breaks[c]) {
            const x0 = uvs[i][c], x1 = uvs[i + 1][c];
            for (const kk of periodic[c] ? [k - per[c], k, k + per[c]] : [k]) {
                if ((x0 - kk) * (x1 - kk) >= 0) continue;
                // the crossing, by bisection on the projected parameter
                let lo = ts[i], hi = ts[i + 1];
                for (let it = 0; it < 50; it++) {
                    const mid = 0.5 * (lo + hi), x = near( Eval.rationalCurvePoint( curve, mid ), uvs[i] )[c];
                    if ((x - kk) * (x0 - kk) > 0) lo = mid; else hi = mid;
                }
                corners.push( 0.5 * (lo + hi) );
            }
        }
        const minGap = 1e-3 * (b - a);
        const knots = [a, a, a, a];
        const all = inner.filter( t => corners.every( x => Math.abs( x - t ) > minGap ) ).map( t => [t, 1] )
            .concat( corners.filter( t => t > a + minGap && t < b - minGap ).map( t => [t, 3] ) ).sort( (x, y) => x[0] - y[0] );
        for (const [t, mult] of all) for (let k = 0; k < mult; k++) knots.push( t );
        knots.push( b, b, b, b );
        const fit = Fit.approximateCurve( f, 3, knots, 0.05 * tol / Math.max( scale, 1e-300 ), 8 ).curve;
        // the ends exactly at the end points' parameters
        const cp = fit.controlPoints, e0 = uvs[0], e1 = uvs[n];
        cp[0] = [e0[0], e0[1], 1]; cp[cp.length - 1] = [e1[0], e1[1], 1];
        // inside the domain where the surface is open: the control points kept in it, so the curve is (it lies in their
        // hull); a fit along a side would stray past it by a little, where the surface is only carried on
        for (const x of cp) for (let c = 0; c < 2; c++) if (!periodic[c]) x[c] = Math.max( d[2 * c], Math.min( d[2 * c + 1], x[c] ) );
        return fit;
    }

    public static topology( r : BooleanResult ) : ShellTopology {
        const m = r.mesh;
        // directed boundary edges a -> b: on the face of the triangle that has them in its winding (outward), so that
        // face is on the left; the face across is on the right
        const across = new Map<string, number>(); // "a,b" -> face of the triangle with a -> b
        m.triangles.forEach( (t, k) => {
            for (let x = 0; x < 3; x++) across.set( t[x] + "," + t[(x + 1) % 3], r.faceOf[k] );
        } );
        const out = new Map<number, Array<{ to : number, left : number, right : number }>>();
        const facesAt = new Map<number, Set<number>>();
        for (const [key, left] of across) {
            const [a, b] = key.split( "," ).map( Number );
            const right = across.get( b + "," + a );
            if (right == null) throw new Error( "BrepShell: the mesh is not closed (edge " + a + "-" + b + " has one side)" );
            if (right == left) continue;
            let l = out.get( a ); if (l == null) out.set( a, l = [] );
            l.push( { to : b, left : left, right : right } );
            for (const v of [a, b]) { let s = facesAt.get( v ); if (s == null) facesAt.set( v, s = new Set() ); s.add( left ); s.add( right ); }
        }
        // chains break where three or more faces meet, or where two faces touch at a vertex more than once (more than
        // two boundary edges there)
        const isEnd = (v : number) => (facesAt.get( v ) as Set<number>).size >= 3 || new Set( (out.get( v ) as Array<{ to : number }>).map( s => s.to ) ).size != 2;
        const vertices : Array<number> = [];
        const vertexSet = new Set<number>();
        const addVertex = (v : number) => { if (!vertexSet.has( v )) { vertexSet.add( v ); vertices.push( v ); } };
        const used = new Set<string>();
        const edges : ShellTopology["edges"] = [];
        // the directed edge -> (edge index, forward)
        const owner = new Map<string, [number, boolean]>();
        const walk = (a : number, first : { to : number, left : number, right : number }) => {
            const chain = [a];
            let cur = a, step = first;
            for (;;) {
                used.add( cur + "," + step.to ); used.add( step.to + "," + cur );
                chain.push( step.to );
                cur = step.to;
                if (isEnd( cur ) || cur == a) break;
                const next = (out.get( cur ) as Array<{ to : number, left : number, right : number }>).find( s => s.left == first.left && s.right == first.right && !used.has( cur + "," + s.to ) );
                if (next == null) break;
                step = next;
            }
            const e = edges.length;
            edges.push( { chain : chain, left : first.left, right : first.right } );
            addVertex( chain[0] ); addVertex( chain[chain.length - 1] );
            for (let k = 0; k + 1 < chain.length; k++) {
                owner.set( chain[k] + "," + chain[k + 1], [e, true] );
                owner.set( chain[k + 1] + "," + chain[k], [e, false] );
            }
        };
        // open chains from their ends first, then the closed ones that are left
        for (const [a, steps] of out) if (isEnd( a )) for (const s of steps) if (!used.has( a + "," + s.to )) walk( a, s );
        for (const [a, steps] of out) for (const s of steps) if (!used.has( a + "," + s.to )) walk( a, s );

        // loops: for each face, follow its oriented edges (face on the left) end to start
        const loops : ShellTopology["loops"] = r.faces.map( () => [] );
        const startsAt = new Map<string, Array<[number, boolean]>>(); // face:vertex -> oriented edges leaving it
        edges.forEach( (e, k) => {
            const first = e.chain[0], last = e.chain[e.chain.length - 1];
            for (const [face, fwd, from] of [[e.left, true, first], [e.right, false, last]] as Array<[number, boolean, number]>) {
                const key = face + ":" + from;
                let l = startsAt.get( key ); if (l == null) startsAt.set( key, l = [] );
                l.push( [k, fwd] );
            }
        } );
        const taken = new Set<string>();
        edges.forEach( (e, k) => {
            for (const [face, fwd] of [[e.left, true], [e.right, false]] as Array<[number, boolean]>) {
                if (taken.has( k + ":" + fwd )) continue;
                const loop : Array<[number, boolean]> = [];
                let cur : [number, boolean] = [k, fwd];
                for (let guard = 0; guard <= edges.length; guard++) {
                    taken.add( cur[0] + ":" + cur[1] );
                    loop.push( cur );
                    const c = edges[cur[0]].chain;
                    const end = cur[1] ? c[c.length - 1] : c[0];
                    const nexts = (startsAt.get( face + ":" + end ) ?? []).filter( x => !taken.has( x[0] + ":" + x[1] ) );
                    if (nexts.length == 0) break;
                    cur = nexts[0];
                }
                loops[face].push( loop );
            }
        } );
        return { vertices : vertices, edges : edges, loops : loops };
    }

    // ---------- geometry ----------

    // The point of a surface nearest p: from the nearest of a grid of samples, by Newton's method.
    public static projector( s : NurbsSurfaceData ) : (p : Point) => { uv : UV, p : Point } {
        const d = [s.knotsU[0], s.knotsU[s.knotsU.length - 1], s.knotsV[0], s.knotsV[s.knotsV.length - 1]];
        const periodic : [boolean, boolean] = [Analyze.isRationalSurfaceClosed( s, true ), Analyze.isRationalSurfaceClosed( s, false )];
        const seeds : Array<{ uv : UV, p : Point }> = [];
        const g = 16;
        // samples in each direction: a uniform grid, and three in each knot span (a surface whose spans differ in
        // length, as a cap on a rounded rectangle whose long sides take a tenth of its domain, would otherwise be
        // sampled across a whole side at one point), up to 64 spans
        const samples = (knots : Array<number>, a : number, b : number) => {
            const xs : Array<number> = [];
            for (let i = 0; i <= g; i++) xs.push( a + (b - a) * i / g );
            const ks = knots.filter( (k, i) => i == 0 || k > knots[i - 1] );
            if (ks.length - 1 <= 64) for (let i = 0; i + 1 < ks.length; i++) for (const f of [0.25, 0.5, 0.75]) xs.push( ks[i] + f * (ks[i + 1] - ks[i]) );
            return xs.sort( (x, y) => x - y );
        };
        const su = samples( s.knotsU, d[0], d[1] ), sv = samples( s.knotsV, d[2], d[3] );
        const breaks : [Array<number>, Array<number>] = [ShellBuilder.breakpoints( s.knotsU, s.degreeU ), ShellBuilder.breakpoints( s.knotsV, s.degreeV )];
        for (const u of su) for (const v of sv) seeds.push( { uv : [u, v], p : Eval.rationalSurfacePoint( s, u, v ) } );
        // each sample's neighbours' spacing, for the finer grids round the nearest
        const gap = (xs : Array<number>, x : number) => { let h = Infinity; for (const y of xs) if (y != x) h = Math.min( h, Math.abs( y - x ) ); return h; };
        const span = [d[1] - d[0], d[3] - d[2]];
        const inDomain = (x : number, c : number) => {
            if (!periodic[c]) return Math.max( d[2 * c], Math.min( d[2 * c + 1], x ) );
            const t = (x - d[2 * c]) / span[c];
            return d[2 * c] + (t - Math.floor( t )) * span[c];
        };
        return (p : Point) => {
            let best = seeds[0], bd = Vec.distSquared( best.p, p );
            for (const x of seeds) { const dd = Vec.distSquared( x.p, p ); if (dd < bd) { best = x; bd = dd; } }
            // closer, on finer grids round the nearest sample (Newton alone can run off along a surface of revolution)
            let h = [Math.min( span[0] / g, 2 * gap( su, best.uv[0] ) ), Math.min( span[1] / g, 2 * gap( sv, best.uv[1] ) )];
            // (at each spacing, moving on while the nearest is at the edge of the grid round it: the nearest sample can
            // be a span or more from the point where the samples are sparse)
            for (let round = 0, moves = 0; round < 4; ) {
                const c = best;
                for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
                    const uv : UV = [inDomain( c.uv[0] + i * h[0] / 2, 0 ), inDomain( c.uv[1] + j * h[1] / 2, 1 )];
                    const q = Eval.rationalSurfacePoint( s, uv[0], uv[1] ), dd = Vec.distSquared( q, p );
                    if (dd < bd) { best = { uv : uv, p : q }; bd = dd; }
                }
                const atEdge = Math.abs( best.uv[0] - c.uv[0] ) > 0.75 * h[0] || Math.abs( best.uv[1] - c.uv[1] ) > 0.75 * h[1];
                if (atEdge && moves < 16) { moves++; continue; }
                h = [h[0] / 2.5, h[1] / 2.5]; round++; moves = 0;
            }
            const x = ShellBuilder.newton( s, d, breaks, inDomain, p, best.uv );
            return x.d <= bd ? { uv : x.uv, p : x.p } : { uv : best.uv, p : best.p };
        };
    }

    // The interior knots of full multiplicity in each direction: where the surface is only C0 (the corners of a
    // rounded rectangle swept or capped), and Newton's method, which follows one span's polynomial past its end, can
    // settle on a foot of the wrong span.
    private static breakpoints( knots : Array<number>, degree : number ) : Array<number> {
        const out : Array<number> = [];
        for (let i = degree + 1; i < knots.length - degree - 1; ) {
            let j = i; while (j + 1 < knots.length && knots[j + 1] == knots[i]) j++;
            if (j - i + 1 >= degree) out.push( knots[i] );
            i = j + 1;
        }
        return out;
    }

    // Gauss-Newton on the squared distance (its step always goes down hill, where Newton's, with the surface's
    // curvature in it, can climb away on a corner span), halved until the distance falls, and a step that would
    // cross a breakpoint stopping just past it (in the next span, whose polynomial is then followed). Returns the
    // nearest point it reached.
    private static newton( s : NurbsSurfaceData, d : Array<number>, breaks : [Array<number>, Array<number>], inDomain : (x : number, c : number) => number,
                           p : Point, uv0 : UV ) : { uv : UV, p : Point, d : number } {
        let uv : UV = [inDomain( uv0[0], 0 ), inDomain( uv0[1], 1 )];
        let q = Eval.rationalSurfacePoint( s, uv[0], uv[1] ), dq = Vec.distSquared( q, p );
        for (let it = 0; it < 60; it++) {
            const D = Eval.rationalSurfaceDerivatives( s, uv[0], uv[1], 1 );
            const r = Vec.sub( D[0][0], p );
            const g = [Vec.dot( r, D[1][0] ), Vec.dot( r, D[0][1] )];
            const H = [[Vec.dot( D[1][0], D[1][0] ), Vec.dot( D[1][0], D[0][1] )], [Vec.dot( D[1][0], D[0][1] ), Vec.dot( D[0][1], D[0][1] )]];
            const det = H[0][0] * H[1][1] - H[0][1] * H[1][0];
            let step : Array<number>;
            if (Math.abs( det ) > 1e-12 * (H[0][0] * H[1][1] + 1e-300)) step = [(H[1][1] * g[0] - H[0][1] * g[1]) / det, (H[0][0] * g[1] - H[1][0] * g[0]) / det];
            else step = [H[0][0] > 0 ? g[0] / H[0][0] : 0, H[1][1] > 0 ? g[1] / H[1][1] : 0]; // at a pole: each direction alone
            // the full step, then (held at a side of the domain, the full step can make no headway) each direction alone
            const tries = [step, [H[0][0] > 0 ? g[0] / H[0][0] : 0, 0], [0, H[1][1] > 0 ? g[1] / H[1][1] : 0]];
            let moved = false;
            for (const t0 of tries) {
              step = t0;
              for (let half = 0; half < 30 && !moved; half++) {
                const next : UV = [uv[0] - step[0], uv[1] - step[1]];
                for (let c = 0; c < 2; c++) {
                    const a = uv[c], b = next[c], eps = 1e-9 * (d[2 * c + 1] - d[2 * c]);
                    for (const k of breaks[c]) {
                        if (a < k - eps && b > k) next[c] = Math.min( next[c], k + eps );
                        else if (a > k + eps && b < k) next[c] = Math.max( next[c], k - eps );
                    }
                    next[c] = inDomain( next[c], c );
                }
                const qn = Eval.rationalSurfacePoint( s, next[0], next[1] ), dn = Vec.distSquared( qn, p );
                if (dn < dq) { moved = Math.abs( next[0] - uv[0] ) + Math.abs( next[1] - uv[1] ) > 1e-16; uv = next; q = qn; dq = dn; break; }
                step = [step[0] / 2, step[1] / 2];
              }
              if (moved) break;
            }
            if (!moved) break;
        }
        return { uv : uv, p : q, d : dq };
    }

    // A chain of points on the curve where two faces meet, made dense enough to follow it: between two points whose
    // chord strays from the faces by more than `tol` at its middle, a point is put on the faces (projected onto one,
    // then the other, a few times: alternating projections onto the two surfaces), and so on, down to 1/64 of the
    // first spacing.
    private static refine( pts : Array<Point>, onA : (p : Point) => Point, onB : (p : Point) => Point, tol : number ) : Array<Point> {
        const onBoth = (p : Point) => { let q = p; for (let k = 0; k < 4; k++) q = onB( onA( q ) ); return q; };
        const out : Array<Point> = [pts[0]];
        const split = (a : Point, b : Point, depth : number) => {
            const mid = Vec.mul( 0.5, Vec.add( a, b ) );
            const m = onBoth( mid );
            if (depth < 6 && Vec.dist( m, mid ) > tol) { split( a, m, depth + 1 ); split( m, b, depth + 1 ); }
            else out.push( b );
        };
        for (let k = 0; k + 1 < pts.length; k++) split( pts[k], pts[k + 1], 0 );
        return out;
    }

    // A cubic B-spline through a chain of points, within `tol` of the polyline (its ends exact).
    private static fitChain( pts : Array<Point>, tol : number ) : NurbsCurveData {
        if (pts.length <= 3) return Fit.curve( pts, Math.min( 3, pts.length - 1 ) );
        const u = Fit.chordLengthParams( pts );
        const at = (s : number) : Point => {
            let k = 0;
            while (k + 2 < u.length && u[k + 1] < s) k++;
            const du = u[k + 1] - u[k], f = du > 0 ? Math.max( 0, Math.min( 1, (s - u[k]) / du ) ) : 0;
            return Vec.add( Vec.mul( 1 - f, pts[k] ), Vec.mul( f, pts[k + 1] ) );
        };
        // start from a knot per few points, so the fit follows the chain's spacing
        const spans = Math.max( 1, Math.min( 64, Math.floor( pts.length / 4 ) ) );
        const knots = [0, 0, 0, 0];
        for (let k = 1; k < spans; k++) knots.push( u[Math.round( k * (pts.length - 1) / spans )] );
        knots.push( 1, 1, 1, 1 );
        return Fit.approximateCurve( at, 3, knots, tol, 8 ).curve;
    }

    // Whether the surface's own normal (dS/du x dS/dv) points out of the solid: a vote of the face's triangles.
    private static sameSense( r : BooleanResult, fi : number ) : boolean {
        const m = r.mesh, f = r.faces[fi], s = f.surface;
        const d = [s.knotsU[0], s.knotsU[s.knotsU.length - 1], s.knotsV[0], s.knotsV[s.knotsV.length - 1]];
        const periodic : [boolean, boolean] = [Analyze.isRationalSurfaceClosed( s, true ), Analyze.isRationalSurfaceClosed( s, false )];
        const seeds : Array<{ uv : UV, p : Point }> = [];
        for (let i = 0; i <= 8; i++) for (let j = 0; j <= 8; j++) {
            const uv : UV = [d[0] + (d[1] - d[0]) * i / 8, d[2] + (d[3] - d[2]) * j / 8];
            seeds.push( { uv : uv, p : Eval.rationalSurfacePoint( s, uv[0], uv[1] ) } );
        }
        let vote = 0, n = 0;
        for (let k = 0; k < m.triangles.length && n < 24; k++) {
            if (r.faceOf[k] != fi) continue;
            const t = m.triangles[k], a = m.vertices[t[0]], b = m.vertices[t[1]], c = m.vertices[t[2]];
            const nt = Vec.cross( Vec.sub( b, a ), Vec.sub( c, a ) );
            if (Vec.norm( nt ) < 1e-300) continue;
            const cen = Vec.mul( 1 / 3, Vec.add( a, Vec.add( b, c ) ) );
            const cuv = r.cornerUV != null ? r.cornerUV[k] : null;
            let uv : UV | null = cuv != null ? [(cuv[0][0] + cuv[1][0] + cuv[2][0]) / 3, (cuv[0][1] + cuv[1][1] + cuv[2][1]) / 3] : null;
            if (uv == null) {
                let best = seeds[0];
                for (const x of seeds) if (Vec.distSquared( x.p, cen ) < Vec.distSquared( best.p, cen )) best = x;
                uv = SurfaceLoops.project( { surface : s, periodic : periodic }, cen, best.uv );
            }
            if (uv == null) continue;
            const dd = Eval.rationalSurfaceDerivatives( s, uv[0], uv[1], 1 );
            const ns = Vec.cross( dd[1][0], dd[0][1] );
            if (Vec.norm( ns ) < 1e-300) continue;
            vote += Vec.dot( ns, nt ) > 0 ? 1 : -1; n++;
        }
        return n == 0 ? !f.reversed : vote >= 0;
    }

}
