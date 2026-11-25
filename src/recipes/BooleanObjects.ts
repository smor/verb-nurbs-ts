import { NurbsCurveData, NurbsSurfaceData, Point } from "../core/Data.js";
import { Vec } from "../core/Vec.js";
import { Divide } from "../eval/Divide.js";
import { Eval } from "../eval/Eval.js";
import { Make } from "../eval/Make.js";
import { Offset } from "../eval/Offset.js";
import { Sweep } from "../eval/Sweep.js";
import { BrepSolid } from "../solid/Brep.js";
import { BooleanResult, BrepBoolean } from "../solid/BrepBoolean.js";
import { FreeformVesselParams, FreeformVesselRecipe } from "./FreeformVessel.js";

export interface MugParams extends FreeformVesselParams {
    // radius of the handle's round section (default 5.5)
    handleRadius? : number;
    // how far the handle reaches out from the wall (default 32)
    handleReach? : number;
    // heights where the handle meets the wall, as fractions of the height (default [0.25, 0.75])
    handleHeights? : [number, number];
    // angle around the vessel where the handle sits, in radians (default 3.77, away from the wall's seam at 0)
    handleAngle? : number;
}

export interface Mug {
    body : BrepSolid;
    cavity : BrepSolid;
    handle : BrepSolid;
    handleRail : NurbsCurveData;
    result : BooleanResult;
}

export interface PierceParams extends FreeformVesselParams {
    // number of holes around the vessel, per row (default 9)
    holes? : number;
    // rows of holes (default 2)
    rows? : number;
    // hole radius (default 7)
    holeRadius? : number;
    // round notches cut into the rim, and their radius (default 0 and 8)
    notches? : number;
    notchRadius? : number;
}

export interface PiercedVessel {
    body : BrepSolid;
    cavity : BrepSolid;
    tools : Array<BrepSolid>;
    result : BooleanResult;
}

// Models built with NURBS booleans, the way a CAD user would: closed solids combined by union and difference, with
// the seams computed exactly on the surfaces rather than on meshes.

export class BooleanObjectsRecipe {

    // A free-form mug: (body + handle) - cavity.
    //
    // The body is the solid inside the vessel's outer wall, the cavity the solid inside the inner wall, which runs a
    // little above the rim so the subtraction opens the top. The handle is a pipe whose ends go right through the
    // wall into the cavity; subtracting the cavity trims them flush with the inner wall. Leaving the tools long and
    // letting a Boolean trim them is what keeps the seams exact and avoids coincident faces.
    public static mug( params? : MugParams ) : Mug {
        let p = params != null ? params : {};
        let H = p.height != null ? p.height : 110;
        let vp : FreeformVesselParams = Object.assign( {
            height : H, radius : [40, 44] as [number, number], belly : 2.0, lean : [2, -1] as [number, number],
            wallThickness : 3, baseThickness : 5 }, p );
        let solids = BooleanObjectsRecipe.bodyAndCavity( vp );
        let outer = solids.outerFull;

        // the handle rail, in the plane through the axis at the handle angle
        let angle = p.handleAngle != null ? p.handleAngle : 3.77;
        let v = angle / (2 * Math.PI);
        let hz = p.handleHeights != null ? p.handleHeights : [0.25, 0.75];
        let reach = p.handleReach != null ? p.handleReach : 32;
        let r = p.handleRadius != null ? p.handleRadius : 5.5;
        let H1 = H * (1 + solids.extend);
        let at = (z : number) => {
            let u = z / H1;
            let w = Eval.rationalSurfacePoint( outer, u, v );
            let n = Offset.surfaceUnitNormal( outer, u, v );
            n = Vec.normalized( [n[0], n[1], 0] );
            let axis = Vec.sub( w, BrepSolid.curveCentroid( Make.surfaceIsocurve( outer, u, false ) ) );
            if (Vec.dot( n, axis ) < 0) n = Vec.mul( -1, n );
            return { w : w, n : n };
        };
        let a = at( H * hz[0] ), b = at( H * hz[1] ), m = at( H * (hz[0] + hz[1]) / 2 );
        let up : Point = [0, 0, 1];
        let depth = (vp.wallThickness as number) + 2 * r;
        let pts : Array<Point> = [
            Vec.sub( a.w, Vec.mul( depth, a.n ) ),
            Vec.add( Vec.add( a.w, Vec.mul( 0.3 * reach, a.n ) ), Vec.mul( 0.02 * H, up ) ),
            Vec.add( Vec.add( a.w, Vec.mul( 0.85 * reach, a.n ) ), Vec.mul( 0.1 * H, up ) ),
            Vec.add( m.w, Vec.mul( reach, m.n ) ),
            Vec.add( Vec.add( b.w, Vec.mul( 0.85 * reach, b.n ) ), Vec.mul( -0.1 * H, up ) ),
            Vec.add( Vec.add( b.w, Vec.mul( 0.3 * reach, b.n ) ), Vec.mul( -0.02 * H, up ) ),
            Vec.sub( b.w, Vec.mul( depth, b.n ) ),
        ];
        let rail = Make.rationalInterpCurve( pts, 3 );
        let pipe = Sweep.pipe( rail, r, { tolerance : 2e-3 } ).surface;
        let handle = BrepSolid.cappedTube( pipe, [96, 40] );

        let result = BrepBoolean.evaluate( [solids.body, handle, solids.cavity], f => (f[0] || f[1]) && !f[2] );
        return { body : solids.body, cavity : solids.cavity, handle : handle, handleRail : rail, result : result };
    }

