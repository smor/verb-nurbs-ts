import { NurbsCurveData, Point } from "../core/Data.js";
import { Vec } from "../core/Vec.js";
import { Fit } from "../eval/Fit.js";
import { Make } from "../eval/Make.js";
import { Sweep } from "../eval/Sweep.js";
import { BrepSolid } from "../solid/Brep.js";
import { BooleanResult, BrepBoolean } from "../solid/BrepBoolean.js";
import { TriMesh } from "../solid/TriMesh.js";
import { BooleanObjectsRecipe, Mug } from "./BooleanObjects.js";

export interface ApplianceParams {
    // footprint of the base (x by y) and its height at the front and back of the sloped top
    width? : number;
    depth? : number;
    frontHeight? : number;
    backHeight? : number;
    // how square the footprint is (2: ellipse, larger: squarer)
    squareness? : number;
    // how much the base narrows from the floor to the top
    taper? : number;
    // the bowl: height, radius at its foot and at its rim, wall thickness
    bowlHeight? : number;
    bowlRadius? : [number, number];
    bowlWall? : number;
    // how deep the bowl sits in the base, below the top surface at the bowl's centre
    seatDepth? : number;
    // radial gap between the bowl and its seat
    clearance? : number;
    // the carry arch over the back of the top: its height above the top, and its section (width, thickness)
    archHeight? : number;
    archSection? : [number, number];
    // fillet radii: the base's top edge, the seat's edge, the arch's feet, the bowl's handle joint
    topFillet? : number;
    seatFillet? : number;
    archFillet? : number;
    handleFillet? : number;
    // tessellation of the base's wall (around)
    divs? : number;
    fine? : boolean;
}

export interface Appliance {
    base : BooleanResult;
    bowl : Mug;
    // where the bowl sits on the base: translate the bowl's mesh by this
    bowlOffset : Point;
    // both parts, the bowl moved into its seat
    assembly : TriMesh;
}

// An original kitchen-appliance study in two separate parts, each a closed solid that can be made:
//
// * the base: a soft, tapered block whose top is cut by a sloped plane. A conical seat is sunk into the slope, and a
//   carry arch rises from the back of it. Every new edge is rounded with a rolling-ball fillet: the top edge and the
//   seat's edge are convex, the arch's feet concave.
// * the bowl: a conical vessel with a handle, which drops into the seat with a set radial clearance (the seat is the
//   bowl's own cone, widened by the clearance).
//
// Built only from lofts, sweeps and Booleans with fillets: (block - slab - seat) + arch for the base, and
// (body + handle) - cavity for the bowl.
export class ApplianceRecipe {

