import { NurbsCurveData, NurbsSurfaceData, Point } from "../../core/Data.js";
import { Vec } from "../../core/Vec.js";
import { Analyze } from "../../eval/Analyze.js";
import { Eval } from "../../eval/Eval.js";
import { Make } from "../../eval/Make.js";
import { Modify } from "../../eval/Modify.js";
import { RotationMinimizingFrames, Sweep, SweepOptions } from "../../eval/Sweep.js";
import { BrepFace, BrepSolid } from "../Brep.js";

// How a loft passes through its sections (Rhino's and Grasshopper's loft styles).
//   normal   - a cubic (or lower, with fewer sections) that interpolates every section
//   loose    - the sections' control points are the surface's control net across: smoother, through the first and last
//              section only
//   straight - ruled between consecutive sections (degree 1 across)
export type LoftType = "normal" | "loose" | "straight";

export interface LoftOptions {
    type? : LoftType;
}

// Tessellation of a solid built by a node: divisions along the sections (or round a pipe) and across them.
export interface NodeDensity {
    along? : number;
    across? : number;
}

// How a pipe ends: flat (a planar cap) or round (a half-sphere).
export type PipeCaps = "flat" | "round";

export interface Sweep2Options {
    // sections placed along the rails before lofting (default 24)
    stations? : number;
}

// The surface and solid builders of Rhino and Grasshopper, on NURBS curves given in world coordinates: Plane Surface,
// 4Point Surface, Boundary Surfaces, Loft, Sweep1, Sweep2 and Pipe. The builders that take profiles (Extrude,
// Extrude Point) are `Primitives.extrude` and `Primitives.extrudePoint`. Each node returns the surface Grasshopper
// returns; the `...Solid` variants close it with caps when the sections are closed and planar (Grasshopper's Cap
// Holes), as a `BrepSolid` that rounds, Booleans and STEP take. docs/primitives.md lists them with their inputs.
export class Nodes {

    // ---- surfaces ----

    // A rectangle in a plane (Plane Surface): `origin` and the plane's x and y directions (y is made perpendicular to
    // x), with the x and y extents as domains, or as sizes from 0. Degree 1, u along x and v along y.
    public static plane( origin : Point, xAxis : Point, yAxis : Point, x : number | [number, number], y : number | [number, number] ) : NurbsSurfaceData {
        const ex = Nodes.unit( xAxis, "plane's x axis" );
        const ey = Nodes.unit( Vec.sub( yAxis, Vec.mul( Vec.dot( yAxis, ex ), ex ) ), "plane's y axis, away from its x axis," );
        const dx = typeof x == "number" ? [0, x] : x, dy = typeof y == "number" ? [0, y] : y;
        if (!(dx[1] > dx[0]) || !(dy[1] > dy[0])) throw new Error( "Nodes: a plane surface's x and y domains are increasing" );
        const at = (a : number, b : number) : Point => Vec.add( origin, Vec.add( Vec.mul( a, ex ), Vec.mul( b, ey ) ) );
        return Make.fourPointSurface( at( dx[0], dy[0] ), at( dx[1], dy[0] ), at( dx[1], dy[1] ), at( dx[0], dy[1] ), 1 );
    }

    // The bilinear patch through four corners in order (4Point Surface): planar when they are, a hyperbolic
    // paraboloid otherwise. Without `d` it is the triangle a, b, c (the side from c to d collapses to a point).
    public static fourPoint( a : Point, b : Point, c : Point, d? : Point ) : NurbsSurfaceData {
        const pts = [a, b, c].concat( d != null ? [d] : [] );
        pts.forEach( p => Nodes.finite( p ) );
        for (let i = 0; i < pts.length; i++) if (Vec.dist( pts[i], pts[(i + 1) % pts.length] ) < 1e-12) throw new Error( "Nodes: a four point surface has distinct corners" );
        return Make.fourPointSurface( a, b, c, d != null ? d : c, 1 );
    }

