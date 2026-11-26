import { NurbsCurveData, NurbsSurfaceData, Point } from "../core/Data.js";
import { Vec } from "../core/Vec.js";
import { Analyze } from "../eval/Analyze.js";
import { Divide } from "../eval/Divide.js";
import { Eval } from "../eval/Eval.js";
import { Make } from "../eval/Make.js";
import { Offset } from "../eval/Offset.js";
import { Fit } from "../eval/Fit.js";
import { RotationMinimizingFrames, Sweep } from "../eval/Sweep.js";
import { BrepSolid } from "../solid/Brep.js";
import { BooleanResult, BrepBoolean } from "../solid/BrepBoolean.js";
import { FilletShape } from "../solid/Fillet.js";
import { FreeformVesselParams, FreeformVesselRecipe } from "./FreeformVessel.js";

export interface MugParams extends FreeformVesselParams {
    // radius of the handle's round section (default 5.5)
    handleRadius? : number;
    // a sculpted grip instead of a round section: the section's width (across the handle's plane) and thickness (in
    // it), as a soft superellipse. Overrides handleRadius
    handleSection? : [number, number];
    // how much the section swells (or, below 1, narrows) halfway along the handle: the scale there (default 1)
    handleSwell? : number;
    // how far the handle reaches out from the wall (default 32)
    handleReach? : number;
    // heights where the handle meets the wall, as fractions of the height (default [0.25, 0.75])
    handleHeights? : [number, number];
    // angle around the vessel where the handle sits, in radians (default 3.77, away from the wall's seam at 0)
    handleAngle? : number;
    // radius of the rolling-ball fillet where the handle meets the body (default 0: a sharp joint)
    fillet? : number;
    // more solids joined to the body, such as a foot (they must stay clear of the cavity), and the fillet radius where
    // they meet the body (default 0)
    addons? : Array<BrepSolid>;
    addonFillet? : number;
    // ribs standing proud of the inner wall, evenly spaced around it (starting half a spacing from the handle): their
    // number (default 0), the heights they run between as fractions of the height (default [0.15, 0.7]), their section
    // (width along the wall and depth across it, default [6, 5]; 1 of the depth is sunk into the wall) and the radius
    // of the fillet where they meet the wall (default 0)
    ribs? : number;
    ribHeights? : [number, number];
    ribSize? : [number, number];
    ribFillet? : number;
    // the fillets' cross-section: "circular" (default) or "curvature" (G2 with the faces)
    filletShape? : FilletShape;
    // prove the Boolean's intersections complete (`IntersectionCertificate`); the result's report says which pairs of
    // faces could not be proven (default false: it costs time, so a makeable build asks for it)
    certify? : boolean;
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
    // where the first notch sits around the rim, as a fraction of the spacing between notches (default 0.5)
    notchPhase? : number;
    // radius of the rolling-ball fillet that rounds the edges of the holes and notches (default 0: sharp edges)
    fillet? : number;
    // radius of the fillet on the rim's inner edge (default 0: sharp). Equal to `fillet`, the notches' inner corners
    // become ball corners, where three fillets meet
    rimFillet? : number;
    // the fillets' cross-section: "circular" (default) or "curvature" (G2 with the faces)
    filletShape? : FilletShape;
    // prove the Boolean's intersections complete, as for `MugParams.certify` (default false)
    certify? : boolean;
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

    // A closed superellipse |x/a|^n + |y/b|^n = 1 in the XY plane around the origin, as a periodic cubic B-spline
    // through `samples` points (n = 2 is an ellipse; larger n is squarer)
    public static superellipse( a : number, b : number, n : number, samples : number ) : NurbsCurveData {
        const pts : Array<Point> = [];
        for (let i = 0; i < samples; i++) {
            const t = 2 * Math.PI * i / samples;
            const c = Math.cos( t ), s = Math.sin( t );
            pts.push( [a * Math.sign( c ) * Math.pow( Math.abs( c ), 2 / n ), b * Math.sign( s ) * Math.pow( Math.abs( s ), 2 / n ), 0] );
        }
        return Fit.periodicCurve( pts, 3 );
    }

