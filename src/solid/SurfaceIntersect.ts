import { MeshData, NurbsSurfaceData, Point, UV } from "../core/Data.js";
import { Mat } from "../core/Mat.js";
import { Vec } from "../core/Vec.js";
import { Eval } from "../eval/Eval.js";
import { Intersect } from "../eval/Intersect.js";
import { SurfaceLoops, CriticalPoint } from "./SurfaceLoops.js";

// A surface with the information the intersection needs about its parameter domain: whether it closes on itself
// in u or in v (a periodic direction has a seam that intersection curves may cross).
export interface SurfaceDomain {
    surface : NurbsSurfaceData;
    periodic? : [boolean, boolean];
}

// One branch of the intersection of two surfaces, as a polyline whose every vertex lies on both surfaces (to the
// refinement tolerance) and carries its parameters on each.
export interface IntersectionCurve {
    points : Array<Point>;
    uvA : Array<UV>;
    uvB : Array<UV>;
    // per vertex, a bit mask of the seams of surface A (1: u seam, 2: v seam) that the vertex lies on; the vertex's
    // parameter in that direction is then stored as the start of the domain, and also stands for the end
    seamA : Array<number>;
    seamB : Array<number>;
    // true for a closed loop; the last vertex is then not a repeat of the first
    closed : boolean;
}

export interface SurfaceIntersectOptions {
    // grid resolution used to find the branches (default 48 x 48 per surface)
    divsA? : [number, number];
    divsB? : [number, number];
    // target distance between consecutive vertices (default: 1/100 of the smaller surface's size)
    step? : number;
    // refinement tolerance on the distance between the two surfaces (default 1e-9)
    tolerance? : number;
    // look for closed loops smaller than the grid, from the critical points of the distance between the surfaces
    // (`SurfaceLoops`); default true
    loops? : boolean;
    // cells per direction in which critical points are sought (default 8)
    loopCells? : number;
}

// The full result of an intersection: its branches, and the isolated points where the two surfaces touch without
// crossing (tangent contact), which produce no branch.
export interface SurfaceIntersection {
    curves : Array<IntersectionCurve>;
    touching : Array<CriticalPoint>;
}

// Surface-surface intersection with parameters on both surfaces.
//
// The method is the usual one for general free-form surfaces (Patrikalakis and Maekawa, "Shape Interrogation for
// Computer Aided Design and Manufacturing", 2002, ch. 5; Barnhill and Kersey, "A marching method for parametric
// surface/surface intersection", CAGD 1990):
//
// 1. find a start point on every branch from an approximation, here the intersection of two grid triangulations,
//    which finds every branch that the grids resolve (branches smaller than a grid cell can be missed)
// 2. refine each point onto both surfaces with the three-plane Newton iteration (the point where the two tangent
//    planes and the plane normal to both meet), keeping the parameters on both surfaces, which trimming needs
// 3. densify the branch until consecutive points are `step` apart, refining every inserted point
// 4. insert an exact vertex wherever the branch crosses the seam of a periodic surface (isocurve/surface Newton),
//    so the trimmed faces can be split there
// 5. find the closed loops step 1 cannot resolve from the critical points of the distance between the surfaces
//    (`SurfaceLoops`, after Sinha's theorem), and trace each with a marching method (`trace`)

export class SurfaceIntersect {

    public static surfaces( A : SurfaceDomain, B : SurfaceDomain, options? : SurfaceIntersectOptions ) : Array<IntersectionCurve> {
        return SurfaceIntersect.analyze( A, B, options ).curves;
    }

