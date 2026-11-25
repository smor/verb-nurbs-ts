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
    // the keyed coupling: a lobed foot under the bowl (its mean radius and height) that drops into a matching pocket
    // in the seat's floor. Its lobes are uneven so the bowl only fits one way round. 0 for none (default 34, 8)
    couplingRadius? : number;
    couplingHeight? : number;
    // the bowl's handle: a sculpted grip, its section (width, thickness) and how much it swells halfway
    gripSection? : [number, number];
    gripSwell? : number;
    // the lid: plate thickness, how far it overhangs the rim, its lobed tab's reach, the plug that drops inside the rim
    // (depth and wall), the central hole's radius and the fillet round the hole
    lidThickness? : number;
    lidOverhang? : number;
    lidTab? : number;
    plugDepth? : number;
    plugWall? : number;
    lidHole? : number;
    lidFillet? : number;
    // tessellation of the base's wall (around)
    divs? : number;
    fine? : boolean;
}

export interface Appliance {
    base : BooleanResult;
    bowl : Mug;
    // the lid, in the bowl's frame: it rests on the rim
    lid : BooleanResult;
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
// * the bowl: a conical vessel with a sculpted handle (a variable-section sweep), which drops into the seat with a set
//   radial clearance (the seat is the bowl's own cone, widened by the clearance). A lobed foot under it keys into a
//   pocket in the seat's floor: the pocket is the foot's outline offset by the clearance.
// * the lid: a plate with a soft edge and a lobed tab, a plug that drops inside the rim, and a central filler hole
//   with rounded edges.
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
        let profile = BooleanObjectsRecipe.superellipse( archS[0] / 2, archS[1] / 2, 3, 24 );
        let arch = BrepSolid.cappedTube( Sweep.surface( rail, profile, { tolerance : 0.02 } ).surface, [fine ? 96 : 48, fine ? 40 : 24] );

        // 5. the keyed coupling: the foot's outline, and the pocket's (the outline pushed out by the clearance)
        let cR = p.couplingRadius != null ? p.couplingRadius : 34, cH = p.couplingHeight != null ? p.couplingHeight : 8;
        let key = (t : number) => cR * (1 + 0.1 * Math.cos( 3 * t ) + 0.05 * Math.cos( t ));
        let solids = [block, slab, seatTool, arch];
        let keyFoot : BrepSolid | null = null;
        if (cR > 0 && cH > 0) {
            keyFoot = ApplianceRecipe.prism( ApplianceRecipe.polar( key, 0, 0, 96 ), -cH, 2, [8, fine ? 128 : 96] );
            let pocket = ApplianceRecipe.polar( key, gap, 0, 96 );
            solids.push( ApplianceRecipe.prism( pocket, zf - cH - 1.5, zf + 1, [8, fine ? 128 : 96], [0, yb] ) );
        }

        let ft = p.topFillet != null ? p.topFillet : 10, fs = p.seatFillet != null ? p.seatFillet : 4, fa = p.archFillet != null ? p.archFillet : 6;
        let base = BrepBoolean.evaluate( solids, f => (f[0] && !f[1] && !f[2] && !f[4]) || f[3], {
            fillet : (c : { solids : [number, number] }) => {
                let k = c.solids[0] + "," + c.solids[1];
                return k == "0,1" ? ft : k == "1,2" ? fs : k == "1,3" ? fa : k == "2,4" ? 2 : 0;
            }
        } );

