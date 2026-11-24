import { ArrayExtensions } from "../core/ArrayExtensions.js";
import { Constants } from "../core/Constants.js";
import { NurbsCurveData, NurbsSurfaceData, Point, Vector } from "../core/Data.js";
import { Mat } from "../core/Mat.js";
import { Trig } from "../core/Trig.js";
import { Vec } from "../core/Vec.js";
import { Analyze } from "./Analyze.js";
import { Eval } from "./Eval.js";
import { Modify } from "./Modify.js";
import { Intersect } from "./Intersect.js";

// `Make` provides algorithms for generating NURBS representations of various special surfaces and curves. One of the very
// desirable properties of NURBS is the ability to represent common curve types like conics in NURBS. As a result, verb
// is able to represent many curve types with exceptional economy as many of the algorithms (for example, for intersection)
// can be reused.
//
// This class includes methods for building:
//
//* conics
//* polylines
//* lofts
//* swept surfaces
//
// Many of these algorithms owe their implementation to Piegl & Tiller's "The NURBS Book"

export class Make {

    //Generate a surface by translating a profile curve along a rail curve
    //
    //**params**
    //
    //* profile NurbsCurveData
    //* rail NurbsCurveData
    //
    //**returns**
    //
    //* NurbsSurfaceData object

    public static rationalTranslationalSurface( profile : NurbsCurveData, rail : NurbsCurveData ) : NurbsSurfaceData {

        let pt0 = Eval.rationalCurvePoint( rail, ArrayExtensions.first(rail.knots) )
            , startu = ArrayExtensions.first(rail.knots)
            , endu = ArrayExtensions.last(rail.knots)
            , numSamples = 2 * rail.controlPoints.length
            , span = ( endu - startu ) / (numSamples-1);

        let crvs = [];

        for (let i = 0; i < numSamples; i++) {

            let pt = Vec.sub( Eval.rationalCurvePoint( rail, startu + i * span ), pt0 );

            let crv = Modify.rationalCurveTransform(profile, [[1,0,0,pt[0]], [0,1,0,pt[1]], [0,0,1,pt[2]], [0,0,0,1]]);
            crvs.push( crv );

        }

        return Make.loftedSurface( crvs );
    }

    //Extract the boundary curves from a surface
    //
    //**returns**
    //
    //* an array containing 4 elements, first 2 curves in the V direction, then 2 curves in the U direction

    public static surfaceBoundaryCurves(surface : NurbsSurfaceData) : Array<NurbsCurveData> {
        let crvs = [];

        let c0 = Make.surfaceIsocurve( surface, ArrayExtensions.first(surface.knotsU), false );
        let c1 = Make.surfaceIsocurve( surface, ArrayExtensions.last(surface.knotsU), false );
        let c2 = Make.surfaceIsocurve( surface, ArrayExtensions.first(surface.knotsV), true );
        let c3 = Make.surfaceIsocurve( surface, ArrayExtensions.last(surface.knotsV), true );

        return [c0, c1, c2, c3];
    }


    public static surfaceIsocurve( surface : NurbsSurfaceData, u : number, useV? : boolean) : NurbsCurveData { if (useV == null) useV = false;

        let knots = useV ? surface.knotsV : surface.knotsU;
        let degree = useV ? surface.degreeV : surface.degreeU;

        let knotMults = Analyze.knotMultiplicities( knots );

        //if the knot already exists in the array, don't make duplicates
        let reqKnotIndex : number = -1;
        for (let i = 0; i < knotMults.length; i++) {
            if ( Math.abs( u - knotMults[i].knot ) < Constants.EPSILON ){
                reqKnotIndex = i;
                break;
            }
        }

        let numKnotsToInsert = degree + 1;
        if (reqKnotIndex >= 0){
            numKnotsToInsert = numKnotsToInsert - knotMults[reqKnotIndex].mult;
        }

        //insert the knots
        let newSrf = numKnotsToInsert > 0 ? Modify.surfaceKnotRefine( surface, Vec.rep(numKnotsToInsert, u), useV ) : surface;

        //obtain the correct index of control points to extract
        let span = Eval.knotSpan( degree, u, knots );

        if ( Math.abs( u - ArrayExtensions.first(knots) ) < Constants.EPSILON  ){
            span = 0;
        } else if ( Math.abs( u - ArrayExtensions.last(knots) ) < Constants.EPSILON ) {
            span = ( useV ? newSrf.controlPoints[0].length : newSrf.controlPoints.length ) - 1;
        }

        if (useV){
            return new NurbsCurveData( newSrf.degreeU, newSrf.knotsU, newSrf.controlPoints.map((row) => row[span]));
        }

        return new NurbsCurveData( newSrf.degreeV, newSrf.knotsV, newSrf.controlPoints[span] );
    }

