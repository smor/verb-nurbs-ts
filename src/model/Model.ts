import { NurbsCurveData, NurbsSurfaceData, Point } from "../core/Data.js";
import { Vec } from "../core/Vec.js";
import { Analyze } from "../eval/Analyze.js";
import { Divide } from "../eval/Divide.js";
import { Make } from "../eval/Make.js";
import { Sweep } from "../eval/Sweep.js";
import { BrepFace, BrepSolid } from "../solid/Brep.js";
import { BooleanOptions, BooleanResult, BrepBoolean } from "../solid/BrepBoolean.js";
import { BrepEdges } from "../solid/BrepEdges.js";
import { BrepShell, ShellBuilder } from "../solid/BrepShell.js";
import { Extrusion, ProfilePoint, ProfileSegmentSpec, ProfileSpec } from "../solid/Extrusion.js";
import { Lathe } from "../solid/Lathe.js";
import { Catalog } from "../solid/primitives/Catalog.js";
import { FilletShape } from "../solid/Fillet.js";
import { Implicit, LatticePattern } from "../solid/Implicit.js";
import { Machine, Makeable, MakeableReport } from "../solid/Makeable.js";
import { TriMesh } from "../solid/TriMesh.js";
import { Expr } from "./Expr.js";
import { Wall } from "./Wall.js";

// A number in a model document: a literal, or an expression over the document's parameters (see `Expr`).
export type ModelValue = number | string;
export type ModelPoint = [ModelValue, ModelValue, ModelValue];

// The features a model is built from. Each has an id (its key in `ModelDocument.features`), which names it in
// other features' inputs and in the persistent names of the faces and edges it makes.
export type ModelFeature =
    // primitives: closed solids with named faces
    | { type : "box", min : ModelPoint, max : ModelPoint, divs? : ModelValue }
    | { type : "cylinder", from : ModelPoint, to : ModelPoint, radius : ModelValue, divs? : [ModelValue, ModelValue] }
    | { type : "pipe", through : Array<ModelPoint>, radius : ModelValue, divs? : [ModelValue, ModelValue] }
    | { type : "revolve", profile : Array<[ModelValue, ModelValue]>, divs? : [ModelValue, ModelValue] }
    // a straight prism over an outline in the plane z = 0, from z = 0 to `height`: points [x, y] or [x, y, r] (r rounds
    // that corner by a tangent arc), in either orientation; its values may be expressions. Built as an exact extrusion
    // (lines and arcs, `Extrusion`), its caps planes trimmed by the outline, so any simple polygon will do (#99).
    // Faces: bottom, top, and outer.k (one per side and rounded corner). (`center`, where its caps once fanned from,
    // is accepted and not read.)
    | { type : "prism", outline : Array<Array<ModelValue>>, height : ModelValue, center? : [ModelValue, ModelValue] }
    // a planar profile (lines, three-point arcs, circles and cubic Béziers, with holes) extruded from z up by height,
    // exact (`Extrusion`): faces bottom, top, outer.k and hole{i}.k
    | { type : "extrude", profile : ProfileSpec, height : ModelValue, z? : ModelValue, twist? : ModelValue, scaleTop? : ModelValue }
    // the same profile drawn in the (r, z) half-plane (x the radius) and turned about the z axis (#87); faces outer.k
    | { type : "lathe", profile : ProfileSpec, degrees? : ModelValue }
    // a primitive from the catalogue (`Catalog`, docs/primitives.md) by name, with its parameters by name (missing
    // ones take their defaults; angles in degrees)
    | { type : "primitive", shape : string, values? : { [name : string] : ModelValue } }
    // rigid or scaling placement of a feature (all of its solids): scale about the origin, then rotate about an axis
    // through `about` (degrees, right-handed), then translate
    | { type : "transform", of : string, scale? : ModelValue | ModelPoint, rotate? : { axis : ModelPoint, degrees : ModelValue, about? : ModelPoint }, translate? : ModelPoint }
    // a switch: `then` where `when` is not 0, `else` where it is; either may be left out, for nothing. Resolved before
    // anything is built (`Model.choose`): nothing drops out of a union and out of a difference's cutters, and what is
    // made from nothing alone (a transform, a round, a difference from it, an intersection with it) is nothing
    | { type : "choose", when : ModelValue, then? : string, else? : string }
    // constructive solid geometry
    | { type : "union", of : Array<string> }
    | { type : "intersection", of : Array<string> }
    | { type : "difference", from : string, minus : Array<string> }
    // rounding, on a solid or a Boolean: rules in order, the first whose pattern matches an edge's name gives its
    // radius (0: leave it sharp); see `ModelEdgeRule`
    | { type : "round", of : string, rules : Array<ModelEdgeRule>, shape? : FilletShape, corner? : "auto" | "ball" }
    // hollowing: the solid less its inside, `thickness` in from every face but the `open` ones (patterns over the face
    // names of `of`, as for edges), which the inside goes through; see `Model` on how the inside is built
    | { type : "shell", of : string, thickness : ModelValue, open? : Array<string> }
    // lightweighting: the solid's inside as a lattice (a TPMS sheet or struts, `wall` thick, in cubic cells of side
    // `cell`) within a skin `skin` thick (0: none), fused to it with a smooth joint of radius `blend`; the wall may be
    // graded, linearly along an axis of the solid's bounding box to `grade.to`. Meshed on a grid of side `size`
    // (default: an eighth of the cell, two thirds of the skin or a third of the thinnest wall). The skin leaves out the `open` faces
    // (patterns over the solid's face names), where the lattice runs out to the surface: a printer's resin or powder
    // drains from the voids there. The last feature, like a round
    | { type : "lattice", of : string, pattern : LatticePattern, cell : ModelValue, wall : ModelValue, skin? : ModelValue,
        blend? : ModelValue, size? : ModelValue, grade? : { axis : "x" | "y" | "z", to : ModelValue }, open? : Array<string> };

// Edges are named by the two faces they join (`Model` explains face names): "a.+z|b.tube", the two names in sorted
// order. A pattern matches a name when it does with `*` standing for any run of characters; "a.*|b.*" matches
// every edge between a's faces and b's. Edges between two operands of a Boolean are its new edges; edges between two
// faces of one primitive are its own edges.
export interface ModelEdgeRule { edges : string, radius : ModelValue }

export interface ModelDocument {
    // the version of this format (1)
    version : 1;
    // named numbers, which features use in expressions; a parameter's own expression may use other parameters
    parameters? : { [name : string] : ModelValue };
    features : { [id : string] : ModelFeature };
    // the feature whose solid the model is
    output : string;
    // a machine to check the model against (`Makeable.MACHINES` key, or a machine), for the verdict
    machine? : string | Machine;
    // prove every intersection of the Booleans complete (no branch or small loop missed); the verdict notes the pairs
    // of faces it cannot prove (`IntersectionCertificate`; default false)
    certify? : boolean;
}

// What a model regenerates to: the solid, its faces' persistent names, the verdict, and what was rebuilt.
export interface ModelResult {
    result : BooleanResult;
    // for each face of `result.faces`, its persistent name
    faceNames : Array<string>;
    // for each persistent name, the face it names (in `result.faces`; no two faces share a name)
    faceIndex : { [name : string] : number };
    verdict : ModelVerdict;
    // each feature's content hash, and whether this evaluation built it (false: it came from the cache)
    features : { [id : string] : { hash : string, built : boolean } };
    parameters : { [name : string] : number };
    // for each shell in the output, its wall as asked and as measured (`Model.wall`)
    walls : Array<ModelWall>;
    // for a lattice output: its mesh (the solid it fills is `result`), and its volume against the solid's
    lattice? : ModelLattice;
    // for each switch (`choose`) the output reached: whether it chose `then`
    chosen? : { [id : string] : boolean };
    // the result's exact shell, when the result is one solid made from a shell, as it is (an extrusion, a turned
    // profile): its faces are `result.faces`, in order (#117)
    shell? : BrepShell;
}

// A lattice output: the mesh, the pattern, and how much of the solid it keeps.
// (`bodies`: the separate pieces; `voids`: the sealed cavities inside them, where resin or powder would be trapped;
// `size`: the meshing grid's step)
export interface ModelLattice { mesh : TriMesh, pattern : LatticePattern, cell : number, wall : [number, number], skin : number, volume : number, fraction : number,
                                bodies : number, voids : number, size : number }

// A shell's wall: the thickness asked, and the thinnest found on the result, between the inside faces and the
// outside faces (open ones left out), fillets counted with the faces they join.
export interface ModelWall { shell : string, thickness : number, thinnest : number }

// What the rounds of a model's rounded operands left undone, summed (see `ModelVerdict`'s fillets check).
export interface Fillets {
    failed : number, skipped : number, reduced : number,
    // the round rules that selected no edge, as `"round": "pattern"` (#79)
    unmatched? : Array<string>,
}

// A shell within a tree: the leaves of its solid and of its inside, and its open faces' names.
interface Shelled { id : string, thickness : number, outside : [number, number], inside : [number, number], open : Array<string> }

// Whether a model is a buildable solid or a visual model, decided the same way every time from checks on the
// result, each with a plain reason. A buildable solid is a closed, outward-facing 2-manifold with positive volume,
// every requested fillet in place, and (when the document names a machine) makeable on that machine.
export interface ModelVerdict {
    kind : "buildable" | "visual";
    reasons : Array<string>;
    // the checks, each passed or not
    checks : Array<{ name : string, passed : boolean, detail : string }>;
    // what is worth knowing but does not make the model visual (supports needed, the build direction, ...)
    notes : Array<string>;
    // the machine check behind the "makeable" check, when the document names a machine and the result is closed:
    // its measured wall, size, orientation and mould release, for display
    makeable? : MakeableReport;
}