    public static build( params? : ApplianceParams ) : Appliance {
        let p = params != null ? params : {};
        let W = p.width != null ? p.width : 200, D = p.depth != null ? p.depth : 250;
        let hf = p.frontHeight != null ? p.frontHeight : 120, hb = p.backHeight != null ? p.backHeight : 190;
        let sq = p.squareness != null ? p.squareness : 3.2;
        let taper = p.taper != null ? p.taper : 0.88;
        let bH = p.bowlHeight != null ? p.bowlHeight : 170;
        let bR = p.bowlRadius != null ? p.bowlRadius : [58, 76] as [number, number];
        let seat = p.seatDepth != null ? p.seatDepth : 80;
        let gap = p.clearance != null ? p.clearance : 0.6;
        let archH = p.archHeight != null ? p.archHeight : 70;
        let archS = p.archSection != null ? p.archSection : [30, 16] as [number, number];
        let fine = p.fine != null ? p.fine : true;
        let around = p.divs != null ? p.divs : (fine ? 192 : 96);

        // the sloped top: z = hf at the front (y = -D/2), hb at the back (y = D/2)
        let slope = (hb - hf) / D;
        let topZ = (y : number) => (hf + hb) / 2 + slope * y;
        let up : Point = Vec.normalized( [0, -slope, 1] );

        // 1. the block: a loft of rounded-square sections, narrowing upwards, well above the top so the slab cuts it
        let Htot = hb + archH + 120;
        let sections : Array<NurbsCurveData> = [];
        let K = 5;
        for (let k = 0; k < K; k++) {
            let s = k / (K - 1);
            let f = 1 - (1 - taper) * s;
            sections.push( ApplianceRecipe.superellipse( W / 2 * f, D / 2 * f, sq, [0, 6 * s, Htot * s], 48 ) );
        }
        let wall = Fit.loft( sections, 3, sections.map( (_, k) => k / (K - 1) ) );
        let block = BrepSolid.cappedWall( wall, [fine ? 24 : 12, around] );

        // 2. the slab above the sloped plane: a wide flat-ended cylinder along the plane's normal. Its start cap is the
        // top surface; the cap's centre (a pole of its parameterisation) falls inside the seat, which is cut away.
        let yb = -0.12 * D; // the bowl's centre, a little forward
        let c0 : Point = [0, yb, topZ( yb )];
        let slabR = 1.6 * Math.max( W, D );
        let slab = BrepSolid.cappedTube( Sweep.pipe( Make.rationalBezierCurve( [c0, Vec.add( c0, Vec.mul( 2 * Htot, up ) )] ), slabR ).surface,
            [8, around] );

        // 3. the seat: the bowl's cone widened by the clearance, from the bowl's foot up through the top
        let zf = topZ( yb ) - seat;
        let rAt = (h : number) => bR[0] + (bR[1] - bR[0]) * h / bH; // bowl radius at height h above its foot
        let seatTop = seat + 0.5 * D * slope + 40;
        let seatTool = BrepSolid.cappedTube( Sweep.pipe( Make.rationalBezierCurve( [[0, yb, zf], [0, yb, zf + seatTop]] ),
            [rAt( 0 ) + gap, rAt( seatTop ) + gap] ).surface, [12, fine ? 96 : 64] );

        // 4. the arch: a soft rectangular section swept over the back of the top, its feet sunk into the block
        let yA = 0.5 * (yb + rAt( seat ) + 0.5 * D * taper) + 8, xA = 0.25 * W;
        let foot = (x : number) : Point => [x, yA, topZ( yA )];
        let fl = foot( -xA ), fr = foot( xA );
        let rail = Make.rationalInterpCurve( [
            Vec.sub( fl, Vec.mul( 18, up ) ),
            Vec.add( fl, Vec.mul( 0.45 * archH, up ) ),
            Vec.add( Vec.add( foot( -0.55 * xA ), Vec.mul( 0.9 * archH, up ) ), [0, 6, 0] ),
            Vec.add( Vec.add( foot( 0 ), Vec.mul( archH, up ) ), [0, 8, 0] ),
            Vec.add( Vec.add( foot( 0.55 * xA ), Vec.mul( 0.9 * archH, up ) ), [0, 6, 0] ),
            Vec.add( fr, Vec.mul( 0.45 * archH, up ) ),
            Vec.sub( fr, Vec.mul( 18, up ) ),
        ], 3 );
        let profile = ApplianceRecipe.superellipse( archS[0] / 2, archS[1] / 2, 3, [0, 0, 0], 24 );
        let arch = BrepSolid.cappedTube( Sweep.surface( rail, profile, { tolerance : 0.02 } ).surface, [fine ? 96 : 48, fine ? 40 : 24] );

        let ft = p.topFillet != null ? p.topFillet : 10, fs = p.seatFillet != null ? p.seatFillet : 4, fa = p.archFillet != null ? p.archFillet : 6;
        let base = BrepBoolean.evaluate( [block, slab, seatTool, arch], f => (f[0] && !f[1] && !f[2]) || f[3], {
            fillet : (c : { solids : [number, number] }) => {
                let k = c.solids[0] + "," + c.solids[1];
                return k == "0,1" ? ft : k == "1,2" ? fs : k == "1,3" ? fa : 0;
            }
        } );

        // the bowl: a cone with its handle towards the front, where the top is lowest
        let bowl = BooleanObjectsRecipe.mug( {
            height : bH, radius : bR, linearRadius : true, belly : 0, lean : [0, 0], harmonics : [],
            wallThickness : p.bowlWall != null ? p.bowlWall : 2.5, baseThickness : 4,
            handleRadius : 8, handleReach : 40, handleHeights : [0.62, 0.92], handleAngle : 1.5 * Math.PI,
            fillet : p.handleFillet != null ? p.handleFillet : 4,
            divsU : fine ? 48 : 24, divsV : fine ? 192 : 96, offsetTolerance : fine ? 0.02 : 0.08
        } );
        let bowlOffset : Point = [0, yb, zf];
        let assembly = new TriMesh();
        for (let m of [base.mesh, bowl.result.mesh]) {
            let o = assembly.vertices.length;
            let shift = m === base.mesh ? [0, 0, 0] : bowlOffset;
            for (let v of m.vertices) assembly.addVertex( Vec.add( v, shift ) );
            for (let t of m.triangles) assembly.addTriangle( t[0] + o, t[1] + o, t[2] + o );
        }
        return { base : base, bowl : bowl, bowlOffset : bowlOffset, assembly : assembly };
    }

    // A closed superellipse |x/a|^n + |y/b|^n = 1 around a centre, as a periodic cubic B-spline
    public static superellipse( a : number, b : number, n : number, centre : Point, samples : number ) : NurbsCurveData {
        let pts : Array<Point> = [];
        for (let i = 0; i < samples; i++) {
            let t = 2 * Math.PI * i / samples;
            let c = Math.cos( t ), s = Math.sin( t );
            pts.push( [centre[0] + a * Math.sign( c ) * Math.pow( Math.abs( c ), 2 / n ),
                       centre[1] + b * Math.sign( s ) * Math.pow( Math.abs( s ), 2 / n ), centre[2]] );
        }
        return Fit.periodicCurve( pts, 3 );
    }
}