    // A free-form mug: (body + handle) - cavity.
    //
    // The body is the solid inside the vessel's outer wall, the cavity the solid inside the inner wall, which runs a
    // little above the rim so the subtraction opens the top. The handle is a pipe whose ends go right through the
    // wall into the cavity; subtracting the cavity trims them flush with the inner wall. Leaving the tools long and
    // letting a Boolean trim them is what keeps the seams exact and avoids coincident faces.
    public static mug( params? : MugParams ) : Mug {
        const p = params != null ? params : {};
        const H = p.height != null ? p.height : 110;
        const vp : FreeformVesselParams = Object.assign( {
            height : H, radius : [40, 44] as [number, number], belly : 2.0, lean : [2, -1] as [number, number],
            wallThickness : 3, baseThickness : 5 }, p );
        const solids = BooleanObjectsRecipe.bodyAndCavity( vp );
        const outer = solids.outerFull;

        // the handle rail, in the plane through the axis at the handle angle
        const angle = p.handleAngle != null ? p.handleAngle : 3.77;
        const v = angle / (2 * Math.PI);
        const hz = p.handleHeights != null ? p.handleHeights : [0.25, 0.75];
        const reach = p.handleReach != null ? p.handleReach : 32;
        const r = p.handleRadius != null ? p.handleRadius : 5.5;
        const H1 = H * (1 + solids.extend);
        const at = (z : number, vv : number = v) => {
            const u = z / H1;
            const w = Eval.rationalSurfacePoint( outer, u, vv );
            let n = Offset.surfaceUnitNormal( outer, u, vv );
            n = Vec.normalized( [n[0], n[1], 0] );
            const axis = Vec.sub( w, BrepSolid.curveCentroid( Make.surfaceIsocurve( outer, u, false ) ) );
            if (Vec.dot( n, axis ) < 0) n = Vec.mul( -1, n );
            return { w : w, n : n };
        };
        const a = at( H * hz[0] ), b = at( H * hz[1] ), m = at( H * (hz[0] + hz[1]) / 2 );
        const up : Point = [0, 0, 1];
        const depth = (vp.wallThickness as number) + 2 * r;
        // the legs of the handle lean towards each other as they leave the wall; keep them at least three pipe
        // radii apart, where the joints allow
        const gap = H * (hz[1] - hz[0]);
        const lift = Math.max( 0, Math.min( 0.1 * H, (gap - 3 * r) / 2 ) );
        const pts : Array<Point> = [
            Vec.sub( a.w, Vec.mul( depth, a.n ) ),
            Vec.add( Vec.add( a.w, Vec.mul( 0.3 * reach, a.n ) ), Vec.mul( 0.02 * H, up ) ),
            Vec.add( Vec.add( a.w, Vec.mul( 0.85 * reach, a.n ) ), Vec.mul( lift, up ) ),
            Vec.add( m.w, Vec.mul( reach, m.n ) ),
            Vec.add( Vec.add( b.w, Vec.mul( 0.85 * reach, b.n ) ), Vec.mul( -lift, up ) ),
            Vec.add( Vec.add( b.w, Vec.mul( 0.3 * reach, b.n ) ), Vec.mul( -0.02 * H, up ) ),
            Vec.sub( b.w, Vec.mul( depth, b.n ) ),
        ];
        const rail = Make.rationalInterpCurve( pts, 3 );
        let pipe : NurbsSurfaceData;
        if (p.handleSection == null && p.handleSwell == null) pipe = Sweep.pipe( rail, r, { tolerance : 2e-3, noFold : true } ).surface;
        else {
            // a variable-section sweep: the section's width lies across the handle's plane, whatever the start frame
            const sec = p.handleSection != null ? p.handleSection : [2 * r, 2 * r];
            const swell = p.handleSwell != null ? p.handleSwell : 1;
            const across = Vec.normalized( Vec.cross( a.n, up ) );
            const u0 = rail.knots[0], u1 = rail.knots[rail.knots.length - 1];
            const fr = new RotationMinimizingFrames( rail ).frameAt( u0 );
            const twist = Math.atan2( Vec.dot( across, fr.binormal ), Vec.dot( across, fr.normal ) );
            const profile = BooleanObjectsRecipe.superellipse( sec[0] / 2, sec[1] / 2, 2.6, 32 );
            pipe = Sweep.surface( rail, profile, { tolerance : 2e-3, twist : twist, noFold : true, scale : (u : number) => {
                const t = Math.sin( Math.PI * (u - u0) / (u1 - u0) );
                return 1 + (swell - 1) * t * t;
            } } ).surface;
        }
        const handle = BrepSolid.cappedTube( pipe, [96, 40] );

        const fr = p.fillet != null ? p.fillet : 0;
        // ribs: a soft section swept up the inner wall, following it, with its back sunk 1 into the wall. At both ends
        // the rib narrows and dives into the middle of the wall, so it grows out of the wall and its end caps are
        // buried: it meets the inner wall in one closed loop, which can be filleted
        const ribs : Array<BrepSolid> = [];
        const nr = p.ribs != null ? p.ribs : 0;
        const rh = p.ribHeights != null ? p.ribHeights : [0.15, 0.7], rs = p.ribSize != null ? p.ribSize : [6, 5];
        const wall = vp.wallThickness as number;
        const endScale = Math.min( 0.5, 0.7 * wall / rs[1] );
        for (let k = 0; k < nr; k++) {
            const vv = ((angle + 2 * Math.PI * (k + 0.5) / nr) / (2 * Math.PI)) % 1;
            // the ends dive steeply, over about a rib's width, so the rib ends bluntly where it leaves the wall
            const pts : Array<Point> = [];
            const z0 = H * rh[0], z1 = H * rh[1], dive = rs[0];
            const zs = [z0, z0 + dive];
            const N = 6;
            for (let i = 1; i < N; i++) zs.push( z0 + dive + (z1 - z0 - 2 * dive) * i / N );
            zs.push( z1 - dive, z1 );
            zs.forEach( (z, i) => {
                const o = at( z, vv );
                const depth = i == 0 || i == zs.length - 1 ? wall / 2 : wall + rs[1] / 2 - 1;
                pts.push( Vec.sub( o.w, Vec.mul( depth, o.n ) ) );
            } );
            const rail = Make.rationalInterpCurve( pts, 3 );
            const u0 = rail.knots[0], u1 = rail.knots[rail.knots.length - 1];
            // the parameter where the rail reaches full depth, from each end
            const ue = Analyze.rationalCurveClosestParam( rail, pts[1] ) - u0;
            const n0 = at( H * rh[0], vv ).n;
            const fr0 = new RotationMinimizingFrames( rail ).frameAt( u0 );
            const tw = Math.atan2( Vec.dot( n0, fr0.binormal ), Vec.dot( n0, fr0.normal ) );
            const sec = BooleanObjectsRecipe.superellipse( rs[1] / 2, rs[0] / 2, 2.4, 24 );
            const scale = (u : number) => {
                const t = Math.min( 1, Math.min( u - u0, u1 - u ) / ue );
                return endScale + (1 - endScale) * Math.sin( 0.5 * Math.PI * t );
            };
            ribs.push( BrepSolid.cappedTube( Sweep.surface( rail, sec, { tolerance : 2e-3, twist : tw, scale : scale } ).surface, [48, 32] ) );
        }

        const addons = p.addons != null ? p.addons : [];
        const fa = p.addonFillet != null ? p.addonFillet : 0, fb = p.ribFillet != null ? p.ribFillet : 0;
        const n = 2 + addons.length; // the cavity's index; ribs follow it
        const result = BrepBoolean.evaluate( [solids.body, handle].concat( addons, [solids.cavity], ribs ), f => {
            let joined = false;
            for (let i = 0; i < n; i++) joined = joined || f[i];
            let rib = false;
            for (let i = n + 1; i < f.length; i++) rib = rib || f[i];
            return (joined && !f[n]) || (rib && f[0]);
        }, { filletShape : p.filletShape, certify : p.certify === true, fillet : (c : { solids : [number, number] }) =>
            c.solids[1] > n ? (c.solids[0] == n ? fb : 0) : c.solids[0] != 0 || c.solids[1] == n ? 0 : c.solids[1] == 1 ? fr : fa } );
        return { body : solids.body, cavity : solids.cavity, handle : handle, handleRail : rail, result : result };
    }