    public static loftedSurface( curves : Array<NurbsCurveData>, degreeV : number = null ) : NurbsSurfaceData {

        curves = Modify.unifyCurveKnotVectors( curves );

        //degree
        let degreeU = curves[0].degree;
        if (degreeV == null) degreeV = 3;
        if (degreeV > curves.length - 1){
            degreeV = curves.length - 1;
        }

        //knots
        let knotsU = curves[0].knots;

        let knotsV : number[] = [];
        let controlPoints = [];
        for (let i = 0; i < curves[0].controlPoints.length; i++) {

            //extract the ith control pt of each curve
            let points = curves.map(function(x){
                return x.controlPoints[i];
            });

            //construct an interpolating curve using this list
            let c = Make.rationalInterpCurve( points, degreeV, true );
            controlPoints.push( c.controlPoints );
            knotsV = c.knots; //redundant computation
        }

        return new NurbsSurfaceData( degreeU, degreeV, knotsU, knotsV, controlPoints );
    }

    public static clonedCurve( curve : NurbsCurveData ) : NurbsCurveData {
        return new NurbsCurveData( curve.degree, curve.knots.slice(), curve.controlPoints.map(function(x){ return x.slice(); }) );
    }

    //Generate the control points, weights, and knots for a bezier curve of any degree
    //
    //**params**
    //
    //* first point in counter-clockwise form
    //* second point in counter-clockwise form
    //* third point in counter-clockwise form
    //* forth point in counter-clockwise form
    //
    //**returns**
    //
    //* NurbsSurfaceData object

    public static rationalBezierCurve( controlPoints : Array<Point>, weights : Array<number> = null ) : NurbsCurveData {

        let degree = controlPoints.length - 1;

        let knots = [];
        for (let i = 0; i < degree+1; i++) { knots.push(0.0); }
        for (let i = 0; i < degree+1; i++) { knots.push(1.0); }

        //if weights aren't provided, build uniform weights
        if (weights == null) weights = Vec.rep( controlPoints.length, 1.0 );

        return new NurbsCurveData( degree, knots, Eval.homogenize1d( controlPoints, weights ));
    }

    //Generate the control points, weights, and knots of a surface defined by 4 points
    //
    //**params**
    //
    //* first point in counter-clockwise form
    //* second point in counter-clockwise form
    //* third point in counter-clockwise form
    //* forth point in counter-clockwise form
    //
    //**returns**
    //
    //* NurbsSurfaceData object

   public static fourPointSurface( p1 : Point, p2 : Point, p3 : Point, p4 : Point, degree? : number) : NurbsSurfaceData { if (degree == null) degree = 3;

        let degreeFloat : number = degree;

        let pts = [];
        for (let i = 0; i < degree+1; i++) {

            let row = [];
            for (let j = 0; j < degree+1; j++) {

                let l = 1.0 - i / degreeFloat;
                let p1p2 = Vec.lerp( l, p1, p2 );
                let p4p3 = Vec.lerp( l, p4, p3 );

                let res = Vec.lerp( 1.0 - j / degreeFloat, p1p2, p4p3 );
                res.push(1.0); //add the weight

                row.push(res);
            }

            pts.push( row );
        }

       let zeros = Vec.rep(degree+1, 0.0);
       let ones = Vec.rep(degree+1, 1.0);

       return new NurbsSurfaceData( degree, degree, zeros.concat(ones), zeros.concat(ones), pts );

    }

    //Generate the control points, weights, and knots of an elliptical arc
    //
    //**params**
    //
    //* the center
    //* the scaled x axis
    //* the scaled y axis
    //* start angle of the ellipse arc, between 0 and 2pi, where 0 points at the xaxis
    //* end angle of the arc, between 0 and 2pi, greater than the start angle
    //
    //**returns**
    //
    //* a NurbsCurveData object representing a NURBS curve