// A model: a document of parameters and features, regenerated deterministically into a solid with persistent names.
//
// Design (after the history-based parametric modellers, and the naming schemes of J. Kripac, "A mechanism for
// persistently naming topological entities in history-based parametric solid models", CAD 29(2), 1997, and
// V. Capoyleas, X. Chen, C. M. Hoffmann, "Generic naming in generative, constraint-based design", CAD 28(1), 1996):
//
// * The document is plain JSON: parameters, features keyed by id, an output. Values are numbers or expressions
//   over the parameters. Nothing else goes in, so the same document always gives the same model.
// * Every feature has a content hash: its type, its values (resolved), and its inputs' hashes. A feature whose hash
//   is in the cache is not built again: change one parameter and only the features that depend on it rebuild.
// * The Booleans of a tree compile into one N-ary Boolean over its primitives (`BrepBoolean.evaluate`), whose
//   expression is the tree's, so a tree of any depth is cut once, with one set of seams.
// * Faces have persistent names, from their history rather than their position in a list: a primitive's face is
//   "<feature>.<face>" ("lid.+z", "peg.tube"), behind any transforms "<transform>/<feature>.<face>"; a fillet is
//   "round(<face>|<face>)", after the two faces it joins; a corner "corner(<face>|<face>|<face>)" (with ".<k>" for
//   each part of a setback corner). Where one face is split into pieces, they are told apart by "#1", "#2", ...
//   in order of decreasing area. Rules select edges by these names, so they keep selecting the same edges when
//   the parameters change.
// * The verdict says whether the result is buildable or only visual, and why (`ModelVerdict`).
//
// * A shell is the solid less its inside, in the same N-ary Boolean: X && !inside(X). The inside is the CSG tree
//   offset inward (J. R. Rossignac, A. A. G. Requicha, "Offsetting operations in solid modelling", CAGD 3(2), 1986):
//   primitives offset (mitred when grown), Booleans of the offsets, each no larger than the exact erosion, so walls
//   are never thinner than asked. The result's walls are then measured for the verdict (docs/model.md, "Shells").
//
// * A round that is an operand of a further feature is a stage of its own (route A, step A4 of
//   docs/exact-booleans.md): it is evaluated first (one Boolean of its tree, rounded), its result made an exact shell
//   (`ShellBuilder.fromResult`) and the shell an operand of the next Boolean (`ShellBuilder.solid`), with its faces
//   named as the round named them ("round(box.+x|box.+y)", behind any transforms "T/round(box.+x|box.+y)"). Each
//   stage is cached by its hash like any feature, so moving a hole through a rounded part rebuilds the hole and the
//   cut, not the round.
//
// Limits: a round over a rounded operand is refused (rounding the edges a Boolean makes on a shell is step A5), and
// so is a shell of one (its offset is not built). A round as the output, moved by transforms, is still rewritten as
// the round of the moved part (`Model.liftRound`), so its single Boolean builds it.
/**
 * Why a model could not be built, and where: the feature at fault (its id, `crank1/disc` inside a component instance)
 * and its type, when the failure is a feature's. A failure from inside the kernel keeps the kernel's error as `cause`.
 */
export class ModelError extends Error {
    public readonly feature? : string;
    public readonly type? : string;
    constructor( message : string, where : { feature? : string, type? : string } = {}, cause? : unknown ) {
        super( message );
        this.name = "ModelError";
        if (where.feature != null) this.feature = where.feature;
        if (where.type != null) this.type = where.type;
        if (cause !== undefined) (this as { cause? : unknown }).cause = cause;
    }
}

export class Model {

    private cache = new Map<string, unknown>();