    // A vessel whose wall is pierced by rows of round holes: body - cavity - cylinders.
    public static pierced( params? : PierceParams ) : PiercedVessel {
        const p = params != null ? params : {};
        const H = p.height != null ? p.height : 140;
        const vp : FreeformVesselParams = Object.assign( { height : H, radius : [55, 62] as [number, number], wallThickness : 3, baseThickness : 4 }, p );
        const solids = BooleanObjectsRecipe.bodyAndCavity( vp );
        const n = p.holes != null ? p.holes : 9;
        const rows = p.rows != null ? p.rows : 2;
        const hr = p.holeRadius != null ? p.holeRadius : 7;
        const R = Math.max( ...(vp.radius as Array<number>) ) * 1.6;
        // the tools start well inside the cavity wherever they cut, even where the wall leans in: at half the larger
        // radius, but no further out than 0.6 times the smaller one (a vessel narrowing to its rim had its notches
        // start inside the wall, and their end caps cut a pocket in it)
        const start = Math.min( 0.5 * R / 1.6, 0.6 * Math.min( ...(vp.radius as Array<number>) ) );
        const tools : Array<BrepSolid> = [];
        for (let row = 0; row < rows; row++) {
            const z = H * (0.35 + 0.35 * (rows == 1 ? 0.5 : row / (rows - 1)));
            for (let k = 0; k < n; k++) {
                // keep clear of the wall's seam at angle 0, and stagger the rows
                const th = 2 * Math.PI * (k + 0.5 + 0.5 * (row % 2)) / n;
                const dir : Point = [Math.cos( th ), Math.sin( th ), 0];
                // from inside the cavity (not through the axis, so each tool cuts the wall once) to well outside
                const a = Vec.add( [0, 0, z], Vec.mul( start, dir ) ), b = Vec.add( [0, 0, z], Vec.mul( R, dir ) );
                const tube = Sweep.pipe( Make.rationalBezierCurve( [a, b] ), hr ).surface;
                tools.push( BrepSolid.cappedTube( tube, [12, 32] ) );
            }
        }
        // notches: tools centred on the rim, so their seams run across the edge between the outer wall and the rim
        const notches = p.notches != null ? p.notches : 0, nr = p.notchRadius != null ? p.notchRadius : 8;
        for (let k = 0; k < notches; k++) {
            const th = 2 * Math.PI * (k + (p.notchPhase != null ? p.notchPhase : 0.5)) / notches;
            const dir : Point = [Math.cos( th ), Math.sin( th ), 0];
            const a = Vec.add( [0, 0, H], Vec.mul( start, dir ) ), b = Vec.add( [0, 0, H], Vec.mul( R, dir ) );
            tools.push( BrepSolid.cappedTube( Sweep.pipe( Make.rationalBezierCurve( [a, b] ), nr ).surface, [12, 32] ) );
        }
        const fr = p.fillet != null ? p.fillet : 0, rim = p.rimFillet != null ? p.rimFillet : 0;
        // the rim's inner edge is the one between the body's top (face 2) and the cavity's wall
        const result = BrepBoolean.evaluate( [solids.body, solids.cavity].concat( tools ),
            f => f[0] && !f[1] && !f.slice( 2 ).some( x => x ), { filletShape : p.filletShape, certify : p.certify === true, fillet : (c : { solids : [number, number], faces : [number, number] }) =>
                c.solids[1] >= 2 ? fr : c.solids[0] == 0 && c.solids[1] == 1 && c.faces[0] == 2 ? rim : 0 } );
        return { body : solids.body, cavity : solids.cavity, tools : tools, result : result };
    }

