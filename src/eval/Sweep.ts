import { NurbsCurveData, NurbsSurfaceData, Point, Vector } from "../core/Data.js";
import { Vec } from "../core/Vec.js";
import { Eval } from "./Eval.js";
import { Fit } from "./Fit.js";
import { Make } from "./Make.js";

// A moving frame on a curve: `tangent`, `normal` and `binormal` are unit vectors, with binormal = tangent x normal.
export interface Frame {
    u : number;
    point : Point;
    tangent : Vector;
    normal : Vector;
    binormal : Vector;
}

export interface FrameOptions {
    // the frame's normal at the start of the rail; it is projected to be perpendicular to the tangent. Default: the
    // world Z axis (or X when the rail starts along Z), which keeps a profile drawn in the XY plane upright
    initialNormal? : Vector;
    // treat the rail as closed and spread the frame's mismatch after one loop evenly along it, so the frame at the end
    // equals the frame at the start. Default: true when the rail's end points and end tangents coincide
    closed? : boolean;
    // number of steps used to propagate the frame (default: max(512, 64 per knot span))
    samples? : number;
}

// Rotation-minimising frames along a curve, computed with the double reflection method (Wang, Juettler, Zheng and
// Liu, "Computation of rotation minimizing frames", ACM TOG 2008).
//
// Unlike Frenet frames, these do not flip at inflections or spin where the curve is nearly straight, which is what a
// sweep needs. The frame is propagated through `samples` steps once; `frameAt(u)` then takes one more reflection step
// from the nearest sample, so any parameter can be queried.

export class RotationMinimizingFrames {

    public rail : NurbsCurveData;
    public closed : boolean;
    // the angle (radians) the frame turned around the tangent over a closed loop before correction
    public closureAngle : number = 0.0;

    private us : Array<number> = [];
    private pts : Array<Point> = [];
    private tans : Array<Vector> = [];
    private nors : Array<Vector> = [];
    private u0 : number;
    private u1 : number;

    constructor( rail : NurbsCurveData, options? : FrameOptions ) {
        this.rail = rail;
        this.u0 = rail.knots[0];
        this.u1 = rail.knots[rail.knots.length - 1];
        let spans = Fit.spans( rail.knots ).length;
        let n = options != null && options.samples != null ? options.samples : Math.max( 512, 64 * spans );

        let t0 = this.tangentAt( this.u0 ), t1 = this.tangentAt( this.u1 );
        let p0 = Eval.rationalCurvePoint( rail, this.u0 ), p1 = Eval.rationalCurvePoint( rail, this.u1 );
        let size = Vec.norm( Vec.sub( Eval.rationalCurvePoint( rail, (this.u0 + this.u1) / 2 ), p0 ) ) + 1e-12;
        this.closed = options != null && options.closed != null ? options.closed
            : Vec.dist( p0, p1 ) < 1e-7 * size && Vec.dot( t0, t1 ) > 1 - 1e-6;

        let r : Vector;
        if (options != null && options.initialNormal != null) r = options.initialNormal;
        else r = Math.abs( t0[2] ) < 0.9 ? [0.0, 0.0, 1.0] : [1.0, 0.0, 0.0];
        r = Vec.sub( r, Vec.mul( Vec.dot( r, t0 ), t0 ) );
        if (Vec.norm( r ) < 1e-10) throw "RotationMinimizingFrames: the initial normal is parallel to the tangent";
        r = Vec.normalized( r );

        for (let i = 0; i <= n; i++) {
            let u = this.u0 + (this.u1 - this.u0) * i / n;
            let x = Eval.rationalCurvePoint( rail, u ), t = this.tangentAt( u );
            if (i > 0) r = RotationMinimizingFrames.reflect( this.pts[i-1], this.tans[i-1], this.nors[i-1], x, t );
            this.us.push( u ); this.pts.push( x ); this.tans.push( t ); this.nors.push( r );
        }

        if (this.closed) {
            let tEnd = this.tans[n], rEnd = this.nors[n], rStart = this.nors[0];
            this.closureAngle = Math.atan2( Vec.dot( Vec.cross( rEnd, rStart ), tEnd ), Vec.dot( rEnd, rStart ) );
        }
    }

