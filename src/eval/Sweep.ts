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
        const spans = Fit.spans( rail.knots ).length;
        const n = options != null && options.samples != null ? options.samples : Math.max( 512, 64 * spans );

        const t0 = this.tangentAt( this.u0 ), t1 = this.tangentAt( this.u1 );
        const p0 = Eval.rationalCurvePoint( rail, this.u0 ), p1 = Eval.rationalCurvePoint( rail, this.u1 );
        const size = Vec.norm( Vec.sub( Eval.rationalCurvePoint( rail, (this.u0 + this.u1) / 2 ), p0 ) ) + 1e-12;
        this.closed = options != null && options.closed != null ? options.closed
            : Vec.dist( p0, p1 ) < 1e-7 * size && Vec.dot( t0, t1 ) > 1 - 1e-6;

        let r : Vector;
        if (options != null && options.initialNormal != null) r = options.initialNormal;
        else r = Math.abs( t0[2] ) < 0.9 ? [0.0, 0.0, 1.0] : [1.0, 0.0, 0.0];
        r = Vec.sub( r, Vec.mul( Vec.dot( r, t0 ), t0 ) );
        if (Vec.norm( r ) < 1e-10) throw "RotationMinimizingFrames: the initial normal is parallel to the tangent";
        r = Vec.normalized( r );

        for (let i = 0; i <= n; i++) {
            const u = this.u0 + (this.u1 - this.u0) * i / n;
            const x = Eval.rationalCurvePoint( rail, u ), t = this.tangentAt( u );
            if (i > 0) r = RotationMinimizingFrames.reflect( this.pts[i-1], this.tans[i-1], this.nors[i-1], x, t );
            this.us.push( u ); this.pts.push( x ); this.tans.push( t ); this.nors.push( r );
        }

        if (this.closed) {
            const tEnd = this.tans[n], rEnd = this.nors[n], rStart = this.nors[0];
            this.closureAngle = Math.atan2( Vec.dot( Vec.cross( rEnd, rStart ), tEnd ), Vec.dot( rEnd, rStart ) );
        }
    }

    // The frame at parameter u.
    public frameAt( u : number ) : Frame {
        u = Math.min( Math.max( u, this.u0 ), this.u1 );
        const n = this.us.length - 1;
        const i = Math.min( Math.floor( (u - this.u0) / (this.u1 - this.u0) * n ), n );
        const x = Eval.rationalCurvePoint( this.rail, u ), t = this.tangentAt( u );
        let r = u == this.us[i] ? this.nors[i] : RotationMinimizingFrames.reflect( this.pts[i], this.tans[i], this.nors[i], x, t );
        if (this.closed && this.closureAngle != 0.0) {
            const a = this.closureAngle * (u - this.u0) / (this.u1 - this.u0);
            r = Vec.add( Vec.mul( Math.cos( a ), r ), Vec.mul( Math.sin( a ), Vec.cross( t, r ) ) );
        }
        r = Vec.normalized( Vec.sub( r, Vec.mul( Vec.dot( r, t ), t ) ) );
        return { u : u, point : x, tangent : t, normal : r, binormal : Vec.cross( t, r ) };
    }

    // `count` frames at evenly spaced parameters, including both ends.
    public frames( count : number ) : Array<Frame> {
        const out : Array<Frame> = [];
        for (let i = 0; i < count; i++) out.push( this.frameAt( this.u0 + (this.u1 - this.u0) * i / (count - 1) ) );
        return out;
    }

    private tangentAt( u : number ) : Vector {
        let d = Eval.rationalCurveDerivatives( this.rail, u, 1 )[1];
        if (Vec.norm( d ) < 1e-12) {
            const du = 1e-6 * (this.u1 - this.u0);
            d = Eval.rationalCurveDerivatives( this.rail, u + du <= this.u1 ? u + du : u - du, 1 )[1];
        }
        return Vec.normalized( d );
    }

    // one double reflection step: carry normal r at (x0, t0) to (x1, t1)
    private static reflect( x0 : Point, t0 : Vector, r0 : Vector, x1 : Point, t1 : Vector ) : Vector {
        const v1 = Vec.sub( x1, x0 );
        const c1 = Vec.dot( v1, v1 );
        let rL = r0, tL = t0;
        if (c1 > 1e-24) {
            rL = Vec.sub( r0, Vec.mul( 2 / c1 * Vec.dot( v1, r0 ), v1 ) );
            tL = Vec.sub( t0, Vec.mul( 2 / c1 * Vec.dot( v1, t0 ), v1 ) );
        }
        const v2 = Vec.sub( t1, tL );
        const c2 = Vec.dot( v2, v2 );
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
    // keep the surface from folding on the inside of tight bends. A section reaching further towards the centre of a
    // bend than the bend's radius turns the surface inside out there, and the solid crosses itself. With `noFold`
    // set (a fraction of that radius, 0.9 when given as true), the section is narrowed smoothly where, and only where,
    // it would reach further; everywhere else the sweep is unchanged. `SweepResult.narrowed` says how much
    noFold? : boolean | number;
}

