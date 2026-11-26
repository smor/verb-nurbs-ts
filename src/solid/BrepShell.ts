import { NurbsCurveData, NurbsSurfaceData, Point, UV } from "../core/Data.js";
import { Vec } from "../core/Vec.js";
import { Analyze } from "../eval/Analyze.js";
import { Eval } from "../eval/Eval.js";
import { Fit } from "../eval/Fit.js";
import { BooleanResult } from "./BrepBoolean.js";
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

    // The largest distance between a curve and a surface at the curve's p-curve on it, at the same parameter.
    public static deviation( curve : NurbsCurveData, surface : NurbsSurfaceData, pcurve : NurbsCurveData, samples : number = 64 ) : number {
        const a = curve.knots[0], b = curve.knots[curve.knots.length - 1];
        let worst = 0;
        for (let i = 0; i <= samples; i++) {
            const t = a + (b - a) * i / samples, uv = Eval.rationalCurvePoint( pcurve, t );
            worst = Math.max( worst, Vec.dist( Eval.rationalSurfacePoint( surface, uv[0], uv[1] ), Eval.rationalCurvePoint( curve, t ) ) );
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
        const knots = [a, a, a, a];
        for (let k = 1; k < spans; k++) knots.push( a + (b - a) * k / spans );
        knots.push( b, b, b, b );
        const fit = Fit.approximateCurve( f, 3, knots, 0.05 * tol / Math.max( scale, 1e-300 ), 8 ).curve;
        // the ends exactly at the end points' parameters
        const cp = fit.controlPoints, e0 = uvs[0], e1 = uvs[n];
        cp[0] = [e0[0], e0[1], 1]; cp[cp.length - 1] = [e1[0], e1[1], 1];
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
        for (let i = 0; i <= g; i++) for (let j = 0; j <= g; j++) {
            const uv : UV = [d[0] + (d[1] - d[0]) * i / g, d[2] + (d[3] - d[2]) * j / g];
            seeds.push( { uv : uv, p : Eval.rationalSurfacePoint( s, uv[0], uv[1] ) } );
        }
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
            let h = [span[0] / g, span[1] / g];
            for (let round = 0; round < 4; round++) {
                const c = best;
                for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
                    const uv : UV = [inDomain( c.uv[0] + i * h[0] / 2, 0 ), inDomain( c.uv[1] + j * h[1] / 2, 1 )];
                    const q = Eval.rationalSurfacePoint( s, uv[0], uv[1] ), dd = Vec.distSquared( q, p );
                    if (dd < bd) { best = { uv : uv, p : q }; bd = dd; }
                }
                h = [h[0] / 2.5, h[1] / 2.5];
            }
            const uv = SurfaceLoops.project( { surface : s, periodic : periodic }, p, best.uv );
            if (uv == null) return { uv : best.uv, p : best.p };
            const q = Eval.rationalSurfacePoint( s, uv[0], uv[1] );
            return Vec.distSquared( q, p ) <= bd ? { uv : uv, p : q } : { uv : best.uv, p : best.p };
        };
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