    // The frame at parameter u.
    public frameAt( u : number ) : Frame {
        u = Math.min( Math.max( u, this.u0 ), this.u1 );
        let n = this.us.length - 1;
        let i = Math.min( Math.floor( (u - this.u0) / (this.u1 - this.u0) * n ), n );
        let x = Eval.rationalCurvePoint( this.rail, u ), t = this.tangentAt( u );
        let r = u == this.us[i] ? this.nors[i] : RotationMinimizingFrames.reflect( this.pts[i], this.tans[i], this.nors[i], x, t );
        if (this.closed && this.closureAngle != 0.0) {
            let a = this.closureAngle * (u - this.u0) / (this.u1 - this.u0);
            r = Vec.add( Vec.mul( Math.cos( a ), r ), Vec.mul( Math.sin( a ), Vec.cross( t, r ) ) );
        }
        r = Vec.normalized( Vec.sub( r, Vec.mul( Vec.dot( r, t ), t ) ) );
        return { u : u, point : x, tangent : t, normal : r, binormal : Vec.cross( t, r ) };
    }

    // `count` frames at evenly spaced parameters, including both ends.
    public frames( count : number ) : Array<Frame> {
        let out : Array<Frame> = [];
        for (let i = 0; i < count; i++) out.push( this.frameAt( this.u0 + (this.u1 - this.u0) * i / (count - 1) ) );
        return out;
    }

    private tangentAt( u : number ) : Vector {
        let d = Eval.rationalCurveDerivatives( this.rail, u, 1 )[1];
        if (Vec.norm( d ) < 1e-12) {
            let du = 1e-6 * (this.u1 - this.u0);
            d = Eval.rationalCurveDerivatives( this.rail, u + du <= this.u1 ? u + du : u - du, 1 )[1];
        }
        return Vec.normalized( d );
    }

    // one double reflection step: carry normal r at (x0, t0) to (x1, t1)
    private static reflect( x0 : Point, t0 : Vector, r0 : Vector, x1 : Point, t1 : Vector ) : Vector {
        let v1 = Vec.sub( x1, x0 );
        let c1 = Vec.dot( v1, v1 );
        let rL = r0, tL = t0;
        if (c1 > 1e-24) {
            rL = Vec.sub( r0, Vec.mul( 2 / c1 * Vec.dot( v1, r0 ), v1 ) );
            tL = Vec.sub( t0, Vec.mul( 2 / c1 * Vec.dot( v1, t0 ), v1 ) );
        }
        let v2 = Vec.sub( t1, tL );
        let c2 = Vec.dot( v2, v2 );
        if (c2 < 1e-24) return rL;
        return Vec.sub( rL, Vec.mul( 2 / c2 * Vec.dot( v2, rL ), v2 ) );
    }
}

export interface SweepOptions extends FrameOptions {
    // rotation of the profile around the rail, in radians: a constant, a [start, end] pair blended linearly over the
    // rail's parameter, or a function of the rail parameter. On a closed rail use whole turns (multiples of 2*PI) so
    // the surface closes up
    twist? : number | [number, number] | ((u : number) => number);
    // scale of the profile: a constant, a [start, end] pair, or a function of the rail parameter
    scale? : number | [number, number] | ((u : number) => number);
    // maximum distance between the returned NURBS and the exact sweep (default 1e-3)
    tolerance? : number;
    maxIterations? : number;
}

export interface SweepResult {
    surface : NurbsSurfaceData;
    maxError : number;
    // the u direction follows the rail and the v direction the profile; these say whether each one closes on itself
    closedU : boolean;
    closedV : boolean;
    frames : RotationMinimizingFrames;
}

// `Sweep` moves a profile along a rail on rotation-minimising frames.

export class Sweep {

