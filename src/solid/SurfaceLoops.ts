import { NurbsSurfaceData, Point, UV } from "../core/Data.js";
import { Mat } from "../core/Mat.js";
import { Vec } from "../core/Vec.js";
import { Eval } from "../eval/Eval.js";

// A surface and whether it closes on itself in u and v. Structurally the same as `SurfaceDomain`; repeated here so
// this module depends only on the evaluation layer.
export interface LoopSurface {
    surface : NurbsSurfaceData;
    periodic? : [boolean, boolean];
}

// A pair of points, one on each surface, where the distance between the surfaces is critical: the segment between
// them is normal to both surfaces, so the two normals are parallel ("collinear normal points").
export interface CriticalPoint {
    uvA : UV;
    uvB : UV;
    pointA : Point;
    pointB : Point;
    // the distance between the two points
    distance : number;
}

// A start point on a loop, and its distance from the critical point inside the loop.
export interface LoopStart {
    uvA : UV;
    uvB : UV;
    size : number;
}

export interface LoopOptions {
    // cells per direction of each surface's domain in which critical points are sought (default 8)
    cells? : number;
    // distance below which a critical point counts as a point where the surfaces touch (default 1e-7 x model size)
    touch? : number;
}

// Loop detection for surface/surface intersection.
//
// A marching method only finds the branches it is given a start point on, and start points from sampling (grids,
// triangulations) miss every closed loop smaller than the sampling. A small loop is not rare: a sphere grazing a
// plane, a boss just touching a curved wall, a fillet nicking a face.
//
// The guarantee used here is Sinha's theorem (P. Sinha, E. Klassen, K. K. Wang, "Exploiting topological and
// geometric properties for selective subdivision", ACM Symposium on Computational Geometry, 1985): if two smooth
// surfaces meet in a closed loop, then somewhere inside the loop the normal of one surface is parallel to the
// normal of the other. The pair of points is then a critical point of the squared distance between the surfaces,
// a "collinear normal point" (Kriezis, Patrikalakis, Wolter, "Topological and differential-equation methods for
// surface intersections", CAD 24(1), 1992; Patrikalakis and Maekawa, "Shape Interrogation for Computer Aided Design
// and Manufacturing", 2002, sec. 5.8).
//
// So:
// 1. split both domains into cells and keep the pairs of cells that come close and whose normal cones admit
//    parallel normals (every other pair can hold no loop);
// 2. from each kept pair, solve for a critical point of |A(u, v) - B(s, t)|^2 with Newton's method on its gradient;
// 3. at a critical point where the surfaces are a positive distance apart, a loop around it crosses every curve
//    through it: walk A's isocurves away from it until the signed distance to B changes sign, and that crossing is
//    a start point on the loop. A critical point at zero distance is a point where the surfaces touch (tangency).
//
// Steps 1 and 2 sample the normal cones, so they are a strong heuristic, not a proof; what they find is exact.
export class SurfaceLoops {

    // Critical points of the squared distance between A and B, inside both domains.
    public static criticalPoints( A : LoopSurface, B : LoopSurface, options? : LoopOptions ) : Array<CriticalPoint> {
        const n = options != null && options.cells != null ? options.cells : 8;
        const ca = SurfaceLoops.cells( A.surface, n ), cb = SurfaceLoops.cells( B.surface, n );
        const out : Array<CriticalPoint> = [];
        const sizeA = SurfaceLoops.diagonal( ca ), sizeB = SurfaceLoops.diagonal( cb );
        const same = 1e-7 * Math.max( sizeA, sizeB );
        for (const a of ca) for (const b of cb) {
            if (!SurfaceLoops.boxesMeet( a, b )) continue;
            if (!SurfaceLoops.conesAdmitParallel( a, b )) continue;
            // a critical point already found in this pair of cells: Newton's method would most likely find it again
            if (out.some( o => SurfaceLoops.inCell( a, o.uvA ) && SurfaceLoops.inCell( b, o.uvB ) )) continue;
            // a rough foot point is enough to start from: Newton's method below refines it
            const foot = SurfaceLoops.project( A, Eval.rationalSurfacePoint( B.surface, b.centre[0], b.centre[1] ), a.centre, 6 );
            const cp = SurfaceLoops.newton( A, B, foot != null ? foot : a.centre, b.centre );
            if (cp == null) continue;
            if (out.some( o => Vec.dist( o.pointA, cp.pointA ) < same && Vec.dist( o.pointB, cp.pointB ) < same )) continue;
            out.push( cp );
        }
        return out;
    }

