import { Point, Vector } from "../core/Data.js";
import { Arc } from "./Arc.js";

// A Circle is a three dimensional curve representing the points that are equidistant from a point in a particular plane

export class Circle extends Arc {

    //Create a circle
    //
    //**params**
    //
    //* Length 3 array representing the center of the circle
    //* Length 3 array representing the xaxis
    //* Length 3 array representing the perpendicular yaxis
    //* Radius of the circle

    constructor(center : Point, xaxis : Vector, yaxis : Vector, radius : number) {
        super( center, xaxis, yaxis, radius, 0, Math.PI * 2 );
    }
}
