import { NurbsCurveData, NurbsSurfaceData, Point, UV } from "../core/Data.js";
import { Vec } from "../core/Vec.js";
import { Analyze } from "../eval/Analyze.js";
import { Eval } from "../eval/Eval.js";
import { Fit } from "../eval/Fit.js";

// An edge while the B-rep is built: a polyline on the faces where they meet (its first and last points are its
// vertices), or a fitted curve (a seam), with the faces on its left and right.
export interface SeamEdge {
    pts : Array<Point>;
    start : number;
    end : number;
    left : number;
    right : number;
    curve? : NurbsCurveData;
    // a seam edge: its curve runs along the seam from w0 to w1 (the surface's other parameter, linearly in the curve's
    // parameter from 0 to 1), and the face's boundary uses it forwards on the low side (at the domain's start) when
    // lowForward, on the high side (at its end) otherwise
    seam? : { w0 : number, w1 : number, lowForward : boolean };
}

// Where a face was cut: along the seam of its surface's closed direction d (0: u, 1: v), at c0, the period per.
export interface SeamCut { d : number, c0 : number, per : number }

// A face while the B-rep is built: its surface, whether the surface's normal points out of the solid, and the nearest
// point of the surface to a point (its parameters, in the surface's domain, and the point).
export interface SeamFace {
    surface : NurbsSurfaceData;
    sameSense : boolean;
    project : (p : Point) => { uv : UV, p : Point };
}

export interface SeamLoop {
    outer : boolean;
    edges : Array<[number, boolean]>;
}

// Seams: faces on closed surfaces, cut where their surfaces close.
//
// A surface closed in one direction (a pipe, a surface of revolution, a disc with a pole at its centre) has a seam:
// the iso-curve where its parameter jumps from the end of its domain back to the start. A face on it whose boundary
// crosses the seam (a ring round a pipe, a wall with a hole across the seam) has no boundary in parameter space
// until the seam is made one: exchange formats and the kernels that read them expect a seam edge, used twice by the
// face, once on each side of the cut, so that every face is a region of its surface's parameter rectangle.
//
// The cut: where each loop of the face crosses the seam (where its closed parameter passes the domain's start,
// modulo the period), a vertex is put on the loop's edge; along the seam, the crossings sorted by the other parameter
// bound the stretches of the seam inside the face (each crossing says which side the face is on, from the direction
// the loop crosses: the face lies on a loop's left). A stretch that runs into a pole (where the surface shrinks to a
// point) ends there. Each stretch becomes a seam edge, an iso-curve of the surface, and the face's loops are walked
// again with each seam edge twice, keeping to one side of the cut at each crossing.
//
// Surfaces closed in both directions (a torus) are left as they are: their faces keep their loops uncut.
export class Seams {