// How far a sweep's section reaches into its rail's bends: the largest value, over the rail, of the bend's curvature
// times the section's reach towards its centre. Below 1 the sweep cannot fold; at 1 or above it folds.
export interface FoldReport {
    // the largest ratio, and the rail parameter and point where it occurs
    ratio : number;
    u : number;
    point : Point;
}

export interface SweepResult {
    surface : NurbsSurfaceData;
    maxError : number;
    // the u direction follows the rail and the v direction the profile; these say whether each one closes on itself
    closedU : boolean;
    closedV : boolean;
    frames : RotationMinimizingFrames;
    // the fold ratio of the swept surface as built (see `FoldReport`)
    fold : FoldReport;
    // with `noFold`: the smallest factor the section was narrowed by (1 when it never needed to be), and where
    narrowed? : { scale : number, u : number, point : Point };
}

// `Sweep` moves a profile along a rail on rotation-minimising frames.

export class Sweep {

    // Sweep a profile along a rail.
    //
    // The profile is drawn in the XY plane around the origin. At each point of the rail, its X axis follows the
    // frame's normal and its Y axis the frame's binormal, after the optional twist and scale. The result is a
    // non-rational B-spline surface within `tolerance` of that exact sweep; u follows the rail and v the profile.

    public static surface( rail : NurbsCurveData, profile : NurbsCurveData, options? : SweepOptions ) : SweepResult {
        const o = options != null ? options : {};
        const frames = new RotationMinimizingFrames( rail, o );
        const twist = Sweep.paramFunction( o.twist, 0.0, rail );
        const userScale = Sweep.paramFunction( o.scale, 1.0, rail );
        const tol = o.tolerance != null ? o.tolerance : 1e-3;
        let scale = userScale;
        let narrowed : SweepResult["narrowed"];
        if (o.noFold != null && o.noFold !== false) {
            const limit = o.noFold === true ? 0.9 : o.noFold;
            const n = Sweep.FOLD_SAMPLES;
            const u0 = rail.knots[0], u1 = rail.knots[rail.knots.length - 1];
            const reach = Sweep.reach( rail, profile, frames, twist, userScale, n );
            const fold = reach.map( r => Math.min( 1, r > limit ? limit / r : 1 ) );
            // two passes: the parts of the rail that are near each other along it are left to the fold test, and
            // how near is set by the section's size, which the first pass may have narrowed
            let smooth = Sweep.smoothFactor( fold, frames.closed );
            for (let pass = 0; pass < 2; pass++) {
                const clear = Sweep.clearance( rail, profile, frames, twist, (u : number) => userScale( u ), n, limit,
                                               smooth.map( x => x ) );
                const need = fold.map( (x, i) => Math.min( x, clear[i] ) );
                smooth = Sweep.smoothFactor( need, frames.closed );
            }
            let worst = 0;
            for (let i = 1; i < n; i++) if (smooth[i] < smooth[worst]) worst = i;
            const sm = smooth;
            const factor = (u : number) => {
                const x = (u - u0) / (u1 - u0) * (frames.closed ? n : n - 1);
                const i = Math.floor( x ), t = x - i;
                const a = frames.closed ? sm[((i % n) + n) % n] : sm[Math.min( i, n - 1 )];
                const b = frames.closed ? sm[(((i + 1) % n) + n) % n] : sm[Math.min( i + 1, n - 1 )];
                const h = t * t * (3 - 2 * t);
                return a + (b - a) * h;
            };
            const uw = u0 + (u1 - u0) * worst / (frames.closed ? n : n - 1);
            narrowed = { scale : smooth[worst], u : uw, point : Eval.rationalCurvePoint( rail, uw ) };
            if (smooth[worst] < 1) scale = (u : number) => userScale( u ) * factor( u );
        }

        // frames are expensive: cache them per rail parameter during one fit
        const cache = new Map<number, Frame>();
        const frameAt = (u : number) => {
            let f = cache.get( u );
            if (f == null) { f = frames.frameAt( u ); cache.set( u, f ); }
            return f;
        };
        const profileCache = new Map<number, Point>();
        const profileAt = (v : number) => {
            let p = profileCache.get( v );
            if (p == null) { p = Eval.rationalCurvePoint( profile, v ); profileCache.set( v, p ); }
            return p;
        };
        const f = (u : number, v : number) : Point => {
            const fr = frameAt( u ), p = profileAt( v );
            const a = twist( u ), s = scale( u );
            const x = s * (p[0] * Math.cos( a ) - p[1] * Math.sin( a ));
            const y = s * (p[0] * Math.sin( a ) + p[1] * Math.cos( a ));
            return Vec.add( fr.point, Vec.add( Vec.mul( x, fr.normal ), Vec.mul( y, fr.binormal ) ) );
        };

        const pa = Eval.rationalCurvePoint( profile, profile.knots[0] ), pb = Eval.rationalCurvePoint( profile, profile.knots[profile.knots.length - 1] );
        const closedV = Vec.dist( pa, pb ) < 1e-9 * (1 + Vec.norm( pa ));

        const degU = Math.max( 3, rail.degree );
        let degV = Math.max( profile.degree, 1 );
        const knotsU = Sweep.knotsForDegree( rail, degU );
        let knotsV = profile.knots;
        if (closedV) {
            // a closed profile is fitted periodically, cubic, so the surface is as smooth across its seam as elsewhere;
            // start from the profile's spans, split until there are at least 8
            degV = Math.max( 3, profile.degree );
            let b = Fit.spans( profile.knots ).map( s => s[0] ).concat( [profile.knots[profile.knots.length - 1]] );
            while (b.length - 1 < 8) b = Fit.insertKnots( b, Fit.spans( b ).map( s => (s[0] + s[1]) / 2 ) );
            knotsV = b;
        }
        const fit = Fit.approximateSurface( f, degU, degV, knotsU, knotsV, tol, o.maxIterations, closedV );

        const reach = Sweep.reach( rail, profile, frames, twist, scale, Sweep.FOLD_SAMPLES );
        let k = 0;
        for (let i = 1; i < reach.length; i++) if (reach[i] > reach[k]) k = i;
        const u0 = rail.knots[0], u1 = rail.knots[rail.knots.length - 1];
        const uk = u0 + (u1 - u0) * k / (frames.closed ? reach.length : reach.length - 1);

        return {
            surface : fit.surface,
            maxError : fit.maxError,
            closedU : frames.closed,
            closedV : closedV,
            frames : frames,
            fold : { ratio : reach[k], u : uk, point : Eval.rationalCurvePoint( rail, uk ) },
            narrowed : narrowed
        };
    }

