import { NurbsCurveData, Point } from "../core/Data.js";
import { Fit } from "../eval/Fit.js";
import { Sweep, SweepResult } from "../eval/Sweep.js";
import { Shell } from "../solid/Shell.js";
import { ManifoldReport, TriMesh } from "../solid/TriMesh.js";

export interface SweptObject {
    rail : NurbsCurveData;
    profile : NurbsCurveData | null;
    sweep : SweepResult;
    mesh : TriMesh;
    report : {
        sweepMaxError : number;
        closureAngle : number;
        manifold : ManifoldReport;
        volume : number;
    };
}

export interface KnotPipeParams {
    // (p, q) torus knot; (2, 3) is the trefoil (default)
    p? : number;
    q? : number;
    // size of the knot (default 30) and of the torus tube it winds around (default 12)
    radius? : number;
    // (held to `MAX_TUBE` times the radius, so the knot never passes through its own axis)
    tubeRadius? : number;
    // pipe radius, and how much it swells and thins along the knot (default 5 and 0.35)
    pipeRadius? : number;
    pipeSwell? : number;
    // narrow the section smoothly where it would reach past the centre of a tight bend and fold the surface
    // (default true; see `SweepOptions.noFold`)
    noFold? : boolean;
    tolerance? : number;
    divsU? : number;
    divsV? : number;
}

export interface TwistedRingParams {
    // ring radius (default 32) and the height of its waves (default 4, with 3 waves)
    radius? : number;
    wave? : number;
    waves? : number;
    // superellipse profile: half width, half height and exponent (4 is a rounded square) (default 6, 3, 4)
    width? : number;
    height? : number;
    exponent? : number;
    // full turns of the profile around the ring (default 1)
    turns? : number;
    // narrow the section smoothly where it would reach past the centre of a tight bend and fold the surface
    // (default true; see `SweepOptions.noFold`)
    noFold? : boolean;
    tolerance? : number;
    divsU? : number;
    divsV? : number;
}

export interface RibbonKnotParams {
    // (p, q) torus knot (default 3, 5), its size (default 34) and the torus tube it winds around (default 13)
    p? : number;
    q? : number;
    radius? : number;
    // (held to `MAX_TUBE` times the radius, so the knot never passes through its own axis)
    tubeRadius? : number;
    // ribbon width (default 9) and thickness; 0 makes a sheet with no thickness, for visual work (default 1.6)
    width? : number;
    thickness? : number;
    // full turns of the ribbon about the knot (default 2)
    turns? : number;
    // narrow the section smoothly where it would reach past the centre of a tight bend and fold the surface
    // (default true; see `SweepOptions.noFold`)
    noFold? : boolean;
    tolerance? : number;
    divsU? : number;
    divsV? : number;
}

// Objects swept on rotation-minimising frames, all closed rails, meshed as genus 1 solids. Dimensions in millimetres.

export class SweptObjectsRecipe {

    // A pipe along a torus knot whose radius swells and thins as it goes.
    public static knotPipe( params? : KnotPipeParams ) : SweptObject {
        const o = params != null ? params : {};
        const [p, q] = SweptObjectsRecipe.knotIndices( o.p != null ? o.p : 2, o.q != null ? o.q : 3 );
        const R = o.radius != null ? o.radius : 30, r = Math.min( o.tubeRadius != null ? o.tubeRadius : 12, SweptObjectsRecipe.MAX_TUBE * R );
        const pr = o.pipeRadius != null ? o.pipeRadius : 5, swell = o.pipeSwell != null ? o.pipeSwell : 0.35;
        const cps : Array<Point> = [];
        const n = 24 * Math.max( p, q );
        for (let i = 0; i < n; i++) {
            const t = 2 * Math.PI * i / n;
            const rr = R + r * Math.cos( q * t );
            cps.push( [rr * Math.cos( p * t ), rr * Math.sin( p * t ), -r * Math.sin( q * t )] );
        }
        const rail = Fit.periodicCurve( cps, 3 );
        const sweep = Sweep.pipe( rail, (u : number) => pr * (1 + swell * Math.sin( 2 * Math.PI * q * u )),
            { tolerance : o.tolerance != null ? o.tolerance : 0.02, noFold : o.noFold !== false } );
        const mesh = Shell.tube( sweep.surface, sweep.closedU, { divsU : o.divsU != null ? o.divsU : 400, divsV : o.divsV != null ? o.divsV : 40 } );
        return SweptObjectsRecipe.finish( rail, null, sweep, mesh );
    }

