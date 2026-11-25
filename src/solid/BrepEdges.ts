import { Point, UV } from "../core/Data.js";
import { Vec } from "../core/Vec.js";
import { Eval } from "../eval/Eval.js";
import { BrepFace, BrepSolid } from "./Brep.js";
import { FilletSide } from "./Fillet.js";
import { IntersectionCurve, SurfaceIntersect } from "./SurfaceIntersect.js";

// A side of a face's domain: the parameter `axis` (0: u, 1: v) held at `value`.
export interface DomainSide { axis : number; value : number; }

// An edge of a solid: where two of its faces meet along sides of their domains.
export interface SolidEdge {
    faces : [number, number];
    sides : [DomainSide, DomainSide];
    // the edge as a curve on both faces (closed when the sides run round a periodic direction)
    curve : IntersectionCurve;
}

// The edges of a solid's own faces. A face is a NURBS surface over its whole domain, so its edges are the sides of
// the domain that are not seams and do not collapse to a point; two faces share an edge where a side of one runs along
// a side of the other, which is how the solid constructors build them.
export class BrepEdges {

    // The edge between faces a and b of a solid, or null if they do not meet along a side of each.
    public static between( solid : BrepSolid, a : number, b : number, samples? : number ) : SolidEdge | null {
        let fa = solid.faces[a], fb = solid.faces[b];
        let size = Vec.dist( solid.boundingBox().min, solid.boundingBox().max );
        let tol = size * 1e-6;
        for (let sa of BrepEdges.sides( fa )) for (let sb of BrepEdges.sides( fb )) {
            let along = 1 - sa.axis;
            let d = SurfaceIntersect.domain( fa.surface );
            let lo = d[2 * along], hi = d[2 * along + 1];
            let closed = fa.periodic[along];
            let n = samples != null ? samples : Math.max( 16, 2 * fa.divs[along] );
            let count = closed ? n : n + 1;
            let uvA : Array<UV> = [], uvB : Array<UV> = [], points : Array<Point> = [];
            let guess : number | null = null, ok = true;
            for (let k = 0; k < count; k++) {
                let uv : UV = [0, 0];
                uv[sa.axis] = sa.value; uv[along] = lo + (hi - lo) * k / n;
                let p = Eval.rationalSurfacePoint( fa.surface, uv[0], uv[1] );
                let q = BrepEdges.closestOnSide( fb, sb, p, guess );
                if (q == null || q.dist > tol) { ok = false; break; }
                guess = q.uv[1 - sb.axis];
                uvA.push( uv ); uvB.push( q.uv ); points.push( p );
            }
            if (!ok) continue;
            let seam = (f : BrepFace, uvs : Array<UV>) => uvs.map( uv => {
                let m = 0, dd = SurfaceIntersect.domain( f.surface );
                for (let x = 0; x < 2; x++) {
                    if (!f.periodic[x]) continue;
                    let span = dd[2 * x + 1] - dd[2 * x];
                    if (Math.abs( uv[x] - dd[2 * x] ) < 1e-9 * span || Math.abs( uv[x] - dd[2 * x + 1] ) < 1e-9 * span) { m |= 1 << x; uv[x] = dd[2 * x]; }
                }
                return m;
            } );
            let curve : IntersectionCurve = { points : points, uvA : uvA, uvB : uvB, seamA : seam( fa, uvA ), seamB : seam( fb, uvB ), closed : closed };
            return { faces : [a, b], sides : [sa, sb], curve : curve };
        }
        return null;
    }

    // All edges of a solid.
    public static all( solid : BrepSolid ) : Array<SolidEdge> {
        let out : Array<SolidEdge> = [];
        for (let a = 0; a < solid.faces.length; a++) for (let b = a + 1; b < solid.faces.length; b++) {
            let e = BrepEdges.between( solid, a, b );
            if (e != null) out.push( e );
        }
        return out;
    }