    // The planar surface inside each closed planar curve (Boundary Surfaces): a cone from the centroid of the region
    // to the curve, which is exact and planar but needs the region to be star-shaped about its centroid (every convex
    // region is, and stars, hearts and most outlines are). u runs along the curve, v from the centroid out. A curve
    // inside another (a hole) is refused: these faces are untrimmed.
    public static boundary( curves : Array<NurbsCurveData> ) : Array<NurbsSurfaceData> {
        const regions = curves.map( c => Nodes.region( c ) );
        regions.forEach( (r, i) => regions.forEach( (o, j) => {
            if (i != j && Nodes.inside( r.center, o )) throw new Error( "Nodes: boundary surfaces with holes are not supported (one curve lies inside another)" );
        } ) );
        return regions.map( (r, i) => BrepSolid.cone( r.center, curves[i] ) );
    }

    // The surface through a list of section curves (Loft), in order. u runs along the sections and v across them;
    // the sections are made compatible (same degree, same knots) first. See `LoftType`.
    public static loft( curves : Array<NurbsCurveData>, options : LoftOptions = {} ) : NurbsSurfaceData {
        if (curves.length < 2) throw new Error( "Nodes: a loft takes two sections or more" );
        const type = options.type != null ? options.type : "normal";
        const cs = Modify.unifyCurveKnotVectors( curves.map( c => Nodes.normalized( c ) ) );
        if (type == "straight") return Make.loftedSurface( cs, 1 );
        if (type == "normal") return Make.loftedSurface( cs, 3 );
        if (type != "loose") throw new Error( `Nodes: a loft is normal, loose or straight, not "${String( type )}"` );
        const p = Math.min( 3, cs.length - 1 ), n = cs.length;
        const knotsV : Array<number> = [];
        for (let i = 0; i <= p; i++) knotsV.push( 0 );
        for (let i = 1; i < n - p; i++) knotsV.push( i / (n - p) );
        for (let i = 0; i <= p; i++) knotsV.push( 1 );
        const net = cs[0].controlPoints.map( (_, i) => cs.map( c => c.controlPoints[i].slice() ) );
        return new NurbsSurfaceData( cs[0].degree, p, cs[0].knots.slice(), knotsV, net );
    }

    // A section swept along a rail (Sweep1). The section is drawn where it meets the start of the rail, in world
    // coordinates; it is carried along by rotation-minimising frames (Miter none), and its part along the rail's
    // starting tangent is dropped. u follows the rail and v the section; the surface is within `tolerance` (1e-3 by
    // default, `SweepOptions`) of the exact sweep.
    public static sweep1( rail : NurbsCurveData, section : NurbsCurveData, options : SweepOptions = {} ) : NurbsSurfaceData {
        return Nodes.sweep1Result( rail, section, options ).surface;
    }