    public static cut( faces : Array<SeamFace>, edges : Array<SeamEdge>, vertices : Array<Point>, loops : Array<Array<Array<[number, boolean]>>>,
                       tol : number, onBoth : (e : SeamEdge, p : Point) => Point )
        : { edges : Array<SeamEdge>, loops : Array<Array<SeamLoop>>, cuts : Array<SeamCut | null> } {
        const splits = edges.map( () => [] as Array<{ pos : number, vertex : number }> );
        // a vertex on edge e at pos (along its polyline: segment index plus fraction)
        const vertexAt = (e : number, pos : number) : number => {
            const E = edges[e], last = E.pts.length - 1;
            if (pos <= 1e-12) return E.start;
            if (pos >= last - 1e-12) return E.end;
            const known = splits[e].find( x => Math.abs( x.pos - pos ) < 1e-9 );
            if (known != null) return known.vertex;
            const k = Math.floor( pos ), f = pos - k;
            const round = Math.abs( pos - Math.round( pos ) ) < 1e-12;
            const p = round ? E.pts[Math.round( pos )] : onBoth( E, Vec.add( Vec.mul( 1 - f, E.pts[k] ), Vec.mul( f, E.pts[k + 1] ) ) );
            vertices.push( p );
            splits[e].push( { pos : round ? Math.round( pos ) : pos, vertex : vertices.length - 1 } );
            return vertices.length - 1;
        };

        type Plan = { d : number, c0 : number, per : number, seams : Array<{ a : number, b : number, wa : number, wb : number }>, poles : Set<number> };
        const plans : Array<Plan | null> = faces.map( (F, fi) => {
            const s = F.surface;
            const cu = Analyze.isRationalSurfaceClosed( s, true ), cv = Analyze.isRationalSurfaceClosed( s, false );
            if (cu == cv) return null;
            const d = cu ? 0 : 1;
            const dom = Seams.domain( s ), c0 = dom[2 * d], per = dom[2 * d + 1] - c0;
            const crossings : Array<{ vertex : number, w : number, above : boolean }> = [];
            for (const loop of loops[fi]) {
                const S : Array<{ j : number, k : number, n : number, p : Point }> = [];
                loop.forEach( ([e, fwd], j) => {
                    const pts = fwd ? edges[e].pts : edges[e].pts.slice().reverse();
                    for (let k = 0; k + 1 < pts.length; k++) S.push( { j : j, k : k, n : pts.length, p : pts[k] } );
                } );
                const x = Seams.unwrap( S.map( q => (F.project( q.p ).uv[d] - c0) / per ) );
                const snap = (v : number) => Math.abs( v - Math.round( v ) ) < 1e-9 ? Math.round( v ) : v;
                for (let i = 0; i < S.length; i++) {
                    const a = snap( x[i] ), b = snap( x[i + 1] );
                    const fa = Math.floor( a ), fb = Math.floor( b );
                    if (fa == fb) continue;
                    if (Math.abs( fa - fb ) > 1) return null;
                    const t = (Math.max( fa, fb ) - a) / (b - a);
                    const [e, fwd] = loop[S[i].j];
                    const pos = fwd ? S[i].k + t : S[i].n - 2 - S[i].k + (1 - t);
                    const v = vertexAt( e, pos );
                    crossings.push( { vertex : v, w : F.project( vertices[v] ).uv[1 - d], above : ((d == 0) == (b > a)) == F.sameSense } );
                }
            }
            if (crossings.length == 0) return null;
            crossings.sort( (p, q) => p.w - q.w );
            // the seam's stretches inside the face, from the lowest crossing up
            const seams : Plan["seams"] = [], poles = new Set<number>();
            const pole = (w : number) : number | null => {
                const at = (c : number) => d == 0 ? Eval.rationalSurfacePoint( s, c, w ) : Eval.rationalSurfacePoint( s, w, c );
                const p0 = at( c0 );
                for (let k = 1; k < 8; k++) if (Vec.dist( at( c0 + per * k / 8 ), p0 ) > 1e-3 * tol) return null;
                vertices.push( p0 ); poles.add( vertices.length - 1 );
                return vertices.length - 1;
            };
            let open : { vertex : number, w : number } | null = null;
            for (let i = 0; i < crossings.length; i++) {
                const c = crossings[i];
                if (c.above) { if (open != null) return null; open = c; continue; }
                if (open != null) {
                    if (open.vertex != c.vertex) seams.push( { a : open.vertex, b : c.vertex, wa : open.w, wb : c.w } );
                    open = null;
                    continue;
                }
                if (i > 0) return null;
                const p = pole( dom[2 * (1 - d)] );
                if (p == null) return null;
                seams.push( { a : p, b : c.vertex, wa : dom[2 * (1 - d)], wb : c.w } );
            }
            if (open != null) {
                const p = pole( dom[2 * (1 - d) + 1] );
                if (p == null) return null;
                seams.push( { a : open.vertex, b : p, wa : open.w, wb : dom[2 * (1 - d) + 1] } );
            }
            return { d : d, c0 : c0, per : per, seams : seams, poles : poles };
        } );

        // the edges, split at the crossings
        const out : Array<SeamEdge> = [];
        const pieces = edges.map( (E, e) => {
            const cuts = splits[e].slice().sort( (p, q) => p.pos - q.pos );
            const ids : Array<number> = [];
            let pos0 = 0, v0 = E.start;
            for (const c of cuts.concat( [{ pos : E.pts.length - 1, vertex : E.end }] )) {
                const pts = [vertices[v0]];
                for (let k = Math.floor( pos0 ) + 1; k < c.pos - 1e-12; k++) pts.push( E.pts[k] );
                pts.push( vertices[c.vertex] );
                ids.push( out.length );
                out.push( { pts : pts, start : v0, end : c.vertex, left : E.left, right : E.right } );
                pos0 = c.pos; v0 = c.vertex;
            }
            return ids;
        } );
        const expand = (loop : Array<[number, boolean]>) : Array<[number, boolean]> =>
            ([] as Array<[number, boolean]>).concat( ...loop.map( ([e, fwd]) => {
                const l = pieces[e].map( id => [id, fwd] as [number, boolean] );
                return fwd ? l : l.reverse();
            } ) );

        const result = faces.map( (F, fi) => {
            const plan = plans[fi];
            if (plan == null) {
                const ls = loops[fi].map( expand );
                return Seams.outer( F, ls, out, null );
            }
            const { d, c0, per } = plan;
            // the seam edges, from low to high along the seam; on the side at c0 the face's boundary runs one way, on
            // the side at c0 + per the other
            const lowFwd = (d == 1) == F.sameSense;
            const seamUse = new Map<number, number>(); // seam edge -> side (0: at c0, 1: at c0 + per) of its forward use
            for (const sm of plan.seams) {
                const s = F.surface;
                const iso = (t : number) : Point => {
                    const w = sm.wa + t * (sm.wb - sm.wa);
                    return d == 0 ? Eval.rationalSurfacePoint( s, c0, w ) : Eval.rationalSurfacePoint( s, w, c0 );
                };
                const curve = Fit.approximateCurve( iso, 3, [0, 0, 0, 0, 1, 1, 1, 1], 0.25 * tol, 8 ).curve;
                seamUse.set( out.length, lowFwd ? 0 : 1 );
                out.push( { pts : [vertices[sm.a], vertices[sm.b]], start : sm.a, end : sm.b, left : fi, right : fi, curve : curve,
                            seam : { w0 : sm.wa, w1 : sm.wb, lowForward : lowFwd } } );
            }
            const uses : Array<[number, boolean]> = ([] as Array<[number, boolean]>).concat( ...loops[fi].map( expand ) );
            for (const e of seamUse.keys()) uses.push( [e, true], [e, false] );
            const seamVertices = new Set<number>( plan.poles );
            for (const sm of plan.seams) { seamVertices.add( sm.a ); seamVertices.add( sm.b ); }
            // which side of the cut a use leaves from (atStart) or arrives at
            const side = (u : [number, boolean], atStart : boolean) : number => {
                const [e, fwd] = u, E = out[e];
                const sideOfForward = seamUse.get( e );
                if (sideOfForward != null) return fwd ? sideOfForward : 1 - sideOfForward;
                const pts = fwd ? E.pts : E.pts.slice().reverse();
                const a = atStart ? pts[0] : pts[pts.length - 1], b = atStart ? pts[1] : pts[pts.length - 2];
                const x = (F.project( Vec.lerp( 0.5, a, b ) ).uv[d] - c0) / per;
                return x - Math.floor( x ) < 0.5 ? 0 : 1;
            };
            const startOf = (u : [number, boolean]) => u[1] ? out[u[0]].start : out[u[0]].end;
            const endOf = (u : [number, boolean]) => u[1] ? out[u[0]].end : out[u[0]].start;
            const leaving = new Map<number, Array<number>>();
            uses.forEach( (u, k) => { const v = startOf( u ); let l = leaving.get( v ); if (l == null) leaving.set( v, l = [] ); l.push( k ); } );
            const used = new Set<number>(), ls : Array<Array<[number, boolean]>> = [];
            for (let k0 = 0; k0 < uses.length; k0++) {
                if (used.has( k0 )) continue;
                const loop : Array<[number, boolean]> = [uses[k0]];
                used.add( k0 );
                let cur = k0;
                for (let guard = 0; guard < uses.length; guard++) {
                    const v = endOf( uses[cur] );
                    let cands = (leaving.get( v ) ?? []).filter( k => !used.has( k ) || k == k0 );
                    if (cands.length > 1 && seamVertices.has( v )) {
                        const sd = side( uses[cur], false );
                        // at a pole the two sides of the cut meet
                        cands = cands.filter( k => (side( uses[k], true ) == sd) != plan.poles.has( v ) );
                    }
                    if (cands.length == 0) break;
                    const next = cands.includes( k0 ) ? k0 : cands[0];
                    if (next == k0) break;
                    loop.push( uses[next] ); used.add( next ); cur = next;
                }
                ls.push( loop );
            }
            return Seams.outer( F, ls, out, { d : d, c0 : c0, per : per, seamUse : seamUse } );
        } );
        return { edges : out, loops : result, cuts : plans.map( p => p == null ? null : { d : p.d, c0 : p.c0, per : p.per } ) };
    }

