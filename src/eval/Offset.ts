import { NurbsCurveData, NurbsSurfaceData, Point, Vector } from "../core/Data.js";
import { Vec } from "../core/Vec.js";
import { Eval } from "./Eval.js";
import { Fit } from "./Fit.js";

// Options shared by the offset functions.
export interface OffsetOptions {
    // maximum allowed distance between the returned NURBS and the true offset, checked at sample points (default 1e-4)
    tolerance? : number;
    // maximum number of knot refinement rounds (default 10)
    maxIterations? : number;
    // fit the surface's v direction periodically (default: when the surface closes on itself smoothly in v)
    periodicV? : boolean;
}

// The result of an offset: the approximating NURBS and the largest deviation measured from the true offset.
export interface OffsetResult<T> {
    result : T;
    maxError : number;
    iterations : number;
}

// `Offset` computes offset curves and surfaces.
//
// The exact offset of a NURBS is generally not a NURBS, so these functions return a non-rational B-spline that stays
// within a tolerance of the true offset. They work by interpolating exact offset points at the Greville abscissae of
// the input's knot vector, measuring the deviation in between, and inserting knots where it is too large.
//
// The input's degree and knots are kept as the starting point, so an offset of a closed, smooth surface stays closed.
// Self-intersections of the offset (offsetting further than the radius of curvature on the concave side) are not
// detected or trimmed here.

export class Offset {

    // Offset a planar curve within its plane.
    //
    //**params**
    //
    //* the curve; it must lie in a plane with the given normal
    //* signed distance; positive offsets to the right of the direction of travel when looking down the normal, which
    //  is outward for a counter-clockwise curve
    //* plane normal (default +Z)
    //* options
    //
    //**returns**
    //
    //* the offset curve, its measured maximum error, and the number of refinement rounds

    public static curve( curve : NurbsCurveData, distance : number, normal? : Vector, options? : OffsetOptions ) : OffsetResult<NurbsCurveData> {
        if (normal == null) normal = [0.0, 0.0, 1.0];
        const n = Vec.normalized( normal );
        const tol = options != null && options.tolerance != null ? options.tolerance : 1e-4;
        const maxIt = options != null && options.maxIterations != null ? options.maxIterations : 10;

        const offsetPoint = (u : number) : Point => {
            const ders = Eval.rationalCurveDerivatives( curve, u, 1 );
            let t = ders[1];
            if (Vec.norm( t ) < 1e-12) {
                // degenerate derivative: use a nearby tangent
                const du = 1e-6 * (curve.knots[curve.knots.length - 1] - curve.knots[0]);
                const u2 = u + du <= curve.knots[curve.knots.length - 1] ? u + du : u - du;
                t = Eval.rationalCurveDerivatives( curve, u2, 1 )[1];
            }
            const side = Vec.normalized( Vec.cross( t, n ) );
            return Vec.add( ders[0], Vec.mul( distance, side ) );
        };

        if (curve.degree == 1) {
            return { result : Offset.polylineOffset( curve, distance, n ), maxError : 0.0, iterations : 0 };
        }

        const fit = Fit.approximateCurve( offsetPoint, curve.degree, curve.knots, tol, maxIt );
        return { result : fit.curve, maxError : fit.maxError, iterations : fit.iterations };
    }

    // Offset a surface along its normal.
    //
    //**params**
    //
    //* the surface
    //* signed distance along the surface normal (the direction of dS/du x dS/dv)
    //* options
    //
    //**returns**
    //
    //* the offset surface, its measured maximum error, and the number of refinement rounds

    public static surface( surface : NurbsSurfaceData, distance : number, options? : OffsetOptions ) : OffsetResult<NurbsSurfaceData> {
        const tol = options != null && options.tolerance != null ? options.tolerance : 1e-4;
        const maxIt = options != null && options.maxIterations != null ? options.maxIterations : 10;

        const offsetPoint = (u : number, v : number) : Point => {
            return Vec.add( Eval.rationalSurfacePoint( surface, u, v ), Vec.mul( distance, Offset.surfaceUnitNormal( surface, u, v ) ) );
        };

        // a surface that closes smoothly on itself in v (a lofted wall of periodic sections) gets a periodic fit, so the
        // offset is as smooth across the seam as elsewhere and not just closed
        const periodicV = options != null && options.periodicV != null ? options.periodicV : Offset.closesSmoothlyInV( surface );
        const fit = Fit.approximateSurface( offsetPoint, surface.degreeU, surface.degreeV, surface.knotsU, surface.knotsV, tol, maxIt, periodicV );
        return { result : fit.surface, maxError : fit.maxError, iterations : fit.iterations };
    }

