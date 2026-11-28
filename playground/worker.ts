// Builds models off the main thread so the sliders stay responsive.
import { ApplianceRecipe, BooleanObjectsRecipe, Catalog, FreeformVesselRecipe, Growth, Makeable, Model, Primitives, Step, SweptObjectsRecipe } from "../src/index.js";
import type { BooleanResult, GrowthResult, LatticePattern, ManifoldReport, ModelDocument, ModelVerdict, Point, TriMesh } from "../src/index.js";

export type ModelId = "vessel" | "knot" | "ring" | "mug" | "pierced" | "ribbon" | "appliance" | "block" | "grown" | "primitive";

export interface BuildRequest { type? : "build"; id : number; model : ModelId; params : Record<string, number | string>; fine : boolean; make : boolean; machine : string; certify? : boolean }
export interface StepRequest { type : "step"; id : number }

// A B-rep part of a build: what STEP export writes, and what the Model verdict judges.
interface Part { name : string; result : BooleanResult }

interface Report {
    manifold : ManifoldReport;
    volume : number;
    fillets? : number;
    filletsFailed? : number;
    filletsSkipped? : number;
}

interface Check { makeable : boolean; machine : string; issues : Array<string>; wall : number; fits : boolean; notes : Array<string>; kind? : "buildable" | "unproven" | "visual"; unproven? : Array<string> }

interface Built {
    mesh : TriMesh;
    report : Report;
    // the build's own accuracy: the seams' distance from both surfaces, or the fit's distance from its targets
    error : number;
    ok : boolean;
    notes? : Array<string>;
    // B-rep parts (the mug, the pierced vessel, the appliance's four, a block without infill): judged by the Model
    // verdict in makeable mode, and written as STEP
    parts? : Array<Part>;
    // a verdict already made (the block, which is a Model document)
    verdict? : ModelVerdict;
    // a mesh judged on its own (the grown sheet), with what can go wrong beyond Makeable's checks
    extraIssues? : Array<string>;
}

function vessel( p : Record<string, number>, fine : boolean ) : Built {
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
    return { mesh : v.mesh, report : v.report, error : v.report.offsetMaxError, ok : v.report.innerRingsSimple,
             extraIssues : v.report.innerRingsSimple ? [] : ["The wall folds over itself: it is thicker than the tightest fold."] };
}

function folds( k : number ) {
    return FreeformVesselRecipe.DEFAULT_HARMONICS.map( h => ({
        frequency : h.frequency, amplitude : [h.amplitude[0] * k, h.amplitude[1] * k] as [number, number], phase : h.phase
    }) );
}

function mug( p : Record<string, number>, fine : boolean, certify : boolean ) : Built {
    const o = BooleanObjectsRecipe.mug( {
        height : p.height, radius : [p.baseRadius, p.rimRadius], harmonics : folds( p.folds ), wallThickness : p.wall,
        handleRadius : p.handle, handleReach : p.reach, handleHeights : [p.low, p.high], fillet : p.fillet,
        offsetTolerance : fine ? 0.02 : 0.08, divsU : fine ? 48 : 24, divsV : fine ? 192 : 96, certify
    } );
    const r = o.result.report;
    return { mesh : o.result.mesh, report : r, error : r.maxCurveError, ok : r.manifold.closedManifold, parts : [{ name : "Mug", result : o.result }] };
}

function pierced( p : Record<string, number>, fine : boolean, certify : boolean ) : Built {
    const o = BooleanObjectsRecipe.pierced( {
        height : p.height, radius : [p.baseRadius, p.rimRadius], harmonics : folds( p.folds ), wallThickness : p.wall,
        holes : p.holes, rows : p.rows, holeRadius : p.hole, notches : p.notches, notchRadius : p.notch, fillet : p.fillet,
        offsetTolerance : fine ? 0.02 : 0.08, divsU : fine ? 48 : 24, divsV : fine ? 192 : 96, certify
    } );
    const r = o.result.report;
    return { mesh : o.result.mesh, report : r, error : r.maxCurveError, ok : r.manifold.closedManifold, parts : [{ name : "Pierced vessel", result : o.result }] };
}

// what the sweep did to stay foldless, said plainly: the section is narrowed only where a bend is too tight for it
function narrowedNote( n? : { scale : number } ) : Array<string> {
    return n != null && n.scale < 0.995
        ? ["The section is narrowed to " + Math.round( 100 * n.scale ) + "% where the rail bends tightest, so the surface does not fold over itself there."]
        : [];
}