    // The branches of the intersection and the points where the surfaces touch.
    public static analyze( A : SurfaceDomain, B : SurfaceDomain, options? : SurfaceIntersectOptions ) : SurfaceIntersection {
        const o = options != null ? options : {};
        const tol = o.tolerance != null ? o.tolerance : 1e-9;
        const a = A.surface, b = B.surface;
        const ma = SurfaceIntersect.gridMesh( a, o.divsA != null ? o.divsA : [48, 48] );
        const mb = SurfaceIntersect.gridMesh( b, o.divsB != null ? o.divsB : [48, 48] );
        const step = o.step != null ? o.step : Math.min( SurfaceIntersect.size( ma ), SurfaceIntersect.size( mb ) ) / 100;

        const out : Array<IntersectionCurve> = [];
        for (const pl of Intersect.meshes( ma, mb )) {
            const pts : Array<Point> = [], ua : Array<UV> = [], ub : Array<UV> = [];
            for (const ip of pl) {
                const r = SurfaceIntersect.refine( A, B, ip.uv0, ip.uv1, tol );
                if (r == null) continue;
                if (pts.length > 0 && Vec.dist( pts[pts.length - 1], r.point ) < step * 0.2) continue;
                pts.push( r.point ); ua.push( r.uvA ); ub.push( r.uvB );
            }
            if (pts.length < 2) continue;
            const gap = Vec.dist( pts[0], pts[pts.length - 1] );
            const closed = gap < step * 2 || gap < SurfaceIntersect.meshEdge( ma, mb ) * 1.5;
            if (closed && gap < step * 0.2) { pts.pop(); ua.pop(); ub.pop(); }
            let c : IntersectionCurve = { points : pts, uvA : ua, uvB : ub, seamA : pts.map( _ => 0 ), seamB : pts.map( _ => 0 ), closed : closed };
            if (!closed) c = SurfaceIntersect.extendToEdges( A, B, c, Math.max( step, SurfaceIntersect.meshEdge( ma, mb ) ) * 4, tol );
            c = SurfaceIntersect.densify( A, B, c, step, tol );
            if (c.closed && c.points.length < SurfaceIntersect.MIN_LOOP_POINTS) {
                // a loop not much bigger than the step is too coarse to trim with: trace it again, finer
                const fine = SurfaceIntersect.retrace( A, B, c, tol );
                if (fine != null) c = fine;
            }
            c = SurfaceIntersect.insertSeams( A, B, c, tol );
            out.push( c );
        }
        const touching : Array<CriticalPoint> = [];
        if (o.loops !== false) {
            const found = SurfaceLoops.seeds( A, B, { cells : o.loopCells } );
            touching.push( ...found.touching );
            for (const s of found.starts) {
                const r = SurfaceIntersect.refine( A, B, s.uvA, s.uvB, tol );
                if (r == null) continue;
                // a start point on a branch already found adds nothing
                if (out.some( c => SurfaceIntersect.onCurve( c, r.point ) )) continue;
                let c = SurfaceIntersect.trace( A, B, r, Math.min( step, Math.max( s.size / 12, 1e-6 * step ) ), tol );
                if (c == null) continue;
                if (!c.closed) c = SurfaceIntersect.extendToEdges( A, B, c, 4 * step, tol );
                c = SurfaceIntersect.insertSeams( A, B, c, tol );
                out.push( c );
            }
        }
        return { curves : out, touching : touching };
    }

