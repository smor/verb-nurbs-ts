import { Point, Vector } from "../core/Data.js";
import { Make } from "../eval/Make.js";
import { NurbsCurve } from "./NurbsCurve.js";

// An EllipseArc is a subset of an Ellipse

export class EllipseArc extends NurbsCurve {

    //Create an EllipseArc
    //
    //**params**
    //
    //* Length 3 array representing the center of the arc
    //* Length 3 array representing the xaxis
    //* Length 3 array representing the perpendicular yaxis
    //* Minimum angle of the EllipseArc
    //* Maximum angle of the EllipseArc

    constructor(center : Point, xaxis : Vector, yaxis : Vector, minAngle : number, maxAngle : number) {
        super( Make.ellipseArc(center, xaxis, yaxis, minAngle, maxAngle) );

        this._center = center;
        this._xaxis = xaxis;
        this._yaxis = yaxis;
        this._minAngle = minAngle;
        this._maxAngle = maxAngle;
    }

    private _center : Point;
    private _xaxis : Vector;
    private _yaxis : Vector;
    private _minAngle : number;
    private _maxAngle : number;

    //Length 3 array representing the center of the arc
    public center(){ return this._center; }

    //Length 3 array representing the xaxis
    public xaxis(){ return this._xaxis; }

    //Length 3 array representing the perpendicular yaxis
    public yaxis(){ return this._yaxis; }

    //Minimum angle of the EllipseArc
    public minAngle(){ return this._minAngle; }

    //Maximum angle of the EllipseArc
    public maxAngle(){ return this._maxAngle; }


}