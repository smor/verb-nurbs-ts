import { Constants } from "../core/Constants.js";
import { NurbsCurveData, NurbsSurfaceData, Point } from "../core/Data.js";
import { Mat } from "../core/Mat.js";
import { Vec } from "../core/Vec.js";
import { Analyze } from "./Analyze.js";
import { Eval } from "./Eval.js";
import { Modify } from "./Modify.js";

// Divide provides various tools for dividing and splitting NURBS geometry.

export class Divide {

    //Split a NURBS surface in two at a given parameter
    //
    //**params**
    //
    //* The surface to split
    //* The parameter at which to split the surface
    //* Whether to split in the U direction or V direction of the surface
    //
    //**returns**
    //
    //* A length two array of new surfaces

    public static surfaceSplit( surface : NurbsSurfaceData, u : number, useV? : boolean) : Array<NurbsSurfaceData> { if (useV == null) useV = false;

        let knots
        , degree
        , controlPoints;

        if (!useV) {
            controlPoints = Mat.transpose( surface.controlPoints );
            knots = surface.knotsU;
            degree = surface.degreeU;
        } else {
            controlPoints = surface.controlPoints;
            knots = surface.knotsV;
            degree = surface.degreeV;
        }

        let knots_to_insert = Array.from({ length: degree+1 }, (_, i) => u);

        let newpts0 = new Array<Array<Point>>()
        , newpts1 = new Array<Array<Point>>();

        let s = Eval.knotSpan( degree, u, knots );
        let res : NurbsCurveData = null;

        for (const cps of controlPoints) {
            res = Modify.curveKnotRefine( new NurbsCurveData(degree, knots, cps), knots_to_insert );

            newpts0.push( res.controlPoints.slice( 0, s + 1 ) );
            newpts1.push( res.controlPoints.slice( s + 1 ) );
        }

        let knots0 = res.knots.slice(0, s + degree + 2);
        let knots1 = res.knots.slice( s + 1 );

        if (!useV){
            newpts0 = Mat.transpose( newpts0 );
            newpts1 = Mat.transpose( newpts1 );

            return [ new NurbsSurfaceData(degree, surface.degreeV, knots0, surface.knotsV.slice(), newpts0 ),
            new NurbsSurfaceData(degree, surface.degreeV, knots1, surface.knotsV.slice(), newpts1 ) ];
        }

        //v dir
        return [ new NurbsSurfaceData(surface.degreeU, degree, surface.knotsU.slice(), knots0, newpts0 ),
        new NurbsSurfaceData(surface.degreeU, degree, surface.knotsU.slice(), knots1, newpts1 ) ];
    }

    //Split a NURBS curve into two parts at a given parameter
    //
    //**params**
    //
    //* NurbsCurveData object representing the curve
    //* location to split the curve
    //
    //**returns**
    //
    //* *Array* two new curves, defined by degree, knots, and control points

    public static curveSplit( curve : NurbsCurveData, u : number ) : Array<NurbsCurveData> {

        let degree = curve.degree
        , controlPoints = curve.controlPoints
        , knots = curve.knots;

        let knots_to_insert = Array.from({ length: degree+1 }, (_, i) => u);
        let res = Modify.curveKnotRefine( curve, knots_to_insert );

        let s = Eval.knotSpan( degree, u, knots );

        let knots0 = res.knots.slice(0, s + degree + 2);
        let knots1 = res.knots.slice( s + 1 );

        let cpts0 = res.controlPoints.slice( 0, s + 1 );
        let cpts1 = res.controlPoints.slice( s + 1 );

        return [
            new NurbsCurveData( degree, knots0, cpts0 ),
            new NurbsCurveData( degree, knots1, cpts1 )
        ];

    }

    //Divide a NURBS curve given a given number of times, including the end points. The result is not split curves
    //but a collection of `CurveLengthSample` objects that can be used for splitting. As with all arc length methods,
    //the result is an approximation.
    //
    //**params**
    //
    //* NurbsCurveData object representing the curve
    //* The number of parts to split the curve into
    //
    //**returns**
    //
    //* An array of `CurveLengthSample` objects

    public static rationalCurveByEqualArcLength(curve : NurbsCurveData, num : number) : Array<CurveLengthSample> {

        let tlen = Analyze.rationalCurveArcLength( curve );
        let inc = tlen / num;

        return Divide.rationalCurveByArcLength(curve, inc);

    }

    //Divide a NURBS curve given a given number of times, including the end points.
    //
    //**params**
    //
    //* NurbsCurveData object representing the curve
    //* The arc length separating the resultant samples
    //
    //**returns**
    //
    //* A sequence of `CurveLengthSample` objects

    public static rationalCurveByArcLength(curve : NurbsCurveData, l : number) : Array<CurveLengthSample> {

        let crvs = Modify.decomposeCurveIntoBeziers( curve )
        , crvlens = crvs.map(function(x){ return Analyze.rationalBezierCurveArcLength(x); })
        , totlen = Vec.sum(crvlens)
        , pts = [ new CurveLengthSample( curve.knots[0], 0.0 ) ];

        if (l > totlen) return pts;

        let inc = l
        , i = 0
        , lc = inc
        , runsum = 0.0
        , runsum1 = 0.0
        , u;

        while ( i < crvs.length ){

            runsum += crvlens[i];

            while ( lc < runsum + Constants.EPSILON ){

                u = Analyze.rationalBezierCurveParamAtArcLength( crvs[i], lc - runsum1, Constants.TOLERANCE, crvlens[i] );

                pts.push( new CurveLengthSample( u, lc ) );
                lc += inc;

            }

            runsum1 += crvlens[i];

            i++;

        }

        return pts;

    }

}


export class CurveLengthSample {
    public u : number;
    public len : number;

    constructor(u : number, len : number) {
        this.u = u;
        this.len = len;
    }
}