    // Start points on closed loops of A and B that sampling may have missed, and the points where A and B touch.
    // Start points are parameter pairs (refine them onto both surfaces); a loop may yield more than one. Each comes
    // with its distance from the critical point inside the loop, a measure of the loop's size.
    public static seeds( A : LoopSurface, B : LoopSurface, options? : LoopOptions )
        : { starts : Array<LoopStart>, touching : Array<CriticalPoint> } {
        const n = options != null && options.cells != null ? options.cells : 8;
        const cps = SurfaceLoops.criticalPoints( A, B, options );
        const dA = SurfaceLoops.domain( A.surface );
        const size = Vec.dist( Eval.rationalSurfacePoint( A.surface, dA[0], dA[2] ), Eval.rationalSurfacePoint( A.surface, dA[1], dA[3] ) );
        const touch = options != null && options.touch != null ? options.touch : 1e-7 * Math.max( size, 1 );
        const starts : Array<LoopStart> = [], touching : Array<CriticalPoint> = [];
        for (const cp of cps) {
            if (cp.distance < touch) { touching.push( cp ); continue; }
            // walk both isocurves of A through the critical point, both ways, as far as two cells
            for (const fixU of [true, false]) {
                const k = fixU ? 1 : 0;
                const reach = 2 * (dA[2 * k + 1] - dA[2 * k]) / n;
                for (const dir of [1, -1]) {
                    const s = SurfaceLoops.crossing( A, B, cp, fixU, dir, reach );
                    if (s != null) {
                        const p = Eval.rationalSurfacePoint( A.surface, s.uvA[0], s.uvA[1] );
                        starts.push( { uvA : s.uvA, uvB : s.uvB, size : Vec.dist( p, cp.pointA ) } );
                    }
                }
            }
        }
        return { starts : starts, touching : touching };
    }

    // ---------- step 3: from a critical point to a start point on the loop ----------

    // Walk A's isocurve through the critical point in one direction and return the first place where A crosses B.
    private static crossing( A : LoopSurface, B : LoopSurface, cp : CriticalPoint, fixU : boolean, dir : number, reach : number )
        : { uvA : UV, uvB : UV } | null {
        const steps = 32;
        const at = (t : number) : UV => fixU ? [cp.uvA[0], cp.uvA[1] + dir * t] : [cp.uvA[0] + dir * t, cp.uvA[1]];
        let uvB = cp.uvB;
        let prev = SurfaceLoops.signedDistance( A, B, at( 0 ), uvB );
        if (prev == null) return null;
        let prevT = 0;
        for (let i = 1; i <= steps; i++) {
            const t = reach * i / steps;
            const uvA = at( t );
            if (!SurfaceLoops.inside( A, uvA )) return null;
            const sd = SurfaceLoops.signedDistance( A, B, uvA, uvB );
            if (sd == null) return null;
            if (Math.sign( sd.value ) != Math.sign( prev.value )) {
                // bisect the sign change, keeping the projection warm
                let lo = prevT, hi = t, flo = prev.value, guess = sd.uvB;
                for (let it = 0; it < 60 && hi - lo > 1e-15 * Math.max( 1, Math.abs( hi ) ); it++) {
                    const mid = 0.5 * (lo + hi);
                    const m = SurfaceLoops.signedDistance( A, B, at( mid ), guess );
                    if (m == null) break;
                    guess = m.uvB;
                    if (Math.sign( m.value ) == Math.sign( flo )) { lo = mid; flo = m.value; } else hi = mid;
                }
                return { uvA : SurfaceLoops.wrap( A, at( 0.5 * (lo + hi) ) ), uvB : SurfaceLoops.wrap( B, guess ) };
            }
            prev = sd; prevT = t; uvB = sd.uvB;
        }
        return null;
    }