// what the knot recipes changed in the knot itself: a tube wider than allowed, a common factor in (p, q)
function knotNotes( p : Record<string, number> ) : Array<string> {
    const out : Array<string> = [];
    const max = SweptObjectsRecipe.MAX_TUBE * p.radius;
    if (p.tube > max) out.push( "The torus tube is held to " + max.toFixed( 1 ) + " mm (0.8 of the knot radius), so the knot does not pass through its own axis." );
    const gcd = (a : number, b : number) : number => b == 0 ? a : gcd( b, a % b );
    const g = gcd( p.p, p.q );
    if (g > 1) out.push( "(" + p.p + ", " + p.q + ") runs " + g + " times round the (" + p.p / g + ", " + p.q / g + ") knot; it is drawn once." );
    return out;
}

function ribbon( p : Record<string, number>, fine : boolean ) : Built {
    const o = SweptObjectsRecipe.ribbonKnot( {
        p : p.p, q : p.q, radius : p.radius, tubeRadius : p.tube, width : p.width, thickness : p.thickness, turns : p.turns,
        tolerance : fine ? 0.02 : 0.1, divsU : fine ? 720 : 300, divsV : fine ? 40 : 20
    } );
    return { mesh : o.mesh, report : o.report, error : o.report.sweepMaxError, ok : true, notes : knotNotes( p ).concat( narrowedNote( o.sweep.narrowed ) ) };
}

function knot( p : Record<string, number>, fine : boolean ) : Built {
    const o = SweptObjectsRecipe.knotPipe( {
        p : p.p, q : p.q, radius : p.radius, tubeRadius : p.tube, pipeRadius : p.pipe, pipeSwell : p.swell,
        tolerance : fine ? 0.02 : 0.1, divsU : fine ? 480 : 200, divsV : fine ? 40 : 20
    } );
    return { mesh : o.mesh, report : o.report, error : o.report.sweepMaxError, ok : true, notes : knotNotes( p ).concat( narrowedNote( o.sweep.narrowed ) ) };
}

function ring( p : Record<string, number>, fine : boolean ) : Built {
    const o = SweptObjectsRecipe.twistedRing( {
        radius : p.radius, wave : p.wave, waves : p.waves, width : p.width, height : p.height, exponent : p.exponent, turns : p.turns,
        tolerance : fine ? 0.01 : 0.05, divsU : fine ? 360 : 160, divsV : fine ? 64 : 32
    } );
    return { mesh : o.mesh, report : o.report, error : o.report.sweepMaxError, ok : true, notes : narrowedNote( o.sweep.narrowed ) };
}

function appliance( p : Record<string, number>, fine : boolean, certify : boolean ) : Built {
    const o = ApplianceRecipe.build( {
        width : p.width, depth : p.depth, frontHeight : p.front, backHeight : p.back, squareness : p.square,
        bowlHeight : p.bowlH, bowlRadius : [p.foot, p.rim], seatDepth : p.seat, clearance : p.gap, archHeight : p.arch,
        topFillet : p.topF, seatFillet : p.seatF, archFillet : p.archF, handleFillet : p.handleF,
        couplingRadius : p.key, gripSwell : p.swell, lidTab : p.tab, lidHole : p.hole, cupLip : p.lip, ribs : p.ribs, fine, certify
    } );
    const parts : Array<Part> = [{ name : "Base", result : o.base }, { name : "Bowl", result : o.bowl.result }, { name : "Lid", result : o.lid }, { name : "Cup", result : o.cup }];
    const reps = parts.map( q => q.result.report );
    const sum = (f : (r : BooleanResult["report"]) => number) => reps.reduce( (a, r) => a + f( r ), 0 );
    const closed = reps.every( r => r.manifold.closedManifold );
    return {
        mesh : o.assembly,
        report : { manifold : { ...reps[0].manifold, closedManifold : closed, boundaryEdges : sum( r => r.manifold.boundaryEdges ),
                                genus : reps.every( r => r.manifold.genus != null ) ? sum( r => r.manifold.genus as number ) : NaN },
                   volume : sum( r => r.volume ), fillets : sum( r => r.fillets ), filletsFailed : sum( r => r.filletsFailed ),
                   filletsSkipped : sum( r => r.filletsSkipped ) },
        error : Math.max( ...reps.map( r => r.maxCurveError ) ),
        ok : closed,
        parts
    };
}