    // The solid inside the outer wall up to the rim, and the solid inside the inner wall from the floor to a little
    // above the rim. body - cavity is the vessel.
    public static bodyAndCavity( vp : FreeformVesselParams ) : { body : BrepSolid, cavity : BrepSolid, outerFull : NurbsSurfaceData, extend : number } {
        const extend = 0.08;
        const w = FreeformVesselRecipe.outerWall( vp, extend );
        const outerFull = w.outerWall;
        const uRim = 1 / (1 + extend);
        const outer = Divide.surfaceSplit( outerFull, uRim, false )[0];
        const off = FreeformVesselRecipe.innerOffset( outerFull, vp.wallThickness != null ? vp.wallThickness : 3, vp.offsetTolerance != null ? vp.offsetTolerance : 0.02 );
        const inner = Divide.surfaceSplit( off.result, FreeformVesselRecipe.uAtHeight( off.result, vp.baseThickness != null ? vp.baseThickness : 4 ), false )[1];
        const divsU = vp.divsU != null ? vp.divsU : 48, divsV = vp.divsV != null ? vp.divsV : 192;
        const body = BrepSolid.cappedWall( outer, [divsU, divsV] );
        const cavity = BrepSolid.cappedWall( inner, [divsU, divsV] );
        return { body : body, cavity : cavity, outerFull : outerFull, extend : extend };
    }
}