    // The loops, the one with the largest area in the parameter plane marked outer (none on a surface closed both
    // ways, whose loops bound no region of its parameter rectangle).
    private static outer( F : SeamFace, ls : Array<Array<[number, boolean]>>, edges : Array<SeamEdge>,
                          cut : { d : number, c0 : number, per : number, seamUse : Map<number, number> } | null ) : Array<SeamLoop> {
        const s = F.surface;
        const cu = Analyze.isRationalSurfaceClosed( s, true ), cv = Analyze.isRationalSurfaceClosed( s, false );
        if (cu && cv) return ls.map( l => ({ outer : false, edges : l }) );
        const areas = ls.map( loop => {
            const uv : Array<UV> = [];
            for (const [e, fwd] of loop) {
                const E = edges[e];
                const pts = fwd ? E.pts : E.pts.slice().reverse();
                const sideOfForward = cut != null ? cut.seamUse.get( e ) : undefined;
                for (let k = 0; k + 1 < pts.length; k++) {
                    const q = F.project( pts[k] ).uv.slice() as UV;
                    if (cut != null) {
                        const x = (q[cut.d] - cut.c0) / cut.per;
                        let f = x - Math.floor( x );
                        if (sideOfForward != null) f = fwd ? sideOfForward : 1 - sideOfForward;
                        else if (f < 1e-6 || f > 1 - 1e-6) {
                            // on the seam: the side of the next point
                            const y = (F.project( Vec.lerp( 0.5, pts[k], pts[k + 1] ) ).uv[cut.d] - cut.c0) / cut.per;
                            f = y - Math.floor( y ) < 0.5 ? 0 : 1;
                        }
                        q[cut.d] = cut.c0 + f * cut.per;
                    }
                    uv.push( q );
                }
            }
            if (cut == null) {
                // unwrapped along the loop where the surface closes
                for (let c = 0; c < 2; c++) if (c == 0 ? cu : cv) {
                    const dom = Seams.domain( s ), per = dom[2 * c + 1] - dom[2 * c];
                    const x = Seams.unwrap( uv.map( q => q[c] / per ) );
                    uv.forEach( (q, k) => { q[c] = x[k] * per; } );
                }
            }
            let a = 0;
            uv.forEach( (p, k) => { const q = uv[(k + 1) % uv.length]; a += p[0] * q[1] - q[0] * p[1]; } );
            return Math.abs( a );
        } );
        let best = 0;
        areas.forEach( (a, k) => { if (a > areas[best]) best = k; } );
        return ls.map( (l, k) => ({ outer : k == best, edges : l }) );
    }

    // Values of a periodic coordinate (period 1) along a closed polyline, unwrapped: each within half a period of the
    // one before; one more value at the end, the first again, unwrapped the same way.
    private static unwrap( x : Array<number> ) : Array<number> {
        const out : Array<number> = [];
        for (let i = 0; i <= x.length; i++) {
            let c = x[i % x.length];
            if (i > 0) c += Math.round( out[i - 1] - c );
            out.push( c );
        }
        return out;
    }

    private static domain( s : NurbsSurfaceData ) : Array<number> {
        return [s.knotsU[0], s.knotsU[s.knotsU.length - 1], s.knotsV[0], s.knotsV[s.knotsV.length - 1]];
    }
}