    // A surface through sections whose ends ride along two rails (Sweep2). Each section starts on `rail1` and ends on
    // `rail2`; at each of `stations` places along the rails a section is set between the two rail points, turned to
    // keep its angle to the rails, scaled to the distance between them, and blended between the two given sections
    // either side. The surface lofts through these (u along the sections, v along the rails). The rails run the same
    // way (the second is reversed if they do not).
    public static sweep2( rail1 : NurbsCurveData, rail2 : NurbsCurveData, sections : Array<NurbsCurveData>, options : Sweep2Options = {} ) : NurbsSurfaceData {
        if (sections.length < 1) throw new Error( "Nodes: a two-rail sweep takes a section at least" );
        const r1 = Nodes.normalized( rail1 );
        let r2 = Nodes.normalized( rail2 );
        const ends = (c : NurbsCurveData) => [Eval.rationalCurvePoint( c, 0 ), Eval.rationalCurvePoint( c, 1 )];
        const [a0, a1] = ends( r1 ), [b0, b1] = ends( r2 );
        if (Vec.dist( a0, b1 ) + Vec.dist( a1, b0 ) < Vec.dist( a0, b0 ) + Vec.dist( a1, b1 )) r2 = Modify.curveReverse( r2 );
        // each section: its parameters on the rails, turned to run from rail 1 to rail 2, and its frame there
        const placed = sections.map( s => {
            let c = Nodes.normalized( s );
            const [s0, s1] = ends( c );
            const t1 = Analyze.rationalCurveClosestParam( r1, s0 ), t2 = Analyze.rationalCurveClosestParam( r2, s1 );
            const swap1 = Analyze.rationalCurveClosestParam( r1, s1 ), swap2 = Analyze.rationalCurveClosestParam( r2, s0 );
            const d = Vec.dist( Eval.rationalCurvePoint( r1, t1 ), s0 ) + Vec.dist( Eval.rationalCurvePoint( r2, t2 ), s1 );
            const dSwap = Vec.dist( Eval.rationalCurvePoint( r1, swap1 ), s1 ) + Vec.dist( Eval.rationalCurvePoint( r2, swap2 ), s0 );
            if (dSwap < d) c = Modify.curveReverse( c );
            const u1 = dSwap < d ? swap1 : t1, u2 = dSwap < d ? swap2 : t2;
            const size = Vec.dist( Eval.rationalCurvePoint( r1, u1 ), Eval.rationalCurvePoint( r2, u2 ) );
            if (Math.min( d, dSwap ) > 1e-6 * Math.max( 1, size )) throw new Error( "Nodes: each section of a two-rail sweep starts on one rail and ends on the other" );
            return { curve : c, u1 : u1, u2 : u2 };
        } ).sort( (p, q) => p.u1 - q.u1 );
        const unified = Modify.unifyCurveKnotVectors( placed.map( p => p.curve ) );
        // rail 2's parameter for rail 1's, piecewise linear through the sections and the rails' ends
        const pairs = [{ u1 : 0, u2 : 0 }].concat( placed.map( p => ({ u1 : p.u1, u2 : p.u2 }) ), [{ u1 : 1, u2 : 1 }] );
        const along2 = (t : number) : number => {
            for (let i = 1; i < pairs.length; i++) if (t <= pairs[i].u1 || i == pairs.length - 1) {
                const a = pairs[i - 1], b = pairs[i];
                return b.u1 - a.u1 < 1e-12 ? b.u2 : a.u2 + (b.u2 - a.u2) * (t - a.u1) / (b.u1 - a.u1);
            }
            return 1;
        };
        const local = unified.map( (c, k) => Nodes.toFrame( c, Nodes.railFrame( r1, r2, placed[k].u1, placed[k].u2 ) ) );
        const n = options.stations != null ? Math.round( options.stations ) : 24;
        if (!(n >= 2)) throw new Error( "Nodes: a two-rail sweep takes two stations or more" );
        const stations : Array<NurbsCurveData> = [];
        for (let i = 0; i < n; i++) {
            const t = i / (n - 1), f = Nodes.railFrame( r1, r2, t, along2( t ) );
            let k = 0;
            while (k < placed.length - 1 && placed[k + 1].u1 < t) k++;
            const lo = placed[k], hi = placed[Math.min( k + 1, placed.length - 1 )];
            const w = hi.u1 - lo.u1 < 1e-12 || t <= lo.u1 ? 0 : t >= hi.u1 ? 1 : (t - lo.u1) / (hi.u1 - lo.u1);
            const a = Nodes.fromFrame( local[k], f ), b = Nodes.fromFrame( local[Math.min( k + 1, placed.length - 1 )], f );
            stations.push( new NurbsCurveData( a.degree, a.knots, a.controlPoints.map( (p, j) => Vec.lerp( w, b.controlPoints[j], p ) ) ) );
        }
        // v is rail 1's parameter: station i at i / (n - 1)
        return Make.loftedSurface( stations, 3, stations.map( (_, i) => i / (n - 1) ) );
    }

    // A circular tube round a curve (Pipe), open at its ends: u follows the curve and v goes round. The radius is a
    // constant or a [start, end] pair; the surface is within 1e-3 of the exact pipe (`Sweep.pipe`).
    public static pipe( curve : NurbsCurveData, radius : number | [number, number], options : SweepOptions = {} ) : NurbsSurfaceData {
        Nodes.radii( radius );
        return Sweep.pipe( curve, radius, options ).surface;
    }

    // ---- solids ----

    // A loft between closed planar sections, capped at both ends with planar faces (Loft then Cap Holes). The end
    // sections must be star-shaped about their centroids, as for `boundary`.
    public static loftSolid( curves : Array<NurbsCurveData>, options : LoftOptions = {}, density : NodeDensity = {} ) : BrepSolid {
        curves.forEach( c => Nodes.requireClosed( c, "a capped loft's section" ) );
        const s = Nodes.loft( curves, options );
        const along = density.along != null ? density.along : 64, across = density.across != null ? density.across : 8 * (curves.length - 1);
        const first = Nodes.isocurve( s, false ), last = Nodes.isocurve( s, true );
        return new BrepSolid( [
            BrepSolid.face( s, [true, false], [along, across], "side" ),
            Nodes.cap( first, along, "bottom" ),
            Nodes.cap( last, along, "top" ),
        ] ).orient();
    }