// The block is a Model document, not a recipe: a rounded box with a bore, hollowed or filled with a lattice. The
// model is kept between builds, so a slider rebuilds only the features that depend on it (the lattice, say, without
// the rounded solid under it).
export const PATTERNS : Array<LatticePattern> = ["gyroid", "schwarz-p", "diamond", "octet", "bcc", "cubic"];
const blockModel = new Model();

export function blockDocument( p : Record<string, number>, lattice : boolean, machine? : string, certify? : boolean ) : ModelDocument {
    const features : ModelDocument["features"] = {
        body : { type : "box", min : ["-w/2", "-d/2", 0], max : ["w/2", "d/2", "h"] },
        bore : { type : "cylinder", from : [0, 0, -5], to : [0, 0, "h+5"], radius : "bore" },
        holed : { type : "difference", from : "body", minus : ["bore"] },
    };
    let solid = "holed";
    if (p.shell > 0) {
        features.hollow = { type : "shell", of : "holed", thickness : "shell", open : ["body.+z"] };
        solid = "hollow";
    }
    // The box's own edges at the edge radius, and the inside's at that less the wall, so the wall keeps its
    // thickness round the corners. A shell's rim (the open top's edges) and its other inside edges stay sharp: a
    // blend there would have to run across the rim, which is only a wall thick. A solid block's bore rims are rounded
    // at a smaller radius.
    const shelled = p.shell > 0;
    features.round = { type : "round", of : solid, rules : shelled ? [
        { edges : "*body.+z*", radius : 0 },
        { edges : "body.*|body.*", radius : "r" },
        { edges : "hollow~body.*|hollow~body.*", radius : "max(r - shell, 0)" },
        { edges : "*", radius : 0 }] : [
        { edges : "body.*|body.*", radius : "r" },
        { edges : "*", radius : "min(r, bore) / 3" }] };
    let output = "round";
    if (lattice) {
        features.infill = { type : "lattice", of : "round", pattern : PATTERNS[Math.round( p.pattern )], cell : "cell", wall : "wall", skin : "skin",
                            blend : "wall / 2", size : "wall * 0.45", open : ["body.+z"] };
        output = "infill";
    }
    return { version : 1, parameters : { w : p.width, d : p.depth, h : p.height, r : p.edge, bore : p.bore, shell : p.shell,
                                         cell : p.cell, wall : p.wall, skin : p.skin },
             features, output, machine, certify };
}

function block( p : Record<string, number>, fine : boolean, certify : boolean, machine? : string ) : Built {
    // a lattice is meshed on a fine grid: only for the final model, and only on a solid block
    const lattice = fine && p.cell > 0 && !(p.shell > 0);
    const r = blockModel.evaluate( blockDocument( p, lattice, machine, certify ) );
    const notes : Array<string> = [];
    if (p.cell > 0 && p.shell > 0) notes.push( "The infill is left out: a shelled block is hollow, so there is nothing to fill. Set the shell to 0 for infill." );
    else if (p.cell > 0 && !fine) notes.push( "The infill is meshed on the final model, a moment after the preview." );
    if (r.lattice != null) {
        const l = r.lattice;
        notes.push( `The infill keeps ${(100 * l.fraction).toFixed( 0 )}% of the solid's material.` );
        return { mesh : l.mesh, report : { manifold : l.mesh.checkClosedManifold(), volume : l.volume }, error : NaN, ok : true, notes, verdict : r.verdict };
    }
    const rep = r.result.report;
    for (const w of r.walls) notes.push( `The shell's wall is ${w.thinnest.toFixed( 2 )} mm at its thinnest (${w.thickness} mm asked).` );
    return { mesh : r.result.mesh, report : rep, error : rep.maxCurveError, ok : rep.manifold.closedManifold, notes,
             parts : [{ name : "Block", result : r.result }], verdict : r.verdict };
}