    // A vessel whose wall is pierced by rows of round holes: body - cavity - cylinders.
    public static pierced( params? : PierceParams ) : PiercedVessel {
        let p = params != null ? params : {};
        let H = p.height != null ? p.height : 140;
        let vp : FreeformVesselParams = Object.assign( { height : H, radius : [55, 62] as [number, number], wallThickness : 3, baseThickness : 4 }, p );
        let solids = BooleanObjectsRecipe.bodyAndCavity( vp );
        let n = p.holes != null ? p.holes : 9;
        let rows = p.rows != null ? p.rows : 2;
        let hr = p.holeRadius != null ? p.holeRadius : 7;
        let R = Math.max( ...(vp.radius as Array<number>) ) * 1.6;
        let tools : Array<BrepSolid> = [];
        for (let row = 0; row < rows; row++) {
            let z = H * (0.35 + 0.35 * (rows == 1 ? 0.5 : row / (rows - 1)));
            for (let k = 0; k < n; k++) {
                // keep clear of the wall's seam at angle 0, and stagger the rows
                let th = 2 * Math.PI * (k + 0.5 + 0.5 * (row % 2)) / n;
                let dir : Point = [Math.cos( th ), Math.sin( th ), 0];
                // from inside the cavity (not through the axis, so each tool cuts the wall once) to well outside
                let a = Vec.add( [0, 0, z], Vec.mul( 0.5 * R / 1.6, dir ) ), b = Vec.add( [0, 0, z], Vec.mul( R, dir ) );
                let tube = Sweep.pipe( Make.rationalBezierCurve( [a, b] ), hr ).surface;
                tools.push( BrepSolid.cappedTube( tube, [12, 32] ) );
            }
        }
        // notches: tools centred on the rim, so their seams run across the edge between the outer wall and the rim
        let notches = p.notches != null ? p.notches : 0, nr = p.notchRadius != null ? p.notchRadius : 8;
        for (let k = 0; k < notches; k++) {
            let th = 2 * Math.PI * (k + 0.5) / notches;
            let dir : Point = [Math.cos( th ), Math.sin( th ), 0];
            let a = Vec.add( [0, 0, H], Vec.mul( 0.5 * R / 1.6, dir ) ), b = Vec.add( [0, 0, H], Vec.mul( R, dir ) );
            tools.push( BrepSolid.cappedTube( Sweep.pipe( Make.rationalBezierCurve( [a, b] ), nr ).surface, [12, 32] ) );
        }
        let result = BrepBoolean.evaluate( [solids.body, solids.cavity].concat( tools ),
            f => f[0] && !f[1] && !f.slice( 2 ).some( x => x ) );
        return { body : solids.body, cavity : solids.cavity, tools : tools, result : result };
    }

    // The solid inside the outer wall up to the rim, and the solid inside the inner wall from the floor to a little
    // above the rim. body - cavity is the vessel.
    public static bodyAndCavity( vp : FreeformVesselParams ) : { body : BrepSolid, cavity : BrepSolid, outerFull : NurbsSurfaceData, extend : number } {
        let extend = 0.08;
        let H = vp.height != null ? vp.height : 160;
        let w = FreeformVesselRecipe.outerWall( vp, extend );
        let outerFull = w.outerWall;
        let uRim = 1 / (1 + extend);
        let outer = Divide.surfaceSplit( outerFull, uRim, false )[0];
        let off = FreeformVesselRecipe.innerOffset( outerFull, vp.wallThickness != null ? vp.wallThickness : 3, vp.offsetTolerance != null ? vp.offsetTolerance : 0.02 );
        let inner = Divide.surfaceSplit( off.result, FreeformVesselRecipe.uAtHeight( off.result, vp.baseThickness != null ? vp.baseThickness : 4 ), false )[1];
        let divsU = vp.divsU != null ? vp.divsU : 48, divsV = vp.divsV != null ? vp.divsV : 192;
        let body = BrepSolid.cappedWall( outer, [divsU, divsV] );
        let cavity = BrepSolid.cappedWall( inner, [divsU, divsV] );
        return { body : body, cavity : cavity, outerFull : outerFull, extend : extend };
    }
}