    // Regenerates a document. The model keeps what it built, so evaluating an edited document rebuilds only what
    // the edit changed.
    public evaluate( given : ModelDocument ) : ModelResult {
        if (given.version !== 1) throw new Error( "Model: unknown document version " + String( given.version ) );
        if (given.features?.[given.output] == null) throw new Error( `Model: the output "${given.output}" is not a feature` );
        const params = Model.parameters( given.parameters ?? {} );
        const chosen : { [id : string] : boolean } = {};
        const doc = Model.liftRound( Model.choose( given, params, chosen ) );
        const num = (v : ModelValue, what : string) : number => {
            if (typeof v == "number") { if (!isFinite( v )) throw new Error( `Model: ${what} is not finite` ); return v; }
            if (typeof v == "string") return Expr.evaluate( v, params );
            throw new Error( `Model: ${what} must be a number or an expression` );
        };
        const point = (p : ModelPoint, what : string) : Point => {
            if (!Array.isArray( p ) || p.length != 3) throw new Error( `Model: ${what} must be a point [x, y, z]` );
            return [num( p[0], what + "[0]" ), num( p[1], what + "[1]" ), num( p[2], what + "[2]" )];
        };
        const features = doc.features;
        if (features[doc.output] == null) throw new Error( `Model: the output "${doc.output}" is not a feature` );

        // hashes, depth first, with cycles caught
        const hashes = new Map<string, string>(), visiting = new Set<string>();
        const hashOf = (id : string) : string => {
            const known = hashes.get( id );
            if (known != null) return known;
            const f = features[id];
            if (f == null) throw new Error( `Model: unknown feature "${id}"` );
            if (visiting.has( id )) throw new Error( `Model: feature "${id}" depends on itself` );
            visiting.add( id );
            let resolved : unknown, inputs : Array<string>;
            try {
                resolved = Model.resolve( f, num, point );
                inputs = Model.inputs( f ).map( hashOf );
            } catch (e) {
                // a feature's own values or inputs at fault: the error names it (an input's own error names the input)
                if (e instanceof ModelError && e.feature != null) throw e;
                throw new ModelError( e instanceof Error ? e.message : String( e ), { feature : id, type : f.type }, e instanceof Error ? (e as { cause? : unknown }).cause : undefined );
            }
            visiting.delete( id );
            const h = Model.hash( Model.canonical( { type : f.type, values : resolved, inputs : inputs } ) );
            hashes.set( id, h );
            return h;
        };
        hashOf( doc.output );

        const built = new Set<string>();
        // A failure is cached too (the same content fails the same way), and one from inside the kernel is reported
        // as the failure of the feature being built, with the kernel's error as its cause.
        const cached = <T>( stage : string, id : string, make : () => T ) : T => {
            const key = stage + ":" + id + ":" + (hashes.get( id ) as string);
            if (this.cache.has( key )) {
                const v = this.cache.get( key );
                if (v instanceof ModelFailure) throw v.error;
                return v as T;
            }
            let v : T;
            try {
                v = make();
            } catch (e) {
                const message = e instanceof Error ? e.message : String( e );
                const where = { feature : id, type : features[id]?.type };
                const error = e instanceof ModelError && e.feature != null ? e
                    : message.startsWith( "Model:" ) ? new ModelError( message, where, e instanceof Error ? (e as { cause? : unknown }).cause : undefined )
                    : new ModelError( `Model: building "${id}" failed: ${message}`, where, e );
                this.cache.set( key, new ModelFailure( error ) );
                built.add( id );
                throw error;
            }
            this.cache.set( key, v );
            built.add( id );
            return v;
        };

        // a feature's solids: its primitives (each with its path of transforms) and the Boolean expression over them
        // (`shells`: each shell in it, by the leaves of its outside and of its inside, for the wall check)
        // (a leaf with a `path` is a rounded operand made a shell: its faces carry their persistent names, which the
        // path of transforms it went through goes before; `fillets`: what the rounds inside the tree left undone)
        type Leaf = { name : string, solid : BrepSolid, path? : string };
        type Tree = { leaves : Array<Leaf>, expr : (inside : Array<boolean>) => boolean, shells : Array<Shelled>, fillets? : Fillets };
        const nameOf = (l : Leaf, fi : number) => (l.path != null ? l.path : l.name + ".") + Model.faceName( l.solid.faces[fi], fi );
        const combine = (id : string, type : "union" | "intersection" | "difference", parts : Array<Tree>) : Tree => {
            const leaves = ([] as Tree["leaves"]).concat( ...parts.map( p => p.leaves ) );
            const offsets : Array<number> = [];
            let n = 0;
            for (const p of parts) { offsets.push( n ); n += p.leaves.length; }
            const sub = (k : number, x : Array<boolean>) => parts[k].expr( x.slice( offsets[k], offsets[k] + parts[k].leaves.length ) );
            const expr = type == "union" ? (x : Array<boolean>) => parts.some( (_, k) => sub( k, x ) )
                : type == "intersection" ? (x : Array<boolean>) => parts.every( (_, k) => sub( k, x ) )
                : (x : Array<boolean>) => sub( 0, x ) && !parts.slice( 1 ).some( (_, k) => sub( k + 1, x ) );
            const names = new Set<string>();
            for (const l of leaves) {
                if (names.has( l.name )) throw new Error( `Model: "${l.name}" is used twice in "${id}"; place a copy with a transform` );
                names.add( l.name );
            }
            const shells = ([] as Array<Shelled>).concat( ...parts.map( (p, k) => p.shells.map( s => Model.shift( s, offsets[k] ) ) ) );
            return { leaves : leaves, expr : expr, shells : shells, fillets : Model.addFillets( parts.map( p => p.fillets ) ) };
        };
        const EMPTY : Tree = { leaves : [], expr : () => false, shells : [] };

        // A feature's solids offset by d (d > 0: in, an erosion; d < 0: out, a dilation), the faces whose names
        // (`path` + leaf + face) match `open` the other way. Erosions come out no larger than the exact ones, and
        // dilations no smaller, so an inside built from them leaves walls at least d thick (see `Model`).
        const offset = (id : string, d : number, path : string, open : Array<RegExp>) : Tree => {
            const f = features[id];
            switch (f.type) {
                case "primitive": throw new Error( `Model: a shell cannot yet offset the primitive "${id}"` );
                case "extrude": case "prism": throw new Error( `Model: a shell cannot yet offset the extrusion "${id}"` );
                case "lathe": throw new Error( `Model: a shell cannot yet offset the revolved profile "${id}"` );
                case "box": case "cylinder": case "pipe": case "revolve": {
                    const leaf = path + id;
                    const by = (face : string) => open.some( re => re.test( leaf + "." + face ) ) ? -d : d;
                    const s = Model.offsetPrimitive( f, by, num, point, id );
                    return s == null ? EMPTY : { leaves : [{ name : id, solid : s }], expr : (x : Array<boolean>) => x[0], shells : [] };
                }
                case "transform": {
                    const M = Model.matrix( f, num, point );
                    const s = Model.similarity( M );
                    if (s == null) throw new Error( `Model: a shell can only go through a rigid or uniformly scaled transform, not "${id}"` );
                    const t = offset( f.of, d / s, path + id + "/", open );
                    return { leaves : t.leaves.map( l => ({ name : id + "/" + l.name, solid : Model.transform( l.solid, M ) }) ), expr : t.expr, shells : [] };
                }
                case "union": {
                    // a dilation of a union is the union of the dilations; an erosion contains the union of the
                    // erosions (equal away from the seams, larger at concave seams), which is taken
                    const parts = f.of.map( k => offset( k, d, path, open ) ).filter( p => p.leaves.length > 0 );
                    return parts.length == 0 ? EMPTY : combine( id, "union", parts );
                }
                case "intersection": {
                    // the other way about: erosions exact, the dilation within the intersection of the dilations
                    const parts = f.of.map( k => offset( k, d, path, open ) );
                    return parts.some( p => p.leaves.length == 0 ) ? EMPTY : combine( id, "intersection", parts );
                }
                case "difference": {
                    // A - B offset in is (A in) - (B out); offset out, it lies within (A out) - (B in)
                    const from = offset( f.from, d, path, open );
                    if (from.leaves.length == 0) return EMPTY;
                    const minus = f.minus.map( k => offset( k, -d, path, open ) ).filter( p => p.leaves.length > 0 );
                    return combine( id, "difference", [from].concat( minus ) );
                }
                case "shell": throw new Error( `Model: a shell cannot be shelled again ("${id}")` );
                case "round": throw new Error( `Model: a shell cannot yet offset the rounded "${id}"` );
                case "lattice": throw new Error( `Model: the lattice "${id}" can only be the last feature (an operand of nothing)` );
            }
            throw new Error( `Model: unknown feature type "${(f as { type : string }).type}" in "${id}"` );
        };
        const tree = (id : string) : Tree => cached( "tree", id, () => {
            const f = features[id];
            switch (f.type) {
                case "box": case "cylinder": case "pipe": case "revolve": case "primitive": case "extrude": case "lathe": case "prism":
                    return { leaves : [{ name : id, solid : Model.primitive( f, num, point ) }], expr : (x : Array<boolean>) => x[0], shells : [] };
                case "transform": {
                    const t = tree( f.of );
                    const M = Model.matrix( f, num, point );
                    return { leaves : t.leaves.map( l => ({ name : id + "/" + l.name, solid : Model.transform( l.solid, M ), path : l.path != null ? id + "/" + l.path : undefined }) ),
                             expr : t.expr, shells : t.shells.map( s => ({ ...s, open : s.open.map( n => id + "/" + n ) }) ), fillets : t.fillets };
                }
                case "union": case "intersection": case "difference": {
                    const ids = f.type == "difference" ? [f.from].concat( f.minus ) : f.of;
                    if (ids.length == 0) throw new Error( `Model: "${id}" has no operands` );
                    return combine( id, f.type, ids.map( tree ) );
                }
                case "shell": {
                    // the solid less its inside, in the one Boolean: X && !inside(X)
                    const t = tree( f.of );
                    const th = num( f.thickness, `"${id}" thickness` );
                    if (!(th > 0)) throw new Error( `Model: the shell "${id}" needs a positive thickness` );
                    const open = (f.open ?? []).map( Model.pattern );
                    const faces = t.leaves.flatMap( l => l.solid.faces.map( (_, k) => nameOf( l, k ) ) );
                    (f.open ?? []).forEach( (g, k) => {
                        if (!faces.some( n => open[k].test( n ) )) throw new Error( `Model: the shell "${id}" opens "${g}", which names no face of "${f.of}"` );
                    } );
                    const inside = offset( f.of, th, "", open );
                    const n = t.leaves.length;
                    const leaves = t.leaves.concat( inside.leaves.map( l => ({ name : id + "~" + l.name, solid : l.solid }) ) );
                    return {
                        leaves : leaves,
                        expr : (x : Array<boolean>) => t.expr( x.slice( 0, n ) ) && !inside.expr( x.slice( n ) ),
                        shells : t.shells.concat( [{ id : id, thickness : th, outside : [0, n], inside : [n, leaves.length], open : faces.filter( nm => open.some( re => re.test( nm ) ) ) }] ),
                        fillets : t.fillets,
                    };
                }
                case "round": {
                    // a rounded operand is evaluated first, as a stage of its own (cached like any), and its exact shell
                    // is the operand: its faces trimmed by their loops, named as the round named them
                    const b = build( id );
                    const shell = ShellBuilder.fromResult( b.result );
                    const s = ShellBuilder.solid( shell, b.result.mesh );
                    s.faces.forEach( (fc, k) => { fc.name = b.names[shell.faces[k].source]; } );
                    const rep = b.result.report;
                    const own : Fillets = { failed : rep.filletsFailed, skipped : rep.filletsSkipped, reduced : rep.filletsReduced ?? 0 };
                    return { leaves : [{ name : id, solid : s, path : "" }], expr : (x : Array<boolean>) => x[0], shells : [], fillets : Model.addFillets( [b.fillets, own] ) };
                }
                case "lattice": throw new Error( `Model: the lattice "${id}" can only be the last feature (an operand of nothing)` );
            }
            throw new Error( `Model: unknown feature type "${(f as { type : string }).type}" in "${id}"` );
        } );

        // a feature's solid: one Boolean of its tree, rounded if it is a round
        const build = (solidId : string) : { result : BooleanResult, names : Array<string>, walls : Array<ModelWall>, fillets? : Fillets, shell? : BrepShell } =>
            cached( doc.certify === true ? "solid+certify" : "solid", solidId, () => {
            const out = features[solidId];
            const round = out.type == "round" ? out : null;
            const t = tree( round != null ? round.of : solidId );
            const leafName = (si : number, fi : number) => nameOf( t.leaves[si], fi );

            let options : BooleanOptions = { certify : doc.certify === true };
            const rules : Array<{ edges : string, re : RegExp, radius : number, hits : number }> = [];
            if (round != null) {
                rules.push( ...round.rules.map( r => ({ edges : r.edges, re : Model.pattern( r.edges ), radius : num( r.radius, `"${solidId}" radius` ), hits : 0 }) ) );
                // an edge "a|b" (its faces' names sorted) matches a pattern either way round: "b.*x|b.*y" is an x face
                // and a y face, whichever sorts first (#79); every rule that matches counts the edge, the first rounds it
                const radius = (name : string) => {
                    const bar = name.indexOf( "|" ), other = bar < 0 ? name : name.slice( bar + 1 ) + "|" + name.slice( 0, bar );
                    let r : (typeof rules)[number] | undefined;
                    for (const x of rules) if (x.re.test( name ) || x.re.test( other )) { x.hits++; r ??= x; }
                    return r != null ? r.radius : 0;
                };
                // (rounding the edges of a rounded operand, or the new edges on it, is step A5 of docs/exact-booleans.md)
                if (t.leaves.some( l => l.solid.edges != null )) throw new Error( `Model: the round "${solidId}" is over a rounded operand, which cannot be rounded again yet` );
                const edges : Array<{ solid : number, faces : [number, number], radius : number }> = [];
                t.leaves.forEach( (l, si) => BrepEdges.all( l.solid ).forEach( e => {
                    const r = radius( Model.edgeName( leafName( si, e.faces[0] ), leafName( si, e.faces[1] ) ) );
                    if (r > 0) edges.push( { solid : si, faces : e.faces, radius : r } );
                } ) );
                options = { ...options,
                    fillet : (c : { solids : [number, number], faces : [number, number] }) => radius( Model.edgeName( leafName( c.solids[0], c.faces[0] ), leafName( c.solids[1], c.faces[1] ) ) ),
                    edges : edges, filletShape : round.shape, filletCorner : round.corner,
                };
            }
            let r = BrepBoolean.evaluate( t.leaves.map( l => l.solid ), t.expr, options );
            // one solid made from a shell, as it is (no other operand, nothing rounded, each face whole): the shell is
            // the result's exact boundary, so its volume is the exact one (on the faces, not the mesh's chords) and it
            // meshes for export as it is, without fitting a shell back to the result (#117)
            let shell : BrepShell | undefined;
            const source = t.leaves.length == 1 && round == null ? ShellBuilder.sourceOf( t.leaves[0].solid ) : undefined;
            if (source != null && r.faces.length == source.faces.length && r.faces.every( (f, k) => f.solid == 0 && f.face == k )
                && source.faces.every( (f, k) => f.source == k )) {
                shell = source;
                r = { ...r, report : { ...r.report, volume : source.volume ?? ShellBuilder.volume( source ) } };
            }
            // a rule that selected no edge, of the operands or new, is said (a pattern written the wrong way round, or
            // naming a face that is not there, would otherwise round nothing in silence)
            const unmatched = round == null ? [] : rules.filter( x => x.hits == 0 ).map( x => `"${solidId}": "${x.edges}"` );
            const fillets = unmatched.length == 0 ? t.fillets : Model.addFillets( [t.fillets, { failed : 0, skipped : 0, reduced : 0, unmatched : unmatched }] );
            return { result : r, names : Model.names( r, leafName, (si, fi) => t.leaves[si].solid.faces[fi].half === true ), walls : t.shells.map( s => Model.wall( r, s, leafName ) ), fillets : fillets, shell : shell };
        } );

        // the output: a Boolean of its tree, rounded if it is a round
        const lat = features[doc.output].type == "lattice" ? features[doc.output] as Extract<ModelFeature, { type : "lattice" }> : null;
        const solidId = lat != null ? lat.of : doc.output;
        const out = features[solidId];
        if (out.type == "lattice") throw new Error( `Model: the lattice "${doc.output}" fills "${solidId}", another lattice` );
        const solid = build( solidId );

        const lattice = lat == null ? undefined : cached( "lattice", doc.output, () => Model.lattice( doc.output, lat, solid.result, solid.names, num ) );
        const verdict = Model.verdict( solid.result, doc.machine, solid.walls, lattice, solid.fillets );
        const faceIndex : { [name : string] : number } = {};
        solid.names.forEach( (n, k) => { faceIndex[n] = k; } );
        const report : ModelResult["features"] = {};
        for (const [id, h] of hashes) report[id] = { hash : h, built : built.has( id ) };
        return { result : solid.result, faceNames : solid.names, faceIndex : faceIndex, verdict : verdict, features : report, parameters : params, walls : solid.walls, lattice : lattice, shell : solid.shell,
            ...(Object.keys( chosen ).length ? { chosen : chosen } : {}) };
    }