// A primitive from the catalogue, as a Model document: the shape with its parameters ("p:<name>" in the request),
// and every edge rounded at `round` when it is positive (those a fillet cannot take stay sharp, and say so).
const primitiveModel = new Model();
function primitive( p : Record<string, number | string>, certify : boolean, machine? : string ) : Built {
    const values : Record<string, number> = {};
    for (const k of Object.keys( p )) if (k.startsWith( "p:" )) values[k.slice( 2 )] = Number( p[k] );
    const round = Number( p.round ) || 0;
    const features : ModelDocument["features"] = { shape : { type : "primitive", shape : String( p.shape ), values } };
    // the creases only: a tangent join (a torus's two halves, a capsule's caps) is an edge but has nothing to round
    if (round > 0) {
        const solid = Catalog.build( String( p.shape ), values );
        const name = (k : number) => "shape." + (solid.faces[k].name ?? "face" + k);
        const rules = Primitives.creases( solid ).map( e => ({ edges : Model.edgeName( name( e.faces[0] ), name( e.faces[1] ) ), radius : round }) );
        features.rounded = { type : "round", of : "shape", rules : rules.concat( [{ edges : "*", radius : 0 }] ) };
    }
    const r = primitiveModel.evaluate( { version : 1, parameters : {}, features, output : round > 0 ? "rounded" : "shape", machine, certify } );
    const rep = r.result.report;
    const notes : Array<string> = [];
    if (round > 0 && rep.filletsSkipped > 0) notes.push( rep.filletsSkipped + " edges stay sharp: they end at a corner the fillets cannot blend yet (an apex, or a vertex of four edges or more)." );
    return { mesh : r.result.mesh, report : rep, error : rep.maxCurveError, ok : rep.manifold.closedManifold, notes,
             parts : [{ name : String( p.shape ), result : r.result }], verdict : r.verdict };
}

// The grown sheet: a disc that grows at its rim, round its centre or everywhere, buckling as it goes; the final model
// is thickened into a closed solid. The growth is kept, so the final build only thickens what the preview grew.
let grownCache : { key : string, grown : GrowthResult } | null = null;
function grow( p : Record<string, number> ) : GrowthResult {
    const key = JSON.stringify( [p.radius, p.zone, p.rate, p.reach, p.steps, p.bending] );
    if (grownCache != null && grownCache.key == key) return grownCache.grown;
    const zone = Math.round( p.zone );
    // a finer sheet facets less, at the cost of a slower growth (about 8 s at 30 mm)
    const edge = p.radius / 16;
    const zones = [zone == 0 ? { kind : "edge" as const, rate : p.rate, reach : p.reach }
                 : zone == 1 ? { kind : "point" as const, rate : p.rate, reach : p.reach, at : [[0, 0, 0] as Point] }
                 : { kind : "everywhere" as const, rate : p.rate }];
    const grown = Growth.grow( Growth.disc( p.radius, edge ), {
        zones, steps : Math.round( p.steps ), bending : p.bending, maxVertices : 5000,
        // the rim grows round a still centre, like a leaf round its stem
        pin : zone == 0 ? (m : Point) => Math.hypot( m[0], m[1] ) < 0.12 * p.radius : undefined
    } );
    grownCache = { key, grown };
    return grown;
}

function grown( p : Record<string, number>, fine : boolean ) : Built {
    const g = grow( p );
    const notes = [`The sheet's area grew ${g.areaGrowth.toFixed( 1 )} times.`];
    if (!fine) {
        notes.push( "The preview is the bare sheet; the final model thickens it into a solid." );
        return { mesh : g.mesh, report : { manifold : g.mesh.checkClosedManifold(), volume : 0 }, error : NaN, ok : true, notes };
    }
    const s = Growth.thicken( g, p.thickness, Math.min( p.thickness / 3, 0.7 ) );
    const extra = s.separate ? [] : ["Two folds came closer than the thickness and fused: lower the thickness, or grow more slowly."];
    return { mesh : s.mesh, report : { manifold : s.mesh.checkClosedManifold(), volume : s.mesh.signedVolume() }, error : NaN, ok : s.separate, notes, extraIssues : extra };
}

function pack( mesh : TriMesh ) {
    const pos = new Float32Array( mesh.vertices.length * 3 );
    mesh.vertices.forEach( (v, i) => { pos[3*i] = v[0]; pos[3*i+1] = v[1]; pos[3*i+2] = v[2]; } );
    const idx = new Uint32Array( mesh.triangles.length * 3 );
    mesh.triangles.forEach( (t, i) => { idx[3*i] = t[0]; idx[3*i+1] = t[1]; idx[3*i+2] = t[2]; } );
    return { pos, idx };
}