    // A closed section swept along a rail (Sweep1 then Cap Holes): capped flat at both ends of an open rail, or a
    // ring when the rail is closed.
    public static sweep1Solid( rail : NurbsCurveData, section : NurbsCurveData, options : SweepOptions = {}, density : NodeDensity = {} ) : BrepSolid {
        Nodes.requireClosed( section, "a capped sweep's section" );
        const r = Nodes.sweep1Result( rail, section, options );
        return Nodes.tubeSolid( r.surface, r.closedU, density, null );
    }

    // A solid pipe (Pipe with caps): flat or round (half-sphere) ends on an open curve, a ring on a closed one.
    public static pipeSolid( curve : NurbsCurveData, radius : number | [number, number], caps : PipeCaps = "flat", options : SweepOptions = {}, density : NodeDensity = {} ) : BrepSolid {
        const rr = Nodes.radii( radius );
        if (caps != "flat" && caps != "round") throw new Error( `Nodes: a pipe's caps are flat or round, not "${String( caps )}"` );
        const r = Sweep.pipe( curve, radius, options );
        return Nodes.tubeSolid( r.surface, r.closedU, density, caps == "round" ? { rail : curve, radii : rr } : null );
    }

    // ---- helpers ----

    private static sweep1Result( rail : NurbsCurveData, section : NurbsCurveData, options : SweepOptions ) {
        // the section in the frame at the start of the rail: x along the frame's normal, y along its binormal
        const u0 = rail.knots[0];
        const f = new RotationMinimizingFrames( rail, options ).frameAt( u0 );
        const o : SweepOptions = Object.assign( {}, options, { initialNormal : f.normal } );
        const local = Nodes.toFrame( section, { origin : f.point, x : f.normal, y : f.binormal, z : f.tangent, scale : 1 } );
        return Sweep.surface( rail, local, o );
    }

    // The solid inside a swept tube (u along the rail, closed in v): one face when the rail is closed too, otherwise
    // flat caps from the end sections' centroids, or half-sphere domes on a pipe.
    private static tubeSolid( tube : NurbsSurfaceData, closedU : boolean, density : NodeDensity, round : { rail : NurbsCurveData, radii : [number, number] } | null ) : BrepSolid {
        const along = density.along != null ? density.along : 48, around = density.across != null ? density.across : 32;
        if (closedU) return new BrepSolid( [BrepSolid.face( tube, [true, true], [along, around], "tube" )] ).orient();
        const faces : Array<BrepFace> = [BrepSolid.face( tube, [false, true], [along, around], "tube" )];
        const d = [tube.knotsU[0], tube.knotsU[tube.knotsU.length - 1]];
        [false, true].forEach( atEnd => {
            const ring = Make.surfaceIsocurve( tube, atEnd ? d[1] : d[0], false );
            const name = atEnd ? "end cap" : "start cap";
            if (round == null) { faces.push( Nodes.cap( ring, around, name ) ); return; }
            const rail = round.rail, ru = atEnd ? rail.knots[rail.knots.length - 1] : rail.knots[0];
            const c = Eval.rationalCurvePoint( rail, ru );
            const t = Vec.mul( (atEnd ? 1 : -1) * (atEnd ? round.radii[1] : round.radii[0]), Vec.normalized( Eval.rationalCurveTangent( rail, ru ) ) );
            faces.push( BrepSolid.face( Nodes.dome( ring, c, t ), [true, false], [around, Math.max( 4, Math.round( around / 4 ) )], name ) );
        } );
        return new BrepSolid( faces ).orient();
    }

    // The half-sphere on a ring of radius |t| about c, bulging along t: each of the ring's control points P runs on a
    // quarter ellipse (corner P + t, end c + t, middle weight sqrt(2)/2) to the pole, so the dome shares the ring
    // exactly and is the sphere wherever the ring is the circle. u round the ring, v from the ring to the pole.
    private static dome( ring : NurbsCurveData, c : Point, t : Point ) : NurbsSurfaceData {
        const w = Math.SQRT1_2, top = Vec.add( c, t );
        const net = ring.controlPoints.map( hp => {
            const wi = hp[3], p = [hp[0] / wi, hp[1] / wi, hp[2] / wi], q = Vec.add( p, t );
            return [hp.slice(), q.map( x => x * w * wi ).concat( [w * wi] ), top.map( x => x * wi ).concat( [wi] )];
        } );
        return new NurbsSurfaceData( ring.degree, 2, ring.knots.slice(), [0, 0, 0, 1, 1, 1], net );
    }