    // A marching method (Barnhill and Kersey 1990): from a point on both surfaces, step along the intersection's
    // tangent (the cross product of the two normals) and refine each step onto both surfaces, both ways, until the
    // branch closes on its start or leaves a domain. The step is halved where the refinement fails.
    public static trace( A : SurfaceDomain, B : SurfaceDomain, start : { point : Point, uvA : UV, uvB : UV }, step : number,
                         tol : number, maxPoints : number = 20000 ) : IntersectionCurve | null {
        const halves : Array<Array<{ point : Point, uvA : UV, uvB : UV }>> = [];
        let closed = false;
        for (const dir of [1, -1]) {
            const run = [start];
            let cur = start;
            while (run.length < maxPoints) {
                const pa = Eval.rationalSurfaceDerivatives( A.surface, cur.uvA[0], cur.uvA[1], 1 );
                const pb = Eval.rationalSurfaceDerivatives( B.surface, cur.uvB[0], cur.uvB[1], 1 );
                const t = Vec.cross( Vec.cross( pa[1][0], pa[0][1] ), Vec.cross( pb[1][0], pb[0][1] ) );
                if (Vec.norm( t ) < 1e-14) break; // the surfaces are tangent here: the branch cannot be followed
                const dirT = Vec.mul( dir / Vec.norm( t ), t );
                let next : { point : Point, uvA : UV, uvB : UV } | null = null;
                let h = step;
                for (let tries = 0; tries < 5 && next == null; tries++, h /= 2) {
                    const ga = Vec.add( cur.uvA, SurfaceIntersect.tangentStep( pa[1][0], pa[0][1], Vec.mul( h, dirT ) ) );
                    const gb = Vec.add( cur.uvB, SurfaceIntersect.tangentStep( pb[1][0], pb[0][1], Vec.mul( h, dirT ) ) );
                    if (!SurfaceIntersect.within( A, ga ) || !SurfaceIntersect.within( B, gb )) break;
                    const r = SurfaceIntersect.refine( A, B, ga, gb, tol );
                    if (r != null && Vec.dist( r.point, cur.point ) > 0.2 * h && Vec.dist( r.point, cur.point ) < 2 * h) next = r;
                }
                if (next == null) break;
                if (run.length > 3 && Vec.dist( next.point, start.point ) < 0.75 * step) { closed = true; break; }
                run.push( next ); cur = next;
            }
            halves.push( run );
            if (closed) break;
        }
        let pts = halves[0];
        if (!closed && halves.length > 1) pts = halves[1].slice( 1 ).reverse().concat( halves[0] );
        if (pts.length < 2) return null;
        return { points : pts.map( p => p.point ), uvA : pts.map( p => p.uvA ), uvB : pts.map( p => p.uvB ),
                 seamA : pts.map( () => 0 ), seamB : pts.map( () => 0 ), closed : closed };
    }

    // the fewest vertices a closed loop is given; smaller loops are traced again with a finer step
    public static MIN_LOOP_POINTS = 24;

    // Trace a closed loop again from its first vertex, with a step that gives it about 2 x MIN_LOOP_POINTS vertices.
    private static retrace( A : SurfaceDomain, B : SurfaceDomain, c : IntersectionCurve, tol : number ) : IntersectionCurve | null {
        let perimeter = 0.0;
        for (let i = 0; i < c.points.length; i++) perimeter += Vec.dist( c.points[i], c.points[(i + 1) % c.points.length] );
        if (perimeter <= 0) return null;
        const r = SurfaceIntersect.refine( A, B, c.uvA[0], c.uvB[0], tol );
        if (r == null) return null;
        const t = SurfaceIntersect.trace( A, B, r, perimeter / (2 * SurfaceIntersect.MIN_LOOP_POINTS), tol );
        return t != null && t.closed && t.points.length >= SurfaceIntersect.MIN_LOOP_POINTS / 2 ? t : null;
    }

    // Whether a point of the intersection lies on a branch already found: closer to one of its vertices than about
    // half the length of the branch's segments there (an exact point between two vertices is at most that far).
    private static onCurve( c : IntersectionCurve, p : Point ) : boolean {
        const n = c.points.length;
        for (let i = 0; i < n; i++) {
            const a = c.points[i];
            const prev = i > 0 ? c.points[i - 1] : (c.closed ? c.points[n - 1] : null);
            const next = i + 1 < n ? c.points[i + 1] : (c.closed ? c.points[0] : null);
            let seg = 0.0;
            if (prev != null) seg = Math.max( seg, Vec.dist( prev, a ) );
            if (next != null) seg = Math.max( seg, Vec.dist( a, next ) );
            if (Vec.dist( a, p ) <= 0.6 * seg + 1e-9) return true;
        }
        return false;
    }

