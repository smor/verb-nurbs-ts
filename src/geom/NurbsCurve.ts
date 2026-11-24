import { ArrayExtensions } from "../core/ArrayExtensions.js";
import { Interval, KnotArray, Matrix, NurbsCurveData, Point, Vector } from "../core/Data.js";
import { SerializableBase } from "../core/Serialization.js";
import { Analyze } from "../eval/Analyze.js";
import { Check } from "../eval/Check.js";
import { CurveLengthSample, Divide } from "../eval/Divide.js";
import { Eval } from "../eval/Eval.js";
import { Make } from "../eval/Make.js";
import { Modify } from "../eval/Modify.js";
import { Tess } from "../eval/Tess.js";
import { Offset, OffsetOptions } from "../eval/Offset.js";
import { Dispatcher } from "../exe/Dispatcher.js";
import { ICurve } from "./ICurve.js";

// A NURBS curve - this class represents the base class of many of verb.geom's curve types and provides many tools for analysis and evaluation.
// This object is deliberately constrained to be immutable. The methods to inspect the properties of this class deliberately return copies. `asNurbs` can
// be used to obtain a simplified NurbsCurveData object that can be used with `verb.core` or for serialization purposes.
//
// Under the hood, this type takes advantage of verb's asynchronous runtime using the _Async methods. Calling one of these
// methods returns a `Promise` instead of the value. This allows you to run the computation in a background thread and obtain the value asynchronously.
//
// You can find further documentation for using `Promise`'s at [https://github.com/jdonaldson/promhx](https://github.com/jdonaldson/promhx).

export class NurbsCurve extends SerializableBase implements ICurve {

    //Construct a NurbsCurve by a NurbsCurveData object
    //
    //**params**
    //
    //* The data object
    //
    //**returns**
    //
    //* A new NurbsCurve

    constructor(data : NurbsCurveData) {
        super();
        this._data = Check.isValidNurbsCurveData( data );
    }

    //Construct a NurbsCurve by degree, knots, control points, weights
    //
    //**params**
    //
    //* The degree
    //* The knot array
    //* Array of control points
    //* Array of weight values
    //
    //**returns**
    //
    //* A new NurbsCurve

    public static byKnotsControlPointsWeights( degree : number,
                                                        knots : KnotArray,
                                                        controlPoints : Array<Point>,
                                                        weights : Array<number> = null ) : NurbsCurve {
        return new NurbsCurve( new NurbsCurveData( degree, knots.slice(), Eval.homogenize1d( controlPoints, weights) ) );
    }

    //Construct a NurbsCurve by interpolating a collection of points.  The resultant curve
    //will pass through all of the points.
    //
    //Note: The points are not verified, and may produce a curve with invalid control points. For example, consecutive duplicate points.
    //
    //**params**
    //
    //* An array of points
    //* Optional : The degree of resultant curve
    //
    //**returns**
    //
    //* A new NurbsCurve

    public static byPoints( points : Array<Point>, degree? : number) : NurbsCurve { if (degree == null) degree = 3;
        return new NurbsCurve( Make.rationalInterpCurve(points, degree) );
    }

    //underlying serializable, data object
    private _data : NurbsCurveData;

    //The degree of the curve
    public degree() : number { return this._data.degree; }

    //The knot array
    public knots() : KnotArray { return this._data.knots.slice(0); }

    //Array of control points
    public controlPoints() : Array<Point> { return Eval.dehomogenize1d(this._data.controlPoints); }

    //Array of weight values
    public weights() : Array<number> { return Eval.weight1d(this._data.controlPoints); }

    //Obtain a copy of the underlying data structure for the Curve. Used with verb.core.
    //
    //**returns**
    //
    //* A new NurbsCurveData object

    public asNurbs() : NurbsCurveData {
        return new NurbsCurveData( this.degree(), this.knots(), Eval.homogenize1d( this.controlPoints(), this.weights() ));
    }

    //Obtain a copy of the curve
    //
    //**returns**
    //
    //* The copied curve

    public clone(){
        return new NurbsCurve( this._data );
    }

    //Determine the valid domain of the curve
    //
    //**returns**
    //
    //* An array representing the high and end point of the domain of the curve

    public domain() : Interval<number> {
        return new Interval( ArrayExtensions.first(this._data.knots), ArrayExtensions.last(this._data.knots));
    }

