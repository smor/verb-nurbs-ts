import { Point, Vector } from "../core/Data.js";
import { EllipseArc } from "./EllipseArc.js";

// A CylindricalSurface is a surface making up part of a cylinder.

export class Ellipse extends EllipseArc {

    //Create an ellipse
    //
    //**params**
    //
    //
    //* Length 3 array representing the center of the circle
    //* Length 3 array representing the xaxis
    //* Length 3 array representing the perpendicular yaxis

    constructor(center : Point, xaxis : Vector, yaxis : Vector) {
        super( center, xaxis, yaxis, 0, Math.PI * 2 );
    }
}