    // Whether a parameter pair is inside the domain (periodic directions always are).
    private static within( S : SurfaceDomain, uv : UV ) : boolean {
        const d = SurfaceIntersect.domain( S.surface );
        const p = S.periodic != null ? S.periodic : [false, false];
        for (let k = 0; k < 2; k++) if (!p[k] && (uv[k] < d[2 * k] - 1e-12 || uv[k] > d[2 * k + 1] + 1e-12)) return false;
        return true;
    }

    // Refine an estimate onto both surfaces. Periodic parameters are wrapped into the domain, others clamped.
    // Returns null when the iteration does not converge.
    public static refine( A : SurfaceDomain, B : SurfaceDomain, uvA : UV, uvB : UV, tol : number ) : { point : Point, uvA : UV, uvB : UV } | null {
        const a = A.surface, b = B.surface;
        uvA = SurfaceIntersect.toDomain( A, uvA ); uvB = SurfaceIntersect.toDomain( B, uvB );
        for (let it = 0; it < 30; it++) {
            const pds = Eval.rationalSurfaceDerivatives( a, uvA[0], uvA[1], 1 );
            const qds = Eval.rationalSurfaceDerivatives( b, uvB[0], uvB[1], 1 );
            const p = pds[0][0], pu = pds[1][0], pv = pds[0][1];
            const q = qds[0][0], qu = qds[1][0], qv = qds[0][1];
            if (Vec.dist( p, q ) < tol) return { point : Vec.lerp( 0.5, p, q ), uvA : uvA, uvB : uvB };
            const pn = Vec.normalized( Vec.cross( pu, pv ) );
            const qn = Vec.normalized( Vec.cross( qu, qv ) );
            let fn = Vec.cross( pn, qn );
            if (Vec.norm( fn ) < 1e-12) return null; // tangent surfaces
            fn = Vec.normalized( fn );
            const x = Intersect.threePlanes( pn, Vec.dot( pn, p ), qn, Vec.dot( qn, q ), fn, Vec.dot( fn, Vec.lerp( 0.5, p, q ) ) );
            if (x == null) return null;
            uvA = SurfaceIntersect.toDomain( A, Vec.add( uvA, SurfaceIntersect.tangentStep( pu, pv, Vec.sub( x, p ) ) ) );
            uvB = SurfaceIntersect.toDomain( B, Vec.add( uvB, SurfaceIntersect.tangentStep( qu, qv, Vec.sub( x, q ) ) ) );
        }
        return null;
    }

    // Least-squares parameter step [du, dv] with du * Su + dv * Sv = d
    private static tangentStep( su : Point, sv : Point, d : Point ) : UV {
        const a = Vec.dot( su, su ), b = Vec.dot( su, sv ), c = Vec.dot( sv, sv );
        const r0 = Vec.dot( su, d ), r1 = Vec.dot( sv, d );
        const det = a * c - b * b;
        if (Math.abs( det ) < 1e-300) return [0, 0];
        return [(c * r0 - b * r1) / det, (a * r1 - b * r0) / det];
    }

    public static domain( s : NurbsSurfaceData ) : [number, number, number, number] {
        return [s.knotsU[0], s.knotsU[s.knotsU.length - 1], s.knotsV[0], s.knotsV[s.knotsV.length - 1]];
    }

    public static toDomain( S : SurfaceDomain, uv : UV ) : UV {
        const d = SurfaceIntersect.domain( S.surface );
        const p = S.periodic != null ? S.periodic : [false, false];
        const out : UV = [uv[0], uv[1]];
        for (let k = 0; k < 2; k++) {
            const lo = d[2 * k], hi = d[2 * k + 1], per = hi - lo;
            if (p[k]) { out[k] = lo + ((((out[k] - lo) % per) + per) % per); }
            else out[k] = Math.min( Math.max( out[k], lo ), hi );
        }
        return out;
    }

