import { ArrayExtensions } from "../core/ArrayExtensions.js";
import { Interval, KnotArray, Matrix, MeshData, NurbsCurveData, NurbsSurfaceData, Point, UV, Vector } from "../core/Data.js";
import { SerializableBase } from "../core/Serialization.js";
import { Analyze } from "../eval/Analyze.js";
import { Check } from "../eval/Check.js";
import { Divide } from "../eval/Divide.js";
import { Eval } from "../eval/Eval.js";
import { Make } from "../eval/Make.js";
import { Modify } from "../eval/Modify.js";
import { AdaptiveRefinementOptions, Tess } from "../eval/Tess.js";
import { Dispatcher } from "../exe/Dispatcher.js";
import { ICurve } from "./ICurve.js";
import { ISurface } from "./ISurface.js";
import { NurbsCurve } from "./NurbsCurve.js";

// A NURBS surface - this class represents the base class of many of verb's surface types and provides many tools for analysis and evaluation.
// This object is deliberately constrained to be immutable. The methods to inspect the properties of this class deliberately return copies. `asNurbs` can
// be used to obtain a simplified NurbsCurveData object that can be used with `verb.core` or for serialization purposes.
//
// Under the hood, this type takes advantage of verb's asynchronous runtime using the _Async methods. Calling one of these
// methods returns a `Promise` that respect the  You can find further documentation for this type at
// [https://github.com/jdonaldson/promhx](https://github.com/jdonaldson/promhx).

export class NurbsSurface extends SerializableBase implements ISurface {

    //Construct a NurbsSurface by a NurbsSurfaceData object
    //
    //**params**
    //
    //* The data object
    //
    //**returns**
    //
    //* A new NurbsSurface

    constructor(data : NurbsSurfaceData) {
        super();
        this._data = Check.isValidNurbsSurfaceData(data);
    }


    //Construct a NurbsSurface by degree, knots, control points, weights
    //
    //**params**
    //
    //* The degree in the U direction
    //* The degree in the V direction
    //* The knot array in the U direction
    //* The knot array in the V direction
    //* Two dimensional array of points
    //* Two dimensional array of weight values
    //
    //**returns**
    //
    //* A new NurbsSurface

    public static byKnotsControlPointsWeights(degreeU : number,
                                                       degreeV : number,
                                                       knotsU : KnotArray,
                                                       knotsV : KnotArray,
                                                       controlPoints : Array<Array<Point>>,
                                                       weights : Array<Array<number>> = null ) : NurbsSurface {
        return new NurbsSurface( new NurbsSurfaceData( degreeU, degreeV, knotsU, knotsV, Eval.homogenize2d(controlPoints, weights) ) );
    }

    //Construct a NurbsSurface from four perimeter points in counter-clockwise order
    //
    //**params**
    //
    //* The first point
    //* The second point
    //* The third point
    //* The fourth point
    //
    //**returns**
    //
    //* A new NurbsSurface

    public static byCorners( point0 : Point, point1 : Point, point2 : Point, point3 : Point ) : NurbsSurface {
        return new NurbsSurface( Make.fourPointSurface( point0, point1, point2, point3 ) );
    }

    //Construct a NurbsSurface by lofting between a collection of curves
    //
    //**params**
    //
    //* A collection of curves
    //
    //**returns**
    //
    //* A new NurbsSurface

    public static byLoftingCurves( curves : Array<ICurve>, degreeV : number = null ) : NurbsSurface {
        return new NurbsSurface( Make.loftedSurface(curves.map((c) => c.asNurbs()), degreeV ));
    }

    //underlying serializable, data object

    private _data : NurbsSurfaceData;


    //The degree in the U direction

    public degreeU() : number { return this._data.degreeU; }

    //The degree in the V direction

    public degreeV() : number { return this._data.degreeV; }

    //The knot array in the U direction

    public knotsU() : Array<number> { return this._data.knotsU.slice(0); }

    //The knot array in the V direction

    public knotsV() : Array<number> { return this._data.knotsV.slice(0); }

    //Two dimensional array of points

    public controlPoints() : Array<Array<Point>> { return Eval.dehomogenize2d(this._data.controlPoints); }

    //Two dimensional array of weight values

    public weights() : Array<Point> { return Eval.weight2d(this._data.controlPoints); }

