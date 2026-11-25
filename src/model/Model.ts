import { NurbsSurfaceData, Point } from "../core/Data.js";
import { Vec } from "../core/Vec.js";
import { Make } from "../eval/Make.js";
import { Sweep } from "../eval/Sweep.js";
import { BrepFace, BrepSolid } from "../solid/Brep.js";
import { BooleanResult, BrepBoolean } from "../solid/BrepBoolean.js";
import { BrepEdges } from "../solid/BrepEdges.js";
import { FilletShape } from "../solid/Fillet.js";
import { Machine, Makeable } from "../solid/Makeable.js";
import { Expr } from "./Expr.js";

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
    // rigid or scaling placement of a feature (all of its solids): scale about the origin, then rotate about an axis
    // through `about` (degrees, right-handed), then translate
    | { type : "transform", of : string, scale? : ModelValue | ModelPoint, rotate? : { axis : ModelPoint, degrees : ModelValue, about? : ModelPoint }, translate? : ModelPoint }
    // constructive solid geometry
    | { type : "union", of : Array<string> }
    | { type : "intersection", of : Array<string> }
    | { type : "difference", from : string, minus : Array<string> }
    // rounding, on a solid or a Boolean: rules in order, the first whose pattern matches an edge's name gives its
    // radius (0: leave it sharp); see `ModelEdgeRule`
    | { type : "round", of : string, rules : Array<ModelEdgeRule>, shape? : FilletShape, corner? : "auto" | "ball" };

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
}

// What a model regenerates to: the solid, its faces' persistent names, the verdict, and what was rebuilt.
export interface ModelResult {
    result : BooleanResult;
    // for each face of `result.faces`, its persistent name
    faceNames : Array<string>;
    // for each persistent name, the faces it names (one, unless the name is ambiguous after all)
    faceIndex : { [name : string] : number };
    verdict : ModelVerdict;
    // each feature's content hash, and whether this evaluation built it (false: it came from the cache)
    features : { [id : string] : { hash : string, built : boolean } };
    parameters : { [name : string] : number };
}

// Whether a model is a buildable solid or a visual model, decided the same way every time from checks on the
// result, each with a plain reason. A buildable solid is a closed, outward-facing 2-manifold with positive volume,
// every requested fillet in place, and (when the document names a machine) makeable on that machine.
export interface ModelVerdict {
    kind : "buildable" | "visual";
    reasons : Array<string>;
    // the checks, each passed or not
    checks : Array<{ name : string, passed : boolean, detail : string }>;
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
// Limits: rounding applies to the output's Boolean as a whole (a round is the last feature on its branch), and a
// rounded solid cannot yet be an operand of a further Boolean.
export class Model {

    private cache = new Map<string, unknown>();

    // Regenerates a document. The model keeps what it built, so evaluating an edited document rebuilds only what
    // the edit changed.
    public evaluate( doc : ModelDocument ) : ModelResult {
        if (doc.version !== 1) throw new Error( "Model: unknown document version " + String( doc.version ) );
        const params = Model.parameters( doc.parameters ?? {} );
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
            const resolved = Model.resolve( f, num, point );
            const inputs = Model.inputs( f ).map( hashOf );
            visiting.delete( id );
            const h = Model.hash( Model.canonical( { type : f.type, values : resolved, inputs : inputs } ) );
            hashes.set( id, h );
            return h;
        };
        hashOf( doc.output );

        const built = new Set<string>();
        const cached = <T>( stage : string, id : string, make : () => T ) : T => {
            const key = stage + ":" + id + ":" + (hashes.get( id ) as string);
            if (this.cache.has( key )) return this.cache.get( key ) as T;
            const v = make();
            this.cache.set( key, v );
            built.add( id );
            return v;
        };

