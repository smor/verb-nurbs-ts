import { Point } from "../core/Data.js";
import { Make } from "../eval/Make.js";
import { NurbsCurve } from "./NurbsCurve.js";

//A Bezier curve is a common spline curve
export class BezierCurve extends NurbsCurve {

    //Create a bezier curve
    //
    //**params**
    //
    //* Array of control points
    //* Array of control point weights (optional)

    constructor(points : Array<Point>, weights : Array<number> = null) {
        super( Make.rationalBezierCurve( points, weights ) );
    }
}