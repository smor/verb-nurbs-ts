import { Point, Vector } from "../core/Data.js";
import { Make } from "../eval/Make.js";
import { NurbsSurface } from "./NurbsSurface.js";

// A ConicalSurface is a surface making up the curve surface of a cone

export class ConicalSurface extends NurbsSurface {

    //Make a conical surface
    //
    //**params**
    //
    //* Length 3 array representing the axis of the cone
    //* Length 3 array representing the x axis, perpendicular to the axis
    //* Length 3 array representing the base of the cone
    //* Height of the cone
    //* Radius of the cone

    constructor(axis : Vector, xaxis : Vector, base : Point, height : number, radius : number)  {
        super( Make.conicalSurface(axis, xaxis, base, height, radius ));

        this._axis = axis;
        this._xaxis = xaxis;
        this._base = base;
        this._height = height;
        this._radius = radius;
    }

    private _axis : Vector;
    private _xaxis : Vector;
    private _base : Point;
    private _height : number;
    private _radius : number;

    //Length 3 array representing the axis of the cone
    public axis(){ return this._axis; }

    //Length 3 array representing the x axis, perpendicular to the axis
    public xaxis(){ return this._xaxis; }

    //Length 3 array representing the base of the cone
    public base(){ return this._base; }

    //Height of the cone
    public height(){ return this._height; }

    //Radius of the cone
    public radius(){ return this._radius; }

}