    // Whether a surface's v = start and v = end edges coincide with matching tangent planes (checked at a few u).
    public static closesSmoothlyInV( surface : NurbsSurfaceData ) : boolean {
        if (surface.degreeV < 2) return false;
        const ku = surface.knotsU, kv = surface.knotsV;
        const u0 = ku[0], u1 = ku[ku.length - 1], v0 = kv[0], v1 = kv[kv.length - 1];
        let size = 0.0;
        for (let i = 0; i <= 8; i++) {
            const u = u0 + (u1 - u0) * (0.05 + 0.9 * i / 8);
            const a = Eval.rationalSurfaceDerivatives( surface, u, v0, 1 ), b = Eval.rationalSurfaceDerivatives( surface, u, v1, 1 );
            size = Math.max( size, Vec.norm( a[0][1] ) );
            if (Vec.dist( a[0][0], b[0][0] ) > 1e-9 * (1 + Vec.norm( a[0][0] ))) return false;
            const na = Vec.cross( a[1][0], a[0][1] ), nb = Vec.cross( b[1][0], b[0][1] );
            if (Vec.norm( na ) < 1e-12 || Vec.norm( nb ) < 1e-12) continue;
            if (Vec.angleBetween( na, nb ) > 0.05) return false;
        }
        return size > 0;
    }

    // Unit normal of a surface, robust to degenerate points such as the poles of a sphere or a collapsed edge: when
    // dS/du x dS/dv vanishes, the normal is taken from nearby points inside the domain.

    public static surfaceUnitNormal( surface : NurbsSurfaceData, u : number, v : number ) : Vector {
        let n = Eval.rationalSurfaceNormal( surface, u, v );
        let len = Vec.norm( n );
        if (len > 1e-10) return Vec.mul( 1 / len, n );
        const u0 = surface.knotsU[0], u1 = surface.knotsU[surface.knotsU.length - 1];
        const v0 = surface.knotsV[0], v1 = surface.knotsV[surface.knotsV.length - 1];
        for (let k = 1; k <= 6; k++) {
            const e = Math.pow( 10, -7 + k );
            const uu = Math.min( Math.max( u, u0 + e * (u1 - u0) ), u1 - e * (u1 - u0) );
            const vv = Math.min( Math.max( v, v0 + e * (v1 - v0) ), v1 - e * (v1 - v0) );
            n = Eval.rationalSurfaceNormal( surface, uu, vv );
            len = Vec.norm( n );
            if (len > 1e-10) return Vec.mul( 1 / len, n );
        }
        throw "Offset: cannot determine a surface normal at (" + u + ", " + v + ")";
    }

    // Exact offset of a degree 1 curve (a polyline): each segment moves sideways, and consecutive segments are joined
    // at the intersection of their offset lines (a miter join).

    public static polylineOffset( curve : NurbsCurveData, distance : number, normal : Vector ) : NurbsCurveData {
        const pts = Eval.dehomogenize1d( curve.controlPoints );
        const closed = Vec.dist( pts[0], pts[pts.length - 1] ) < 1e-10;
        const dirs : Array<Vector> = [];
        for (let i = 0; i < pts.length - 1; i++) dirs.push( Vec.normalized( Vec.sub( pts[i+1], pts[i] ) ) );
        const sides = dirs.map( d => Vec.normalized( Vec.cross( d, normal ) ) );
        const out : Array<Point> = [];
        for (let i = 0; i < pts.length; i++) {
            const prev = i > 0 ? i - 1 : (closed ? dirs.length - 1 : -1);
            const next = i < dirs.length ? i : (closed ? 0 : -1);
            if (prev < 0) { out.push( Vec.add( pts[i], Vec.mul( distance, sides[next] ) ) ); continue; }
            if (next < 0) { out.push( Vec.add( pts[i], Vec.mul( distance, sides[prev] ) ) ); continue; }
            const bis = Vec.add( sides[prev], sides[next] );
            const c = Vec.dot( Vec.normalized( bis ), sides[next] );
            out.push( Vec.add( pts[i], Vec.mul( distance / c, Vec.normalized( bis ) ) ) );
        }
        return new NurbsCurveData( 1, curve.knots.slice(), Eval.homogenize1d( out, null ) );
    }
}
