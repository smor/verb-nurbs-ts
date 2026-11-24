import { Point } from "../core/Data.js";
import { Make } from "../eval/Make.js";
import { NurbsCurve } from "./NurbsCurve.js";

// A curve representing a straight line
export class Line extends NurbsCurve {

    //Create a line
    //
    //**params**
    //
    //* Length 3 array representing the start point
    //* Length 3 array representing the end point

    constructor(start : Point, end : Point) {
        super( Make.polyline( [ start, end ] ) );

        this._start = start;
        this._end = end;
    }

    private _start : Point;
    private _end : Point;

    //Length 3 array representing the start point
    public start(){ return this._start; }

    //Length 3 array representing the end point
    public end(){ return this._end; }

}