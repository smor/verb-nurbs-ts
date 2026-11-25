import { MeshData, NurbsSurfaceData, Point, UV } from "../core/Data.js";
import { Mat } from "../core/Mat.js";
import { Vec } from "../core/Vec.js";
import { Eval } from "../eval/Eval.js";
import { Intersect } from "../eval/Intersect.js";

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

export class SurfaceIntersect {

    public static surfaces( A : SurfaceDomain, B : SurfaceDomain, options? : SurfaceIntersectOptions ) : Array<IntersectionCurve> {
        let o = options != null ? options : {};
        let tol = o.tolerance != null ? o.tolerance : 1e-9;
        let a = A.surface, b = B.surface;
        let pa = A.periodic != null ? A.periodic : [false, false];
        let pb = B.periodic != null ? B.periodic : [false, false];
        let ma = SurfaceIntersect.gridMesh( a, o.divsA != null ? o.divsA : [48, 48] );
        let mb = SurfaceIntersect.gridMesh( b, o.divsB != null ? o.divsB : [48, 48] );
        let step = o.step != null ? o.step : Math.min( SurfaceIntersect.size( ma ), SurfaceIntersect.size( mb ) ) / 100;

        let out : Array<IntersectionCurve> = [];
        for (let pl of Intersect.meshes( ma, mb )) {
            let pts : Array<Point> = [], ua : Array<UV> = [], ub : Array<UV> = [];
            for (let ip of pl) {
                let r = SurfaceIntersect.refine( A, B, ip.uv0, ip.uv1, tol );
                if (r == null) continue;
                if (pts.length > 0 && Vec.dist( pts[pts.length - 1], r.point ) < step * 0.2) continue;
                pts.push( r.point ); ua.push( r.uvA ); ub.push( r.uvB );
            }
            if (pts.length < 2) continue;
            let gap = Vec.dist( pts[0], pts[pts.length - 1] );
            let closed = gap < step * 2 || gap < SurfaceIntersect.meshEdge( ma, mb ) * 1.5;
            if (closed && gap < step * 0.2) { pts.pop(); ua.pop(); ub.pop(); }
            let c : IntersectionCurve = { points : pts, uvA : ua, uvB : ub, seamA : pts.map( _ => 0 ), seamB : pts.map( _ => 0 ), closed : closed };
            if (!closed) c = SurfaceIntersect.extendToEdges( A, B, c, Math.max( step, SurfaceIntersect.meshEdge( ma, mb ) ) * 4, tol );
            c = SurfaceIntersect.densify( A, B, c, step, tol );
            c = SurfaceIntersect.insertSeams( A, B, c, tol );
            out.push( c );
        }
        return out;
    }

    // Refine an estimate onto both surfaces. Periodic parameters are wrapped into the domain, others clamped.
    // Returns null when the iteration does not converge.
    public static refine( A : SurfaceDomain, B : SurfaceDomain, uvA : UV, uvB : UV, tol : number ) : { point : Point, uvA : UV, uvB : UV } | null {
        let a = A.surface, b = B.surface;
        uvA = SurfaceIntersect.toDomain( A, uvA ); uvB = SurfaceIntersect.toDomain( B, uvB );
        for (let it = 0; it < 30; it++) {
            let pds = Eval.rationalSurfaceDerivatives( a, uvA[0], uvA[1], 1 );
            let qds = Eval.rationalSurfaceDerivatives( b, uvB[0], uvB[1], 1 );
            let p = pds[0][0], pu = pds[1][0], pv = pds[0][1];
            let q = qds[0][0], qu = qds[1][0], qv = qds[0][1];
            if (Vec.dist( p, q ) < tol) return { point : Vec.lerp( 0.5, p, q ), uvA : uvA, uvB : uvB };
            let pn = Vec.normalized( Vec.cross( pu, pv ) );
            let qn = Vec.normalized( Vec.cross( qu, qv ) );
            let fn = Vec.cross( pn, qn );
            if (Vec.norm( fn ) < 1e-12) return null; // tangent surfaces
            fn = Vec.normalized( fn );
            let x = Intersect.threePlanes( pn, Vec.dot( pn, p ), qn, Vec.dot( qn, q ), fn, Vec.dot( fn, Vec.lerp( 0.5, p, q ) ) );
            if (x == null) return null;
            uvA = SurfaceIntersect.toDomain( A, Vec.add( uvA, SurfaceIntersect.tangentStep( pu, pv, Vec.sub( x, p ) ) ) );
            uvB = SurfaceIntersect.toDomain( B, Vec.add( uvB, SurfaceIntersect.tangentStep( qu, qv, Vec.sub( x, q ) ) ) );
        }
        return null;
    }