    //Obtain a copy of the underlying data structure for the Surface. Used with verb.core.
    //
    //**returns**
    //
    //* A new NurbsSurfaceData object

    public asNurbs() : NurbsSurfaceData {
        return new NurbsSurfaceData( this.degreeU(), this.degreeV(), this.knotsU(), this.knotsV(), Eval.homogenize2d( this.controlPoints(), this.weights() ));
    }

    //Obtain a copy of the Surface
    //
    //**returns**
    //
    //* A new NurbsSurface

    public clone() : NurbsSurface {
        return new NurbsSurface( this.asNurbs() );
    }

    //The parametric domain in the U direction
    //
    //**returns**
    //
    //* An Interval object with min and max property

    public domainU() : Interval<number> {
        return new Interval( ArrayExtensions.first(this._data.knotsU), ArrayExtensions.last(this._data.knotsU));
    }

    //The parametric domain in the V direction
    //
    //**returns**
    //
    //* An Interval object with min and max property

    public domainV() : Interval<number> {
        return new Interval( ArrayExtensions.first(this._data.knotsV), ArrayExtensions.last(this._data.knotsV));
    }

    //Obtain a point on the surface at the given parameter
    //
    //**params**
    //
    //* The u parameter
    //* The v parameter
    //
    //**returns**
    //
    //* A point on the surface

    public point( u : number, v : number ) : Point {
        return Eval.rationalSurfacePoint( this._data, u, v );
    }

    //The async version of `point`

    public pointAsync( u : number, v : number ) : Promise<Point> {
        return Dispatcher.dispatchMethod( Eval, 'rationalSurfacePoint', [ this._data, u, v ] );
    }

    //Obtain the normal to the surface at the given parameter
    //
    //**params**
    //
    //* The u parameter
    //* The v parameter
    //
    //**returns**
    //
    //* A normalized vector normal to the surface

    public normal( u : number, v : number ) : Point {
        return Eval.rationalSurfaceNormal( this._data, u, v );
    }

    //The async version of `normal`

    public normalAsync( u : number, v : number ) : Promise<Array<Array<Vector>>> {
        return Dispatcher.dispatchMethod( Eval, 'rationalSurfaceNormal', [ this._data, u, v ] );
    }

    //Obtain the derivatives of the NurbsSurface.  Returns a two dimensional array
    //containing the derivative vectors.  Increasing U partial derivatives are increasing
    //row-wise.  Increasing V partial derivatives are increasing column-wise.  Therefore,
    //the [0][0] position is a point on the surface, [n][0] is the nth V partial derivative,
    //the [1][1] position is twist vector or mixed partial derivative Puv.
    //
    //**params**
    //
    //* The u parameter
    //* The v parameter
    //* Number of derivatives to evaluate
    //
    //**returns**
    //
    //* A two dimensional array of vectors

    public derivatives( u : number, v : number, numDerivs? : number) : Array<Array<Vector>> { if (numDerivs == null) numDerivs = 1;
        return Eval.rationalSurfaceDerivatives( this._data, u, v, numDerivs );
    }

    //The async version of `derivatives`

    public derivativesAsync( u : number, v : number, numDerivs? : number) : Promise<Array<Array<Vector>>> { if (numDerivs == null) numDerivs = 1;
        return Dispatcher.dispatchMethod( Eval, 'rationalSurfaceDerivatives', [ this._data, u, v, numDerivs ] );
    }


    //Get the closest parameter on the surface to a point
    //
    //**params**
    //
    //* The point
    //
    //**returns**
    //
    //* The closest point

    public closestParam( pt : Point ) : UV {
        return Analyze.rationalSurfaceClosestParam( this._data, pt );
    }

    //The async version of `closestParam`

    public closestParamAsync( pt : Point ) : Promise<UV> {
        return Dispatcher.dispatchMethod( Analyze, 'rationalSurfaceClosestParam', [ this._data, pt ] );
    }

    //Get the closest point on the surface to a point
    //
    //**params**
    //
    //* The point
    //
    //**returns**
    //
    //* The closest point

    public closestPoint( pt : Point ) : Point {
        return Analyze.rationalSurfaceClosestPoint( this._data, pt );
    }

    //The async version of `closestParam`

    public closestPointAsync( pt : Point ) : Promise<Point> {
        return Dispatcher.dispatchMethod( Analyze, 'rationalSurfaceClosestPoint', [ this._data, pt ] );
    }

