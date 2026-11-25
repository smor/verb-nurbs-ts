import { Interval, NurbsSurfaceData, Point, Vector } from "../core/Data.js";
import { ISerializable } from "../core/Serialization.js";

// An interface representing a Surface

export interface ISurface extends ISerializable {

    //Provide the NURBS representation of the curve
    //
    //**returns**
    //
    //* A NurbsCurveData object representing the curve

    asNurbs() : NurbsSurfaceData;

    //Provide the domain of the surface in the U direction
    //
    //**returns**
    //
    //* An interval object with min and max properties

    domainU() : Interval<number>;

    //Provide the domain of the surface in the V direction
    //
    //**returns**
    //
    //* An interval object with min and max properties

    domainV() : Interval<number>;

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

    point(u : number, v : number) : Point;

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

    derivatives(u : number, v : number, numDerivs? : number) : Array<Array<Vector>>;

}