    // Least-squares parameter step [du, dv] with du * Su + dv * Sv = d
    private static tangentStep( su : Point, sv : Point, d : Point ) : UV {
        let a = Vec.dot( su, su ), b = Vec.dot( su, sv ), c = Vec.dot( sv, sv );
        let r0 = Vec.dot( su, d ), r1 = Vec.dot( sv, d );
        let det = a * c - b * b;
        if (Math.abs( det ) < 1e-300) return [0, 0];
        return [(c * r0 - b * r1) / det, (a * r1 - b * r0) / det];
    }

    public static domain( s : NurbsSurfaceData ) : [number, number, number, number] {
        return [s.knotsU[0], s.knotsU[s.knotsU.length - 1], s.knotsV[0], s.knotsV[s.knotsV.length - 1]];
    }

    public static toDomain( S : SurfaceDomain, uv : UV ) : UV {
        let d = SurfaceIntersect.domain( S.surface );
        let p = S.periodic != null ? S.periodic : [false, false];
        let out : UV = [uv[0], uv[1]];
        for (let k = 0; k < 2; k++) {
            let lo = d[2 * k], hi = d[2 * k + 1], per = hi - lo;
            if (p[k]) { out[k] = lo + ((((out[k] - lo) % per) + per) % per); }
            else out[k] = Math.min( Math.max( out[k], lo ), hi );
        }
        return out;
    }

    // The point between two parameters, taking the short way around periodic directions.
    public static lerpUV( S : SurfaceDomain, t : number, a : UV, b : UV ) : UV {
        let d = SurfaceIntersect.domain( S.surface );
        let p = S.periodic != null ? S.periodic : [false, false];
        let bb : UV = [b[0], b[1]];
        for (let k = 0; k < 2; k++) {
            if (!p[k]) continue;
            let per = d[2 * k + 1] - d[2 * k];
            if (bb[k] - a[k] > per / 2) bb[k] -= per;
            else if (a[k] - bb[k] > per / 2) bb[k] += per;
        }
        return SurfaceIntersect.toDomain( S, [a[0] + (bb[0] - a[0]) * t, a[1] + (bb[1] - a[1]) * t] );
    }