    //Split a surface
    //
    //**params**
    //
    //* The parameter to do the split
    //* Whether to divide in V or U
    //
    //**returns**
    //
    //* A length 2 array with two new NurbsSurface objects

    public split( u : number, useV? : boolean) : Array<NurbsSurface> { if (useV == null) useV = false;
        return Divide.surfaceSplit( this._data, u, useV )
            .map(function(x){ return new NurbsSurface(x); });
    }

    //The async version of `split`

    public splitAsync( u : number, useV? : boolean) : Promise<Array<NurbsSurface>> { if (useV == null) useV = false;
        return Dispatcher.dispatchMethod( Divide, 'surfaceSplit', [ this._data, u, useV ] )
            .then(function(s : Array<NurbsSurfaceData>){
                return s.map(function(x){ return new NurbsSurface(x); });
            });
    }

    //Reverse the parameterization of the curve
    //
    //**params**
    //
    //* False to reverse u, true to reverse v
    //
    //**returns**
    //
    //* The reversed surface

    public reverse( useV? : boolean) : NurbsSurface { if (useV == null) useV = false;
        return new NurbsSurface( Modify.surfaceReverse( this._data, useV ) );
    }

    //The async version of `reverse`

    public reverseAsync( useV? : boolean) : Promise<NurbsSurface> { if (useV == null) useV = false;
        return Dispatcher.dispatchMethod( Modify, 'surfaceReverse', [ this._data, useV ])
            .then(function(c){ return new NurbsSurface(c); });
    }

    //Extract an isocurve from a surface
    //
    //**params**
    //
    //* The parameter at which to obtain the isocurve
    //* False for a u-iso, true for a v-iso
    //
    //**returns**
    //
    //* A NurbsCurve in the provided direction

    public isocurve( u : number, useV? : boolean) : NurbsCurve { if (useV == null) useV = false;
        return new NurbsCurve( Make.surfaceIsocurve( this._data, u, useV ) );
    }

    //The async version of `isocurve`

    public isocurveAsync( u : number, useV? : boolean) : Promise<NurbsCurve> { if (useV == null) useV = false;
        return Dispatcher.dispatchMethod( Make, 'surfaceIsocurve', [ this._data, u, useV ] )
            .then(function(x){ return new NurbsCurve(x); });
    }

    //Extract the boundary curves from a surface
    //
    //**returns**
    //
    //* an array containing 4 elements, first 2 curves in the V direction, then 2 curves in the U direction

    public boundaries( options : AdaptiveRefinementOptions = null) : Array<NurbsCurve> {
        return Make.surfaceBoundaryCurves( this._data ).map(function(x){ return new NurbsCurve(x); });
    }

    //The async version of `boundaries`

    public boundariesAsync( options : AdaptiveRefinementOptions = null ) : Promise<Array<NurbsCurve>> {
        return Dispatcher.dispatchMethod( Make, 'surfaceBoundaryCurves', [ this._data ] )
            .then(function(cs : Array<NurbsCurveData>){
                return cs.map(function(x){ return new NurbsCurve(x); });
            });

    }

    //Tessellate the surface
    //
    //**params**
    //
    //* an AdaptiveRefinementOptions object
    //
    //**returns**
    //
    //* A MeshData object

    public tessellate( options : AdaptiveRefinementOptions = null) : MeshData {
        return Tess.rationalSurfaceAdaptive( this._data, options );
    }

    //The async version of `boundaries`

    public tessellateAsync( options : AdaptiveRefinementOptions = null ) : Promise<MeshData> {
        return Dispatcher.dispatchMethod( Tess, 'rationalSurfaceAdaptive', [ this._data,  options ] );
    }

    //Transform a Surface with the given matrix.
    //
    //**params**
    //
    //* 4x4 array representing the transform
    //
    //**returns**
    //
    //* A new Surface

    public transform( mat : Matrix ) : NurbsSurface {
        return new NurbsSurface( Modify.rationalSurfaceTransform( this._data, mat ) );
    }

    //The async version of `transform`

    public transformAsync( mat : Matrix ) : Promise<NurbsSurface> {
        return Dispatcher.dispatchMethod( Modify, 'rationalSurfaceTransform', [ this._data,  mat ] )
            .then(function(x){ return new NurbsSurface(x); });
    }
}
