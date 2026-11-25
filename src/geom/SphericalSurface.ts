import { Point } from "../core/Data.js";
import { Make } from "../eval/Make.js";
import { NurbsSurface } from "./NurbsSurface.js";

// A surface representing the doubly curved surface of a sphere

export class SphericalSurface extends NurbsSurface {

    //Create a spherical surface
    //
    //**params**
    //
    //* Length 3 array representing the center of the circle
    //* Radius of the circle

    constructor(center : Point, radius : number) {
        super( Make.sphericalSurface( center, [0,0,1], [1,0,0], radius ));

        this._center = center;
        this._radius = radius;
    }

    private _center : Point;
    private _radius : number;

    //Length 3 array representing the center of the circle

    public center() : Point{ return this._center; }

    //Radius of the circle

    public radius() : number{ return this._radius; }


}