    public static ellipseArc( center : Point, xaxis : Point, yaxis : Point, startAngle : number, endAngle : number ) : NurbsCurveData {

        let xradius = Vec.norm( xaxis );
        let yradius = Vec.norm( yaxis );

        xaxis = Vec.normalized( xaxis );
        yaxis = Vec.normalized( yaxis );

        //if the end angle is less than the start angle, do a circle
        if (endAngle < startAngle) endAngle = 2.0 * Math.PI + startAngle;

        let theta = endAngle - startAngle
        , numArcs = 0;

        //how many arcs?
        if (theta <= Math.PI / 2) {
            numArcs = 1;
        } else {
            if (theta <= Math.PI){
                numArcs = 2;
            } else if (theta <= 3 * Math.PI / 2){
                numArcs = 3;
            } else {
                numArcs = 4;
            }
        }

        let dtheta = theta / numArcs
        , n = 2 * numArcs
        , w1 = Math.cos( dtheta / 2)
        , P0 = Vec.add( center, Vec.add( Vec.mul( xradius * Math.cos(startAngle), xaxis), Vec.mul( yradius * Math.sin(startAngle), yaxis ) ) )
        , T0 = Vec.sub( Vec.mul( Math.cos(startAngle), yaxis ), Vec.mul( Math.sin(startAngle), xaxis) )
        , controlPoints = []
        , knots = Vec.zeros1d( 2 *numArcs + 3 )
        , index = 0
        , angle = startAngle
        , weights = Vec.zeros1d( numArcs * 2 );

        controlPoints[0] = P0;
        weights[0] = 1.0;

        for (let i = 1; i < numArcs+1; i++) {

            angle += dtheta;
            let P2 = Vec.add( center,
                                Vec.add( Vec.mul( xradius * Math.cos(angle), xaxis), Vec.mul( yradius * Math.sin(angle), yaxis ) ) );

            weights[index+2] = 1;
            controlPoints[index+2] = P2;

            let T2 = Vec.sub( Vec.mul( Math.cos(angle), yaxis ), Vec.mul( Math.sin(angle), xaxis) );

            let inters = Intersect.rays(P0, Vec.mul( 1 / Vec.norm(T0), T0), P2, Vec.mul( 1 / Vec.norm(T2), T2));
            let P1 = Vec.add( P0, Vec.mul(inters.u0, T0));

            weights[index+1] = w1;
            controlPoints[index+1] = P1;

            index += 2;

            if (i < numArcs){
                P0 = P2;
                T0 = T2;
            }
        }

        let j = 2 * numArcs + 1;

        for (let i = 0; i < 3; i++) {
            knots[i] = 0.0;
            knots[i+j] = 1.0;
        }

        switch (numArcs){
            case 2:
                knots[3] = knots[4] = 0.5;
                break;
            case 3:
                knots[3] = knots[4] = 1/3;
                knots[5] = knots[6] = 2/3;
                break;
            case 4:
                knots[3] = knots[4] = 0.25;
                knots[5] = knots[6] = 0.5;
                knots[7] = knots[8] = 0.75;
        }

        return new NurbsCurveData( 2, knots, Eval.homogenize1d( controlPoints, weights ));
    }


    //Generate the control points, weights, and knots of an arbitrary arc
    // (Corresponds to Algorithm A7.1 from Piegl & Tiller)
    //
    //**params**
    //
    //* the center of the arc
    //* the xaxis of the arc
    //* orthogonal yaxis of the arc
    //* radius of the arc
    //* start angle of the arc, between 0 and 2pi
    //* end angle of the arc, between 0 and 2pi, greater than the start angle
    //
    //**returns**
    //
    //* a NurbsCurveData object representing a NURBS curve

    public static arc( center : Point, xaxis : Vector, yaxis : Vector, radius : number, startAngle : number,
                                endAngle : number ) : NurbsCurveData {
        return Make.ellipseArc(  center, Vec.mul( radius, Vec.normalized( xaxis ) ), Vec.mul( radius, Vec.normalized( yaxis ) ), startAngle, endAngle );
    }

    //Generate the control points, weights, and knots of a polyline curve
    //
    //**params**
    //
    //* array of points in curve
    //
    //**returns**
    //
    //* a NurbsCurveData object representing a NURBS curve

    public static polyline( pts : Array<Point>) : NurbsCurveData {

        let knots = [0.0,0.0];
        let lsum = 0.0;

        for (let i = 0; i < pts.length-1; i++) {
            lsum += Vec.dist( pts[i], pts[i+1] );
            knots.push( lsum );
        }
        knots.push( lsum );

        //normalize the knot array
        knots = Vec.mul( 1 / lsum, knots );

        let weights = Array.from({ length: pts.length }, (_, i) => 1.0);

        return new NurbsCurveData( 1, knots, Eval.homogenize1d(pts.slice(0), weights ));

    }

