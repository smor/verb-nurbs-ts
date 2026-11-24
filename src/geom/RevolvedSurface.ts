import { Point, Vector } from "../core/Data.js";
import { Make } from "../eval/Make.js";
import { ICurve } from "./ICurve.js";
import { NurbsCurve } from "./NurbsCurve.js";
import { NurbsSurface } from "./NurbsSurface.js";

// A surface formed by revolving a profile curve around a given axis line

export class RevolvedSurface extends NurbsSurface {

    //Construct a revolved surface
    //
    //**params**
    //
    //* The profile curve
    //* A point on the axis of revolution
    //* The direction of the axis of revolution
    //* The angle to revolve around.  2 * Math.PI corresponds to a complete revolution

    constructor(profile : NurbsCurve, center : Point, axis : Vector, angle : number)  {
        super( Make.revolvedSurface( profile.asNurbs(), center, axis, angle ) );

        this._profile = profile;
        this._center = center;
        this._axis = axis;
        this._angle = angle;
    }

    private _profile : ICurve;
    private _center : Point;
    private _axis : Vector;
    private _angle : number;

    //The profile curve

    public profile() : ICurve { return this._profile; }

    //A point on the axis of revolution

    public center() : Point { return this._center; }

    //The direction of the axis of revolution

    public axis() : Vector { return this._center; }

    //The angle to revolve around.  2 * Math.PI corresponds to a complete revolution

    public angle() : number { return this._angle; }

}