    // The point between two parameters, taking the short way around periodic directions.
    public static lerpUV( S : SurfaceDomain, t : number, a : UV, b : UV ) : UV {
        const d = SurfaceIntersect.domain( S.surface );
        const p = S.periodic != null ? S.periodic : [false, false];
        const bb : UV = [b[0], b[1]];
        for (let k = 0; k < 2; k++) {
            if (!p[k]) continue;
            const per = d[2 * k + 1] - d[2 * k];
            if (bb[k] - a[k] > per / 2) bb[k] -= per;
            else if (a[k] - bb[k] > per / 2) bb[k] += per;
        }
        return SurfaceIntersect.toDomain( S, [a[0] + (bb[0] - a[0]) * t, a[1] + (bb[1] - a[1]) * t] );
    }

    // An open branch leaves through an edge of one of the two faces. Put an exact vertex where it crosses that edge
    // (isocurve/surface Newton from the branch's last vertex), so the faces on both sides of the edge share it.
    // `reach` bounds how far the edge may be from the last vertex.
    public static extendToEdges( A : SurfaceDomain, B : SurfaceDomain, c : IntersectionCurve, reach : number, tol : number ) : IntersectionCurve {
        const end = (k : number) => {
            const p = c.points[k];
            let best : { point : Point, uvA : UV, uvB : UV, d : number } | null = null;
            for (let side = 0; side < 2; side++) {
                const S = side == 0 ? A : B, O = side == 0 ? B : A;
                const uvS = side == 0 ? c.uvA[k] : c.uvB[k], uvO = side == 0 ? c.uvB[k] : c.uvA[k];
                const per = S.periodic != null ? S.periodic : [false, false];
                const d = SurfaceIntersect.domain( S.surface );
                for (let a = 0; a < 2; a++) {
                    if (per[a]) continue;
                    for (let e = 0; e < 2; e++) {
                        const value = d[2 * a + e];
                        const r = SurfaceIntersect.isocurveSurface( S.surface, a == 0, value, uvS[1 - a], O.surface, uvO, tol );
                        if (r == null) continue;
                        const dist = Vec.dist( r.point, p );
                        if (dist > reach || (best != null && dist >= best.d)) continue;
                        const onS : UV = a == 0 ? [value, r.t] : [r.t, value];
                        const onO = SurfaceIntersect.toDomain( O, r.uvB );
                        const od = SurfaceIntersect.domain( O.surface );
                        const op = O.periodic != null ? O.periodic : [false, false];
                        const off = [0, 1].some( q => !op[q] && (r.uvB[q] < od[2 * q] - 1e-9 || r.uvB[q] > od[2 * q + 1] + 1e-9) );
                        if (off) continue; // the crossing is off the other face
                        best = { point : r.point, uvA : side == 0 ? onS : onO, uvB : side == 0 ? onO : onS, d : dist };
                    }
                }
            }
            return best;
        };
        const pts = c.points.slice(), ua = c.uvA.slice(), ub = c.uvB.slice();
        const first = end( 0 ), last = end( c.points.length - 1 );
        if (first != null) {
            if (first.d < reach * 0.02) { pts[0] = first.point; ua[0] = first.uvA; ub[0] = first.uvB; }
            else { pts.unshift( first.point ); ua.unshift( first.uvA ); ub.unshift( first.uvB ); }
        }
        if (last != null) {
            const n = pts.length - 1;
            if (last.d < reach * 0.02) { pts[n] = last.point; ua[n] = last.uvA; ub[n] = last.uvB; }
            else { pts.push( last.point ); ua.push( last.uvA ); ub.push( last.uvB ); }
        }
        return { points : pts, uvA : ua, uvB : ub, seamA : pts.map( _ => 0 ), seamB : pts.map( _ => 0 ), closed : false };
    }