    //Generate the control points, weights, and knots of an extruded surface
    //
    //**params**
    //
    //* axis of the extrusion
    //* length of the extrusion
    //* a NurbsCurveData object representing a NURBS surface
    //
    //**returns**
    //
    //* an object with the following properties: controlPoints, weights, knots, degree

    public static extrudedSurface( axis : Point, length : number, profile : NurbsCurveData ) : NurbsSurfaceData {

        let controlPoints : number[][][] = [[],[],[]]
        , weights : number[][] = [[],[],[]];

        let prof_controlPoints = Eval.dehomogenize1d( profile.controlPoints );
        let prof_weights = Eval.weight1d( profile.controlPoints );

        let translation = Vec.mul( length, axis );
        let halfTranslation = Vec.mul( 0.5 * length, axis );

        //original control points
        for (let j = 0; j < prof_controlPoints.length; j++) {

            controlPoints[2][j] = prof_controlPoints[j];
            controlPoints[1][j] = Vec.add( halfTranslation, prof_controlPoints[j] );
            controlPoints[0][j] = Vec.add( translation, prof_controlPoints[j] );

            weights[0][j] = prof_weights[j];
            weights[1][j] = prof_weights[j];
            weights[2][j] = prof_weights[j];
        }

        return new NurbsSurfaceData( 2, profile.degree, [0,0,0,1,1,1], profile.knots, Eval.homogenize2d( controlPoints, weights) );
    }

    //Generate the control points, weights, and knots of a cylinder
    //
    //**params**
    //
    //* normalized axis of cylinder
    //* xaxis in plane of cylinder
    //* position of base of cylinder
    //* height from base to top
    //* radius of the cylinder
    //
    //**returns**
    //
    //* an object with the following properties: controlPoints, weights, knotsU, knotsV, degreeU, degreeV

    public static cylindricalSurface( axis : Point, xaxis : Point, base : Point, height : number, radius : number ) : NurbsSurfaceData {

        let yaxis = Vec.cross( axis, xaxis )
        , angle = 2.0 * Math.PI
        , circ = Make.arc( base, xaxis, yaxis, radius, 0.0, 2 * Math.PI );

        return Make.extrudedSurface( axis, height, circ );

    }

    //Generate the control points, weights, and knots of a revolved surface
    // (Corresponds to Algorithm A7.1 from Piegl & Tiller)
    //
    //**params**
    //
    //* center of the rotation axis
    //* axis of the rotation axis
    //* angle to revolve around axis
    //* degree of the generatrix
    //* control points of the generatrix
    //* weights of the generatrix
    //
    //**returns**
    //
    //* an object with the following properties: controlPoints, weights, knots, degree