    // The distance from A(uvA) to its closest point on B (searched from uvB0), signed by B's normal.
    private static signedDistance( A : LoopSurface, B : LoopSurface, uvA : UV, uvB0 : UV ) : { value : number, uvB : UV } | null {
        const X = Eval.rationalSurfacePoint( A.surface, uvA[0], uvA[1] );
        const uvB = SurfaceLoops.project( B, X, uvB0 );
        if (uvB == null) return null;
        const d = Eval.rationalSurfaceDerivatives( B.surface, uvB[0], uvB[1], 1 );
        const nb = Vec.cross( d[1][0], d[0][1] );
        return { value : Vec.dot( Vec.sub( X, d[0][0] ), nb ), uvB : uvB };
    }

    // The parameters of the point of B closest to X, by Newton's method from uv0.
    public static project( B : LoopSurface, X : Point, uv0 : UV, iterations : number = 30 ) : UV | null {
        let uv = SurfaceLoops.wrap( B, uv0 );
        for (let it = 0; it < iterations; it++) {
            const d = Eval.rationalSurfaceDerivatives( B.surface, uv[0], uv[1], 2 );
            const r = Vec.sub( d[0][0], X );
            const g = [Vec.dot( r, d[1][0] ), Vec.dot( r, d[0][1] )];
            const H = [[Vec.dot( d[1][0], d[1][0] ) + Vec.dot( r, d[2][0] ), Vec.dot( d[1][0], d[0][1] ) + Vec.dot( r, d[1][1] )],
                       [Vec.dot( d[1][0], d[0][1] ) + Vec.dot( r, d[1][1] ), Vec.dot( d[0][1], d[0][1] ) + Vec.dot( r, d[0][2] )]];
            const step = SurfaceLoops.solve( H, g );
            if (step == null) return null;
            const next = SurfaceLoops.wrap( B, [uv[0] - step[0], uv[1] - step[1]] );
            const moved = Math.abs( next[0] - uv[0] ) + Math.abs( next[1] - uv[1] );
            uv = next;
            if (moved < 1e-14) return uv;
        }
        return uv;
    }

    // ---------- step 2: Newton's method on the gradient of the squared distance ----------