    /**
     * A document with its switches (`choose` features) resolved at the parameters' values: each reference to a switch
     * becomes the feature it chooses, and nothing (a switch with no feature on the side chosen) drops out of a union
     * and out of a difference's cutters; a union left with one solid, and a difference left with no cutter, are that
     * solid. A transform, round, shell or lattice of nothing, a difference from nothing and an intersection with
     * nothing are nothing; an output that is nothing is refused ("switched off"). `chosen` gets each switch reached:
     * true for `then`. A document without switches is returned as it is.
     */
    public static choose( doc : ModelDocument, params : { [name : string] : number }, chosen : { [id : string] : boolean } = {} ) : ModelDocument {
        const features = doc.features;
        if (!Object.values( features ).some( f => f.type == "choose" )) return doc;
        const out : { [id : string] : ModelFeature } = {};
        // the feature an id stands for once switches are resolved (itself, another, or null: nothing)
        const memo = new Map<string, string | null>(), visiting = new Set<string>();
        const at = ( id : string ) : string | null => {
            if (memo.has( id )) return memo.get( id )!;
            const f = features[id];
            if (f == null) throw new Error( `Model: unknown feature "${id}"` );
            if (visiting.has( id )) throw new Error( `Model: feature "${id}" depends on itself` );
            visiting.add( id );
            let r : string | null = id;
            switch (f.type) {
                case "choose": {
                    let on : boolean;
                    try {
                        on = (typeof f.when == "number" ? f.when : Expr.evaluate( f.when, params )) != 0;
                    } catch (e) { throw new ModelError( e instanceof Error ? e.message : String( e ), { feature : id, type : f.type } ); }
                    chosen[id] = on;
                    const next = on ? f.then : f.else;
                    r = next == null ? null : at( next );
                    break;
                }
                case "transform": case "round": case "shell": case "lattice": {
                    const of = at( f.of );
                    if (of == null) r = null; else out[id] = { ...f, of : of };
                    break;
                }
                case "union": {
                    const of = f.of.map( at ).filter( (x) : x is string => x != null );
                    if (of.length == 0) r = null; else if (of.length == 1) r = of[0]; else out[id] = { ...f, of : of };
                    break;
                }
                case "intersection": {
                    const of = f.of.map( at );
                    if (of.some( x => x == null )) r = null; else out[id] = { ...f, of : of as Array<string> };
                    break;
                }
                case "difference": {
                    const from = at( f.from ), minus = f.minus.map( at ).filter( (x) : x is string => x != null );
                    if (from == null) r = null; else if (minus.length == 0) r = from; else out[id] = { ...f, from : from, minus : minus };
                    break;
                }
                default: out[id] = f;
            }
            visiting.delete( id );
            memo.set( id, r );
            return r;
        };
        const output = at( doc.output );
        if (output == null) throw new ModelError( `Model: the output "${doc.output}" is switched off: nothing is left of it`, { feature : doc.output, type : features[doc.output].type } );
        return { ...doc, features : out, output : output };
    }

    /**
     * A document whose solid is a round moved by transforms (the round of a part, then placed), rewritten as the round
     * of the moved part: rigid motions commute with rounding, and a uniform scale does once the radii are scaled with
     * it, so the solid is the same, and the round stays the last feature, as the single Boolean that builds it needs.
     * (A scale that differs along the axes does not commute: such a document is left as it is, and refused.) The round takes the id of the outermost
     * transform's round, its edge patterns gain the transforms' path ("T/" before each name, as the faces under T
     * are named), and its faces are named `round(T/a.x|T/b.y)`. Any other document is returned as it is.
     */
    public static liftRound( doc : ModelDocument ) : ModelDocument {
        const features = doc.features;
        const top = features[doc.output];
        const solidId = top.type == "lattice" ? top.of : doc.output;
        const chain : Array<string> = [];
        let id = solidId;
        while (features[id]?.type == "transform") { chain.push( id ); id = (features[id] as Extract<ModelFeature, { type : "transform" }>).of; }
        const round = features[id];
        if (chain.length == 0 || round?.type != "round") return doc;
        // the product of the chain's uniform scales, by which the radii grow (its size: a mirror rounds the same)
        const factors : Array<ModelValue> = [];
        for (const t of chain) {
            const sc = (features[t] as Extract<ModelFeature, { type : "transform" }>).scale;
            if (sc == null) continue;
            if (!Array.isArray( sc )) { factors.push( sc ); continue; }
            if (Model.canonical( sc[0] ) != Model.canonical( sc[1] ) || Model.canonical( sc[0] ) != Model.canonical( sc[2] )) return doc;
            factors.push( sc[0] );
        }
        const grow = ( r : ModelValue ) : ModelValue => factors.length == 0 ? r
            : factors.every( f => typeof f == "number" ) && typeof r == "number" ? factors.reduce( (a : number, f) => a * Math.abs( f as number ), r )
            : `(${r})` + factors.map( f => ` * abs(${f})` ).join( "" );
        const path = chain.join( "/" ) + "/";
        const prefix = ( g : string ) => g.split( "|" ).map( t => path + t ).join( "|" );
        const out : { [id : string] : ModelFeature } = { ...features };
        const last = chain[chain.length - 1];
        out[last] = { ...(features[last] as Extract<ModelFeature, { type : "transform" }>), of : round.of };
        out[id] = { ...round, of : chain[0], rules : round.rules.map( r => ({ edges : prefix( r.edges ), radius : grow( r.radius ) }) ) };
        if (top.type == "lattice") return { ...doc, features : { ...out, [doc.output] : { ...top, of : id } } };
        return { ...doc, features : out, output : id };
    }

    // ---------- parameters and values ----------

    // The parameters' values, each expression evaluated after the parameters it uses.
    public static parameters( defs : { [name : string] : ModelValue } ) : { [name : string] : number } {
        const out : { [name : string] : number } = {}, visiting = new Set<string>();
        const value = (name : string) : number => {
            if (Object.prototype.hasOwnProperty.call( out, name )) return out[name];
            const d = defs[name];
            if (visiting.has( name )) throw new Error( `Model: parameter "${name}" depends on itself` );
            visiting.add( name );
            let v : number;
            if (typeof d == "number") v = d;
            else {
                const scope : { [name : string] : number } = {};
                for (const n of Expr.names( d )) {
                    if (!Object.prototype.hasOwnProperty.call( defs, n )) throw new Error( `Model: parameter "${name}" uses "${n}", which is not a parameter` );
                    scope[n] = value( n );
                }
                v = Expr.evaluate( d, scope );
            }
            if (!isFinite( v )) throw new Error( `Model: parameter "${name}" is not finite` );
            visiting.delete( name );
            out[name] = v;
            return v;
        };
        for (const name of Object.keys( defs ).sort()) value( name );
        return out;
    }