    // The sides of a face's domain that are edges: not across a periodic direction, and not collapsed to a point.
    public static sides( f : BrepFace ) : Array<DomainSide> {
        let d = SurfaceIntersect.domain( f.surface );
        let out : Array<DomainSide> = [];
        for (let axis = 0; axis < 2; axis++) {
            if (f.periodic[axis]) continue;
            for (let value of [d[2 * axis], d[2 * axis + 1]]) {
                let along = 1 - axis, lo = d[2 * along], hi = d[2 * along + 1];
                let at = (t : number) => { let uv : UV = [0, 0]; uv[axis] = value; uv[along] = lo + (hi - lo) * t; return Eval.rationalSurfacePoint( f.surface, uv[0], uv[1] ); };
                let len = 0.0, prev = at( 0 );
                for (let k = 1; k <= 8; k++) { let p = at( k / 8 ); len += Vec.dist( p, prev ); prev = p; }
                let box = BrepSolid.faceBox( f );
                if (len > 1e-6 * Vec.dist( box.min, box.max )) out.push( { axis : axis, value : value } );
            }
        }
        return out;
    }

    // How each face takes part in a solid's own edge: the result's outward normal is the face's own, and the kept part
    // of each face runs from the edge into its domain, inside the other face's solid where the edge is convex.
    public static filletSides( solid : BrepSolid, e : SolidEdge, k : number ) : [FilletSide, FilletSide] {
        let fa = solid.faces[e.faces[0]], fb = solid.faces[e.faces[1]];
        let c = e.curve;
        let into = (f : BrepFace, side : DomainSide, uv : UV) : Point => {
            let d = Eval.rationalSurfaceDerivatives( f.surface, uv[0], uv[1], 1 );
            let dd = SurfaceIntersect.domain( f.surface );
            let inward = side.value == dd[2 * side.axis] ? 1 : -1;
            return Vec.mul( inward, side.axis == 0 ? d[1][0] : d[0][1] );
        };
        let outward = (f : BrepFace, uv : UV) : Point => {
            let d = Eval.rationalSurfaceDerivatives( f.surface, uv[0], uv[1], 1 );
            return Vec.mul( f.reversed ? -1 : 1, Vec.cross( d[1][0], d[0][1] ) );
        };
        let A : FilletSide = { face : fa, sign : fa.reversed ? -1 : 1, keptInsideOther : Vec.dot( into( fa, e.sides[0], c.uvA[k] ), outward( fb, c.uvB[k] ) ) < 0 };
        let B : FilletSide = { face : fb, sign : fb.reversed ? -1 : 1, keptInsideOther : Vec.dot( into( fb, e.sides[1], c.uvB[k] ), outward( fa, c.uvA[k] ) ) < 0 };
        return [A, B];
    }

    // The point of a face's domain side nearest to p: its parameters and distance. Sampled, then refined by Newton's
    // method along the side; `guess` (the parameter along the side) starts it next to the last point found.
    private static closestOnSide( f : BrepFace, side : DomainSide, p : Point, guess : number | null ) : { uv : UV, dist : number } | null {
        let along = 1 - side.axis;
        let d = SurfaceIntersect.domain( f.surface );
        let lo = d[2 * along], hi = d[2 * along + 1], span = hi - lo;
        let at = (w : number) : UV => { let uv : UV = [0, 0]; uv[side.axis] = side.value; uv[along] = w; return uv; };
        let w = guess != null ? guess : lo, best = Infinity;
        if (guess == null) {
            for (let k = 0; k <= 64; k++) {
                let x = lo + span * k / 64, q = at( x );
                let dd = Vec.dist( Eval.rationalSurfacePoint( f.surface, q[0], q[1] ), p );
                if (dd < best) { best = dd; w = x; }
            }
        }
        for (let it = 0; it < 30; it++) {
            let q = at( w );
            let ds = Eval.rationalSurfaceDerivatives( f.surface, q[0], q[1], 2 );
            let t = along == 0 ? ds[1][0] : ds[0][1], tt = along == 0 ? ds[2][0] : ds[0][2];
            let r = Vec.sub( ds[0][0], p );
            let g = Vec.dot( r, t ), h = Vec.dot( t, t ) + Vec.dot( r, tt );
            if (Math.abs( h ) < 1e-300) break;
            let step = -g / (h > 0 ? h : Vec.dot( t, t ));
            w += step;
            if (f.periodic[along]) { while (w < lo) w += span; while (w > hi) w -= span; }
            else w = Math.max( lo, Math.min( hi, w ) );
            if (Math.abs( step ) < 1e-14 * span) break;
        }
        let uv = at( w );
        return { uv : uv, dist : Vec.dist( Eval.rationalSurfacePoint( f.surface, uv[0], uv[1] ), p ) };
    }
}