    // An open branch leaves through an edge of one of the two faces. Put an exact vertex where it crosses that edge
    // (isocurve/surface Newton from the branch's last vertex), so the faces on both sides of the edge share it.
    // `reach` bounds how far the edge may be from the last vertex.
    public static extendToEdges( A : SurfaceDomain, B : SurfaceDomain, c : IntersectionCurve, reach : number, tol : number ) : IntersectionCurve {
        let end = (k : number) => {
            let p = c.points[k];
            let best : { point : Point, uvA : UV, uvB : UV, d : number } | null = null;
            for (let side = 0; side < 2; side++) {
                let S = side == 0 ? A : B, O = side == 0 ? B : A;
                let uvS = side == 0 ? c.uvA[k] : c.uvB[k], uvO = side == 0 ? c.uvB[k] : c.uvA[k];
                let per = S.periodic != null ? S.periodic : [false, false];
                let d = SurfaceIntersect.domain( S.surface );
                for (let a = 0; a < 2; a++) {
                    if (per[a]) continue;
                    for (let e = 0; e < 2; e++) {
                        let value = d[2 * a + e];
                        let r = SurfaceIntersect.isocurveSurface( S.surface, a == 0, value, uvS[1 - a], O.surface, uvO, tol );
                        if (r == null) continue;
                        let dist = Vec.dist( r.point, p );
                        if (dist > reach || (best != null && dist >= best.d)) continue;
                        let onS : UV = a == 0 ? [value, r.t] : [r.t, value];
                        let onO = SurfaceIntersect.toDomain( O, r.uvB );
                        let od = SurfaceIntersect.domain( O.surface );
                        let op = O.periodic != null ? O.periodic : [false, false];
                        let off = [0, 1].some( q => !op[q] && (r.uvB[q] < od[2 * q] - 1e-9 || r.uvB[q] > od[2 * q + 1] + 1e-9) );
                        if (off) continue; // the crossing is off the other face
                        best = { point : r.point, uvA : side == 0 ? onS : onO, uvB : side == 0 ? onO : onS, d : dist };
                    }
                }
            }
            return best;
        };
        let pts = c.points.slice(), ua = c.uvA.slice(), ub = c.uvB.slice();
        let first = end( 0 ), last = end( c.points.length - 1 );
        if (first != null) {
            if (first.d < reach * 0.02) { pts[0] = first.point; ua[0] = first.uvA; ub[0] = first.uvB; }
            else { pts.unshift( first.point ); ua.unshift( first.uvA ); ub.unshift( first.uvB ); }
        }
        if (last != null) {
            let n = pts.length - 1;
            if (last.d < reach * 0.02) { pts[n] = last.point; ua[n] = last.uvA; ub[n] = last.uvB; }
            else { pts.push( last.point ); ua.push( last.uvA ); ub.push( last.uvB ); }
        }
        return { points : pts, uvA : ua, uvB : ub, seamA : pts.map( _ => 0 ), seamB : pts.map( _ => 0 ), closed : false };
    }

    // Insert refined midpoints wherever two consecutive vertices are more than `step` apart.
    public static densify( A : SurfaceDomain, B : SurfaceDomain, c : IntersectionCurve, step : number, tol : number ) : IntersectionCurve {
        let pts = [c.points[0]], ua = [c.uvA[0]], ub = [c.uvB[0]];
        let n = c.points.length;
        let segs = c.closed ? n : n - 1;
        for (let i = 0; i < segs; i++) {
            let j = (i + 1) % n;
            let d = Vec.dist( c.points[i], c.points[j] );
            let k = Math.ceil( d / step );
            for (let s = 1; s < k; s++) {
                let t = s / k;
                let r = SurfaceIntersect.refine( A, B, SurfaceIntersect.lerpUV( A, t, c.uvA[i], c.uvA[j] ), SurfaceIntersect.lerpUV( B, t, c.uvB[i], c.uvB[j] ), tol );
                if (r == null) continue;
                pts.push( r.point ); ua.push( r.uvA ); ub.push( r.uvB );
            }
            if (j != 0) { pts.push( c.points[j] ); ua.push( c.uvA[j] ); ub.push( c.uvB[j] ); }
        }
        return { points : pts, uvA : ua, uvB : ub, seamA : pts.map( _ => 0 ), seamB : pts.map( _ => 0 ), closed : c.closed };
    }