    // A feature's own values, resolved to numbers (its inputs are ids, left out).
    private static resolve( f : ModelFeature, num : (v : ModelValue, what : string) => number, point : (p : ModelPoint, what : string) => Point ) : unknown {
        const pair = (v : [ModelValue, ModelValue] | undefined, what : string) => v == null ? null : [num( v[0], what ), num( v[1], what )];
        switch (f.type) {
            case "box": return { min : point( f.min, "min" ), max : point( f.max, "max" ), divs : f.divs == null ? null : num( f.divs, "divs" ) };
            case "cylinder": return { from : point( f.from, "from" ), to : point( f.to, "to" ), radius : num( f.radius, "radius" ), divs : pair( f.divs, "divs" ) };
            case "pipe": return { through : f.through.map( (p, k) => point( p, "through[" + k + "]" ) ), radius : num( f.radius, "radius" ), divs : pair( f.divs, "divs" ) };
            case "revolve": return { profile : f.profile.map( (p, k) => [num( p[0], `profile[${k}]` ), num( p[1], `profile[${k}]` )] ), divs : pair( f.divs, "divs" ) };
            case "primitive": return { shape : f.shape, values : Model.primitiveValues( f.values, num ) };
            case "prism": return { outline : Model.outline( f, num ), height : num( f.height, "height" ) };
            case "extrude": return { profile : f.profile, height : num( f.height, "height" ), z : f.z == null ? 0 : num( f.z, "z" ),
                ...(f.twist != null ? { twist : num( f.twist, "twist" ) } : {}), ...(f.scaleTop != null ? { scaleTop : num( f.scaleTop, "scaleTop" ) } : {}) };
            case "lathe": return { profile : f.profile, degrees : f.degrees == null ? 360 : num( f.degrees, "degrees" ) };
            case "transform": return Model.matrix( f, num, point );
            case "union": case "intersection": return { n : f.of.length };
            case "difference": return { n : f.minus.length };
            case "round": return { rules : f.rules.map( r => [r.edges, num( r.radius, "radius" )] ), shape : f.shape ?? "circular", corner : f.corner ?? "auto" };
            case "shell": return { thickness : num( f.thickness, "thickness" ), open : f.open ?? [] };
            case "lattice": return { pattern : f.pattern, cell : num( f.cell, "cell" ), wall : num( f.wall, "wall" ), skin : num( f.skin ?? 0, "skin" ),
                                     blend : num( f.blend ?? 0, "blend" ), size : f.size == null ? null : num( f.size, "size" ),
                                     grade : f.grade == null ? null : [f.grade.axis, num( f.grade.to, "grade" )], open : f.open ?? [] };
        }
        throw new Error( `Model: unknown feature type "${(f as { type : string }).type}"` );
    }

    private static inputs( f : ModelFeature ) : Array<string> {
        switch (f.type) {
            case "transform": case "round": case "shell": case "lattice": return [f.of];
            case "union": case "intersection": return f.of;
            case "difference": return [f.from].concat( f.minus );
            default: return [];
        }
    }

    // ---------- primitives and placement ----------

    private static primitive( f : ModelFeature, num : (v : ModelValue, what : string) => number, point : (p : ModelPoint, what : string) => Point ) : BrepSolid {
        const divs = (d : [ModelValue, ModelValue] | undefined, def : [number, number]) : [number, number] =>
            d == null ? def : [Math.max( 2, Math.round( num( d[0], "divs" ) ) ), Math.max( 3, Math.round( num( d[1], "divs" ) ) )];
        const positive = (x : number, what : string) => { if (!(x > 0)) throw new Error( `Model: ${what} must be positive` ); return x; };
        switch (f.type) {
            case "primitive": return Catalog.build( f.shape, Model.primitiveValues( f.values, num ) );
            case "prism": {
                // an exact extrusion (`Extrusion`): caps that are planes trimmed by the outline, so any simple polygon
                // will do and a Boolean does not depend on where a fan's centre falls (#99). (`center`, the point the
                // caps fanned from before, is no longer read.)
                const pts = Model.outline( f, num ), h = positive( num( f.height, "height" ), "a prism's height" );
                return Extrusion.solid( Model.outlineProfile( pts ), h );
            }
            case "extrude": return Extrusion.solid( f.profile, num( f.height, "height" ), f.z == null ? 0 : num( f.z, "z" ),
                { twist : f.twist == null ? 0 : num( f.twist, "twist" ), scaleTop : f.scaleTop == null ? 1 : num( f.scaleTop, "scaleTop" ) } );
            case "lathe": return Lathe.solid( f.profile, f.degrees == null ? 360 : num( f.degrees, "degrees" ) );
            case "box": {
                const a = point( f.min, "min" ), b = point( f.max, "max" );
                for (let k = 0; k < 3; k++) if (!(b[k] > a[k])) throw new Error( "Model: a box's max must exceed its min on every axis" );
                return BrepSolid.box( a, b, f.divs == null ? 12 : Math.max( 2, Math.round( num( f.divs, "divs" ) ) ) );
            }
            case "cylinder": {
                const a = point( f.from, "from" ), b = point( f.to, "to" );
                if (Vec.dist( a, b ) == 0) throw new Error( "Model: a cylinder's ends must differ" );
                // exact: a rational circle (at `to`) moved along the axis (to `from` at u = 0), not a swept approximation,
                // so that copies of one cylinder, moved or turned, are the same surface
                const r = positive( num( f.radius, "radius" ), "a cylinder's radius" ), axis = Vec.normalized( Vec.sub( b, a ) );
                const k = [0, 1, 2].reduce( (m, i) => Math.abs( axis[i] ) < Math.abs( axis[m] ) - 1e-12 ? i : m, 0 );
                const e = [0, 0, 0]; e[k] = 1;
                const x = Vec.normalized( Vec.sub( e, Vec.mul( Vec.dot( e, axis ), axis ) ) ), y = Vec.cross( axis, x );
                const tube = Make.extrudedSurface( Vec.mul( -1, axis ), Vec.dist( a, b ), Make.arc( b, x, y, r, 0, 2 * Math.PI ) );
                return BrepSolid.cappedTube( tube, divs( f.divs, [24, 96] ) );
            }
            case "pipe": {
                if (f.through.length < 2) throw new Error( "Model: a pipe runs through two points or more" );
                const pts = f.through.map( (p, k) => point( p, "through[" + k + "]" ) );
                return BrepSolid.cappedTube( Sweep.pipe( Model.rail( pts ), positive( num( f.radius, "radius" ), "a pipe's radius" ) ).surface, divs( f.divs, [48, 64] ) );
            }
            case "revolve": {
                // circles of the profile's radii at its heights, lofted (u around), turned so that u runs up the
                // axis and v around it, the layout `cappedWall` takes
                if (f.profile.length < 2) throw new Error( "Model: a revolve's profile has two points or more" );
                const prof = f.profile.map( (p, k) => [num( p[0], `profile[${k}]` ), num( p[1], `profile[${k}]` )] );
                prof.forEach( (p, k) => {
                    if (!(p[0] > 0)) throw new Error( "Model: a revolve's radii must be positive" );
                    if (k > 0 && !(p[1] > prof[k - 1][1])) throw new Error( "Model: a revolve's heights must increase" );
                } );
                const circles = prof.map( p => Make.arc( [0, 0, p[1]], [1, 0, 0], [0, 1, 0], p[0], 0, 2 * Math.PI ) );
                const wall = Model.transpose( Make.loftedSurface( circles, Math.min( 3, circles.length - 1 ) ) );
                return BrepSolid.cappedWall( wall, divs( f.divs, [Math.max( 8, 8 * (prof.length - 1) ), 96] ) );
            }
        }
        throw new Error( "Model: not a primitive: " + f.type );
    }

    // An outline with rounded corners as an exact profile: at a corner of radius r between its neighbours, the arc of
    // that radius tangent to both sides (from the side's tangent point to the other's, through the arc's middle), and
    // lines between. Refuses radii whose arcs would overlap along a side.
    private static outlineProfile( pts : Array<[number, number, number]> ) : ProfileSpec {
        const n = pts.length;
        const corners = pts.map( (p, i) => {
            const a = pts[(i + n - 1) % n], b = pts[(i + 1) % n], r = p[2];
            if (!(r > 0)) return { in : [p[0], p[1]] as ProfilePoint, out : [p[0], p[1]] as ProfilePoint, via : null as ProfilePoint | null, d : 0 };
            const ua = Vec.normalized( [a[0] - p[0], a[1] - p[1], 0] ), ub = Vec.normalized( [b[0] - p[0], b[1] - p[1], 0] );
            const cos = Math.max( -1, Math.min( 1, Vec.dot( ua, ub ) ) ), half = Math.acos( cos ) / 2;
            if (!(half > 1e-6) || !(half < Math.PI / 2 - 1e-6)) throw new Error( `Model: outline corner ${i} is too flat or too sharp to round` );
            const d = r / Math.tan( half ), bis = Vec.normalized( Vec.add( ua, ub ) ), toC = r / Math.sin( half );
            const c = [p[0] + bis[0] * toC, p[1] + bis[1] * toC];
            return { in : [p[0] + ua[0] * d, p[1] + ua[1] * d] as ProfilePoint, out : [p[0] + ub[0] * d, p[1] + ub[1] * d] as ProfilePoint,
                     via : [c[0] - bis[0] * r, c[1] - bis[1] * r] as ProfilePoint, d };
        } );
        for (let i = 0; i < n; i++) {
            const j = (i + 1) % n, len = Math.hypot( pts[j][0] - pts[i][0], pts[j][1] - pts[i][1] );
            if (corners[i].d + corners[j].d > len * (1 + 1e-9)) throw new Error( `Model: the rounded corners ${i} and ${j} overlap along their side (radii too large)` );
        }
        const segments : Array<ProfileSegmentSpec> = [];
        const same = (u : ProfilePoint, v : ProfilePoint) => Math.hypot( u[0] - v[0], u[1] - v[1] ) < 1e-12;
        let at = corners[0].out;
        for (let k = 1; k <= n; k++) {
            const c = corners[k % n];
            if (!same( at, c.in )) segments.push( { type : "line", to : c.in } );
            if (c.via != null) segments.push( { type : "arc", via : c.via, to : c.out } );
            at = c.out;
        }
        return { outer : { kind : "path", start : corners[0].out, segments } };
    }

