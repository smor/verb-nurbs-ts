import { NurbsCurveData, NurbsSurfaceData, Point, Vector, KnotArray } from "../core/Data.js";
import { Vec } from "../core/Vec.js";
import { Eval } from "./Eval.js";
import { Fit } from "./Fit.js";

// Options shared by the offset functions.
export interface OffsetOptions {
    // maximum allowed distance between the returned NURBS and the true offset, checked at sample points (default 1e-4)
    tolerance? : number;
    // maximum number of knot refinement rounds (default 10)
    maxIterations? : number;
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
        let n = Vec.normalized( normal );
        let tol = options != null && options.tolerance != null ? options.tolerance : 1e-4;
        let maxIt = options != null && options.maxIterations != null ? options.maxIterations : 10;

        let offsetPoint = (u : number) : Point => {
            let ders = Eval.rationalCurveDerivatives( curve, u, 1 );
            let t = ders[1];
            if (Vec.norm( t ) < 1e-12) {
                // degenerate derivative: use a nearby tangent
                let du = 1e-6 * (curve.knots[curve.knots.length - 1] - curve.knots[0]);
                let u2 = u + du <= curve.knots[curve.knots.length - 1] ? u + du : u - du;
                t = Eval.rationalCurveDerivatives( curve, u2, 1 )[1];
            }
            let side = Vec.normalized( Vec.cross( t, n ) );
            return Vec.add( ders[0], Vec.mul( distance, side ) );
        };

        if (curve.degree == 1) {
            return { result : Offset.polylineOffset( curve, distance, n ), maxError : 0.0, iterations : 0 };
        }

        let fit = Fit.approximateCurve( offsetPoint, curve.degree, curve.knots, tol, maxIt );
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
        let tol = options != null && options.tolerance != null ? options.tolerance : 1e-4;
        let maxIt = options != null && options.maxIterations != null ? options.maxIterations : 10;

        let offsetPoint = (u : number, v : number) : Point => {
            return Vec.add( Eval.rationalSurfacePoint( surface, u, v ), Vec.mul( distance, Offset.surfaceUnitNormal( surface, u, v ) ) );
        };

        let fit = Fit.approximateSurface( offsetPoint, surface.degreeU, surface.degreeV, surface.knotsU, surface.knotsV, tol, maxIt );
        return { result : fit.surface, maxError : fit.maxError, iterations : fit.iterations };
    }

    // Unit normal of a surface, robust to degenerate points such as the poles of a sphere or a collapsed edge: when
    // dS/du x dS/dv vanishes, the normal is taken from nearby points inside the domain.

    public static surfaceUnitNormal( surface : NurbsSurfaceData, u : number, v : number ) : Vector {
        let n = Eval.rationalSurfaceNormal( surface, u, v );
        let len = Vec.norm( n );
        if (len > 1e-10) return Vec.mul( 1 / len, n );
        let u0 = surface.knotsU[0], u1 = surface.knotsU[surface.knotsU.length - 1];
        let v0 = surface.knotsV[0], v1 = surface.knotsV[surface.knotsV.length - 1];
        for (let k = 1; k <= 6; k++) {
            let e = Math.pow( 10, -7 + k );
            let uu = Math.min( Math.max( u, u0 + e * (u1 - u0) ), u1 - e * (u1 - u0) );
            let vv = Math.min( Math.max( v, v0 + e * (v1 - v0) ), v1 - e * (v1 - v0) );
            n = Eval.rationalSurfaceNormal( surface, uu, vv );
            len = Vec.norm( n );
            if (len > 1e-10) return Vec.mul( 1 / len, n );
        }
        throw "Offset: cannot determine a surface normal at (" + u + ", " + v + ")";
    }

    // Exact offset of a degree 1 curve (a polyline): each segment moves sideways, and consecutive segments are joined
    // at the intersection of their offset lines (a miter join).

    public static polylineOffset( curve : NurbsCurveData, distance : number, normal : Vector ) : NurbsCurveData {
        let pts = Eval.dehomogenize1d( curve.controlPoints );
        let closed = Vec.dist( pts[0], pts[pts.length - 1] ) < 1e-10;
        let dirs : Array<Vector> = [];
        for (let i = 0; i < pts.length - 1; i++) dirs.push( Vec.normalized( Vec.sub( pts[i+1], pts[i] ) ) );
        let sides = dirs.map( d => Vec.normalized( Vec.cross( d, normal ) ) );
        let out : Array<Point> = [];
        for (let i = 0; i < pts.length; i++) {
            let prev = i > 0 ? i - 1 : (closed ? dirs.length - 1 : -1);
            let next = i < dirs.length ? i : (closed ? 0 : -1);
            if (prev < 0) { out.push( Vec.add( pts[i], Vec.mul( distance, sides[next] ) ) ); continue; }
            if (next < 0) { out.push( Vec.add( pts[i], Vec.mul( distance, sides[prev] ) ) ); continue; }
            let bis = Vec.add( sides[prev], sides[next] );
            let c = Vec.dot( Vec.normalized( bis ), sides[next] );
            out.push( Vec.add( pts[i], Vec.mul( distance / c, Vec.normalized( bis ) ) ) );
        }
        return new NurbsCurveData( 1, curve.knots.slice(), Eval.homogenize1d( out, null ) );
    }
}
