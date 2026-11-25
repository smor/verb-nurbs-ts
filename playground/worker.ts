// Builds models off the main thread so the sliders stay responsive.
import { BooleanObjectsRecipe, FreeformVesselRecipe, Makeable, SweptObjectsRecipe } from "../src/index.js";
import type { TriMesh } from "../src/index.js";

export type ModelId = "vessel" | "knot" | "ring" | "mug" | "pierced" | "ribbon";

export interface BuildRequest { id : number; model : ModelId; params : Record<string, number>; fine : boolean; make : boolean; machine : string }

function vessel( p : Record<string, number>, fine : boolean ) {
    let base = FreeformVesselRecipe.DEFAULT_HARMONICS;
    let harmonics = base.map( h => ({
        frequency : h.frequency,
        amplitude : [h.amplitude[0] * p.folds, h.amplitude[1] * p.folds] as [number, number],
        phase : [h.phase[0], h.phase[0] + (h.phase[1] - h.phase[0]) * p.drift + p.turn] as [number, number]
    }) );
    let v = FreeformVesselRecipe.build( {
        height : p.height, radius : [p.baseRadius, p.rimRadius], belly : p.belly, lean : [p.lean, -p.lean / 2],
        harmonics, wallThickness : p.wall, baseThickness : p.floor,
        offsetTolerance : fine ? 0.02 : 0.08, divsU : fine ? 64 : 28, divsV : fine ? 256 : 112
    } );
    return { mesh : v.mesh, report : v.report, error : v.report.offsetMaxError, ok : v.report.innerRingsSimple };
}

function folds( k : number ) {
    return FreeformVesselRecipe.DEFAULT_HARMONICS.map( h => ({
        frequency : h.frequency, amplitude : [h.amplitude[0] * k, h.amplitude[1] * k] as [number, number], phase : h.phase
    }) );
}

function mug( p : Record<string, number>, fine : boolean ) {
    let o = BooleanObjectsRecipe.mug( {
        height : p.height, radius : [p.baseRadius, p.rimRadius], harmonics : folds( p.folds ), wallThickness : p.wall,
        handleRadius : p.handle, handleReach : p.reach, handleHeights : [p.low, p.high], fillet : p.fillet,
        offsetTolerance : fine ? 0.02 : 0.08, divsU : fine ? 48 : 24, divsV : fine ? 192 : 96
    } );
    let r = o.result.report;
    return { mesh : o.result.mesh, report : r, error : r.maxCurveError, ok : r.manifold.closedManifold };
}

function pierced( p : Record<string, number>, fine : boolean ) {
    let o = BooleanObjectsRecipe.pierced( {
        height : p.height, radius : [p.baseRadius, p.rimRadius], harmonics : folds( p.folds ), wallThickness : p.wall,
        holes : p.holes, rows : p.rows, holeRadius : p.hole, notches : p.notches, notchRadius : p.notch, fillet : p.fillet,
        offsetTolerance : fine ? 0.02 : 0.08, divsU : fine ? 48 : 24, divsV : fine ? 192 : 96
    } );
    let r = o.result.report;
    return { mesh : o.result.mesh, report : r, error : r.maxCurveError, ok : r.manifold.closedManifold };
}

function ribbon( p : Record<string, number>, fine : boolean ) {
    let o = SweptObjectsRecipe.ribbonKnot( {
        p : p.p, q : p.q, radius : p.radius, tubeRadius : p.tube, width : p.width, thickness : p.thickness, turns : p.turns,
        tolerance : fine ? 0.02 : 0.1, divsU : fine ? 720 : 300, divsV : fine ? 40 : 20
    } );
    return { mesh : o.mesh, report : o.report, error : o.report.sweepMaxError, ok : true };
}

function knot( p : Record<string, number>, fine : boolean ) {
    let o = SweptObjectsRecipe.knotPipe( {
        p : p.p, q : p.q, radius : p.radius, tubeRadius : p.tube, pipeRadius : p.pipe, pipeSwell : p.swell,
        tolerance : fine ? 0.02 : 0.1, divsU : fine ? 480 : 200, divsV : fine ? 40 : 20
    } );
    return { mesh : o.mesh, report : o.report, error : o.report.sweepMaxError, ok : true };
}

function ring( p : Record<string, number>, fine : boolean ) {
    let o = SweptObjectsRecipe.twistedRing( {
        radius : p.radius, wave : p.wave, waves : p.waves, width : p.width, height : p.height, exponent : p.exponent, turns : p.turns,
        tolerance : fine ? 0.01 : 0.05, divsU : fine ? 360 : 160, divsV : fine ? 64 : 32
    } );
    return { mesh : o.mesh, report : o.report, error : o.report.sweepMaxError, ok : true };
}

function pack( mesh : TriMesh ) {
    let pos = new Float32Array( mesh.vertices.length * 3 );
    mesh.vertices.forEach( (v, i) => { pos[3*i] = v[0]; pos[3*i+1] = v[1]; pos[3*i+2] = v[2]; } );
    let idx = new Uint32Array( mesh.triangles.length * 3 );
    mesh.triangles.forEach( (t, i) => { idx[3*i] = t[0]; idx[3*i+1] = t[1]; idx[3*i+2] = t[2]; } );
    return { pos, idx };
}

self.onmessage = (e : MessageEvent<BuildRequest>) => {
    let { id, model, params, fine, make, machine } = e.data;
    let t0 = performance.now();
    try {
        let build = { vessel, knot, ring, mug, pierced, ribbon }[model];
        let r = build( params, fine );
        let check = null;
        if (make && fine) {
            let c = Makeable.check( r.mesh, machine );
            if (!r.ok) c.issues.unshift( "The wall folds over itself: it is thicker than the tightest fold." );
            check = { makeable : c.makeable && r.ok, issues : c.issues, machine : c.machine.name, wall : c.wall.p01, fits : c.fits };
        }
        let ms = performance.now() - t0;
        let { pos, idx } = pack( r.mesh );
        let bb = r.report.manifold ? r.mesh.boundingBox() : null;
        (self as any).postMessage( {
            id, model, ok : true, pos, idx, ms, fine,
            stats : {
                triangles : r.mesh.triangles.length,
                manifold : r.report.manifold,
                volume : r.report.volume,
                error : r.error,
                selfCheck : r.ok,
                fillets : r.report.fillets, filletsFailed : r.report.filletsFailed, filletsSkipped : r.report.filletsSkipped,
                check,
                size : bb ? [bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]] : null
            }
        }, [pos.buffer, idx.buffer] );
    } catch (err) {
        (self as any).postMessage( { id, model, fine, ok : false, message : String( err ) } );
    }
};