    public static revolvedSurface( profile : NurbsCurveData, center : Point, axis : Point, theta : number ) : NurbsSurfaceData {

        let prof_controlPoints = Eval.dehomogenize1d( profile.controlPoints )
            , prof_weights = Eval.weight1d( profile.controlPoints );

        let narcs : number, knotsU : number[];

        if (theta <= Math.PI / 2) { //less than 90
            narcs = 1;
            knotsU = Vec.zeros1d( 6 + 2  * (narcs-1) );
        } else {
            if (theta <= Math.PI){  //between 90 and 180
                narcs = 2;
                knotsU = Vec.zeros1d( 6 + 2 * (narcs-1) );
                knotsU[3]= knotsU[4] = 0.5;
            } else if (theta <= 3 * Math.PI / 2){ //between 180 and 270
                narcs = 3;
                knotsU = Vec.zeros1d( 6 + 2 * (narcs-1) );
                knotsU[3]= knotsU[4] = 1/3;
                knotsU[5]= knotsU[6] = 2/3;
            } else { //between 270 and 360
                narcs = 4;
                knotsU = Vec.zeros1d( 6 + 2 * (narcs-1) );
                knotsU[3]= knotsU[4] = 1/4;
                knotsU[5]= knotsU[6] = 1/2;
                knotsU[7]= knotsU[8] = 3/4;
            }
        }

        let dtheta = theta / narcs //divide the interval into several points
        , j = 3 + 2 * (narcs-1);

        //initialize the start and end knots
        //keep in mind that we only return the knot vector for thes
        for (let i = 0; i < 3; i++) {
            knotsU[i] = 0.0;
            knotsU[j+i] = 1.0;
        }

        //do some initialization
        let n = 2 * narcs
        , wm = Math.cos( dtheta/2.0 )
        , angle = 0.0
        , sines = Vec.zeros1d( narcs + 1)
        , cosines = Vec.zeros1d( narcs + 1);
        let controlPoints = Vec.zeros3d( 2*narcs + 1, prof_controlPoints.length, 3 )
        , weights = Vec.zeros2d( 2*narcs + 1, prof_controlPoints.length );

        //initialize the sines and cosines
        for (let i = 1; i < narcs+1; i++) {
            angle += dtheta;
            cosines[i] = Math.cos(angle);
            sines[i] = Math.sin(angle);
        }

        //for each pt in the generatrix
        //i.e. for each row of the 2d knot vectors
        for (let j = 0; j < prof_controlPoints.length; j++) {

            //get the closest point of the generatrix point on the axis
            let O = Trig.rayClosestPoint(prof_controlPoints[j], center, axis)
            //X is the vector from the axis to generatrix control pt
            , X = Vec.sub( prof_controlPoints[j], O )
            //radius at that height
            , r = Vec.norm(X)
            //Y is perpendicular to X and axis, and complete the coordinate system
            , Y = Vec.cross(axis,X);

            if ( r > Constants.EPSILON ){
                X = Vec.mul( 1 / r, X);
                Y = Vec.mul( 1 / r, Y);
            }

            //the first row of controlPoints and weights is just the generatrix
            controlPoints[0][j] = prof_controlPoints[j];
            let P0 = prof_controlPoints[j];
            weights[0][j] = prof_weights[j];

            //store T0 as the Y vector
            let T0 = Y
            , index = 0
            , angle = 0.0;

            //proceed around the circle
            for (let i = 1; i < narcs+1; i++) {

                //O + r * cos(theta) * X + r * sin(theta) * Y
                //rotated generatrix pt
                let P2 = r == 0 ? O : Vec.add( O, Vec.add( Vec.mul( r * cosines[i], X), Vec.mul( r * sines[i], Y) ) );

                controlPoints[index+2][j] = P2;
                weights[index+2][j] = prof_weights[j];

                //construct the vector tangent to the rotation
                let T2 = Vec.sub( Vec.mul( cosines[i], Y), Vec.mul(sines[i], X));

                 //construct the next control pt
                if (r == 0){
                    controlPoints[index+1][j] = O;
                } else {

                    let inters = Intersect.rays(P0, Vec.mul( 1 / Vec.norm(T0), T0), P2, Vec.mul( 1 / Vec.norm(T2), T2));
                    let P1 = Vec.add( P0, Vec.mul(inters.u0, T0));

                    controlPoints[index+1][j] = P1;
                }

                weights[index+1][j] = wm * prof_weights[j];

                index += 2;

                if (i < narcs) {
                    P0 = P2;
                    T0 = T2;
                }
            }
        }

        return new NurbsSurfaceData( 2, profile.degree, knotsU, profile.knots, Eval.homogenize2d( controlPoints, weights ) );

    }

    //Generate the control points, weights, and knots of a sphere
    //
    //**params**
    //
    //* the center of the sphere
    //* normalized axis of sphere
    //* vector perpendicular to axis of sphere, starting the rotation of the sphere
    //* radius of the sphere
    //
    //**returns**
    //
    //* an object with the following properties: controlPoints, weights, knotsU, knotsV, degreeU, degreeV
    //

    public static sphericalSurface( center : Point, axis : Point, xaxis : Point, radius : number ){

        let arc = Make.arc(center, Vec.mul( -1.0, axis ), xaxis, radius, 0.0, Math.PI );
        return Make.revolvedSurface( arc, center, axis, 2 * Math.PI );

    }

    //Generate the control points, weights, and knots of a cone
    //
    //**params**
    //
    //* normalized axis of cone
    //* position of base of cone
    //* height from base to tip
    //* radius at the base of the cone
    //
    //**returns**
    //
    //* an object with the following properties: controlPoints, weights, knots, degree
    //