    //Transform a curve with the given matrix.
    //
    //**params**
    //
    //* 4d array representing the transform
    //
    //**returns**
    //
    //* A point represented as an array

    public transform( mat : Matrix ) : NurbsCurve {
        return new NurbsCurve( Modify.rationalCurveTransform( this._data, mat ) );
    }

    //The async version of `transform`

    public transformAsync( mat : Matrix ) : Promise<NurbsCurve> {
        return Dispatcher.dispatchMethod( Modify, 'rationalCurveTransform', [ this._data,  mat ] )
            .then(function(x){ return new NurbsCurve(x); });
    }

    //Sample a point at the given parameter
    //
    //**params**
    //
    //* The parameter to sample the curve
    //
    //**returns**
    //
    //* A point represented as an array

    public point( u : number ) : Point {
        return Eval.rationalCurvePoint( this._data, u );
    }

    //The async version of `point`

    public pointAsync( u : number) : Promise<Point> {
        return Dispatcher.dispatchMethod( Eval, 'rationalCurvePoint', [ this._data,  u ] );
    }

    //Obtain the curve tangent at the given parameter.  This is the first derivative and is
    //not normalized
    //
    //**params**
    //
    //* The parameter to sample the curve
    //
    //**returns**
    //
    //* A point represented as an array

    public tangent( u : number ) : Vector {
        return Eval.rationalCurveTangent( this._data, u );
    }

    //The async version of `tangent`

    public tangentAsync( u : number ) : Promise<Vector> {
        return Dispatcher.dispatchMethod( Eval, 'rationalCurveTangent', [ this._data, u ] );
    }

    //Get derivatives at a given parameter
    //
    //**params**
    //
    //* The parameter to sample the curve
    //* The number of derivatives to obtain
    //
    //**returns**
    //
    //* A point represented as an array

    public derivatives( u : number, numDerivs? : number) : Array<Vector> { if (numDerivs == null) numDerivs = 1;
        return Eval.rationalCurveDerivatives( this._data, u, numDerivs );
    }

    //The async version of `derivatives`

    public derivativesAsync( u : number, numDerivs? : number) : Promise<Array<Vector>> { if (numDerivs == null) numDerivs = 1;
        return Dispatcher.dispatchMethod( Eval, 'rationalCurveDerivatives', [ this._data, u, numDerivs ] );
    }

    //Determine the closest point on the curve to the given point
    //
    //**params**
    //
    //* A length 3 array representing the point
    //
    //**returns**
    //
    //* The closest point

    public closestPoint( pt : Point ) : Point {
        return Analyze.rationalCurveClosestPoint( this._data, pt );
    }

    //The async version of `closestPoint`

    public closestPointAsync( pt : Point ) : Promise<Point> {
        return Dispatcher.dispatchMethod( Analyze, 'rationalCurveClosestPoint', [ this._data,  pt ] );
    }

    //Determine the closest parameter on the curve to the given point
    //
    //**params**
    //
    //* A length 3 array representing the point
    //
    //**returns**
    //
    //* The closest parameter

    public closestParam( pt : Point ) : number {
        return Analyze.rationalCurveClosestParam( this._data, pt );
    }

    //The async version of `length`

    public closestParamAsync( pt : any ) : Promise<Point> {
        return Dispatcher.dispatchMethod( Analyze, 'rationalCurveClosestParam', [ this._data,  pt ] );
    }

    //Determine the arc length of the curve
    //
    //**returns**
    //
    //* The length of the curve

    public length() : number {
        return Analyze.rationalCurveArcLength( this._data );
    }

    //The async version of `length`

    public lengthAsync() : Promise<number> {
        return Dispatcher.dispatchMethod( Analyze, 'rationalCurveArcLength', [ this._data ] );
    }

    //Determine the arc length of the curve at the given parameter
    //
    //**params**
    //
    //* The parameter at which to evaluate
    //
    //**returns**
    //
    //* The length of the curve at the given parameter

    public lengthAtParam( u : number ) : number {
        return Analyze.rationalCurveArcLength( this._data, u );
    }

    //The async version of `lengthAtParam`

    public lengthAtParamAsync() : Promise<number> {
        return Dispatcher.dispatchMethod( Analyze, 'rationalCurveArcLength', [ this._data ] );
    }