    // a prism's outline, resolved: [x, y, r] per point (r 0 for a sharp corner)
    private static outline( f : Extract<ModelFeature, { type : "prism" }>, num : (v : ModelValue, what : string) => number ) : Array<[number, number, number]> {
        if (f.outline.length < 3) throw new Error( "Model: a prism's outline has three points or more" );
        return f.outline.map( (p, k) => {
            if (p.length != 2 && p.length != 3) throw new Error( `Model: outline[${k}] is [x, y] or [x, y, r]` );
            const r = p.length == 3 ? num( p[2], `outline[${k}]` ) : 0;
            if (!(r >= 0)) throw new Error( `Model: outline[${k}]'s corner radius must be 0 or more` );
            return [num( p[0], `outline[${k}]` ), num( p[1], `outline[${k}]` ), r];
        } );
    }

    // a catalogue primitive's values, resolved, by sorted name (so its hash does not depend on their order)
    private static primitiveValues( values : { [name : string] : ModelValue } | undefined, num : (v : ModelValue, what : string) => number ) : { [name : string] : number } {
        const out : { [name : string] : number } = {};
        for (const k of Object.keys( values ?? {} ).sort()) out[k] = num( (values as { [name : string] : ModelValue })[k], k );
        return out;
    }

    private static rail( pts : Array<Point> ) : NurbsCurveData {
        return pts.length == 2 ? Make.rationalBezierCurve( pts ) : Make.rationalInterpCurve( pts, Math.min( 3, pts.length - 1 ) );
    }

    // A primitive offset face by face: `by(face)` is how far its face moves in (out when negative). Boxes and
    // cylinders stay boxes and cylinders, mitred at their edges: in, that is the exact offset; out, it contains it.
    // A pipe's tube is offset exactly (radius less d, while d is under the rail's radius of curvature), and its ends
    // move along the rail. Returns null when nothing is left.
    private static offsetPrimitive( f : ModelFeature, by : (face : string) => number, num : (v : ModelValue, what : string) => number, point : (p : ModelPoint, what : string) => Point, id : string ) : BrepSolid | null {
        switch (f.type) {
            case "box": {
                const a = point( f.min, "min" ), b = point( f.max, "max" );
                const lo = [0, 1, 2].map( k => a[k] + by( "-" + "xyz"[k] ) ), hi = [0, 1, 2].map( k => b[k] - by( "+" + "xyz"[k] ) );
                if ([0, 1, 2].some( k => !(hi[k] > lo[k]) )) return null;
                return Model.primitive( { type : "box", min : lo as ModelPoint, max : hi as ModelPoint, divs : f.divs }, num, point );
            }
            case "cylinder": case "pipe": {
                const pts = f.type == "cylinder" ? [point( f.from, "from" ), point( f.to, "to" )] : f.through.map( (p, k) => point( p, "through[" + k + "]" ) );
                const r = num( f.radius, "radius" ) - by( "tube" ), s0 = by( "start cap" ), s1 = by( "end cap" );
                if (!(r > 0)) return null;
                const divs = f.divs;
                if (pts.length == 2) {
                    const u = Vec.normalized( Vec.sub( pts[1], pts[0] ) );
                    const a = Vec.add( pts[0], Vec.mul( s0, u ) ), b = Vec.sub( pts[1], Vec.mul( s1, u ) );
                    if (!(Vec.dot( Vec.sub( b, a ), u ) > 0)) return null;
                    return f.type == "cylinder" ? Model.primitive( { type : "cylinder", from : a as ModelPoint, to : b as ModelPoint, radius : r, divs : divs }, num, point )
                        : Model.primitive( { type : "pipe", through : [a as ModelPoint, b as ModelPoint], radius : r, divs : divs }, num, point );
                }
                // a curved rail: cut back by arc length (moving a curved pipe's end out is not done yet)
                if (s0 < 0 || s1 < 0) throw new Error( `Model: a shell cannot yet move the end of the curved pipe "${id}" out (an open end, or a pipe taken away)` );
                let rail = Model.rail( pts );
                const len = Analyze.rationalCurveArcLength( rail );
                if (!(s0 + s1 < len)) return null;
                const at = (l : number) => {
                    let lo = rail.knots[0], hi = rail.knots[rail.knots.length - 1];
                    for (let k = 0; k < 60; k++) { const m = 0.5 * (lo + hi); if (Analyze.rationalCurveArcLength( rail, m ) < l) lo = m; else hi = m; }
                    return 0.5 * (lo + hi);
                };
                const u1 = at( len - s1 ), u0 = at( s0 );
                if (s1 > 0) rail = Divide.curveSplit( rail, u1 )[0];
                if (s0 > 0) rail = Divide.curveSplit( rail, u0 )[1];
                const dv = divs == null ? [48, 64] : [Math.max( 2, Math.round( num( divs[0], "divs" ) ) ), Math.max( 3, Math.round( num( divs[1], "divs" ) ) )];
                return BrepSolid.cappedTube( Sweep.pipe( rail, r ).surface, dv as [number, number] );
            }
            case "revolve": throw new Error( `Model: a shell cannot yet offset the revolve "${id}"` );
        }
        throw new Error( "Model: not a primitive: " + f.type );
    }

