import { Intersect as EvalIntersect } from "../eval/Intersect.js";
import { NurbsCurveData } from "../core/Data.js";
import { CurveCurveIntersection, CurveSurfaceIntersection } from "../core/Intersections.js";
import { Dispatcher } from "../exe/Dispatcher.js";
import { ICurve } from "./ICurve.js";
import { ISurface } from "./ISurface.js";
import { NurbsCurve } from "./NurbsCurve.js";

// A class providing simplified access to verb's intersection tools. Intersect contains only static methods.
//
// Similar to `NurbsCurve` and `NurbsSurface`, `Intersect` provides asynchronous versions of all of its methods.

export class Intersect {

    //Determine the intersection of two curves
    //
    //**params**
    //
    //* ICurve object
    //* ICurve object
    //* tolerance for the intersection
    //
    //**returns**
    //
    //* a possibly empty array of CurveCurveIntersection objects

    public static curves( first : ICurve, second : ICurve, tol? : number) : Array<CurveCurveIntersection> { if (tol == null) tol = 1e-3;
        return EvalIntersect.curves( first.asNurbs(), second.asNurbs(), tol );
    }

    // The async version of `curves`

    public static curvesAsync( first : ICurve, second : ICurve, tol? : number) : Promise<Array<CurveCurveIntersection>> { if (tol == null) tol = 1e-3;
        return Dispatcher.dispatchMethod( EvalIntersect, "curves", [first.asNurbs(), second.asNurbs(), tol ]);
    }

    //Determine the intersection of a curve and a surface
    //
    //**params**
    //
    //* ICurve
    //* ISurface
    //* tolerance for the curve intersection
    //
    //**returns**
    //
    //* array of CurveSurfaceIntersection objects

    public static curveAndSurface( curve : ICurve, surface : ISurface, tol? : number) : Array<CurveSurfaceIntersection> { if (tol == null) tol = 1e-3;
        return EvalIntersect.curveAndSurface( curve.asNurbs(), surface.asNurbs(), tol);
    }

    // The async version of `curveAndSurface`

    public static curveAndSurfaceAsync( curve : ICurve, surface : ISurface, tol? : number) : Promise<Array<CurveSurfaceIntersection>> { if (tol == null) tol = 1e-3;
        return Dispatcher.dispatchMethod( EvalIntersect, "curveAndSurface", [curve.asNurbs(), surface.asNurbs(), tol ]);
    }

    //Determine the intersection of two surfaces
    //
    //**params**
    //
    //* ISurface
    //* ISurface
    //
    //**returns**
    //
    //* array of NurbsCurveData objects

    public static surfaces( first : ISurface, second : ISurface, tol? : number) : Array<NurbsCurve> { if (tol == null) tol = 1e-3;
        return EvalIntersect.surfaces( first.asNurbs(), second.asNurbs(), tol )
            .map(function(cd : NurbsCurveData){ return new NurbsCurve(cd); });
    }

    // The async version of `surfaces`

    public static surfacesAsync( first : ISurface, second : ISurface, tol? : number) : Promise<Array<NurbsCurve>> { if (tol == null) tol = 1e-3;
        return Dispatcher.dispatchMethod( EvalIntersect, "surfaces", [first.asNurbs(), second.asNurbs(), tol])
            .then(function(cds){
                return cds.map(function(cd : NurbsCurveData){ return new NurbsCurve(cd); });
            });
    }
}