    // Insert an exact vertex wherever the curve crosses a seam of either surface.
    public static insertSeams( A : SurfaceDomain, B : SurfaceDomain, c : IntersectionCurve, tol : number ) : IntersectionCurve {
        let n = c.points.length;
        let segs = c.closed ? n : n - 1;
        let pts : Array<Point> = [], ua : Array<UV> = [], ub : Array<UV> = [], sa : Array<number> = [], sb : Array<number> = [];
        let push = (p : Point, a : UV, b : UV, ma : number, mb : number) => { pts.push( p ); ua.push( a ); ub.push( b ); sa.push( ma ); sb.push( mb ); };
        for (let i = 0; i < n; i++) {
            push( c.points[i], c.uvA[i], c.uvB[i], 0, 0 );
            if (i >= segs) continue;
            let j = (i + 1) % n;
            // crossings in order along the segment: [t, onA, dir]
            let crossings : Array<[number, boolean, number]> = [];
            for (let side = 0; side < 2; side++) {
                let S = side == 0 ? A : B;
                let uvs = side == 0 ? c.uvA : c.uvB;
                let per = S.periodic != null ? S.periodic : [false, false];
                let d = SurfaceIntersect.domain( S.surface );
                for (let k = 0; k < 2; k++) {
                    if (!per[k]) continue;
                    let len = d[2 * k + 1] - d[2 * k];
                    let x0 = uvs[i][k], x1 = uvs[j][k];
                    if (Math.abs( x1 - x0 ) > len / 2) {
                        // crosses the seam: fraction of the way along the segment, going the short way
                        let a0 = x0 > x1 ? d[2 * k + 1] - x0 : x0 - d[2 * k];
                        let a1 = x0 > x1 ? x1 - d[2 * k] : d[2 * k + 1] - x1;
                        crossings.push( [a0 / (a0 + a1), side == 0, k] );
                    }
                }
            }
            crossings.sort( (p, q) => p[0] - q[0] );
            for (let cr of crossings) {
                let t = cr[0], onA = cr[1], k = cr[2];
                let S = onA ? A : B, O = onA ? B : A;
                let d = SurfaceIntersect.domain( S.surface );
                let uvS = SurfaceIntersect.lerpUV( S, t, (onA ? c.uvA : c.uvB)[i], (onA ? c.uvA : c.uvB)[j] );
                let uvO = SurfaceIntersect.lerpUV( O, t, (onA ? c.uvB : c.uvA)[i], (onA ? c.uvB : c.uvA)[j] );
                let r = SurfaceIntersect.isocurveSurface( S.surface, k == 0, d[2 * k], uvS[1 - k], O.surface, uvO, tol );
                if (r == null) throw "SurfaceIntersect: could not place the seam crossing of an intersection curve";
                let uvSeam : UV = k == 0 ? [d[0], r.t] : [r.t, d[2]];
                let uvOther = SurfaceIntersect.toDomain( O, r.uvB );
                let mask = k == 0 ? 1 : 2;
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
        let d = SurfaceIntersect.domain( a );
        let lo = fixU ? d[2] : d[0], hi = fixU ? d[3] : d[1];
        for (let it = 0; it < 50; it++) {
            let da = fixU ? Eval.rationalSurfaceDerivatives( a, value, t, 1 ) : Eval.rationalSurfaceDerivatives( a, t, value, 1 );
            let db = Eval.rationalSurfaceDerivatives( b, s, r, 1 );
            let F = Vec.sub( da[0][0], db[0][0] );
            if (Vec.norm( F ) < tol) return { t : t, uvB : [s, r], point : Vec.lerp( 0.5, da[0][0], db[0][0] ) };
            let At = fixU ? da[0][1] : da[1][0];
            let J = [0, 1, 2].map( k => [At[k], -db[1][0][k], -db[0][1][k]] );
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
        let d = SurfaceIntersect.domain( s );
        let pts : Array<Point> = [], uvs : Array<UV> = [], nrm : Array<Point> = [], faces : Array<Array<number>> = [];
        for (let i = 0; i <= divs[0]; i++) for (let j = 0; j <= divs[1]; j++) {
            let u = d[0] + (d[1] - d[0]) * i / divs[0], v = d[2] + (d[3] - d[2]) * j / divs[1];
            pts.push( Eval.rationalSurfacePoint( s, u, v ) ); uvs.push( [u, v] ); nrm.push( [0, 0, 0] );
        }
        let w = divs[1] + 1;
        for (let i = 0; i < divs[0]; i++) for (let j = 0; j < divs[1]; j++) {
            let a = i * w + j, b = a + 1, c = a + w + 1, e = a + w;
            faces.push( [a, b, c] ); faces.push( [a, c, e] );
        }
        return new MeshData( faces, pts, nrm, uvs );
    }

    private static size( m : MeshData ) : number {
        let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for (let p of m.points) for (let k = 0; k < 3; k++) { min[k] = Math.min( min[k], p[k] ); max[k] = Math.max( max[k], p[k] ); }
        return Vec.dist( min, max );
    }

    // the longest triangle edge of either mesh, which bounds the gap the mesh intersection can leave in a loop
    private static meshEdge( ma : MeshData, mb : MeshData ) : number {
        let e = 0.0;
        for (let m of [ma, mb]) for (let f of m.faces) for (let k = 0; k < 3; k++) e = Math.max( e, Vec.dist( m.points[f[k]], m.points[f[(k + 1) % 3]] ) );
        return e;
    }
}
