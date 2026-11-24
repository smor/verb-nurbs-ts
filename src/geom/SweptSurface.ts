import { Make } from "../eval/Make.js";
import { ICurve } from "./ICurve.js";
import { NurbsSurface } from "./NurbsSurface.js";

// A SweptSurface uses a profile curve and a guide rail to form a surface. The profile curve is "swept" along the guide
// rail by a lofting operation.

export class SweptSurface extends NurbsSurface {

    //Construct a Surface by translating along a rail curve
    //
    //**params**
    //
    //* The profile curve
    //* The rail curve

    constructor(profile : ICurve, rail : ICurve) {
        super( Make.rationalTranslationalSurface( profile.asNurbs(), rail.asNurbs() ));

        this._profile = profile;
        this._rail = rail;
    }

    private _profile : ICurve;
    private _rail : ICurve;

    //The profile curve

    public profile() : ICurve { return this._profile; }

    //The rail curve

    public rail() : ICurve { return this._rail; }


}