    // A planar cap face inside a closed planar curve: a cone from its region's centroid.
    private static cap( ring : NurbsCurveData, divs : number, name : string ) : BrepFace {
        return BrepSolid.face( BrepSolid.cone( Nodes.region( ring ).center, ring ), [true, false], [divs, Math.max( 4, Math.round( divs / 8 ) )], name );
    }

    // The plane, centroid and outline of the region inside a closed planar curve, checked to be star-shaped about
    // the centroid.
    private static region( c : NurbsCurveData ) : { center : Point, normal : Point, outline : Array<Point> } {
        Nodes.requireClosed( c, "a boundary" );
        const a = c.knots[0], b = c.knots[c.knots.length - 1], n = 256;
        const pts : Array<Point> = [];
        for (let i = 0; i < n; i++) pts.push( Eval.rationalCurvePoint( c, a + (b - a) * i / n ) );
        // Newell's normal, and the area centroid of the polygon in its plane
        let nw = [0, 0, 0];
        for (let i = 0; i < n; i++) nw = Vec.add( nw, Vec.cross( pts[i], pts[(i + 1) % n] ) );
        const area2 = Vec.norm( nw );
        const size = Math.max( ...pts.map( p => Vec.dist( p, pts[0] ) ) );
        if (!(area2 > 1e-9 * size * size)) throw new Error( "Nodes: a boundary encloses an area" );
        const normal = Vec.mul( 1 / area2, nw );
        const o = pts[0];
        for (const hp of c.controlPoints) {
            const p = [hp[0] / hp[3], hp[1] / hp[3], hp[2] / hp[3]];
            if (Math.abs( Vec.dot( Vec.sub( p, o ), normal ) ) > 1e-7 * size) throw new Error( "Nodes: a boundary is planar" );
        }
        let center = [0, 0, 0];
        for (let i = 0; i < n; i++) {
            const p = Vec.sub( pts[i], o ), q = Vec.sub( pts[(i + 1) % n], o );
            const w = Vec.dot( Vec.cross( p, q ), normal );
            center = Vec.add( center, Vec.mul( w / 3, Vec.add( p, q ) ) );
        }
        center = Vec.add( o, Vec.mul( 1 / area2, center ) );
        for (let i = 0; i < n; i++) {
            const w = Vec.dot( Vec.cross( Vec.sub( pts[i], center ), Vec.sub( pts[(i + 1) % n], center ) ), normal );
            if (!(w > 1e-12 * size * size)) throw new Error( "Nodes: a planar face needs its boundary star-shaped about its centroid" );
        }
        return { center : center, normal : normal, outline : pts };
    }