    // The scale of an affine map that is a similarity (a rotation, mirror and uniform scale, then a translation), or
    // null when it is not one.
    private static similarity( M : Array<Array<number>> ) : number | null {
        const col = (j : number) => [M[0][j], M[1][j], M[2][j]];
        const s2 = Vec.dot( col( 0 ), col( 0 ) );
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++)
            if (Math.abs( Vec.dot( col( i ), col( j ) ) - (i == j ? s2 : 0) ) > 1e-9 * s2) return null;
        return Math.sqrt( s2 );
    }

    private static shift( s : Shelled, by : number ) : Shelled {
        return { ...s, outside : [s.outside[0] + by, s.outside[1] + by], inside : [s.inside[0] + by, s.inside[1] + by] };
    }

    // The affine map of a transform, as rows [a b c t] of a 3x4 matrix.
    private static matrix( f : Extract<ModelFeature, { type : "transform" }>, num : (v : ModelValue, what : string) => number, point : (p : ModelPoint, what : string) => Point ) : Array<Array<number>> {
        let M = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]];
        const then = (A : Array<Array<number>>) => {
            // A after M
            M = A.map( row => [0, 1, 2, 3].map( j => row[0] * M[0][j] + row[1] * M[1][j] + row[2] * M[2][j] + (j == 3 ? row[3] : 0) ) );
        };
        if (f.scale != null) {
            const s = Array.isArray( f.scale ) ? point( f.scale, "scale" ) : [num( f.scale, "scale" ), num( f.scale, "scale" ), num( f.scale, "scale" )];
            if (s.some( x => x == 0 )) throw new Error( "Model: a scale must not be zero" );
            then( [[s[0], 0, 0, 0], [0, s[1], 0, 0], [0, 0, s[2], 0]] );
        }
        if (f.rotate != null) {
            const ax = point( f.rotate.axis, "rotate.axis" ), len = Vec.norm( ax );
            if (len == 0) throw new Error( "Model: a rotation's axis must not be zero" );
            const [x, y, z] = Vec.mul( 1 / len, ax ), a = num( f.rotate.degrees, "rotate.degrees" ) * Math.PI / 180;
            const c = Math.cos( a ), s = Math.sin( a ), t = 1 - c;
            const R = [[t * x * x + c, t * x * y - s * z, t * x * z + s * y], [t * x * y + s * z, t * y * y + c, t * y * z - s * x], [t * x * z - s * y, t * y * z + s * x, t * z * z + c]];
            const o = f.rotate.about != null ? point( f.rotate.about, "rotate.about" ) : [0, 0, 0];
            // rotate about o: p -> R (p - o) + o
            then( R.map( (row, i) => [row[0], row[1], row[2], o[i] - (row[0] * o[0] + row[1] * o[1] + row[2] * o[2])] ) );
        }
        if (f.translate != null) {
            const t = point( f.translate, "translate" );
            then( [[1, 0, 0, t[0]], [0, 1, 0, t[1]], [0, 0, 1, t[2]]] );
        }
        return M;
    }

    // A solid moved by an affine map: each face's control points (homogeneous: the map applies to w p, the weight
    // carries the translation), then the faces' sides found again (a mirror turns them inside out).
    private static transform( s : BrepSolid, M : Array<Array<number>> ) : BrepSolid {
        const move = (p : Array<number>) => {
            const w = p.length == 4 ? p[3] : 1;
            const q = [0, 1, 2].map( i => M[i][0] * p[0] + M[i][1] * p[1] + M[i][2] * p[2] + M[i][3] * w );
            return p.length == 4 ? [q[0], q[1], q[2], w] : q;
        };
        const faces : Array<BrepFace> = s.faces.map( f => ({
            surface : new NurbsSurfaceData( f.surface.degreeU, f.surface.degreeV, f.surface.knotsU.slice(), f.surface.knotsV.slice(), f.surface.controlPoints.map( row => row.map( move ) ) ),
            periodic : [f.periodic[0], f.periodic[1]], divs : [f.divs[0], f.divs[1]], reversed : false, name : f.name,
            // (the halves of a circle's side keep sharing its name, #122)
            ...(f.half === true ? { half : true } : {}),
        }) );
        if (s.edges == null || s.boundary == null) return new BrepSolid( faces ).orient();
        // a solid of trimmed faces (a rounded operand): its trims and its edges' parameters stay, its edges' points and
        // its boundary move, and a mirror turns every face and triangle over
        const det = M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
        faces.forEach( (f, k) => { f.reversed = det < 0 ? !s.faces[k].reversed : s.faces[k].reversed; f.trims = s.faces[k].trims; } );
        const out = new BrepSolid( faces );
        // (edges share their end points, as one object each: they stay shared)
        const moved = new Map<Point, Point>();
        const once = (p : Point) => { let q = moved.get( p ); if (q == null) moved.set( p, q = move( p ) as Point ); return q; };
        out.edges = s.edges.map( e => ({ ...e, points : e.points.map( once ) }) );
        const mesh = new TriMesh();
        for (const v of s.boundary.vertices) mesh.addVertex( move( v ) as Point );
        for (const t of s.boundary.triangles) if (det < 0) mesh.addTriangle( t[0], t[2], t[1] ); else mesh.addTriangle( t[0], t[1], t[2] );
        out.boundary = mesh;
        return out;
    }

    private static transpose( s : NurbsSurfaceData ) : NurbsSurfaceData {
        const cp = s.controlPoints[0].map( (_, j) => s.controlPoints.map( row => row[j] ) );
        return new NurbsSurfaceData( s.degreeV, s.degreeU, s.knotsV.slice(), s.knotsU.slice(), cp );
    }

    // ---------- names ----------

    // The sum of what several rounds left undone (null when none of them is a round).
    private static addFillets( xs : Array<Fillets | undefined> ) : Fillets | undefined {
        const ys = xs.filter( (x) : x is Fillets => x != null );
        if (ys.length == 0) return undefined;
        return { failed : ys.reduce( (a, x) => a + x.failed, 0 ), skipped : ys.reduce( (a, x) => a + x.skipped, 0 ), reduced : ys.reduce( (a, x) => a + x.reduced, 0 ),
                 unmatched : ys.flatMap( x => x.unmatched ?? [] ) };
    }

    private static faceName( f : BrepFace, index : number ) : string {
        return f.name != null && f.name != "" ? f.name : "face" + index;
    }

    public static edgeName( a : string, b : string ) : string {
        return a < b ? a + "|" + b : b + "|" + a;
    }

    // A glob pattern ("*" for any run of characters) as an anchored regular expression.
    public static pattern( glob : string ) : RegExp {
        return new RegExp( "^" + glob.split( "*" ).map( s => s.replace( /[.+?^${}()|[\]\\]/g, "\\$&" ) ).join( ".*" ) + "$" );
    }

    // Persistent names of a Boolean result's faces (see the class comment).
    private static names( r : BooleanResult, leafName : (solid : number, face : number) => string, half : (solid : number, face : number) => boolean = () => false ) : Array<string> {
        const n = r.faces.length;
        const base : Array<string> = new Array( n ).fill( "" );
        r.faces.forEach( (f, k) => { if (f.solid >= 0) base[k] = leafName( f.solid, f.face ); } );
        // fillets: blends are added in the order of `fillets`, after the trimmed faces
        const firstBlend = r.faces.findIndex( f => f.solid < 0 );
        r.fillets.forEach( (fl, k) => {
            const c = r.curves[fl.curve];
            base[firstBlend + k] = "round(" + Model.edgeName( leafName( c.solids[0], c.faces[0] ), leafName( c.solids[1], c.faces[1] ) ) + ")";
        } );
        // corners: after the faces their fillets join
        const adjacent = Model.adjacency( r );
        for (const c of r.corners) {
            const around = new Set<string>();
            for (const fi of c.faces) for (const g of adjacent[fi]) {
                const m = /^round\((.*)\)$/.exec( base[g] );
                if (m != null) m[1].split( "|" ).forEach( x => around.add( x ) );
            }
            const name = "corner(" + Array.from( around ).sort().join( "|" ) + ")";
            c.faces.forEach( (fi, k) => { base[fi] = c.faces.length > 1 ? name + "." + k : name; } );
        }
        r.faces.forEach( (f, k) => { if (base[k] == "") base[k] = f.name != "" ? f.name : "face" + k; } );
        // pieces of one face: by decreasing area, then by their centroids
        const area = new Array( n ).fill( 0 ), centroid = r.faces.map( () => [0, 0, 0] as Point );
        r.mesh.triangles.forEach( (t, k) => {
            const a = r.mesh.vertices[t[0]], b = r.mesh.vertices[t[1]], c = r.mesh.vertices[t[2]];
            const ar = 0.5 * Vec.norm( Vec.cross( Vec.sub( b, a ), Vec.sub( c, a ) ) ), f = r.faceOf[k];
            area[f] += ar;
            centroid[f] = Vec.add( centroid[f], Vec.mul( ar / 3, Vec.add( a, Vec.add( b, c ) ) ) );
        } );
        const groups = new Map<string, Array<number>>();
        base.forEach( (b, k) => { let g = groups.get( b ); if (g == null) groups.set( b, g = [] ); g.push( k ); } );
        const out = base.slice();
        for (const [name, g] of groups) {
            if (g.length < 2) continue;
            // the halves of one side round a circle, each whole, are that one face (#122)
            const leaves = new Set( g.map( k => r.faces[k].solid + ":" + r.faces[k].face ) );
            if (leaves.size == g.length && g.every( k => r.faces[k].solid >= 0 && half( r.faces[k].solid, r.faces[k].face ) )) continue;
            const key = (k : number) => [-Model.round( area[k] ), ...centroid[k].map( x => Model.round( area[k] > 0 ? x / area[k] : 0 ) )];
            g.sort( (p, q) => { const a = key( p ), b = key( q ); for (let i = 0; i < 4; i++) if (a[i] != b[i]) return a[i] - b[i]; return p - q; } );
            g.forEach( (k, j) => { out[k] = name + "#" + (j + 1); } );
        }
        return out;
    }

    // to 9 significant digits: orders by value, not by the last bits of a sum
    private static round( x : number ) : number {
        return x == 0 ? 0 : Number( x.toPrecision( 9 ) );
    }

    // For each face, the faces it shares a mesh edge with.
    private static adjacency( r : BooleanResult ) : Array<Set<number>> {
        const out = r.faces.map( () => new Set<number>() );
        const owner = new Map<string, number>();
        r.mesh.triangles.forEach( (t, k) => {
            for (let x = 0; x < 3; x++) {
                const a = t[x], b = t[(x + 1) % 3], key = a < b ? a + "," + b : b + "," + a;
                const o = owner.get( key );
                if (o == null) owner.set( key, r.faceOf[k] );
                else if (o != r.faceOf[k]) { out[o].add( r.faceOf[k] ); out[r.faceOf[k]].add( o ); }
            }
        } );
        return out;
    }

    // ---------- lattices ----------

    // A solid's lattice infill (`Implicit.infill`), with the wall graded along an axis of the solid's bounding box.
    private static lattice( id : string, f : Extract<ModelFeature, { type : "lattice" }>, solid : BooleanResult, names : Array<string>, num : (v : ModelValue, what : string) => number ) : ModelLattice {
        const patterns : Array<LatticePattern> = ["gyroid", "schwarz-p", "diamond", "bcc", "octet", "cubic"];
        if (!patterns.includes( f.pattern )) throw new Error( `Model: the lattice "${id}" has an unknown pattern "${String( f.pattern )}" (${patterns.join( ", " )})` );
        const cell = num( f.cell, `"${id}" cell` ), wall = num( f.wall, `"${id}" wall` ), skin = num( f.skin ?? 0, `"${id}" skin` );
        const blend = num( f.blend ?? 0, `"${id}" blend` );
        if (!(cell > 0) || !(wall > 0) || !(wall < cell)) throw new Error( `Model: the lattice "${id}" needs 0 < wall < cell` );
        if (!(skin >= 0) || !(blend >= 0)) throw new Error( `Model: the lattice "${id}" needs a skin and a blend of 0 or more` );
        if (!solid.report.manifold.closedManifold) throw new Error( `Model: the lattice "${id}" fills "${f.of}", which is not a closed solid` );
        let to = wall, grade : number | ((p : Point) => number) = wall;
        if (f.grade != null) {
            const ax = ["x", "y", "z"].indexOf( f.grade.axis );
            if (ax < 0) throw new Error( `Model: the lattice "${id}" grades along x, y or z, not "${String( f.grade.axis )}"` );
            to = num( f.grade.to, `"${id}" grade` );
            if (!(to > 0) || !(to < cell)) throw new Error( `Model: the lattice "${id}" needs 0 < grade.to < cell` );
            const bb = solid.mesh.boundingBox(), lo = bb.min[ax], hi = bb.max[ax];
            grade = (p : Point) => wall + (to - wall) * Math.max( 0, Math.min( 1, (p[ax] - lo) / (hi - lo) ) );
        }
        const size = f.size == null ? Math.min( cell / 8, skin > 0 ? skin / 1.5 : Infinity, Math.min( wall, to ) / 3 ) : num( f.size, `"${id}" size` );
        if (!(size > 0)) throw new Error( `Model: the lattice "${id}" needs a positive size` );
        const open = (f.open ?? []).map( Model.pattern );
        (f.open ?? []).forEach( (g, k) => {
            if (!names.some( n => open[k].test( n ) )) throw new Error( `Model: the lattice "${id}" opens "${g}", which names no face of "${f.of}"` );
        } );
        const openFace = names.map( n => open.some( re => re.test( n ) ) );
        const mesh = Implicit.infill( solid.mesh, { pattern : f.pattern, cell : cell, wall : grade, skin : skin, blend : blend, size : size,
                                                    open : open.length == 0 ? undefined : solid.faceOf.map( k => openFace[k] ) } );
        const volume = mesh.signedVolume();
        const pieces = mesh.pieces();
        return { mesh : mesh, pattern : f.pattern, cell : cell, wall : [wall, to], skin : skin, volume : volume, fraction : volume / solid.report.volume,
                 bodies : pieces.filter( p => p.volume > 0 ).length, voids : pieces.filter( p => p.volume < 0 ).length, size : size };
    }

    // ---------- verdict ----------

    // A shell's thinnest wall on the result: the smallest distance from a vertex of the inside faces to the outside
    // faces, measured on the mesh up to twice the thickness.
    private static wall( r : BooleanResult, s : Shelled, leafName : (solid : number, face : number) => string ) : ModelWall {
        const within = (k : number, range : [number, number]) => k >= range[0] && k < range[1];
        const open = new Set( s.open );
        const side = r.faces.map( () => 0 );    // 1 outside, -1 inside, 0 neither
        r.faces.forEach( (f, k) => {
            if (f.solid < 0) return;
            if (within( f.solid, s.inside )) side[k] = -1;
            else if (within( f.solid, s.outside ) && !open.has( leafName( f.solid, f.face ) )) side[k] = 1;
        } );
        const firstBlend = r.faces.findIndex( f => f.solid < 0 );
        r.fillets.forEach( (fl, k) => {
            const c = r.curves[fl.curve];
            // a fillet along an open face's edge rounds the rim: it is neither side
            if ([0, 1].some( j => open.has( leafName( c.solids[j], c.faces[j] ) ) )) return;
            if (c.solids.some( x => within( x, s.inside ) )) side[firstBlend + k] = -1;
            else if (c.solids.every( x => within( x, s.outside ) )) side[firstBlend + k] = 1;
        } );
        const from : Array<number> = [], to : Array<number> = [];
        r.faceOf.forEach( (f, t) => { if (side[f] < 0) from.push( t ); else if (side[f] > 0) to.push( t ); } );
        return { shell : s.id, thickness : s.thickness, thinnest : Wall.thinnest( r.mesh, from, to, 2 * s.thickness ).distance };
    }

    // How thin a shell's measured wall may be against the thickness asked: the mesh's chords cut inside curved faces.
    public static WALL_TOLERANCE = 0.03;

    /**
     * The verdict on a result (see `ModelVerdict`): buildable or visual, with the checks and their reasons. Any B-rep
     * result can be judged, a recipe's as well as a document's; `walls` and `lattice` come from a document's shells
     * and lattice output.
     */
    public static verdict( r : BooleanResult, machine? : string | Machine, walls : Array<ModelWall> = [], lattice? : ModelLattice, inner? : Fillets ) : ModelVerdict {
        if (lattice != null) return Model.latticeVerdict( lattice, machine );
        const m = r.report.manifold;
        // the fillets of the rounded operands count with the result's own
        const fFailed = r.report.filletsFailed + (inner?.failed ?? 0), fSkipped = r.report.filletsSkipped + (inner?.skipped ?? 0);
        const checks : ModelVerdict["checks"] = [
            { name : "closed", passed : m.closedManifold, detail : m.closedManifold ? "every edge joins exactly two faces" : "the surface has open or non-manifold edges" },
            { name : "outward", passed : r.report.volume > 0, detail : r.report.volume > 0 ? "the faces face out (volume " + Model.round( r.report.volume ) + ")" : "the volume is not positive: the faces face in, or there is no solid" },
            { name : "fillets", passed : fFailed == 0 && fSkipped == 0,
              detail : fFailed + fSkipped == 0 ? "every requested fillet is in place" : `${fFailed} fillet(s) too large and ${fSkipped} left sharp at corners` },
        ];
        // a round rule that selects no edge (#79)
        const unmatched = inner?.unmatched ?? [];
        if (unmatched.length > 0) checks.push( { name : "round rules", passed : false,
            detail : `${unmatched.length == 1 ? "a round rule selects" : unmatched.length + " round rules select"} no edge: ${unmatched.join( ", " )}` } );
        for (const w of walls) {
            const ok = w.thinnest >= w.thickness * (1 - Model.WALL_TOLERANCE);
            checks.push( { name : "wall", passed : ok, detail : `the shell "${w.shell}" is ${Model.round( w.thinnest )} thick at its thinnest (${w.thickness} asked)` } );
        }
        const notes : Array<string> = [];
        // fillets made smaller to keep clear of each other are in place, so the model stays buildable; it is said
        const reduced = (r.report.filletsReduced ?? 0) + (inner?.reduced ?? 0);
        if (reduced > 0) notes.push( `${reduced} fillet(s) made smaller than asked, so that they keep clear of each other on a face they share` );
        const cert = r.report.certificate;
        if (cert != null) notes.push( cert.unproven.length == 0
            ? `every intersection is proven complete (${cert.pairs} pairs of faces)`
            : `${cert.unproven.length} of ${cert.pairs} pairs of faces are not proven free of missed intersections (near tangency, or a small loop could hide there)` );
        let makeable : MakeableReport | undefined;
        if (machine != null && checks[0].passed) {
            const mk = makeable = Makeable.check( r.mesh, machine );
            notes.push( ...mk.notes );
            checks.push( { name : "makeable", passed : mk.makeable, detail : mk.makeable ? "makeable on " + mk.machine.name : mk.issues.join( " " ) } );
        }
        const failed = checks.filter( c => !c.passed );
        return { kind : failed.length == 0 ? "buildable" : "visual", reasons : failed.length == 0 ? ["passes every check"] : failed.map( c => c.detail ), checks : checks, notes : notes, makeable : makeable };
    }

    // A lattice is judged on its mesh: closed, outward, its thinnest wall against the machine's, and makeable. It is a
    // mesh, not a B-rep: it goes out as STL (or OBJ), not STEP.
    private static latticeVerdict( l : ModelLattice, machine? : string | Machine ) : ModelVerdict {
        const m = l.mesh.checkClosedManifold();
        const checks : ModelVerdict["checks"] = [
            { name : "closed", passed : m.closedManifold, detail : m.closedManifold ? `the lattice's surface is closed (genus ${m.genus})` : "the lattice's surface has open or non-manifold edges" },
            { name : "outward", passed : l.volume > 0, detail : l.volume > 0 ? `the faces face out (volume ${l.volume.toFixed( 1 )}, ${(100 * l.fraction).toFixed( 1 )}% of the solid)` : "the lattice has no volume" },
        ];
        // a wall thinner than two grid steps can fall between samples and break through
        const thinnest = Math.min( l.wall[0], l.wall[1] );
        checks.push( { name : "resolution", passed : l.size <= 0.5 * thinnest,
                       detail : `meshed on a grid of ${Model.round( l.size )}` + (l.size <= 0.5 * thinnest ? `, fine enough for walls of ${thinnest}` : `, too coarse for walls of ${thinnest}: they may break through (use ${Model.round( thinnest / 3 )} or less)`) } );
        checks.push( { name : "one piece", passed : l.bodies == 1, detail : l.bodies == 1 ? "the lattice is one piece" : `the lattice falls into ${l.bodies} pieces: the loose ones would fall out` } );
        // sealed voids trap a resin printer's resin and a powder bed's powder; a filament printer does not mind them
        const mc = machine == null ? null : typeof machine == "string" ? Makeable.MACHINES[machine] : machine;
        const drains = mc != null && mc.drains === true;
        checks.push( { name : "drains", passed : l.voids == 0 || !drains,
                       detail : l.voids == 0 ? "no sealed voids: every cavity opens to the outside" :
                                `${l.voids} sealed void(s) inside the skin` + (drains ? `: the ${mc.name}'s material would be trapped; open a face of the skin` : " (no harm on this process)") } );
        const notes : Array<string> = [];
        let makeable : MakeableReport | undefined;
        if (machine != null && m.closedManifold) {
            const mk = makeable = Makeable.check( l.mesh, machine );
            notes.push( ...mk.notes );
            const min = mk.machine.minWall;
            checks.push( { name : "lattice wall", passed : thinnest >= min, detail : `the lattice's walls are ${thinnest} at their thinnest (${mk.machine.name} needs ${min})` } );
            checks.push( { name : "makeable", passed : mk.makeable, detail : mk.makeable ? "makeable on " + mk.machine.name : mk.issues.join( " " ) } );
        }
        const failed = checks.filter( c => !c.passed );
        return { kind : failed.length == 0 ? "buildable" : "visual", reasons : failed.length == 0 ? ["passes every check (a mesh: export it as STL)"] : failed.map( c => c.detail ), checks : checks, notes : notes, makeable : makeable };
    }

    // ---------- hashing ----------

    // JSON with sorted keys and numbers in full precision: the same value always gives the same text.
    public static canonical( v : unknown ) : string {
        if (v === null || v === undefined) return "null";
        if (typeof v == "number") return Object.is( v, -0 ) ? "0" : JSON.stringify( v );
        if (typeof v == "string" || typeof v == "boolean") return JSON.stringify( v );
        if (Array.isArray( v )) return "[" + v.map( Model.canonical ).join( "," ) + "]";
        const o = v as { [k : string] : unknown };
        return "{" + Object.keys( o ).filter( k => o[k] !== undefined ).sort().map( k => JSON.stringify( k ) + ":" + Model.canonical( o[k] ) ).join( "," ) + "}";
    }

    // A 64-bit FNV-1a hash of a string, as 16 hex digits (two 32-bit halves with different offsets).
    public static hash( s : string ) : string {
        let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x5bd1e995;
        for (let i = 0; i < s.length; i++) {
            const c = s.charCodeAt( i );
            h1 = Math.imul( h1 ^ c, 0x01000193 ) >>> 0;
            h2 = Math.imul( h2 ^ c, 0x01000193 ^ 0x2c1b3c6d ) >>> 0;
        }
        return h1.toString( 16 ).padStart( 8, "0" ) + h2.toString( 16 ).padStart( 8, "0" );
    }
}

// a feature that failed to build, as the cache keeps it
class ModelFailure {
    constructor( public readonly error : Error ) {}
}