    // A wavy ring with a rounded-square section that turns around the ring as it goes.
    public static twistedRing( params? : TwistedRingParams ) : SweptObject {
        const o = params != null ? params : {};
        const R = o.radius != null ? o.radius : 32, wave = o.wave != null ? o.wave : 4, waves = o.waves != null ? o.waves : 3;
        const w = o.width != null ? o.width : 6, h = o.height != null ? o.height : 3, e = o.exponent != null ? o.exponent : 4;
        const turns = o.turns != null ? o.turns : 1;
        const railCps : Array<Point> = [];
        for (let i = 0; i < 48; i++) {
            const t = 2 * Math.PI * i / 48;
            railCps.push( [R * Math.cos( t ), R * Math.sin( t ), wave * Math.sin( waves * t )] );
        }
        const rail = Fit.periodicCurve( railCps, 3 );
        const profCps : Array<Point> = [];
        for (let i = 0; i < 32; i++) {
            const t = 2 * Math.PI * i / 32;
            const c = Math.cos( t ), s = Math.sin( t );
            profCps.push( [w * Math.sign( c ) * Math.pow( Math.abs( c ), 2 / e ), h * Math.sign( s ) * Math.pow( Math.abs( s ), 2 / e ), 0.0] );
        }
        const profile = Fit.periodicCurve( profCps, 3 );
        const sweep = Sweep.surface( rail, profile, { twist : [0, 2 * Math.PI * turns], tolerance : o.tolerance != null ? o.tolerance : 0.01, noFold : o.noFold !== false } );
        const mesh = Shell.tube( sweep.surface, sweep.closedU, { divsU : o.divsU != null ? o.divsU : 360, divsV : o.divsV != null ? o.divsV : 64 } );
        return SweptObjectsRecipe.finish( rail, profile, sweep, mesh );
    }

    // A ribbon swept along a torus knot, twisting as it goes. With thickness 0 it is a bare sheet: a visual object
    // that encloses nothing. With a thickness it is a thin rounded band, a genus 1 solid that can be made.
    public static ribbonKnot( params? : RibbonKnotParams ) : SweptObject {
        const o = params != null ? params : {};
        const [p, q] = SweptObjectsRecipe.knotIndices( o.p != null ? o.p : 3, o.q != null ? o.q : 5 );
        const R = o.radius != null ? o.radius : 34, r = Math.min( o.tubeRadius != null ? o.tubeRadius : 13, SweptObjectsRecipe.MAX_TUBE * R );
        const w = (o.width != null ? o.width : 9) / 2, th = o.thickness != null ? o.thickness : 1.6;
        const turns = o.turns != null ? o.turns : 2;
        const cps : Array<Point> = [];
        const n = 24 * Math.max( p, q );
        for (let i = 0; i < n; i++) {
            const t = 2 * Math.PI * i / n;
            const rr = R + r * Math.cos( q * t );
            cps.push( [rr * Math.cos( p * t ), rr * Math.sin( p * t ), -r * Math.sin( q * t )] );
        }
        const rail = Fit.periodicCurve( cps, 3 );
        const tol = o.tolerance != null ? o.tolerance : 0.02;
        const divsU = o.divsU != null ? o.divsU : 600;
        let profile : NurbsCurveData, mesh : TriMesh, sweep : SweepResult;
        if (th <= 0) {
            profile = Fit.curve( [[-w, 0, 0], [0, 0, 0], [w, 0, 0]], 1 );
            sweep = Sweep.surface( rail, profile, { twist : [0, 2 * Math.PI * turns], tolerance : tol } );
            mesh = Shell.sheet( sweep.surface, [sweep.closedU, false], { divsU : divsU, divsV : o.divsV != null ? o.divsV : 8 } );
        } else {
            const profCps : Array<Point> = [];
            const h = th / 2, e = 6;
            for (let i = 0; i < 40; i++) {
                const t = 2 * Math.PI * i / 40;
                const c = Math.cos( t ), s = Math.sin( t );
                profCps.push( [w * Math.sign( c ) * Math.pow( Math.abs( c ), 2 / e ), h * Math.sign( s ) * Math.pow( Math.abs( s ), 2 / e ), 0.0] );
            }
            profile = Fit.periodicCurve( profCps, 3 );
            sweep = Sweep.surface( rail, profile, { twist : [0, 2 * Math.PI * turns], tolerance : tol, noFold : o.noFold !== false } );
            mesh = Shell.tube( sweep.surface, sweep.closedU, { divsU : divsU, divsV : o.divsV != null ? o.divsV : 48 } );
        }
        return SweptObjectsRecipe.finish( rail, profile, sweep, mesh );
    }

    // A torus knot whose tube is as wide as its radius passes through its own axis, and every strand that does so
    // meets the others there: the rail crosses itself, and no pipe along it can be a solid. The tube is held to this
    // share of the radius.
    public static MAX_TUBE = 0.8;

    // A (p, q) torus curve with a common factor g runs g times round the same (p/g, q/g) knot: sweeping it would
    // lay g copies of the pipe on top of each other. Take the curve once.
    private static knotIndices( p : number, q : number ) : [number, number] {
        const gcd = (a : number, b : number) : number => b == 0 ? a : gcd( b, a % b );
        const g = Math.max( 1, gcd( Math.abs( Math.round( p ) ), Math.abs( Math.round( q ) ) ) );
        return [Math.round( p ) / g, Math.round( q ) / g];
    }

    private static finish( rail : NurbsCurveData, profile : NurbsCurveData | null, sweep : SweepResult, mesh : TriMesh ) : SweptObject {
        return {
            rail : rail, profile : profile, sweep : sweep, mesh : mesh,
            report : {
                sweepMaxError : sweep.maxError,
                closureAngle : sweep.frames.closureAngle,
                manifold : mesh.checkClosedManifold(),
                volume : mesh.signedVolume()
            }
        };
    }
}
