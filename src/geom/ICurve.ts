import { Interval, NurbsCurveData, Point, Vector } from "../core/Data.js";
import { ISerializable } from "../core/Serialization.js";

//An interface representing a Curve

export interface ICurve extends ISerializable {

    //Provide the NURBS representation of the curve
    //
    //**returns**
    //
    //* A NurbsCurveData object representing the curve

    asNurbs() : NurbsCurveData;

    //Obtain the parametric domain of the curve
    //
    //**returns**
    //
    //* An Interval object containing the min and max of the domain

    domain() : Interval<number>;

    //Evaluate a point on the curve
    //
    //**params**
    //
    //* The parameter on the curve
    //
    //**returns**
    //
    //* The evaluated point

    point(u : number) : Point;

    //Evaluate the derivatives at a point on a curve
    //
    //**params**
    //
    //* The parameter on the curve
    //* The number of derivatives to evaluate on the curve
    //
    //**returns**
    //
    //* An array of derivative vectors

    derivatives(u : number, numDerivs? : number) : Array<Vector>;
}