    // How far a sweep reaches into its rail's bends (see `FoldReport`), without building it.
    public static fold( rail : NurbsCurveData, profile : NurbsCurveData, options? : SweepOptions ) : FoldReport {
        const o = options != null ? options : {};
        const frames = new RotationMinimizingFrames( rail, o );
        const reach = Sweep.reach( rail, profile, frames, Sweep.paramFunction( o.twist, 0.0, rail ), Sweep.paramFunction( o.scale, 1.0, rail ), Sweep.FOLD_SAMPLES );
        let k = 0;
        for (let i = 1; i < reach.length; i++) if (reach[i] > reach[k]) k = i;
        const u0 = rail.knots[0], u1 = rail.knots[rail.knots.length - 1];
        const uk = u0 + (u1 - u0) * k / (frames.closed ? reach.length : reach.length - 1);
        return { ratio : reach[k], u : uk, point : Eval.rationalCurvePoint( rail, uk ) };
    }

    private static FOLD_SAMPLES = 720;

    // The factor each sample needs, eroded then blurred over the same width, so the result is smooth and still at or
    // below every sample's need.
    private static smoothFactor( need : Array<number>, closed : boolean ) : Array<number> {
        const n = need.length, w = Math.max( 2, Math.round( n / 40 ) );
        const at = (a : Array<number>, i : number) => closed ? a[((i % n) + n) % n] : a[Math.min( Math.max( i, 0 ), n - 1 )];
        const eroded = need.map( (_, i) => { let m = 1; for (let k = -2 * w; k <= 2 * w; k++) m = Math.min( m, at( need, i + k ) ); return m; } );
        return eroded.map( (_, i) => {
            let sum = 0, wsum = 0;
            for (let k = -2 * w; k <= 2 * w; k++) { const g = Math.exp( -0.5 * (k / w) * (k / w) ); sum += g * at( eroded, i + k ); wsum += g; }
            return Math.min( 1, sum / wsum );
        } );
    }