    // whether a point of a region's plane lies inside another region (crossings of a ray in that region's plane)
    private static inside( p : Point, r : { center : Point, normal : Point, outline : Array<Point> } ) : boolean {
        if (Math.abs( Vec.dot( Vec.sub( p, r.center ), r.normal ) ) > 1e-9 * Math.max( 1, Vec.norm( r.center ) )) return false;
        const ex = Vec.normalized( Vec.sub( r.outline[0], r.center ) ), ey = Vec.cross( r.normal, ex );
        const flat = (q : Point) => [Vec.dot( Vec.sub( q, r.center ), ex ), Vec.dot( Vec.sub( q, r.center ), ey )];
        const [x, y] = flat( p );
        let odd = false;
        const ring = r.outline.map( flat );
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const [xi, yi] = ring[i], [xj, yj] = ring[j];
            if ((yi > y) != (yj > y) && x < xj + (xi - xj) * (y - yj) / (yi - yj)) odd = !odd;
        }
        return odd;
    }

    // the frame two rails give a section between them: x along the chord, z along the rails' mean tangent made
    // perpendicular to it, y = z cross x; scaled by the chord's length
    private static railFrame( r1 : NurbsCurveData, r2 : NurbsCurveData, u1 : number, u2 : number ) : { origin : Point, x : Point, y : Point, z : Point, scale : number } {
        const p = Eval.rationalCurvePoint( r1, u1 ), q = Eval.rationalCurvePoint( r2, u2 );
        const chord = Vec.sub( q, p ), len = Vec.norm( chord );
        if (!(len > 1e-12)) throw new Error( "Nodes: the rails of a two-rail sweep stay apart" );
        const x = Vec.mul( 1 / len, chord );
        const t = Vec.add( Vec.normalized( Eval.rationalCurveTangent( r1, u1 ) ), Vec.normalized( Eval.rationalCurveTangent( r2, u2 ) ) );
        const z = Nodes.unit( Vec.sub( t, Vec.mul( Vec.dot( t, x ), x ) ), "rails' direction, away from the chord between them," );
        return { origin : p, x : x, y : Vec.cross( z, x ), z : z, scale : len };
    }

    // a curve's control points in a frame's coordinates (divided by its scale), and back
    private static toFrame( c : NurbsCurveData, f : { origin : Point, x : Point, y : Point, z : Point, scale : number } ) : NurbsCurveData {
        return new NurbsCurveData( c.degree, c.knots.slice(), c.controlPoints.map( hp => {
            const w = hp[3], d = Vec.sub( [hp[0] / w, hp[1] / w, hp[2] / w], f.origin );
            return [Vec.dot( d, f.x ) * w / f.scale, Vec.dot( d, f.y ) * w / f.scale, Vec.dot( d, f.z ) * w / f.scale, w];
        } ) );
    }

    private static fromFrame( c : NurbsCurveData, f : { origin : Point, x : Point, y : Point, z : Point, scale : number } ) : NurbsCurveData {
        return new NurbsCurveData( c.degree, c.knots.slice(), c.controlPoints.map( hp => {
            const w = hp[3], l = [hp[0] / w, hp[1] / w, hp[2] / w];
            const p = Vec.add( f.origin, Vec.mul( f.scale, Vec.add( Vec.mul( l[0], f.x ), Vec.add( Vec.mul( l[1], f.y ), Vec.mul( l[2], f.z ) ) ) ) );
            return p.map( x => x * w ).concat( [w] );
        } ) );
    }

    // the isocurve at the start or end of v
    private static isocurve( s : NurbsSurfaceData, atEnd : boolean ) : NurbsCurveData {
        return Make.surfaceIsocurve( s, atEnd ? s.knotsV[s.knotsV.length - 1] : s.knotsV[0], true );
    }

    // a curve over [0, 1]
    private static normalized( c : NurbsCurveData ) : NurbsCurveData {
        const a = c.knots[0], b = c.knots[c.knots.length - 1];
        return new NurbsCurveData( c.degree, c.knots.map( x => x == b ? 1 : (x - a) / (b - a) ), c.controlPoints.map( p => p.slice() ) );
    }

    private static requireClosed( c : NurbsCurveData, what : string ) : void {
        const a = Eval.rationalCurvePoint( c, c.knots[0] ), b = Eval.rationalCurvePoint( c, c.knots[c.knots.length - 1] );
        const size = Math.max( ...c.controlPoints.map( hp => Vec.dist( [hp[0] / hp[3], hp[1] / hp[3], hp[2] / hp[3]], a ) ) );
        if (Vec.dist( a, b ) > 1e-9 * Math.max( 1, size )) throw new Error( `Nodes: ${what} is a closed curve` );
    }

    private static radii( r : number | [number, number] ) : [number, number] {
        const rr : [number, number] = typeof r == "number" ? [r, r] : r;
        if (!(rr[0] > 0 && rr[1] > 0 && isFinite( rr[0] ) && isFinite( rr[1] ))) throw new Error( "Nodes: a pipe's radius is positive" );
        return rr;
    }

    private static unit( v : Point, what : string ) : Point {
        Nodes.finite( v );
        const n = Vec.norm( v );
        if (!(n > 1e-12)) throw new Error( `Nodes: the ${what} is not zero` );
        return Vec.mul( 1 / n, v );
    }

    private static finite( p : Point ) : void {
        if (!(p.length == 3 && p.every( x => isFinite( x ) ))) throw new Error( "Nodes: points have three finite coordinates" );
    }
}