        // a feature's solids: its primitives (each with its path of transforms) and the Boolean expression over them
        type Tree = { leaves : Array<{ name : string, solid : BrepSolid }>, expr : (inside : Array<boolean>) => boolean };
        const tree = (id : string) : Tree => cached( "tree", id, () => {
            const f = features[id];
            switch (f.type) {
                case "box": case "cylinder": case "pipe": case "revolve":
                    return { leaves : [{ name : id, solid : Model.primitive( f, num, point ) }], expr : (x : Array<boolean>) => x[0] };
                case "transform": {
                    const t = tree( f.of );
                    const M = Model.matrix( f, num, point );
                    return { leaves : t.leaves.map( l => ({ name : id + "/" + l.name, solid : Model.transform( l.solid, M ) }) ), expr : t.expr };
                }
                case "union": case "intersection": case "difference": {
                    const ids = f.type == "difference" ? [f.from].concat( f.minus ) : f.of;
                    if (ids.length == 0) throw new Error( `Model: "${id}" has no operands` );
                    const parts = ids.map( tree );
                    const leaves = ([] as Tree["leaves"]).concat( ...parts.map( p => p.leaves ) );
                    const offsets : Array<number> = [];
                    let n = 0;
                    for (const p of parts) { offsets.push( n ); n += p.leaves.length; }
                    const sub = (k : number, x : Array<boolean>) => parts[k].expr( x.slice( offsets[k], offsets[k] + parts[k].leaves.length ) );
                    const expr = f.type == "union" ? (x : Array<boolean>) => parts.some( (_, k) => sub( k, x ) )
                        : f.type == "intersection" ? (x : Array<boolean>) => parts.every( (_, k) => sub( k, x ) )
                        : (x : Array<boolean>) => sub( 0, x ) && !parts.slice( 1 ).some( (_, k) => sub( k + 1, x ) );
                    const names = new Set<string>();
                    for (const l of leaves) {
                        if (names.has( l.name )) throw new Error( `Model: "${l.name}" is used twice in "${id}"; place a copy with a transform` );
                        names.add( l.name );
                    }
                    return { leaves : leaves, expr : expr };
                }
                case "round": throw new Error( `Model: the round "${id}" can only be the last feature (an operand of nothing)` );
            }
            throw new Error( `Model: unknown feature type "${(f as { type : string }).type}" in "${id}"` );
        } );

        // the output: a Boolean of its tree, rounded if it is a round
        const out = features[doc.output];
        const solid = cached( "solid", doc.output, () => {
            const round = out.type == "round" ? out : null;
            const t = tree( round != null ? round.of : doc.output );
            const leafName = (si : number, fi : number) => t.leaves[si].name + "." + Model.faceName( t.leaves[si].solid.faces[fi], fi );
            let options = {};
            if (round != null) {
                const rules = round.rules.map( r => ({ re : Model.pattern( r.edges ), radius : num( r.radius, `"${doc.output}" radius` ) }) );
                const radius = (name : string) => { const r = rules.find( x => x.re.test( name ) ); return r != null ? r.radius : 0; };
                const edges : Array<{ solid : number, faces : [number, number], radius : number }> = [];
                t.leaves.forEach( (l, si) => BrepEdges.all( l.solid ).forEach( e => {
                    const r = radius( Model.edgeName( leafName( si, e.faces[0] ), leafName( si, e.faces[1] ) ) );
                    if (r > 0) edges.push( { solid : si, faces : e.faces, radius : r } );
                } ) );
                options = {
                    fillet : (c : { solids : [number, number], faces : [number, number] }) => radius( Model.edgeName( leafName( c.solids[0], c.faces[0] ), leafName( c.solids[1], c.faces[1] ) ) ),
                    edges : edges, filletShape : round.shape, filletCorner : round.corner,
                };
            }
            const r = BrepBoolean.evaluate( t.leaves.map( l => l.solid ), t.expr, options );
            return { result : r, names : Model.names( r, leafName ) };
        } );

