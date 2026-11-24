import { Vector } from "../core/Data.js";
import { Vec } from "../core/Vec.js";
import { Make } from "../eval/Make.js";
import { ICurve } from "./ICurve.js";
import { NurbsSurface } from "./NurbsSurface.js";

// Form a Surface by extruding a curve along a vector

export class ExtrudedSurface extends NurbsSurface {

    //Construct a Surface by extruding a curve
    //
    //**params**
    //
    //* The profile curve
    //* The direction and magnitude of the extrusion

    constructor(profile : ICurve, direction : Vector) {
        super( Make.extrudedSurface( Vec.normalized( direction ), Vec.norm( direction ), profile.asNurbs() ));

        this._profile = profile;
        this._direction = direction;
    }

    private _profile : ICurve;
    private _direction : Vector;

    //The profile curve

    public profile() : ICurve { return this._profile; }

    //The direction and magnitude of the extrusion

    public direction() : Vector { return this._direction; }

}