    // Insert refined midpoints wherever two consecutive vertices are more than `step` apart.
    public static densify( A : SurfaceDomain, B : SurfaceDomain, c : IntersectionCurve, step : number, tol : number ) : IntersectionCurve {
        const pts = [c.points[0]], ua = [c.uvA[0]], ub = [c.uvB[0]];
        const n = c.points.length;
        const segs = c.closed ? n : n - 1;
        for (let i = 0; i < segs; i++) {
            const j = (i + 1) % n;
            const d = Vec.dist( c.points[i], c.points[j] );
            const k = Math.ceil( d / step );
            for (let s = 1; s < k; s++) {
                const t = s / k;
                const r = SurfaceIntersect.refine( A, B, SurfaceIntersect.lerpUV( A, t, c.uvA[i], c.uvA[j] ), SurfaceIntersect.lerpUV( B, t, c.uvB[i], c.uvB[j] ), tol );
                if (r == null) continue;
                pts.push( r.point ); ua.push( r.uvA ); ub.push( r.uvB );
            }
            if (j != 0) { pts.push( c.points[j] ); ua.push( c.uvA[j] ); ub.push( c.uvB[j] ); }
        }
        return { points : pts, uvA : ua, uvB : ub, seamA : pts.map( _ => 0 ), seamB : pts.map( _ => 0 ), closed : c.closed };
    }

    // Insert an exact vertex wherever the curve crosses a seam of either surface.
    public static insertSeams( A : SurfaceDomain, B : SurfaceDomain, c : IntersectionCurve, tol : number ) : IntersectionCurve {
        const n = c.points.length;
        const segs = c.closed ? n : n - 1;
        const pts : Array<Point> = [], ua : Array<UV> = [], ub : Array<UV> = [], sa : Array<number> = [], sb : Array<number> = [];
        const push = (p : Point, a : UV, b : UV, ma : number, mb : number) => { pts.push( p ); ua.push( a ); ub.push( b ); sa.push( ma ); sb.push( mb ); };
        for (let i = 0; i < n; i++) {
            push( c.points[i], c.uvA[i], c.uvB[i], 0, 0 );
            if (i >= segs) continue;
            const j = (i + 1) % n;
            // crossings in order along the segment: [t, onA, dir]
            const crossings : Array<[number, boolean, number]> = [];
            for (let side = 0; side < 2; side++) {
                const S = side == 0 ? A : B;
                const uvs = side == 0 ? c.uvA : c.uvB;
                const per = S.periodic != null ? S.periodic : [false, false];
                const d = SurfaceIntersect.domain( S.surface );
                for (let k = 0; k < 2; k++) {
                    if (!per[k]) continue;
                    const len = d[2 * k + 1] - d[2 * k];
                    const x0 = uvs[i][k], x1 = uvs[j][k];
                    if (Math.abs( x1 - x0 ) > len / 2) {
                        // crosses the seam: fraction of the way along the segment, going the short way
                        const a0 = x0 > x1 ? d[2 * k + 1] - x0 : x0 - d[2 * k];
                        const a1 = x0 > x1 ? x1 - d[2 * k] : d[2 * k + 1] - x1;
                        crossings.push( [a0 / (a0 + a1), side == 0, k] );
                    }
                }
            }
            crossings.sort( (p, q) => p[0] - q[0] );
            for (const cr of crossings) {
                const t = cr[0], onA = cr[1], k = cr[2];
                const S = onA ? A : B, O = onA ? B : A;
                const d = SurfaceIntersect.domain( S.surface );
                const uvS = SurfaceIntersect.lerpUV( S, t, (onA ? c.uvA : c.uvB)[i], (onA ? c.uvA : c.uvB)[j] );
                const uvO = SurfaceIntersect.lerpUV( O, t, (onA ? c.uvB : c.uvA)[i], (onA ? c.uvB : c.uvA)[j] );
                const r = SurfaceIntersect.isocurveSurface( S.surface, k == 0, d[2 * k], uvS[1 - k], O.surface, uvO, tol );
                if (r == null) throw "SurfaceIntersect: could not place the seam crossing of an intersection curve";
                const uvSeam : UV = k == 0 ? [d[0], r.t] : [r.t, d[2]];
                const uvOther = SurfaceIntersect.toDomain( O, r.uvB );
                const mask = k == 0 ? 1 : 2;
                if (onA) push( r.point, uvSeam, uvOther, mask, 0 ); else push( r.point, uvOther, uvSeam, 0, mask );
            }
        }
        return { points : pts, uvA : ua, uvB : ub, seamA : sa, seamB : sb, closed : c.closed };
    }