    // Sweep a profile along a rail.
    //
    // The profile is drawn in the XY plane around the origin. At each point of the rail, its X axis follows the
    // frame's normal and its Y axis the frame's binormal, after the optional twist and scale. The result is a
    // non-rational B-spline surface within `tolerance` of that exact sweep; u follows the rail and v the profile.

    public static surface( rail : NurbsCurveData, profile : NurbsCurveData, options? : SweepOptions ) : SweepResult {
        let o = options != null ? options : {};
        let frames = new RotationMinimizingFrames( rail, o );
        let twist = Sweep.paramFunction( o.twist, 0.0, rail );
        let scale = Sweep.paramFunction( o.scale, 1.0, rail );
        let tol = o.tolerance != null ? o.tolerance : 1e-3;

        // frames are expensive: cache them per rail parameter during one fit
        let cache = new Map<number, Frame>();
        let frameAt = (u : number) => {
            let f = cache.get( u );
            if (f == null) { f = frames.frameAt( u ); cache.set( u, f ); }
            return f;
        };
        let profileCache = new Map<number, Point>();
        let profileAt = (v : number) => {
            let p = profileCache.get( v );
            if (p == null) { p = Eval.rationalCurvePoint( profile, v ); profileCache.set( v, p ); }
            return p;
        };
        let f = (u : number, v : number) : Point => {
            let fr = frameAt( u ), p = profileAt( v );
            let a = twist( u ), s = scale( u );
            let x = s * (p[0] * Math.cos( a ) - p[1] * Math.sin( a ));
            let y = s * (p[0] * Math.sin( a ) + p[1] * Math.cos( a ));
            return Vec.add( fr.point, Vec.add( Vec.mul( x, fr.normal ), Vec.mul( y, fr.binormal ) ) );
        };

        let degU = Math.max( 3, rail.degree ), degV = Math.max( profile.degree, 1 );
        let knotsU = Sweep.knotsForDegree( rail, degU );
        let fit = Fit.approximateSurface( f, degU, degV, knotsU, profile.knots, tol, o.maxIterations );

        let pa = Eval.rationalCurvePoint( profile, profile.knots[0] ), pb = Eval.rationalCurvePoint( profile, profile.knots[profile.knots.length - 1] );
        return {
            surface : fit.surface,
            maxError : fit.maxError,
            closedU : frames.closed,
            closedV : Vec.dist( pa, pb ) < 1e-9 * (1 + Vec.norm( pa )),
            frames : frames
        };
    }

    // Sweep a circle along a rail: a pipe, optionally with a varying radius.

    public static pipe( rail : NurbsCurveData, radius : number | [number, number] | ((u : number) => number), options? : SweepOptions ) : SweepResult {
        let o : SweepOptions = Object.assign( {}, options != null ? options : {} );
        o.scale = radius;
        let circle = Make.arc( [0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], 1.0, 0.0, 2 * Math.PI );
        return Sweep.surface( rail, circle, o );
    }

    // a uniform knot vector of the given degree spanning the rail's domain, with as many spans as the rail
    private static knotsForDegree( rail : NurbsCurveData, degree : number ) : Array<number> {
        if (degree == rail.degree) return rail.knots.slice();
        let u0 = rail.knots[0], u1 = rail.knots[rail.knots.length - 1];
        let spans = Math.max( 1, Fit.spans( rail.knots ).length );
        let k : Array<number> = [];
        for (let i = 0; i <= degree; i++) k.push( u0 );
        for (let i = 1; i < spans; i++) k.push( u0 + (u1 - u0) * i / spans );
        for (let i = 0; i <= degree; i++) k.push( u1 );
        return k;
    }

    private static paramFunction( spec : number | [number, number] | ((u : number) => number), dflt : number, rail : NurbsCurveData ) : (u : number) => number {
        if (spec == null) return () => dflt;
        if (typeof spec == "number") { let c = spec; return () => c; }
        if (typeof spec == "function") return spec;
        let pair = spec as [number, number];
        let u0 = rail.knots[0], u1 = rail.knots[rail.knots.length - 1];
        return (u : number) => pair[0] + (pair[1] - pair[0]) * (u - u0) / (u1 - u0);
    }
}