// The makeable check of a build. B-rep parts get the Model verdict (closed, outward, every fillet in place, the
// intersection certificate when it ran, and the machine), each part on its own: the gap between separate parts is
// not a wall. Meshes get Makeable's check.
function judge( r : Built, machine : string ) : Check {
    const verdicts : Array<{ name : string, v : ModelVerdict }> = r.verdict != null ? [{ name : "", v : r.verdict }]
        : r.parts != null ? r.parts.map( q => ({ name : q.name, v : Model.verdict( q.result, machine ) }) ) : [];
    if (verdicts.length > 0) {
        const label = (name : string, s : string) => verdicts.length > 1 ? name + ": " + s : s;
        const mks = verdicts.map( x => x.v.makeable ).filter( m => m != null );
        const issues = verdicts.flatMap( x => x.v.kind != "visual" ? [] : x.v.reasons.map( s => label( x.name, s.charAt( 0 ).toUpperCase() + s.slice( 1 ) ) ) );
        // unproven: every check passed, some without a proof; it can be made, said as not proven
        const unproven = verdicts.flatMap( x => x.v.kind != "unproven" ? [] : x.v.unproven.map( s => label( x.name, s.charAt( 0 ).toUpperCase() + s.slice( 1 ) ) ) );
        return { makeable : verdicts.every( x => x.v.kind != "visual" ), unproven,
                 kind : verdicts.some( x => x.v.kind == "visual" ) ? "visual" : verdicts.some( x => x.v.kind == "unproven" ) ? "unproven" : "buildable",
                 machine : Makeable.MACHINES[machine].name, issues,
                 wall : mks.length > 0 ? Math.min( ...mks.map( m => m.wall.p01 ) ) : Infinity, fits : mks.every( m => m.fits ),
                 notes : (r.notes ?? []).concat( verdicts.flatMap( x => x.v.notes.map( s => label( x.name, s.charAt( 0 ).toUpperCase() + s.slice( 1 ) ) ) ) ) };
    }
    const c = Makeable.check( r.mesh, machine );
    const issues = (r.extraIssues ?? []).concat( c.issues );
    return { makeable : issues.length == 0, issues, machine : c.machine.name, wall : c.wall.p01, fits : c.fits, notes : (r.notes ?? []).concat( c.notes ) };
}

// the B-rep parts of the last final build, for STEP export
let lastParts : Array<Part> = [];
let lastModel = "";

function build( req : BuildRequest ) {
    const { id, model, params, fine, make, machine } = req;
    const certify = req.certify === true;
    const t0 = performance.now();
    try {
        const m = make && fine ? machine : undefined;
        if (model == "primitive") return send( primitive( params, certify, m ) );
        const p = params as Record<string, number>;
        const r : Built = model == "vessel" ? vessel( p, fine ) : model == "knot" ? knot( p, fine ) : model == "ring" ? ring( p, fine )
            : model == "mug" ? mug( p, fine, certify ) : model == "pierced" ? pierced( p, fine, certify ) : model == "ribbon" ? ribbon( p, fine )
            : model == "appliance" ? appliance( p, fine, certify ) : model == "block" ? block( p, fine, certify, m ) : grown( p, fine );
        send( r );
    } catch (err) {
        self.postMessage( { id, model, fine, ok : false, message : String( err ) } );
    }

    function send( r : Built ) {
        const m = make && fine ? machine : undefined;
        const check = m != null ? judge( r, m ) : null;
        if (fine) { lastParts = r.parts ?? []; lastModel = model; }
        const ms = performance.now() - t0;
        const { pos, idx } = pack( r.mesh );
        const bb = r.mesh.boundingBox();
        self.postMessage( {
            id, model, ok : true, pos, idx, ms, fine, certified : certify,
            stats : {
                triangles : r.mesh.triangles.length,
                manifold : r.report.manifold,
                volume : r.report.volume,
                error : r.error,
                selfCheck : r.ok,
                fillets : r.report.fillets, filletsFailed : r.report.filletsFailed, filletsSkipped : r.report.filletsSkipped,
                check,
                notes : r.notes ?? [],
                step : (r.parts ?? []).length > 0,
                size : [bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]]
            }
        }, { transfer : [pos.buffer, idx.buffer] } );
    }
}

// the catalogue's shapes and parameters, for the primitive model's controls
self.postMessage( { type : "catalog", entries : Catalog.ENTRIES.map( e => ({ name : e.name, family : e.family, parameters : e.parameters }) ) } );

self.onmessage = (e : MessageEvent<BuildRequest | StepRequest>) => {
    const req = e.data;
    if (req.type == "step") {
        try {
            const files = lastParts.map( q => ({ name : q.name.toLowerCase().replace( / /g, "-" ) + ".step", text : Step.write( q.result, { name : q.name } ) }) );
            self.postMessage( { type : "step", id : req.id, model : lastModel, ok : true, files } );
        } catch (err) {
            self.postMessage( { type : "step", id : req.id, model : lastModel, ok : false, message : String( err ) } );
        }
        return;
    }
    build( req );
};