    // Where an isoparametric curve of `a` (u or v fixed at `value`) crosses surface `b`, by Newton's method on
    // A(t) - B(s, r) = 0, starting from the guess (t0, uvB0). Returns the parameter along the isocurve, the
    // parameters on b and the point; null if it does not converge. Parameters on b are not wrapped or clamped.
    public static isocurveSurface( a : NurbsSurfaceData, fixU : boolean, value : number, t0 : number,
                                   b : NurbsSurfaceData, uvB0 : UV, tol : number = 1e-10 ) : { t : number, uvB : UV, point : Point } | null {
        let t = t0, s = uvB0[0], r = uvB0[1];
        const d = SurfaceIntersect.domain( a );
        const lo = fixU ? d[2] : d[0], hi = fixU ? d[3] : d[1];
        for (let it = 0; it < 50; it++) {
            const da = fixU ? Eval.rationalSurfaceDerivatives( a, value, t, 1 ) : Eval.rationalSurfaceDerivatives( a, t, value, 1 );
            const db = Eval.rationalSurfaceDerivatives( b, s, r, 1 );
            const F = Vec.sub( da[0][0], db[0][0] );
            if (Vec.norm( F ) < tol) return { t : t, uvB : [s, r], point : Vec.lerp( 0.5, da[0][0], db[0][0] ) };
            const At = fixU ? da[0][1] : da[1][0];
            const J = [0, 1, 2].map( k => [At[k], -db[1][0][k], -db[0][1][k]] );
            let step : Array<number>;
            try { step = Mat.solve( J, Vec.mul( -1, F ) ); } catch (e) { return null; }
            if (step.some( x => !isFinite( x ) )) return null;
            t = Math.min( Math.max( t + step[0], lo ), hi );
            s += step[1]; r += step[2];
        }
        return null;
    }

    // A grid triangulation of a surface with its parameters, for finding intersection branches.
    public static gridMesh( s : NurbsSurfaceData, divs : [number, number] ) : MeshData {
        const d = SurfaceIntersect.domain( s );
        const pts : Array<Point> = [], uvs : Array<UV> = [], nrm : Array<Point> = [], faces : Array<Array<number>> = [];
        for (let i = 0; i <= divs[0]; i++) for (let j = 0; j <= divs[1]; j++) {
            const u = d[0] + (d[1] - d[0]) * i / divs[0], v = d[2] + (d[3] - d[2]) * j / divs[1];
            pts.push( Eval.rationalSurfacePoint( s, u, v ) ); uvs.push( [u, v] ); nrm.push( [0, 0, 0] );
        }
        const w = divs[1] + 1;
        for (let i = 0; i < divs[0]; i++) for (let j = 0; j < divs[1]; j++) {
            const a = i * w + j, b = a + 1, c = a + w + 1, e = a + w;
            faces.push( [a, b, c] ); faces.push( [a, c, e] );
        }
        return new MeshData( faces, pts, nrm, uvs );
    }

    private static size( m : MeshData ) : number {
        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for (const p of m.points) for (let k = 0; k < 3; k++) { min[k] = Math.min( min[k], p[k] ); max[k] = Math.max( max[k], p[k] ); }
        return Vec.dist( min, max );
    }

    // the longest triangle edge of either mesh, which bounds the gap the mesh intersection can leave in a loop
    private static meshEdge( ma : MeshData, mb : MeshData ) : number {
        let e = 0.0;
        for (const m of [ma, mb]) for (const f of m.faces) for (let k = 0; k < 3; k++) e = Math.max( e, Vec.dist( m.points[f[k]], m.points[f[(k + 1) % 3]] ) );
        return e;
    }
}