    public static conicalSurface( axis : Point, xaxis : Point, base : Point, height : number, radius : number ) : NurbsSurfaceData {

        let angle = 2 * Math.PI
        , prof_degree = 1
        , prof_ctrl_pts = [ Vec.add( base, Vec.mul( height, axis ) ), Vec.add( base, Vec.mul( radius, xaxis ) )]
        , prof_knots = [0.0,0.0,1.0,1.0]
        , prof_weights = [1.0,1.0]
        , prof = new NurbsCurveData( prof_degree, prof_knots, Eval.homogenize1d( prof_ctrl_pts, prof_weights ) );

        return Make.revolvedSurface(prof, base, axis, angle );

    }

    public static rationalInterpCurve( points : Array<Array<number>>,
                                                degree? : number,
                                                homogeneousPoints? : boolean,
                                                start_tangent : Point = null,
                                                end_tangent : Point = null ) : NurbsCurveData { if (degree == null) degree = 3; if (homogeneousPoints == null) homogeneousPoints = false;

        // 0) build knot vector for curve by normalized chord length
        // 1) construct effective basis function in square matrix (W)
        // 2) construct set of coordinattes to interpolate vector (p)
        // 3) set of control points (c)

        //Wc = p

        // 4) solve for c in all 3 dimensions

        if (points.length < degree + 1){
            throw "You need to supply at least degree + 1 points! You only supplied " + points.length + " points.";
        }

        let us = [ 0.0 ];
        for (let i = 1; i < points.length; i++) {
            let chord = Vec.norm( Vec.sub( points[i], points[i-1] ) );
            let last = us[us.length - 1];
            us.push( last + chord );
        }

        //normalize
        let max = us[us.length-1];
        for (let i = 0; i < us.length; i++) {
            us[i] = us[i] / max;
        }

        let knotsStart = Vec.rep( degree + 1, 0.0 );

        //we need two more control points, two more knots

        let hasTangents = start_tangent != null && end_tangent != null;
        let start = hasTangents ? 0 : 1;
        let end = hasTangents ? us.length - degree + 1 : us.length - degree;

        for (let i = start; i < end; i++) {
            let weightSums = 0.0;
            for (let j = 0; j < degree; j++) {
                weightSums += us[i + j];
            }

            knotsStart.push( (1 / degree) * weightSums );
        }

        let knots = knotsStart.concat( Vec.rep( degree + 1, 1.0 ) );

        //build matrix of basis function coeffs (TODO: use sparse rep)
        let A = [];
        let n = hasTangents ? points.length + 1 : points.length - 1;

        let lst = hasTangents ? 1 : 0;
        let ld = hasTangents ? points.length - (degree - 1) : points.length - (degree + 1);

        for (const u of us) {
            let span = Eval.knotSpanGivenN( n, degree, u, knots );
            let basisFuncs = Eval.basisFunctionsGivenKnotSpanIndex( span, u, degree, knots );

            let ls = span - degree;

            let rowstart = Vec.zeros1d( ls );
            let rowend = Vec.zeros1d( ld - ls );

            A.push( rowstart.concat(basisFuncs).concat(rowend) );
        }

        if (hasTangents){
            let ln = A[0].length - 2;

            let tanRow0 = [-1.0,1.0].concat( Vec.zeros1d( ln ) );
            let tanRow1 = Vec.zeros1d( ln ).concat( [-1.0,1.0] );

            ArrayExtensions.spliceAndInsert(A, 1, 0, tanRow0);
            ArrayExtensions.spliceAndInsert(A, A.length-1, 0, tanRow1);
        }

        //for each dimension, solve
        let dim = points[0].length;
        let xs = [];

        let mult1 = (1 - knots[knots.length - degree - 2] ) / degree;
        let mult0 = knots[degree + 1] / degree;

        for (let i = 0; i < dim; i++) {
            let b : Array<number>;

            if (!hasTangents){
                b = points.map(function(x){ return x[i]; });
            }

            else {
                //insert the tangents at the second and second to last index
                b = [ points[0][i] ];
                b.push( mult0 * start_tangent[i]);
                for (let j = 1; j < points.length-1; j++) b.push( points[j][i] );
                b.push( mult1 * end_tangent[i] );
                b.push( ArrayExtensions.last(points)[i] );
            }

            let x = Mat.solve( A, b );
            xs.push(x);
        }

        let controlPts = Mat.transpose(xs);

        if (!homogeneousPoints){
            let weights = Vec.rep(controlPts.length, 1.0);
            controlPts = Eval.homogenize1d(controlPts, weights);
        }

        return new NurbsCurveData( degree, knots, controlPts );

    }
}