        const verdict = Model.verdict( solid.result, doc.machine );
        const faceIndex : { [name : string] : number } = {};
        solid.names.forEach( (n, k) => { faceIndex[n] = k; } );
        const report : ModelResult["features"] = {};
        for (const [id, h] of hashes) report[id] = { hash : h, built : built.has( id ) };
        return { result : solid.result, faceNames : solid.names, faceIndex : faceIndex, verdict : verdict, features : report, parameters : params };
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
            case "transform": return Model.matrix( f, num, point );
            case "union": case "intersection": return { n : f.of.length };
            case "difference": return { n : f.minus.length };
            case "round": return { rules : f.rules.map( r => [r.edges, num( r.radius, "radius" )] ), shape : f.shape ?? "circular", corner : f.corner ?? "auto" };
        }
        throw new Error( `Model: unknown feature type "${(f as { type : string }).type}"` );
    }

    private static inputs( f : ModelFeature ) : Array<string> {
        switch (f.type) {
            case "transform": case "round": return [f.of];
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
            case "box": {
                const a = point( f.min, "min" ), b = point( f.max, "max" );
                for (let k = 0; k < 3; k++) if (!(b[k] > a[k])) throw new Error( "Model: a box's max must exceed its min on every axis" );
                return BrepSolid.box( a, b, f.divs == null ? 12 : Math.max( 2, Math.round( num( f.divs, "divs" ) ) ) );
            }
            case "cylinder": {
                const a = point( f.from, "from" ), b = point( f.to, "to" );
                if (Vec.dist( a, b ) == 0) throw new Error( "Model: a cylinder's ends must differ" );
                return BrepSolid.cappedTube( Sweep.pipe( Make.rationalBezierCurve( [a, b] ), positive( num( f.radius, "radius" ), "a cylinder's radius" ) ).surface, divs( f.divs, [24, 96] ) );
            }
            case "pipe": {
                if (f.through.length < 2) throw new Error( "Model: a pipe runs through two points or more" );
                const pts = f.through.map( (p, k) => point( p, "through[" + k + "]" ) );
                const rail = pts.length == 2 ? Make.rationalBezierCurve( pts ) : Make.rationalInterpCurve( pts, Math.min( 3, pts.length - 1 ) );
                return BrepSolid.cappedTube( Sweep.pipe( rail, positive( num( f.radius, "radius" ), "a pipe's radius" ) ).surface, divs( f.divs, [48, 64] ) );
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
        }) );
        return new BrepSolid( faces ).orient();
    }

    private static transpose( s : NurbsSurfaceData ) : NurbsSurfaceData {
        const cp = s.controlPoints[0].map( (_, j) => s.controlPoints.map( row => row[j] ) );
        return new NurbsSurfaceData( s.degreeV, s.degreeU, s.knotsV.slice(), s.knotsU.slice(), cp );
    }

    // ---------- names ----------

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
    private static names( r : BooleanResult, leafName : (solid : number, face : number) => string ) : Array<string> {
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

    // ---------- verdict ----------

    public static verdict( r : BooleanResult, machine? : string | Machine ) : ModelVerdict {
        const m = r.report.manifold;
        const checks : ModelVerdict["checks"] = [
            { name : "closed", passed : m.closedManifold, detail : m.closedManifold ? "every edge joins exactly two faces" : "the surface has open or non-manifold edges" },
            { name : "outward", passed : r.report.volume > 0, detail : r.report.volume > 0 ? "the faces face out (volume " + Model.round( r.report.volume ) + ")" : "the volume is not positive: the faces face in, or there is no solid" },
            { name : "fillets", passed : r.report.filletsFailed == 0 && r.report.filletsSkipped == 0,
              detail : r.report.filletsFailed + r.report.filletsSkipped == 0 ? "every requested fillet is in place" : `${r.report.filletsFailed} fillet(s) too large and ${r.report.filletsSkipped} left sharp at corners` },
        ];
        if (machine != null && checks[0].passed) {
            const mk = Makeable.check( r.mesh, machine );
            checks.push( { name : "makeable", passed : mk.makeable, detail : mk.makeable ? "makeable on " + mk.machine.name : mk.issues.join( " " ) } );
        }
        const failed = checks.filter( c => !c.passed );
        return { kind : failed.length == 0 ? "buildable" : "visual", reasons : failed.length == 0 ? ["passes every check"] : failed.map( c => c.detail ), checks : checks };
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
