// Builds models off the main thread so the sliders stay responsive.
import { FreeformVesselRecipe, SweptObjectsRecipe } from "../src/index.js";
import type { TriMesh } from "../src/index.js";

export type ModelId = "vessel" | "knot" | "ring";

export interface BuildRequest { id : number; model : ModelId; params : Record<string, number>; fine : boolean }

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
    let { id, model, params, fine } = e.data;
    let t0 = performance.now();
    try {
        let r = model == "vessel" ? vessel( params, fine ) : model == "knot" ? knot( params, fine ) : ring( params, fine );
        let ms = performance.now() - t0;
        let { pos, idx } = pack( r.mesh );
        let bb = r.report.manifold ? r.mesh.boundingBox() : null;
        (self as any).postMessage( {
            id, ok : true, pos, idx, ms, fine,
            stats : {
                triangles : r.mesh.triangles.length,
                manifold : r.report.manifold,
                volume : r.report.volume,
                error : r.error,
                selfCheck : r.ok,
                size : bb ? [bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]] : null
            }
        }, [pos.buffer, idx.buffer] );
    } catch (err) {
        (self as any).postMessage( { id, ok : false, message : String( err ) } );
    }
};