        // the bowl: a cone with its handle towards the front, where the top is lowest
        let bowl = BooleanObjectsRecipe.mug( {
            height : bH, radius : bR, linearRadius : true, belly : 0, lean : [0, 0], harmonics : [],
            wallThickness : p.bowlWall != null ? p.bowlWall : 2.5, baseThickness : 4,
            handleSection : p.gripSection != null ? p.gripSection : [24, 15], handleSwell : p.gripSwell != null ? p.gripSwell : 1.2,
            handleReach : 44, handleHeights : [0.56, 0.92], handleAngle : 1.5 * Math.PI,
            fillet : p.handleFillet != null ? p.handleFillet : 4,
            addons : keyFoot != null ? [keyFoot] : [], addonFillet : 1,
            divsU : fine ? 48 : 24, divsV : fine ? 192 : 96, offsetTolerance : fine ? 0.02 : 0.08
        } );
        let lid = ApplianceRecipe.lid( p, bH, bR, p.bowlWall != null ? p.bowlWall : 2.5, gap, fine );
        let bowlOffset : Point = [0, yb, zf];
        let assembly = new TriMesh();
        for (let m of [base.mesh, bowl.result.mesh, lid.mesh]) {
            let o = assembly.vertices.length;
            let shift = m === base.mesh ? [0, 0, 0] : bowlOffset;
            for (let v of m.vertices) assembly.addVertex( Vec.add( v, shift ) );
            for (let t of m.triangles) assembly.addTriangle( t[0] + o, t[1] + o, t[2] + o );
        }
        return { base : base, bowl : bowl, lid : lid, bowlOffset : bowlOffset, assembly : assembly };
    }

    // The lid, in the bowl's frame (the rim is the circle of radius bR[1] at height bH):
    // (plate + plug) - plug's hollow - hole. The plate is a loft of its lobed outline, drawn in a little at the bottom
    // and top so its edge is soft; the plug is a ring that drops inside the rim with the clearance. The hole's two
    // edges (on the plate's top and on the plug's ceiling) are rounded.
    public static lid( p : ApplianceParams, bH : number, bR : [number, number], wall : number, gap : number, fine : boolean ) : BooleanResult {
        let T = p.lidThickness != null ? p.lidThickness : 6;
        let over = p.lidOverhang != null ? p.lidOverhang : 5;
        let tab = p.lidTab != null ? p.lidTab : 16;
        let depth = p.plugDepth != null ? p.plugDepth : 12, pw = p.plugWall != null ? p.plugWall : 2.5;
        let hole = p.lidHole != null ? p.lidHole : 24;
        let fl = p.lidFillet != null ? p.lidFillet : 2;
        let around = fine ? 192 : 128;
        // the bowl's inner radius at height z: the wall is measured square to the cone
        let slope = (bR[1] - bR[0]) / bH;
        let rIn = (z : number) => bR[0] + slope * z - wall * Math.sqrt( 1 + slope * slope );

        // the outline: a circle with a tab of three soft lobes on the right (+x), clear of the handle and the arch
        let g = (d : number, w : number) => Math.exp( -d * d / (w * w) );
        let outline = (t : number) => {
            let d = Math.atan2( Math.sin( t ), Math.cos( t ) );
            return bR[1] + over + tab * (g( d, 0.17 ) + 0.55 * (g( d - 0.3, 0.12 ) + g( d + 0.3, 0.12 )));
        };
        let e = Math.min( 2.5, 0.4 * T ), K = 7;
        let sections : Array<NurbsCurveData> = [];
        for (let k = 0; k < K; k++) {
            let phi = Math.PI * k / (K - 1);
            sections.push( ApplianceRecipe.polar( outline, -e * (1 - Math.sin( phi )), bH + T / 2 - T / 2 * Math.cos( phi ), 144 ) );
        }
        let plate = BrepSolid.cappedWall( Fit.loft( sections, 3, sections.map( (_, k) => k / (K - 1) ) ), [fine ? 24 : 16, around] );
        // the plug and its hollow follow the bowl's taper
        let z0 = bH - depth, z1 = bH + T / 2;
        let plug = ApplianceRecipe.tube( [rIn( z0 ) - gap, rIn( z1 ) - gap], z0, z1, [8, around] );
        let hollow = ApplianceRecipe.tube( [rIn( z0 - 2 ) - gap - pw, rIn( bH - 2 ) - gap - pw], z0 - 2, bH - 2, [8, around] );
        let bore = ApplianceRecipe.tube( hole, bH - depth - 6, bH + T + 6, [8, fine ? 96 : 64] );
        return BrepBoolean.evaluate( [plate, plug, hollow, bore], f => (f[0] || f[1]) && !f[2] && !f[3], {
            // the hole's edge on the plate's top (face 2) and on the hollow's ceiling (its end cap, face 2)
            fillet : (c : { solids : [number, number], faces : [number, number] }) =>
                c.solids[1] == 3 && c.faces[0] == 2 && (c.solids[0] == 0 || c.solids[0] == 2) ? (c.solids[0] == 0 ? fl : 0.5 * fl) : 0
        } );
    }

    // A closed outline in polar form r(t) in a horizontal plane at height z, pushed out by `offset` along its normal,
    // as a periodic cubic B-spline through `samples` points
    public static polar( r : (t : number) => number, offset : number, z : number, samples : number ) : NurbsCurveData {
        let at = (t : number) : Point => [r( t ) * Math.cos( t ), r( t ) * Math.sin( t ), z];
        let pts : Array<Point> = [];
        for (let i = 0; i < samples; i++) {
            let t = 2 * Math.PI * i / samples, h = 1e-5;
            let d = Vec.sub( at( t + h ), at( t - h ) );
            let n : Point = Vec.normalized( [d[1], -d[0], 0] ); // outward for a counter-clockwise outline
            pts.push( Vec.add( at( t ), Vec.mul( offset, n ) ) );
        }
        return Fit.periodicCurve( pts, 3 );
    }

    // The solid prism of a closed horizontal outline between two heights, moved by an (x, y) shift
    public static prism( outline : NurbsCurveData, z0 : number, z1 : number, divs : [number, number], shift? : [number, number] ) : BrepSolid {
        let s = shift != null ? shift : [0, 0];
        let move = (dz : number) => new NurbsCurveData( outline.degree, outline.knots.slice(),
            outline.controlPoints.map( c => [c[0] + s[0] * c[3], c[1] + s[1] * c[3], c[2] + dz * c[3], c[3]] ) );
        let z = outline.controlPoints[0][2] / outline.controlPoints[0][3];
        return BrepSolid.cappedWall( Fit.loft( [move( z0 - z ), move( z1 - z )], 1 ), divs );
    }

    // A solid vertical cylinder (or, with a pair of radii at the bottom and the top, a cone) on the z axis
    public static tube( r : number | [number, number], z0 : number, z1 : number, divs : [number, number] ) : BrepSolid {
        return BrepSolid.cappedTube( Sweep.pipe( Make.rationalBezierCurve( [[0, 0, z0], [0, 0, z1]] ), r ).surface, divs );
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
