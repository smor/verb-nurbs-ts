// Builds models off the main thread so the sliders stay responsive.
import { ApplianceRecipe, BooleanObjectsRecipe, FreeformVesselRecipe, Makeable, SweptObjectsRecipe } from "../src/index.js";
import type { TriMesh } from "../src/index.js";

export type ModelId = "vessel" | "knot" | "ring" | "mug" | "pierced" | "ribbon" | "appliance";

export interface BuildRequest { id : number; model : ModelId; params : Record<string, number>; fine : boolean; make : boolean; machine : string }

function vessel( p : Record<string, number>, fine : boolean ) {
    const base = FreeformVesselRecipe.DEFAULT_HARMONICS;
    const harmonics = base.map( h => ({
        frequency : h.frequency,
        amplitude : [h.amplitude[0] * p.folds, h.amplitude[1] * p.folds] as [number, number],
        phase : [h.phase[0], h.phase[0] + (h.phase[1] - h.phase[0]) * p.drift + p.turn] as [number, number]
    }) );
    const v = FreeformVesselRecipe.build( {
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
    const o = BooleanObjectsRecipe.mug( {
        height : p.height, radius : [p.baseRadius, p.rimRadius], harmonics : folds( p.folds ), wallThickness : p.wall,
        handleRadius : p.handle, handleReach : p.reach, handleHeights : [p.low, p.high], fillet : p.fillet,
        offsetTolerance : fine ? 0.02 : 0.08, divsU : fine ? 48 : 24, divsV : fine ? 192 : 96
    } );
    const r = o.result.report;
    return { mesh : o.result.mesh, report : r, error : r.maxCurveError, ok : r.manifold.closedManifold };
}

function pierced( p : Record<string, number>, fine : boolean ) {
    const o = BooleanObjectsRecipe.pierced( {
        height : p.height, radius : [p.baseRadius, p.rimRadius], harmonics : folds( p.folds ), wallThickness : p.wall,
        holes : p.holes, rows : p.rows, holeRadius : p.hole, notches : p.notches, notchRadius : p.notch, fillet : p.fillet,
        offsetTolerance : fine ? 0.02 : 0.08, divsU : fine ? 48 : 24, divsV : fine ? 192 : 96
    } );
    const r = o.result.report;
    return { mesh : o.result.mesh, report : r, error : r.maxCurveError, ok : r.manifold.closedManifold };
}

// what the sweep did to stay foldless, said plainly: the section is narrowed only where a bend is too tight for it
function narrowedNote( n? : { scale : number } ) : Array<string> {
    return n != null && n.scale < 0.995
        ? ["The section is narrowed to " + Math.round( 100 * n.scale ) + "% where the rail bends tightest, so the surface does not fold over itself there."]
        : [];
}

function ribbon( p : Record<string, number>, fine : boolean ) {
    const o = SweptObjectsRecipe.ribbonKnot( {
        p : p.p, q : p.q, radius : p.radius, tubeRadius : p.tube, width : p.width, thickness : p.thickness, turns : p.turns,
        tolerance : fine ? 0.02 : 0.1, divsU : fine ? 720 : 300, divsV : fine ? 40 : 20
    } );
    return { mesh : o.mesh, report : o.report, error : o.report.sweepMaxError, ok : true, notes : narrowedNote( o.sweep.narrowed ) };
}

function knot( p : Record<string, number>, fine : boolean ) {
    const o = SweptObjectsRecipe.knotPipe( {
        p : p.p, q : p.q, radius : p.radius, tubeRadius : p.tube, pipeRadius : p.pipe, pipeSwell : p.swell,
        tolerance : fine ? 0.02 : 0.1, divsU : fine ? 480 : 200, divsV : fine ? 40 : 20
    } );
    return { mesh : o.mesh, report : o.report, error : o.report.sweepMaxError, ok : true, notes : narrowedNote( o.sweep.narrowed ) };
}

function ring( p : Record<string, number>, fine : boolean ) {
    const o = SweptObjectsRecipe.twistedRing( {
        radius : p.radius, wave : p.wave, waves : p.waves, width : p.width, height : p.height, exponent : p.exponent, turns : p.turns,
        tolerance : fine ? 0.01 : 0.05, divsU : fine ? 360 : 160, divsV : fine ? 64 : 32
    } );
    return { mesh : o.mesh, report : o.report, error : o.report.sweepMaxError, ok : true, notes : narrowedNote( o.sweep.narrowed ) };
}

function appliance( p : Record<string, number>, fine : boolean ) {
    const o = ApplianceRecipe.build( {
        width : p.width, depth : p.depth, frontHeight : p.front, backHeight : p.back, squareness : p.square,
        bowlHeight : p.bowlH, bowlRadius : [p.foot, p.rim], seatDepth : p.seat, clearance : p.gap, archHeight : p.arch,
        topFillet : p.topF, seatFillet : p.seatF, archFillet : p.archF, handleFillet : p.handleF,
        couplingRadius : p.key, gripSwell : p.swell, lidTab : p.tab, lidHole : p.hole, cupLip : p.lip, ribs : p.ribs, fine : fine
    } );
    const parts = [{ name : "Base", r : o.base }, { name : "Bowl", r : o.bowl.result }, { name : "Lid", r : o.lid }, { name : "Cup", r : o.cup }];
    const reps = parts.map( q => q.r.report );
    const sum = (f : (r : any) => number) => reps.reduce( (a, r) => a + f( r ), 0 );
    const closed = reps.every( r => r.manifold.closedManifold );
    return {
        mesh : o.assembly,
        report : { manifold : { ...reps[0].manifold, closedManifold : closed, boundaryEdges : sum( r => r.manifold.boundaryEdges ),
                                genus : reps.every( r => r.manifold.genus != null ) ? sum( r => r.manifold.genus ) : null },
                   volume : sum( r => r.volume ), fillets : sum( r => r.fillets ), filletsFailed : sum( r => r.filletsFailed ),
                   filletsSkipped : sum( r => r.filletsSkipped ) },
        error : Math.max( ...reps.map( r => r.maxCurveError ) ),
        ok : closed,
        parts : parts.map( q => ({ name : q.name, mesh : q.r.mesh }) )
    };
}

function pack( mesh : TriMesh ) {
    const pos = new Float32Array( mesh.vertices.length * 3 );
    mesh.vertices.forEach( (v, i) => { pos[3*i] = v[0]; pos[3*i+1] = v[1]; pos[3*i+2] = v[2]; } );
    const idx = new Uint32Array( mesh.triangles.length * 3 );
    mesh.triangles.forEach( (t, i) => { idx[3*i] = t[0]; idx[3*i+1] = t[1]; idx[3*i+2] = t[2]; } );
    return { pos, idx };
}

self.onmessage = (e : MessageEvent<BuildRequest>) => {
    const { id, model, params, fine, make, machine } = e.data;
    const t0 = performance.now();
    try {
        const build = { vessel, knot, ring, mug, pierced, ribbon, appliance }[model] as (p : Record<string, number>, fine : boolean) => any;
        const r = build( params, fine );
        let check = null;
        if (make && fine) {
            if (r.parts) {
                // separate parts are made separately: check each on its own (the gap between them is not a wall)
                const cs = r.parts.map( (x : { name : string, mesh : TriMesh }) => ({ name : x.name, c : Makeable.check( x.mesh, machine ) }) );
                check = { makeable : cs.every( (x : any) => x.c.makeable ), machine : cs[0].c.machine.name,
                          issues : cs.flatMap( (x : any) => x.c.issues.map( (i : string) => x.name + ": " + i ) ),
                          wall : Math.min( ...cs.map( (x : any) => x.c.wall.p01 ) ), fits : cs.every( (x : any) => x.c.fits ) };
            } else {
                const c = Makeable.check( r.mesh, machine );
                if (!r.ok) c.issues.unshift( "The wall folds over itself: it is thicker than the tightest fold." );
                check = { makeable : c.makeable && r.ok, issues : c.issues, machine : c.machine.name, wall : c.wall.p01, fits : c.fits,
                          notes : (r.notes ?? []).concat( c.notes ) };
            }
        }
        const ms = performance.now() - t0;
        const { pos, idx } = pack( r.mesh );
        const bb = r.report.manifold ? r.mesh.boundingBox() : null;
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
                notes : r.notes ?? [],
                size : bb ? [bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]] : null
            }
        }, [pos.buffer, idx.buffer] );
    } catch (err) {
        (self as any).postMessage( { id, model, fine, ok : false, message : String( err ) } );
    }
};
