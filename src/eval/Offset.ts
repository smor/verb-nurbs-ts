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

        let degree = curve.degree;
        let knots = curve.knots.slice();
        let result : NurbsCurveData = null;
        let err = Infinity;
        let it = 0;
        for (; it <= maxIt; it++) {
            let params = Fit.grevilleAbscissae( knots, degree );
            result = Fit.curveWithKnots( params.map( offsetPoint ), params, degree, knots );
            let bad : Array<number> = [];
            err = 0.0;
            for (let [a, b] of Offset.spans( knots )) {
                let worst = 0.0;
                for (let s of Offset.FRACTIONS) {
                    let u = a + (b - a) * s;
                    worst = Math.max( worst, Vec.dist( Eval.rationalCurvePoint( result, u ), offsetPoint( u ) ) );
                }
                err = Math.max( err, worst );
                if (worst > tol) bad.push( (a + b) / 2 );
            }
            if (bad.length == 0) break;
            if (it == maxIt) break;
            knots = Offset.insertKnots( knots, bad );
        }
        return { result : result, maxError : err, iterations : it };
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

        let knotsU = surface.knotsU.slice(), knotsV = surface.knotsV.slice();
        let degU = surface.degreeU, degV = surface.degreeV;
        let result : NurbsSurfaceData = null;
        let err = Infinity;
        let it = 0;
        for (; it <= maxIt; it++) {
            let pu = Fit.grevilleAbscissae( knotsU, degU ), pv = Fit.grevilleAbscissae( knotsV, degV );
            let grid = pu.map( u => pv.map( v => offsetPoint( u, v ) ) );
            result = Fit.surfaceWithKnots( grid, pu, pv, degU, degV, knotsU, knotsV );

            // test the fit away from the interpolation parameters: inside each knot span in one direction, against
            // the interpolation parameters and the span interiors in the other
            let spansU = Offset.spans( knotsU ), spansV = Offset.spans( knotsV );
            let inU = spansU.map( s => Offset.FRACTIONS.map( f => s[0] + (s[1] - s[0]) * f ) );
            let inV = spansV.map( s => Offset.FRACTIONS.map( f => s[0] + (s[1] - s[0]) * f ) );
            let allInV = ([] as Array<number>).concat( ...inV ), allInU = ([] as Array<number>).concat( ...inU );
            let dev = (u : number, v : number) => Vec.dist( Eval.rationalSurfacePoint( result, u, v ), offsetPoint( u, v ) );
            let badU : Array<number> = [], badV : Array<number> = [];
            err = 0.0;
            for (let i = 0; i < spansU.length; i++) {
                let worst = 0.0;
                for (let u of inU[i]) for (let v of pv.concat( allInV )) worst = Math.max( worst, dev( u, v ) );
                err = Math.max( err, worst );
                if (worst > tol) badU.push( (spansU[i][0] + spansU[i][1]) / 2 );
            }
            for (let j = 0; j < spansV.length; j++) {
                let worst = 0.0;
                for (let v of inV[j]) for (let u of pu.concat( allInU )) worst = Math.max( worst, dev( u, v ) );
                err = Math.max( err, worst );
                if (worst > tol) badV.push( (spansV[j][0] + spansV[j][1]) / 2 );
            }
            if (badU.length == 0 && badV.length == 0) break;
            if (it == maxIt) break;
            knotsU = Offset.insertKnots( knotsU, badU );
            knotsV = Offset.insertKnots( knotsV, badV );
        }
        return { result : result, maxError : err, iterations : it };
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

    // where, inside a knot span, the fit is compared with the exact offset (chosen to avoid Greville abscissae)
    private static FRACTIONS = [0.13, 0.31, 0.5, 0.69, 0.87];

    // non-empty knot spans
    private static spans( knots : KnotArray ) : Array<Array<number>> {
        let out : Array<Array<number>> = [];
        for (let i = 0; i < knots.length - 1; i++) if (knots[i+1] - knots[i] > 1e-12) out.push( [knots[i], knots[i+1]] );
        return out;
    }

    private static insertKnots( knots : KnotArray, values : Array<number> ) : KnotArray {
        return knots.concat( values ).sort( (a, b) => a - b );
    }
}
