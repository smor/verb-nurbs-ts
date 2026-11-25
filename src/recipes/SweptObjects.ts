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
    tubeRadius? : number;
    // pipe radius, and how much it swells and thins along the knot (default 5 and 0.35)
    pipeRadius? : number;
    pipeSwell? : number;
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
    tolerance? : number;
    divsU? : number;
    divsV? : number;
}

export interface RibbonKnotParams {
    // (p, q) torus knot (default 3, 5), its size (default 34) and the torus tube it winds around (default 13)
    p? : number;
    q? : number;
    radius? : number;
    tubeRadius? : number;
    // ribbon width (default 9) and thickness; 0 makes a sheet with no thickness, for visual work (default 1.6)
    width? : number;
    thickness? : number;
    // full turns of the ribbon about the knot (default 2)
    turns? : number;
    tolerance? : number;
    divsU? : number;
    divsV? : number;
}

// Objects swept on rotation-minimising frames, all closed rails, meshed as genus 1 solids. Dimensions in millimetres.

export class SweptObjectsRecipe {

    // A pipe along a torus knot whose radius swells and thins as it goes.
    public static knotPipe( params? : KnotPipeParams ) : SweptObject {
        let o = params != null ? params : {};
        let p = o.p != null ? o.p : 2, q = o.q != null ? o.q : 3;
        let R = o.radius != null ? o.radius : 30, r = o.tubeRadius != null ? o.tubeRadius : 12;
        let pr = o.pipeRadius != null ? o.pipeRadius : 5, swell = o.pipeSwell != null ? o.pipeSwell : 0.35;
        let cps : Array<Point> = [];
        let n = 24 * Math.max( p, q );
        for (let i = 0; i < n; i++) {
            let t = 2 * Math.PI * i / n;
            let rr = R + r * Math.cos( q * t );
            cps.push( [rr * Math.cos( p * t ), rr * Math.sin( p * t ), -r * Math.sin( q * t )] );
        }
        let rail = Fit.periodicCurve( cps, 3 );
        let sweep = Sweep.pipe( rail, (u : number) => pr * (1 + swell * Math.sin( 2 * Math.PI * q * u )),
            { tolerance : o.tolerance != null ? o.tolerance : 0.02 } );
        let mesh = Shell.tube( sweep.surface, sweep.closedU, { divsU : o.divsU != null ? o.divsU : 400, divsV : o.divsV != null ? o.divsV : 40 } );
        return SweptObjectsRecipe.finish( rail, null, sweep, mesh );
    }

    // A wavy ring with a rounded-square section that turns around the ring as it goes.
    public static twistedRing( params? : TwistedRingParams ) : SweptObject {
        let o = params != null ? params : {};
        let R = o.radius != null ? o.radius : 32, wave = o.wave != null ? o.wave : 4, waves = o.waves != null ? o.waves : 3;
        let w = o.width != null ? o.width : 6, h = o.height != null ? o.height : 3, e = o.exponent != null ? o.exponent : 4;
        let turns = o.turns != null ? o.turns : 1;
        let railCps : Array<Point> = [];
        for (let i = 0; i < 48; i++) {
            let t = 2 * Math.PI * i / 48;
            railCps.push( [R * Math.cos( t ), R * Math.sin( t ), wave * Math.sin( waves * t )] );
        }
        let rail = Fit.periodicCurve( railCps, 3 );
        let profCps : Array<Point> = [];
        for (let i = 0; i < 32; i++) {
            let t = 2 * Math.PI * i / 32;
            let c = Math.cos( t ), s = Math.sin( t );
            profCps.push( [w * Math.sign( c ) * Math.pow( Math.abs( c ), 2 / e ), h * Math.sign( s ) * Math.pow( Math.abs( s ), 2 / e ), 0.0] );
        }
        let profile = Fit.periodicCurve( profCps, 3 );
        let sweep = Sweep.surface( rail, profile, { twist : [0, 2 * Math.PI * turns], tolerance : o.tolerance != null ? o.tolerance : 0.01 } );
        let mesh = Shell.tube( sweep.surface, sweep.closedU, { divsU : o.divsU != null ? o.divsU : 360, divsV : o.divsV != null ? o.divsV : 64 } );
        return SweptObjectsRecipe.finish( rail, profile, sweep, mesh );
    }

    // A ribbon swept along a torus knot, twisting as it goes. With thickness 0 it is a bare sheet: a visual object
    // that encloses nothing. With a thickness it is a thin rounded band, a genus 1 solid that can be made.
    public static ribbonKnot( params? : RibbonKnotParams ) : SweptObject {
        let o = params != null ? params : {};
        let p = o.p != null ? o.p : 3, q = o.q != null ? o.q : 5;
        let R = o.radius != null ? o.radius : 34, r = o.tubeRadius != null ? o.tubeRadius : 13;
        let w = (o.width != null ? o.width : 9) / 2, th = o.thickness != null ? o.thickness : 1.6;
        let turns = o.turns != null ? o.turns : 2;
        let cps : Array<Point> = [];
        let n = 24 * Math.max( p, q );
        for (let i = 0; i < n; i++) {
            let t = 2 * Math.PI * i / n;
            let rr = R + r * Math.cos( q * t );
            cps.push( [rr * Math.cos( p * t ), rr * Math.sin( p * t ), -r * Math.sin( q * t )] );
        }
        let rail = Fit.periodicCurve( cps, 3 );
        let tol = o.tolerance != null ? o.tolerance : 0.02;
        let divsU = o.divsU != null ? o.divsU : 600;
        let profile : NurbsCurveData, mesh : TriMesh, sweep : SweepResult;
        if (th <= 0) {
            profile = Fit.curve( [[-w, 0, 0], [0, 0, 0], [w, 0, 0]], 1 );
            sweep = Sweep.surface( rail, profile, { twist : [0, 2 * Math.PI * turns], tolerance : tol } );
            mesh = Shell.sheet( sweep.surface, [sweep.closedU, false], { divsU : divsU, divsV : o.divsV != null ? o.divsV : 8 } );
        } else {
            let profCps : Array<Point> = [];
            let h = th / 2, e = 6;
            for (let i = 0; i < 40; i++) {
                let t = 2 * Math.PI * i / 40;
                let c = Math.cos( t ), s = Math.sin( t );
                profCps.push( [w * Math.sign( c ) * Math.pow( Math.abs( c ), 2 / e ), h * Math.sign( s ) * Math.pow( Math.abs( s ), 2 / e ), 0.0] );
            }
            profile = Fit.periodicCurve( profCps, 3 );
            sweep = Sweep.surface( rail, profile, { twist : [0, 2 * Math.PI * turns], tolerance : tol } );
            mesh = Shell.tube( sweep.surface, sweep.closedU, { divsU : divsU, divsV : o.divsV != null ? o.divsV : 48 } );
        }
        return SweptObjectsRecipe.finish( rail, profile, sweep, mesh );
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