    // For each of `n` samples of the rail, the factor its section must be narrowed by so that it keeps clear of the
    // sections of the parts of the sweep that come back near it (strands of a knot, turns of a coil). Two samples
    // further apart along the rail than half a turn of their sections' size are compared: the section of each reaches
    // some way towards the other (over the profile's control points, so never less than the surface does), and the
    // two reaches together must stay within `limit` of the distance between the samples. Samples nearer along the rail
    // are the fold test's business. `current` is the factor so far, which sets the sections' size.
    private static clearance( rail : NurbsCurveData, profile : NurbsCurveData, frames : RotationMinimizingFrames,
                              twist : (u : number) => number, scale : (u : number) => number, n : number, limit : number,
                              current : Array<number> ) : Array<number> {
        const u0 = rail.knots[0], u1 = rail.knots[rail.knots.length - 1];
        const prof = profile.controlPoints.map( p => { const w = p[p.length - 1]; return [p[0] / w, p[1] / w]; } );
        const P : Array<Point> = [], S : Array<Array<Point>> = [], R : Array<number> = [], arc : Array<number> = [0];
        for (let i = 0; i < n; i++) {
            const u = u0 + (u1 - u0) * i / (frames.closed ? n : n - 1);
            const fr = frames.frameAt( u ), a = twist( u ), s = scale( u ), c = Math.cos( a ), sn = Math.sin( a );
            const sec = prof.map( p => Vec.add( Vec.mul( s * (p[0] * c - p[1] * sn), fr.normal ), Vec.mul( s * (p[0] * sn + p[1] * c), fr.binormal ) ) );
            P.push( fr.point ); S.push( sec );
            R.push( Math.max( ...sec.map( q => Vec.norm( q ) ) ) );
            if (i > 0) arc.push( arc[i - 1] + Vec.dist( P[i - 1], P[i] ) );
        }
        const length = arc[n - 1] + (frames.closed ? Vec.dist( P[n - 1], P[0] ) : 0);
        const reachTo = (i : number, d : Point) => { let m = 0; for (const q of S[i]) m = Math.max( m, Vec.dot( q, d ) ); return m; };
        const out = new Array<number>( n ).fill( 1 );
        for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
            const ri = R[i] * current[i], rj = R[j] * current[j];
            let along = arc[j] - arc[i];
            if (frames.closed) along = Math.min( along, length - along );
            if (along < Math.PI * Math.max( ri, rj )) continue;
            const v = Vec.sub( P[j], P[i] ), d = Vec.norm( v );
            if (d >= R[i] + R[j]) continue;
            if (d < 1e-12) { out[i] = out[j] = 0; continue; }
            const dir = Vec.mul( 1 / d, v );
            const both = reachTo( i, dir ) + reachTo( j, Vec.neg( dir ) );
            if (both > limit * d) { const f = limit * d / both; out[i] = Math.min( out[i], f ); out[j] = Math.min( out[j], f ); }
        }
        return out;
    }

    // At `n` samples of the rail: curvature times the section's furthest reach towards the centre of the bend. The
    // surface's derivative along the rail is the rail's speed times (1 - that product) in the tangent direction plus
    // a part across it, so it folds exactly where the product reaches 1. The reach is taken over the profile's control
    // points, which bound the curve (convex hull), so the measure never underestimates.
    private static reach( rail : NurbsCurveData, profile : NurbsCurveData, frames : RotationMinimizingFrames,
                          twist : (u : number) => number, scale : (u : number) => number, n : number ) : Array<number> {
        const u0 = rail.knots[0], u1 = rail.knots[rail.knots.length - 1];
        const pts = profile.controlPoints.map( p => { const w = p[p.length - 1]; return [p[0] / w, p[1] / w]; } );
        const out : Array<number> = [];
        for (let i = 0; i < n; i++) {
            const u = u0 + (u1 - u0) * i / (frames.closed ? n : n - 1);
            const d = Eval.rationalCurveDerivatives( rail, u, 2 );
            const sp2 = Vec.dot( d[1], d[1] );
            if (sp2 < 1e-24) { out.push( 0 ); continue; }
            const t = Vec.mul( 1 / Math.sqrt( sp2 ), d[1] );
            const kv = Vec.mul( 1 / sp2, Vec.sub( d[2], Vec.mul( Vec.dot( d[2], t ), t ) ) );
            const fr = frames.frameAt( u );
            const kn = Vec.dot( kv, fr.normal ), kb = Vec.dot( kv, fr.binormal );
            const a = twist( u ), s = scale( u ), c = Math.cos( a ), sn = Math.sin( a );
            let m = 0;
            for (const p of pts) {
                const x = s * (p[0] * c - p[1] * sn), y = s * (p[0] * sn + p[1] * c);
                m = Math.max( m, x * kn + y * kb );
            }
            out.push( m );
        }
        return out;
    }

    // Sweep a circle along a rail: a pipe, optionally with a varying radius.

    public static pipe( rail : NurbsCurveData, radius : number | [number, number] | ((u : number) => number), options? : SweepOptions ) : SweepResult {
        const o : SweepOptions = Object.assign( {}, options != null ? options : {} );
        o.scale = radius;
        const circle = Make.arc( [0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], 1.0, 0.0, 2 * Math.PI );
        return Sweep.surface( rail, circle, o );
    }

    // a uniform knot vector of the given degree spanning the rail's domain, with as many spans as the rail
    private static knotsForDegree( rail : NurbsCurveData, degree : number ) : Array<number> {
        if (degree == rail.degree) return rail.knots.slice();
        const u0 = rail.knots[0], u1 = rail.knots[rail.knots.length - 1];
        const spans = Math.max( 1, Fit.spans( rail.knots ).length );
        const k : Array<number> = [];
        for (let i = 0; i <= degree; i++) k.push( u0 );
        for (let i = 1; i < spans; i++) k.push( u0 + (u1 - u0) * i / spans );
        for (let i = 0; i <= degree; i++) k.push( u1 );
        return k;
    }

    private static paramFunction( spec : number | [number, number] | ((u : number) => number) | undefined, dflt : number, rail : NurbsCurveData ) : (u : number) => number {
        if (spec == null) return () => dflt;
        if (typeof spec == "number") { const c = spec; return () => c; }
        if (typeof spec == "function") return spec;
        const pair = spec as [number, number];
        const u0 = rail.knots[0], u1 = rail.knots[rail.knots.length - 1];
        return (u : number) => pair[0] + (pair[1] - pair[0]) * (u - u0) / (u1 - u0);
    }
}