    // Newton's method on the collinear-normal conditions
    //     (P - Q) . Pu = 0,  (P - Q) . Pv = 0    (the segment PQ is normal to A)
    //     N . Qs = 0,        N . Qt = 0          (A's normal N = Pu x Pv is normal to B: the normals are parallel)
    // where P = A(u, v) and Q = B(s, t). Unlike the gradient of |P - Q|^2, these exclude the trivial solutions along a
    // transversal intersection, where P = Q but the normals differ.
    private static newton( A : LoopSurface, B : LoopSurface, uvA0 : UV, uvB0 : UV ) : CriticalPoint | null {
        let x = [uvA0[0], uvA0[1], uvB0[0], uvB0[1]];
        let first = Infinity, prevMoved = Infinity, best = Infinity, bestAt = 0;
        const dA = SurfaceLoops.domain( A.surface ), dB = SurfaceLoops.domain( B.surface );
        // limit a step to a quarter of each domain, so a far start cannot jump across the surface
        const lim = [0.25 * (dA[1] - dA[0]), 0.25 * (dA[3] - dA[2]), 0.25 * (dB[1] - dB[0]), 0.25 * (dB[3] - dB[2])];
        const scale = Math.max( 1, 4 * Math.max( ...lim ) );
        for (let it = 0; it < 30; it++) {
            const a = Eval.rationalSurfaceDerivatives( A.surface, x[0], x[1], 2 );
            const b = Eval.rationalSurfaceDerivatives( B.surface, x[2], x[3], 2 );
            const P = a[0][0], Pu = a[1][0], Pv = a[0][1], Puu = a[2][0], Puv = a[1][1], Pvv = a[0][2];
            const Q = b[0][0], Qs = b[1][0], Qt = b[0][1], Qss = b[2][0], Qst = b[1][1], Qtt = b[0][2];
            const d = Vec.sub( P, Q );
            const N = Vec.cross( Pu, Pv );
            const Nu = Vec.add( Vec.cross( Puu, Pv ), Vec.cross( Pu, Puv ) ), Nv = Vec.add( Vec.cross( Puv, Pv ), Vec.cross( Pu, Pvv ) );
            const F = [Vec.dot( d, Pu ), Vec.dot( d, Pv ), Vec.dot( N, Qs ), Vec.dot( N, Qt )];
            // Newton's method converges fast or not at all: give up on a start that has not halved its residual
            // after 8 steps, or that wanders without halving its best residual for 6 steps (a cycle far from any
            // solution, which would otherwise run to the iteration limit)
            const res = Math.hypot( F[0], F[1], F[2], F[3] );
            if (it == 0) first = res;
            else if (it >= 8 && res > 0.5 * first) return null;
            if (res < 0.5 * best) { best = res; bestAt = it; } else if (it - bestAt >= 6) return null;
            // the size of the terms in F, to judge when F is zero up to round-off
            const norm = Vec.dot( Pu, Pu ) + Vec.dot( Pv, Pv ) + Vec.norm( N ) * (Vec.norm( Qs ) + Vec.norm( Qt ));
            const J = [
                [Vec.dot( Pu, Pu ) + Vec.dot( d, Puu ), Vec.dot( Pu, Pv ) + Vec.dot( d, Puv ), -Vec.dot( Qs, Pu ), -Vec.dot( Qt, Pu )],
                [Vec.dot( Pu, Pv ) + Vec.dot( d, Puv ), Vec.dot( Pv, Pv ) + Vec.dot( d, Pvv ), -Vec.dot( Qs, Pv ), -Vec.dot( Qt, Pv )],
                [Vec.dot( Nu, Qs ), Vec.dot( Nv, Qs ), Vec.dot( N, Qss ), Vec.dot( N, Qst )],
                [Vec.dot( Nu, Qt ), Vec.dot( Nv, Qt ), Vec.dot( N, Qst ), Vec.dot( N, Qtt )]];
            const step = SurfaceLoops.solve( J, F );
            if (step == null) return null;
            const k = Math.max( 1, ...step.map( (v, i) => Math.abs( v ) / lim[i] ) );
            const uvA = SurfaceLoops.wrap( A, [x[0] - step[0] / k, x[1] - step[1] / k] );
            const uvB = SurfaceLoops.wrap( B, [x[2] - step[2] / k, x[3] - step[3] / k] );
            const moved = Math.abs( uvA[0] - x[0] ) + Math.abs( uvA[1] - x[1] ) + Math.abs( uvB[0] - x[2] ) + Math.abs( uvB[1] - x[3] );
            x = [uvA[0], uvA[1], uvB[0], uvB[1]];
            // converged: the step is at the round-off level of the parameters, or it has stopped shrinking while
            // tiny (round-off then limits it; requiring a fixed 1e-13 used to reject points found to 1e-12)
            const done = moved < 1e-13 * scale || (moved < 1e-9 * scale && moved > 0.5 * prevMoved);
            prevMoved = moved;
            // a stalled step alone is not a solution (a singular Jacobian stalls too): F must also be near zero
            const small = res <= 1e-8 * norm || res <= 1e-6 * first;
            if (done) {
                if (!small) return null;
                // a critical point on the boundary of a domain is a boundary extremum, not one inside a loop
                if (SurfaceLoops.onBoundary( A, uvA ) || SurfaceLoops.onBoundary( B, uvB )) return null;
                const pa = Eval.rationalSurfacePoint( A.surface, uvA[0], uvA[1] ), pb = Eval.rationalSurfacePoint( B.surface, uvB[0], uvB[1] );
                return { uvA : uvA, uvB : uvB, pointA : pa, pointB : pb, distance : Vec.dist( pa, pb ) };
            }
        }
        return null;
    }

