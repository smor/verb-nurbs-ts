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
        const fa = solid.faces[a], fb = solid.faces[b];
        const size = Vec.dist( solid.boundingBox().min, solid.boundingBox().max );
        const tol = size * 1e-6;
        for (const sa of BrepEdges.sides( fa )) for (const sb of BrepEdges.sides( fb )) {
            const along = 1 - sa.axis;
            const d = SurfaceIntersect.domain( fa.surface );
            const lo = d[2 * along], hi = d[2 * along + 1];
            const closed = fa.periodic[along];
            const n = samples != null ? samples : Math.max( 16, 2 * fa.divs[along] );
            const count = closed ? n : n + 1;
            const uvA : Array<UV> = [], uvB : Array<UV> = [], points : Array<Point> = [];
            let guess : number | null = null, ok = true;
            for (let k = 0; k < count; k++) {
                const uv : UV = [0, 0];
                uv[sa.axis] = sa.value; uv[along] = lo + (hi - lo) * k / n;
                const p = Eval.rationalSurfacePoint( fa.surface, uv[0], uv[1] );
                const q = BrepEdges.closestOnSide( fb, sb, p, guess );
                if (q == null || q.dist > tol) { ok = false; break; }
                guess = q.uv[1 - sb.axis];
                uvA.push( uv ); uvB.push( q.uv ); points.push( p );
            }
            if (!ok) continue;
            const seam = (f : BrepFace, uvs : Array<UV>) => uvs.map( uv => {
                let m = 0;
                const dd = SurfaceIntersect.domain( f.surface );
                for (let x = 0; x < 2; x++) {
                    if (!f.periodic[x]) continue;
                    const span = dd[2 * x + 1] - dd[2 * x];
                    if (Math.abs( uv[x] - dd[2 * x] ) < 1e-9 * span || Math.abs( uv[x] - dd[2 * x + 1] ) < 1e-9 * span) { m |= 1 << x; uv[x] = dd[2 * x]; }
                }
                return m;
            } );
            const curve : IntersectionCurve = { points : points, uvA : uvA, uvB : uvB, seamA : seam( fa, uvA ), seamB : seam( fb, uvB ), closed : closed };
            return { faces : [a, b], sides : [sa, sb], curve : curve };
        }
        return null;
    }

    // All edges of a solid.
    public static all( solid : BrepSolid ) : Array<SolidEdge> {
        const out : Array<SolidEdge> = [];
        for (let a = 0; a < solid.faces.length; a++) for (let b = a + 1; b < solid.faces.length; b++) {
            const e = BrepEdges.between( solid, a, b );
            if (e != null) out.push( e );
        }
        return out;
    }

    // The sides of a face's domain that are edges: not across a periodic direction, and not collapsed to a point.
    public static sides( f : BrepFace ) : Array<DomainSide> {
        const d = SurfaceIntersect.domain( f.surface );
        const out : Array<DomainSide> = [];
        for (let axis = 0; axis < 2; axis++) {
            if (f.periodic[axis]) continue;
            for (const value of [d[2 * axis], d[2 * axis + 1]]) {
                const along = 1 - axis, lo = d[2 * along], hi = d[2 * along + 1];
                const at = (t : number) => { const uv : UV = [0, 0]; uv[axis] = value; uv[along] = lo + (hi - lo) * t; return Eval.rationalSurfacePoint( f.surface, uv[0], uv[1] ); };
                let len = 0.0, prev = at( 0 );
                for (let k = 1; k <= 8; k++) { const p = at( k / 8 ); len += Vec.dist( p, prev ); prev = p; }
                const box = BrepSolid.faceBox( f );
                if (len > 1e-6 * Vec.dist( box.min, box.max )) out.push( { axis : axis, value : value } );
            }
        }
        return out;
    }

    // How each face takes part in a solid's own edge: the result's outward normal is the face's own, and the kept part
    // of each face runs from the edge into its domain, inside the other face's solid where the edge is convex.
    public static filletSides( solid : BrepSolid, e : SolidEdge, k : number ) : [FilletSide, FilletSide] {
        const fa = solid.faces[e.faces[0]], fb = solid.faces[e.faces[1]];
        const c = e.curve;
        const into = (f : BrepFace, side : DomainSide, uv : UV) : Point => {
            const d = Eval.rationalSurfaceDerivatives( f.surface, uv[0], uv[1], 1 );
            const dd = SurfaceIntersect.domain( f.surface );
            const inward = side.value == dd[2 * side.axis] ? 1 : -1;
            return Vec.mul( inward, side.axis == 0 ? d[1][0] : d[0][1] );
        };
        const outward = (f : BrepFace, uv : UV) : Point => {
            const d = Eval.rationalSurfaceDerivatives( f.surface, uv[0], uv[1], 1 );
            return Vec.mul( f.reversed ? -1 : 1, Vec.cross( d[1][0], d[0][1] ) );
        };
        const A : FilletSide = { face : fa, sign : fa.reversed ? -1 : 1, keptInsideOther : Vec.dot( into( fa, e.sides[0], c.uvA[k] ), outward( fb, c.uvB[k] ) ) < 0 };
        const B : FilletSide = { face : fb, sign : fb.reversed ? -1 : 1, keptInsideOther : Vec.dot( into( fb, e.sides[1], c.uvB[k] ), outward( fa, c.uvA[k] ) ) < 0 };
        return [A, B];
    }

    // The point of a face's domain side nearest to p: its parameters and distance. Sampled, then refined by Newton's
    // method along the side; `guess` (the parameter along the side) starts it next to the last point found.
    private static closestOnSide( f : BrepFace, side : DomainSide, p : Point, guess : number | null ) : { uv : UV, dist : number } | null {
        const along = 1 - side.axis;
        const d = SurfaceIntersect.domain( f.surface );
        const lo = d[2 * along], hi = d[2 * along + 1], span = hi - lo;
        const at = (w : number) : UV => { const uv : UV = [0, 0]; uv[side.axis] = side.value; uv[along] = w; return uv; };
        let w = guess != null ? guess : lo, best = Infinity;
        if (guess == null) {
            for (let k = 0; k <= 64; k++) {
                const x = lo + span * k / 64, q = at( x );
                const dd = Vec.dist( Eval.rationalSurfacePoint( f.surface, q[0], q[1] ), p );
                if (dd < best) { best = dd; w = x; }
            }
        }
        for (let it = 0; it < 30; it++) {
            const q = at( w );
            const ds = Eval.rationalSurfaceDerivatives( f.surface, q[0], q[1], 2 );
            const t = along == 0 ? ds[1][0] : ds[0][1], tt = along == 0 ? ds[2][0] : ds[0][2];
            const r = Vec.sub( ds[0][0], p );
            const g = Vec.dot( r, t ), h = Vec.dot( t, t ) + Vec.dot( r, tt );
            if (Math.abs( h ) < 1e-300) break;
            const step = -g / (h > 0 ? h : Vec.dot( t, t ));
            w += step;
            if (f.periodic[along]) { while (w < lo) w += span; while (w > hi) w -= span; }
            else w = Math.max( lo, Math.min( hi, w ) );
            if (Math.abs( step ) < 1e-14 * span) break;
        }
        const uv = at( w );
        return { uv : uv, dist : Vec.dist( Eval.rationalSurfacePoint( f.surface, uv[0], uv[1] ), p ) };
    }
}