    //Determine the parameter of the curve at the given arc length
    //
    //**params**
    //
    //* The arc length at which to determine the parameter
    //
    //**returns**
    //
    //* The length of the curve at the given parameter

    public paramAtLength( len : number, tolerance : number = null ) : number {
        return Analyze.rationalCurveParamAtArcLength( this._data, len, tolerance );
    }

    //The async version of `paramAtLength`

    public paramAtLengthAsync( len : number, tolerance : number = null ) : Promise<number> {
        return Dispatcher.dispatchMethod( Analyze, 'rationalCurveParamAtArcLength', [ this._data, len, tolerance ] );
    }

    //Determine the parameters necessary to divide the curve into equal arc length segments
    //
    //**params**
    //
    //* Number of divisions of the curve
    //
    //**returns**
    //
    //* A collection of parameters

    public divideByEqualArcLength( divisions : number ) : Array<CurveLengthSample> {
        return Divide.rationalCurveByEqualArcLength( this._data, divisions );
    }

    //The async version of `divideByEqualArcLength``

    public divideByEqualArcLengthAsync( divisions : number ) : Promise<Array<CurveLengthSample>> {
        return Dispatcher.dispatchMethod( Divide, 'rationalCurveByEqualArcLength', [ this._data, divisions ] );
    }

    //Given the distance to divide the curve, determine the parameters necessary to divide the curve into equal arc length segments
    //
    //**params**
    //
    //* Arc length of each segment
    //
    //**returns**
    //
    //* A collection of parameters

    public divideByArcLength( arcLength : number ) : Array<CurveLengthSample> {
        return Divide.rationalCurveByArcLength( this._data, arcLength );
    }

    //The async version of `divideByArcLength`

    public divideByArcLengthAsync( divisions : number ) : Promise<Array<CurveLengthSample>> {
        return Dispatcher.dispatchMethod( Divide, 'rationalCurveByArcLength', [ this._data, divisions ] );
    }

    //Split the curve at the given parameter
    //
    //**params**
    //
    //* The parameter at which to split the curve
    //
    //**returns**
    //
    //* Two curves - one at the lower end of the parameter range and one at the higher end.

    public split( u : number ) : Array<NurbsCurve> {
        return Divide.curveSplit( this._data, u ).map(function(x){ return new NurbsCurve(x); });
    }

    // The async version of `split`

    public splitAsync( u : number ) : Promise<Array<NurbsCurve>> {
        return Dispatcher.dispatchMethod( Divide, 'curveSplit', [ this._data, u ])
        .then(function(cs : Array<NurbsCurveData>) : Array<NurbsCurve>{
            return cs.map(function(x){ return new NurbsCurve(x); });
        });
    }

    //Reverse the parameterization of the curve
    //
    //**returns**
    //
    //* A reversed curve

    public reverse() : NurbsCurve {
        return new NurbsCurve( Modify.curveReverse( this._data ) );
    }

    // The async version of `reverse`

    public reverseAsync() : Promise<NurbsCurve> {
        return Dispatcher.dispatchMethod( Modify, 'curveReverse', [ this._data ])
            .then(function(c){ return new NurbsCurve(c); });
    }

    //Tessellate a curve at a given tolerance
    //
    //**params**
    //
    //* The tolerance at which to sample the curve
    //
    //**returns**
    //
    //* A point represented as an array

    public tessellate(tolerance : number = null) : Array<Point> {
        return Tess.rationalCurveAdaptiveSample( this._data, tolerance, false );
    }

    // The async version of `tessellate`

    public tessellateAsync( tolerance : number = null ) : Promise<Array<Point>> {
        return Dispatcher.dispatchMethod( Tess, 'rationalCurveAdaptiveSample', [ this._data, tolerance, false ] );
    }


    // Offset a planar curve within its plane, to within `options.tolerance` of the exact offset.
    //
    //**params**
    //
    //* signed distance; positive is to the right of the direction of travel seen from the normal side (outward for
    //  a counter-clockwise curve)
    //* plane normal (default +Z)
    //* options: tolerance (default 1e-4), maxIterations
    //
    //**returns**
    //
    //* a new NurbsCurve

    public offset( distance : number, normal : Vector = null, options : OffsetOptions = null ) : NurbsCurve {
        return new NurbsCurve( Offset.curve( this._data, distance, normal, options ).result );
    }
}