    // ---------- step 1: cells, their boxes and normal cones ----------

    // Cells depend only on the surface and n, and one face meets many others in a Boolean: compute them once.
    private static cells( s : NurbsSurfaceData, n : number ) : Array<Cell> {
        let bySize = CELLS.get( s );
        if (bySize == null) { bySize = new Map(); CELLS.set( s, bySize ); }
        let out = bySize.get( n );
        if (out == null) { out = SurfaceLoops.sampleCells( s, n ); bySize.set( n, out ); }
        return out;
    }

    private static sampleCells( s : NurbsSurfaceData, n : number ) : Array<Cell> {
        const d = SurfaceLoops.domain( s );
        const m = 4; // samples per cell side
        const out : Array<Cell> = [];
        for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
            const u0 = d[0] + (d[1] - d[0]) * i / n, u1 = d[0] + (d[1] - d[0]) * (i + 1) / n;
            const v0 = d[2] + (d[3] - d[2]) * j / n, v1 = d[2] + (d[3] - d[2]) * (j + 1) / n;
            const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
            const normals : Array<Point> = [];
            let spacing = 0.0;
            let prevRow : Array<Point> = [];
            for (let a = 0; a <= m; a++) {
                const row : Array<Point> = [];
                for (let b = 0; b <= m; b++) {
                    const u = u0 + (u1 - u0) * a / m, v = v0 + (v1 - v0) * b / m;
                    const ds = Eval.rationalSurfaceDerivatives( s, u, v, 1 );
                    const p = ds[0][0];
                    for (let k = 0; k < 3; k++) { min[k] = Math.min( min[k], p[k] ); max[k] = Math.max( max[k], p[k] ); }
                    const nrm = Vec.cross( ds[1][0], ds[0][1] );
                    if (Vec.norm( nrm ) > 1e-300) normals.push( Vec.normalized( nrm ) );
                    if (b > 0) spacing = Math.max( spacing, Vec.dist( p, row[b - 1] ) );
                    if (a > 0) spacing = Math.max( spacing, Vec.dist( p, prevRow[b] ) );
                    row.push( p );
                }
                prevRow = row;
            }
            // the surface bulges past its samples by at most about a quarter of the sample spacing for gentle
            // curvature; pad the box by a full spacing to stay on the safe side
            for (let k = 0; k < 3; k++) { min[k] -= spacing; max[k] += spacing; }
            out.push( { centre : [0.5 * (u0 + u1), 0.5 * (v0 + v1)], lo : [u0, v0], hi : [u1, v1], min : min, max : max, ...SurfaceLoops.cone( normals ) } );
        }
        return out;
    }

    // The cone around the sampled normals: its axis and half-angle, widened by the largest angle between neighbours
    // so that normals between the samples are inside it too. A degenerate cell (a pole) gets the whole sphere.
    private static cone( normals : Array<Point> ) : { axis : Point, angle : number } {
        if (normals.length == 0) return { axis : [0, 0, 1], angle : Math.PI };
        let axis = normals.reduce( (acc, x) => Vec.add( acc, x ), [0, 0, 0] );
        if (Vec.norm( axis ) < 1e-9) return { axis : [0, 0, 1], angle : Math.PI };
        axis = Vec.normalized( axis );
        let angle = 0.0;
        for (const x of normals) angle = Math.max( angle, Math.acos( Math.min( 1, Math.max( -1, Vec.dot( axis, x ) ) ) ) );
        return { axis : axis, angle : Math.min( Math.PI, 2 * angle + 0.05 ) };
    }

    private static inCell( c : Cell, uv : UV ) : boolean {
        return uv[0] >= c.lo[0] && uv[0] <= c.hi[0] && uv[1] >= c.lo[1] && uv[1] <= c.hi[1];
    }

    private static boxesMeet( a : Cell, b : Cell ) : boolean {
        for (let k = 0; k < 3; k++) if (a.max[k] < b.min[k] || b.max[k] < a.min[k]) return false;
        return true;
    }

    private static conesAdmitParallel( a : Cell, b : Cell ) : boolean {
        const c = Math.acos( Math.min( 1, Math.max( -1, Vec.dot( a.axis, b.axis ) ) ) );
        const room = a.angle + b.angle;
        return c <= room || Math.PI - c <= room;
    }

    private static diagonal( cells : Array<Cell> ) : number {
        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for (const c of cells) for (let k = 0; k < 3; k++) { min[k] = Math.min( min[k], c.min[k] ); max[k] = Math.max( max[k], c.max[k] ); }
        return Vec.dist( min, max );
    }

    // ---------- domains ----------

    private static domain( s : NurbsSurfaceData ) : [number, number, number, number] {
        return [s.knotsU[0], s.knotsU[s.knotsU.length - 1], s.knotsV[0], s.knotsV[s.knotsV.length - 1]];
    }

    private static wrap( S : LoopSurface, uv : UV ) : UV {
        const d = SurfaceLoops.domain( S.surface );
        const p = S.periodic != null ? S.periodic : [false, false];
        const out : UV = [uv[0], uv[1]];
        for (let k = 0; k < 2; k++) {
            const lo = d[2 * k], hi = d[2 * k + 1], per = hi - lo;
            if (p[k]) out[k] = lo + ((((out[k] - lo) % per) + per) % per);
            else out[k] = Math.min( Math.max( out[k], lo ), hi );
        }
        return out;
    }

    private static inside( S : LoopSurface, uv : UV ) : boolean {
        const d = SurfaceLoops.domain( S.surface );
        const p = S.periodic != null ? S.periodic : [false, false];
        for (let k = 0; k < 2; k++) if (!p[k] && (uv[k] < d[2 * k] || uv[k] > d[2 * k + 1])) return false;
        return true;
    }

    private static onBoundary( S : LoopSurface, uv : UV ) : boolean {
        const d = SurfaceLoops.domain( S.surface );
        const p = S.periodic != null ? S.periodic : [false, false];
        for (let k = 0; k < 2; k++) {
            if (p[k]) continue;
            const eps = 1e-12 * Math.max( 1, d[2 * k + 1] - d[2 * k] );
            if (uv[k] <= d[2 * k] + eps || uv[k] >= d[2 * k + 1] - eps) return true;
        }
        return false;
    }

    // Solve H x = g; null when H is singular.
    private static solve( H : Array<Array<number>>, g : Array<number> ) : Array<number> | null {
        let x : Array<number>;
        try { x = Mat.solve( H, g ); } catch (e) { return null; }
        return x.every( v => isFinite( v ) ) ? x : null;
    }
}

// Cells by surface, then by cells per side. Weak keys: an entry goes when its surface does. Surface data is treated
// as immutable throughout the library, so an entry never goes stale.
const CELLS = new WeakMap<NurbsSurfaceData, Map<number, Array<Cell>>>();

interface Cell {
    centre : UV;
    lo : UV;
    hi : UV;
    min : Point;
    max : Point;
    axis : Point;
    angle : number;
}
