import { Point, Vector } from "../core/Data.js";
import { Make } from "../eval/Make.js";
import { NurbsCurve } from "./NurbsCurve.js";

// An Arc is a three dimensional curve representing a subset of a full Circle

export class Arc extends NurbsCurve {

    //Constructor for Arc
    //
    //**params**
    //
    //* Length 3 array representing the center of the arc
    //* Length 3 array representing the xaxis
    //* Length 3 array representing the perpendicular yaxis
    //* Radius of the arc arc
    //* Start angle in radians
    //* End angle in radians

    constructor(center : Point, xaxis : Vector, yaxis : Vector, radius : number, minAngle : number, maxAngle : number) {
        super( Make.arc(center, xaxis, yaxis, radius, minAngle, maxAngle ) );

        this._center = center;
        this._xaxis = xaxis;
        this._yaxis = yaxis;
        this._radius = radius;
        this._minAngle = minAngle;
        this._maxAngle = maxAngle;
    }

    private _center : Point;
    private _xaxis : Vector;
    private _yaxis : Vector;
    private _radius : number;
    private _minAngle : number;
    private _maxAngle : number;

    //Length 3 array representing the center of the arc
    public center() : Point { return this._center; }

    //Length 3 array representing the xaxis
    public xaxis() : Vector { return this._xaxis; }

    //Length 3 array representing the perpendicular yaxis
    public yaxis() : Vector { return this._yaxis; }

    //Radius of the arc
    public radius() : number { return this._radius; }

    //Start angle in radians
    public minAngle() : number { return this._minAngle; }

    //End angle in radians
    public maxAngle() : number { return this._maxAngle; }

}