import { Catalog } from "../solid/primitives/Catalog.js";
import { Expr } from "./Expr.js";
import { Model, ModelError } from "./Model.js";
import { ShellBuilder } from "../solid/BrepShell.js";
import { ShellMesher } from "../solid/ShellMesher.js";
import type { BrepShell } from "../solid/BrepShell.js";
import { MassPropertiesOf } from "../solid/MassProperties.js";
import type { MassProperties } from "../solid/MassProperties.js";
import type { BooleanResult } from "../solid/BrepBoolean.js";
import type { Machine } from "../solid/Makeable.js";
import type { MeshTolerance } from "../solid/ShellMesher.js";
import type { TriMesh } from "../solid/TriMesh.js";
import type { ProfileSpec } from "../solid/Extrusion.js";
import type { ModelDocument, ModelFeature, ModelResult, ModelValue, ModelVerdict } from "./Model.js";

// Node graphs for visual programming (docs/visual-programming.md). A graph document is plain JSON: nodes keyed by
// id, each with a type from `Graph.REGISTRY` and its input values under `in`. An input is a literal, an expression
// over the graph's number nodes, or a reference to another node's output, written `"@id"` or `"@id.port"`. The graph
// compiles into a `Model` document (number nodes become parameters, solid nodes become features, both keeping their
// ids), so it is evaluated with the model's content-hash cache: an edit rebuilds only the nodes downstream of it, and
// faces keep their persistent names. Version 1 model documents are accepted as they are.

/** What travels on a wire: a number or a solid. */
export type GraphWire = "number" | "solid";

/** One input of a node type. */
export type GraphPort =
    // a number: a literal, an expression over number nodes, or a wire from a number output
    | { kind : "number", label : string, value : number, min : number, max : number, step : number, unit? : string, integer? : boolean }
    // a solid: always a wire; an optional one may be left unconnected, for nothing (a switch's sides)
    | { kind : "solid", label : string, optional? : boolean }
    // a word chosen from a list (a fillet's shape, an axis)
    | { kind : "choice", label : string, value : string, options : Array<string> }
    // free text that is not an expression (an edge or face name pattern)
    | { kind : "text", label : string, value : string }
    // an expression over number nodes and one variable (`t`, running from 0 to 1), sampled by the node: a curve's
    // coordinates, a profile's radius. Within it, the variable hides a number node of the same id
    | { kind : "function", label : string, value : string, variable : string }
    // a half-section as drawn, from the base up: points "r z; r z; ..." in millimetres, radius from the axis and
    // height, the heights increasing; empty for none where the node allows it
    | { kind : "profile", label : string, value : string, optional : boolean }
    // a closed outline in a plane as points "x, y; x, y, r; ..." where each coordinate is a number or an expression
    // over number nodes, and an optional third value rounds that corner
    | { kind : "points", label : string, value : string }
    // a planar region as JSON: `{ outer, holes }`, each a path of lines, three-point arcs and cubic Béziers or a
    // circle (`ProfileSpec`, docs/formats.md, "Profiles"), in millimetres
    | { kind : "outline", label : string, value : ProfileSpec };

/** A node type: its ports, and how it compiles into model parameters or features. */
export interface GraphNodeType {
    title : string;
    category : "parameter" | "math" | "primitive" | "freeform" | "transform" | "boolean" | "finish" | "logic" | "look" | "component";
    help : string;
    inputs : { [port : string] : GraphPort };
    outputs : { [port : string] : GraphWire };
}

/** A node of a graph document. */
export interface GraphNode {
    // a type of `Graph.REGISTRY`, or "component": an instance of another document (docs/formats.md, "Components")
    type : string;
    // for a component: the document it is an instance of, as the caller's `resolve` understands it (a path)
    use? : string;
    // for a component: the content hash the document must have (`Graph.hash`), so a changed component is noticed
    hash? : string;
    in? : { [port : string] : ModelValue | ProfileSpec };
    // shown on the canvas; never used in names, so renaming a node keeps its faces' names
    label? : string;
}

/**
 * A graph document, version 2 (the format is specified in docs/formats.md). Lengths are in millimetres and angles in
 * degrees. `view` and `meta` never change what is built.
 */
export interface GraphDocument {
    version : 2;
    nodes : { [id : string] : GraphNode };
    // the solids the graph exports, by name: `{ wheel : "@wheel", shaft : "@shaft" }`. The first is the default
    outputs : { [name : string] : string };
    // the editor's layout, and anything else an editor keeps (`show`: the node it displays)
    view? : { nodes? : { [id : string] : { x : number, y : number } }, show? : string, [key : string] : unknown };
    // about the document: a name, a description, an author; free-form
    meta? : { name? : string, description? : string, [key : string] : unknown };
    // the machine the solids are checked against for the verdict (`Makeable.MACHINES` key, or a machine), as in a model
    machine? : string | Machine;
    // the document's own components, by name: a component node with `use: "#name"` is an instance of one. Kept in the
    // document, so a file, a link or a browser's copy carries them; a component in it has no library of its own, and
    // its own "#name" instances are of the same library
    components? : { [name : string] : GraphDocument };
}

/** How to evaluate a graph: which output, and number nodes set from outside (a part's parameters in an assembly). */
export interface GraphOptions {
    // an output's name, or a reference to any solid node (`"@cut"`, to preview it); default: the first output
    output? : string;
    // values for `number` nodes, by id, replacing their own
    set? : { [id : string] : ModelValue };
    // finds the document a component node uses: `use` as written, and the `use` of the document it is written in
    // (null at the top), so that relative paths can be resolved
    resolve? : ( use : string, from : string | null ) => GraphDocument;
    // an export mesh besides the result (`GraphResult.export`): "print" (within 0.02 mm), "view" (0.1 mm, normals
    // within 20 degrees), a tolerance of one's own, or "analysis" (the Boolean's own mesh, as it is)
    mesh? : "print" | "view" | "analysis" | MeshTolerance;
}

/** An export mesh: tessellated from the result's exact shell within a tolerance, with a face name per triangle. */
export interface GraphMesh {
    mesh : TriMesh;
    // for each triangle, the persistent name of the face it stands for
    faceNames : Array<string>;
    // for each triangle, the index of that face in the result (`ModelResult.result.faces`), which `Inspect.brep` draws
    // on (none for a lattice, which has no faces)
    faceOf? : Array<number>;
    // the tolerance asked ("analysis": none), and the largest deviation from the exact faces measured (null: not measured)
    tolerance : MeshTolerance | null;
    deviation : number | null;
}

// A document compiled whole: every parameter and feature, the feature each output names, and the node type of each
// feature (an instance's features under their prefixed ids).
interface Compiled { parameters : { [name : string] : ModelValue }, features : { [id : string] : ModelFeature }, outputs : { [name : string] : string },
                     types : { [feature : string] : string }, looks : Array<GraphLook>, via : { [look : string] : string } }

/** How a solid looks, set by a `look/*` node: it changes nothing that is built (docs/visual-programming.md, "Looks"). */
export interface GraphLook {
    // the node (a path through instances: "plate/glaze"), its kind, and the feature whose faces it covers
    id : string;
    kind : "material" | "band" | "motif";
    of : string;
    // how many looks it is applied over on the same wire (a band over a material: 1), so it comes after them
    depth : number;
    // its inputs: numbers or expressions over the parameters, colours as "#rrggbb", a motif's name
    values : { [k : string] : ModelValue };
}
/** A look as evaluated: its values as numbers (colours and names as they are), and the faces of the result it covers. */
export interface GraphLookResult {
    id : string;
    kind : GraphLook["kind"];
    values : { [k : string] : number | string };
    faces : Array<number>;
}

// Where a graph failed: the node (a path of ids through component instances: "crank1/disc"), its type and the port, or
// the output, when the failure is theirs.
interface Where { node? : string, type? : string, port? : string, output? : string }

/**
 * Why a graph could not be evaluated, and where, for a caller to report (#68 A6):
 * * `stage`: "document" (the document as a whole: its version, a top-level key, an output, a `set`), "node" (a node's
 *   own definition: its type, a port, a wire, an expression) or "build" (building the solid failed);
 * * `node`: the node at fault, as a path of ids from the top document through component instances (`crank1/disc` is
 *   the node `disc` of the instance `crank1`); `type`: its node type; `port`: the port at fault;
 * * `output`: the output at fault, for a document's failure about one.
 * The message is the same as before, naming them too. A failure from inside the kernel keeps its error as `cause`.
 */
export class GraphError extends Error {
    public readonly stage : "document" | "node" | "build";
    public readonly node? : string;
    public readonly type? : string;
    public readonly port? : string;
    public readonly output? : string;
    constructor( message : string, stage : "document" | "node" | "build", where : Where = {}, cause? : unknown ) {
        super( message );
        this.name = "GraphError";
        this.stage = stage;
        if (where.node != null) this.node = where.node;
        if (where.type != null) this.type = where.type;
        if (where.port != null) this.port = where.port;
        if (where.output != null) this.output = where.output;
        if (cause !== undefined) (this as { cause? : unknown }).cause = cause;
    }
}

/** A graph evaluated: the model's result, the model document it compiled into, and each node's state. */
export interface GraphResult extends ModelResult {
    model : ModelDocument;
    // the output evaluated: its name, or the reference asked for
    output : string;
    // "built": computed by this evaluation; "cached": taken from an earlier one; "parameter": a number node;
    // "unused": not upstream of the output; "on" and "off": a switch the output reached, and the side it chose
    nodes : { [id : string] : "built" | "cached" | "parameter" | "unused" | "on" | "off" };
    // the export mesh, when `mesh` was asked for
    export? : GraphMesh;
    // the looks reaching the output, innermost first (a later one covers an earlier one's faces): a material per
    // face, and paint over it (docs/visual-programming.md, "Looks")
    looks? : Array<GraphLookResult>;
}

// the top-level keys of a graph document
const TOP = ["version", "nodes", "outputs", "view", "meta", "machine", "components"];
// the library a document's "#name" instances are of, passed down to the components compiled within it
type Library = { [name : string] : GraphDocument };
const ID = /^[A-Za-z_][A-Za-z0-9_]*$/;
// an output's name: an id that may also hold "-" (a part's name, "axle-washer"); never used in expressions
const NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const REF = /^@([A-Za-z_][A-Za-z0-9_]*)(?:\.([A-Za-z_][A-Za-z0-9_ -]*))?$/;
// a name inside an expression (not part of a number like 1e5, nor after a ".")
const WORD = /(?<![A-Za-z0-9_.])[A-Za-z_][A-Za-z0-9_]*/g;

const num = ( label : string, value : number, min : number, max : number, step = 1, unit? : string ) : GraphPort =>
    ({ kind : "number", label : label, value : value, min : min, max : max, step : step, unit : unit });
const solid = ( label : string ) : GraphPort => ({ kind : "solid", label : label });
const value = num( "value", 0, -100, 100 );

// The math nodes, after the operations of glTF's KHR_interactivity (Khronos, 2025): each is an expression over its
// inputs, so it compiles into a model parameter.
const MATH : { [type : string] : { title : string, inputs : Array<string>, expr : (x : Array<string>) => string, help : string } } = {
    "math/add" : { title : "Add", inputs : ["a", "b"], expr : x => `${x[0]} + ${x[1]}`, help : "a + b" },
    "math/sub" : { title : "Subtract", inputs : ["a", "b"], expr : x => `${x[0]} - ${x[1]}`, help : "a - b" },
    "math/mul" : { title : "Multiply", inputs : ["a", "b"], expr : x => `${x[0]} * ${x[1]}`, help : "a × b" },
    "math/div" : { title : "Divide", inputs : ["a", "b"], expr : x => `${x[0]} / ${x[1]}`, help : "a / b; dividing by zero is an error" },
    "math/min" : { title : "Minimum", inputs : ["a", "b"], expr : x => `min(${x[0]}, ${x[1]})`, help : "the smaller of a and b" },
    "math/max" : { title : "Maximum", inputs : ["a", "b"], expr : x => `max(${x[0]}, ${x[1]})`, help : "the larger of a and b" },
    "math/pow" : { title : "Power", inputs : ["a", "b"], expr : x => `pow(${x[0]}, ${x[1]})`, help : "a to the power b" },
    "math/sqrt" : { title : "Square root", inputs : ["a"], expr : x => `sqrt(${x[0]})`, help : "√a" },
    "math/abs" : { title : "Absolute value", inputs : ["a"], expr : x => `abs(${x[0]})`, help : "|a|" },
    "math/sin" : { title : "Sine", inputs : ["a"], expr : x => `sin(${x[0]})`, help : "sin a, a in radians" },
    "math/cos" : { title : "Cosine", inputs : ["a"], expr : x => `cos(${x[0]})`, help : "cos a, a in radians" },
    "math/rad" : { title : "Degrees to radians", inputs : ["a"], expr : x => `rad(${x[0]})`, help : "a × π / 180" },
    "math/mix" : { title : "Mix", inputs : ["a", "b", "t"], expr : x => `lerp(${x[0]}, ${x[1]}, ${x[2]})`, help : "a + (b - a) t" },
    "math/clamp" : { title : "Clamp", inputs : ["a", "min", "max"], expr : x => `clamp(${x[0]}, ${x[1]}, ${x[2]})`, help : "a held between min and max" },
};

// "box", "rounded rectangle prism", "truncatedCube" -> "box", "rounded-rectangle-prism", "truncated-cube"
const slug = ( name : string ) => name.replace( /([a-z])([A-Z])/g, "$1-$2" ).toLowerCase().replace( /[^a-z0-9]+/g, "-" ).replace( /^-|-$/g, "" );

/** The node graph: its registry of node types, its compiler into model documents, and its evaluator. */
export class Graph {

    /** Every node type, by type name. Primitives come from `Catalog.ENTRIES`, one node per catalogued shape. */
    public static REGISTRY : { [type : string] : GraphNodeType } = Graph.registry();

    private model = new Model();
    // the exact shells of results already meshed (a shell is slow to build), and their meshes by tolerance
    private shells = new WeakMap<BooleanResult, { shell : BrepShell, meshes : Map<string, GraphMesh> }>();

    /**
     * Evaluates a graph document (or a version 1 model document, as it is). The graph keeps what it built, so
     * evaluating an edited document rebuilds only what the edit changed.
     */
    public evaluate( doc : GraphDocument | ModelDocument, options : GraphOptions = {} ) : GraphResult {
        if (doc.version === 1) {
            const r = Graph.build( () => this.model.evaluate( doc ), Object.fromEntries( Object.entries( doc.features ).map( ([id, f]) => [id, f.type] ) ) );
            const nodes : GraphResult["nodes"] = {};
            for (const [id, f] of Object.entries( r.features )) nodes[id] = f.built ? "built" : "cached";
            return this.withMesh( { ...r, model : doc, output : doc.output, nodes : nodes }, options );
        }
        const { model, types, looks } = Graph.compileTyped( doc, options );
        const r = Graph.build( () => this.model.evaluate( model ), types );
        const nodes : GraphResult["nodes"] = {};
        for (const id of Object.keys( doc.nodes )) {
            const t = Graph.REGISTRY[doc.nodes[id].type];
            const f = r.features[id];
            if (doc.nodes[id].type == "component") {
                // an instance: built if any of its features was, unused if none is upstream of the output
                const mine = Object.keys( r.features ).filter( k => k.startsWith( id + "/" ) );
                nodes[id] = mine.length == 0 ? "unused" : mine.some( k => r.features[k].built ) ? "built" : "cached";
                continue;
            }
            // a switch the output reached: the side it chose
            if (doc.nodes[id].type == "logic/switch" && r.chosen?.[id] != null) { nodes[id] = r.chosen[id] ? "on" : "off"; continue; }
            nodes[id] = Graph.isNumber( t ) ? "parameter" : f == null ? "unused" : f.built ? "built" : "cached";
        }
        const looked = looks.length == 0 ? {} : { looks : Graph.looksOf( looks, model, r.faceNames, r.parameters ) };
        return this.withMesh( { ...r, model : model, output : options.output ?? Object.keys( doc.outputs )[0], nodes : nodes, ...looked }, options );
    }

    /**
     * The export mesh of a result (`GraphOptions.mesh`). It is a separate output: the result's own mesh is the one the
     * Booleans work on, and stays as it is. The exact shell is built once per result, and each tolerance meshed once.
     */
    public exportMesh( r : ModelResult, given : "print" | "view" | "analysis" | MeshTolerance ) : GraphMesh {
        // a lattice is a mesh already (of the field, at its own grid step), with no exact shell behind it: that mesh is
        // what it exports, whatever the tolerance
        if (r.lattice != null) {
            const m = r.lattice.mesh;
            return { mesh : m, faceNames : m.triangles.map( () => "lattice" ), tolerance : null, deviation : null };
        }
        if (given == "analysis") {
            return { mesh : r.result.mesh, faceNames : r.result.faceOf.map( f => r.faceNames[f] ), faceOf : r.result.faceOf, tolerance : null, deviation : null };
        }
        const T = ShellMesher.tolerance( given );
        const known = this.known( r );
        const key = JSON.stringify( [T.chordal, T.angle ?? null, T.maxEdge ?? null] );
        let m = known.meshes.get( key );
        if (m == null) {
            const shell = known.shell, sm = ShellMesher.mesh( shell, T );
            m = { mesh : sm.mesh, faceNames : sm.faceOf.map( k => r.faceNames[shell.faces[k].source] ), faceOf : sm.faceOf.map( k => shell.faces[k].source ),
                  tolerance : T, deviation : sm.deviation };
            known.meshes.set( key, m );
        }
        return m;
    }

    /** The exact B-rep shell of a result (built once per result, and shared with its export meshes). */
    public shellOf( r : ModelResult ) : BrepShell {
        if (r.lattice != null) throw new Error( "Graph: a lattice has no exact shell" );
        return this.known( r ).shell;
    }

    /**
     * The mass properties of a result, integrated on its exact shell (`MassPropertiesOf.shell`): volume, mass at
     * `density` (mass per unit volume, 1 by default), centre of mass and inertia tensor about it.
     */
    public massProperties( r : ModelResult, density : number = 1 ) : MassProperties {
        return MassPropertiesOf.shell( this.shellOf( r ), density );
    }

    private known( r : ModelResult ) : { shell : BrepShell, meshes : Map<string, GraphMesh> } {
        let known = this.shells.get( r.result );
        if (known == null) {
            // (a result that is one solid's exact shell as it is meshes that shell, #117)
            known = { shell : r.shell ?? ShellBuilder.fromResult( r.result ), meshes : new Map() };
            this.shells.set( r.result, known );
        }
        return known;
    }

    // The result with its export mesh. A B-rep result whose export mesh is not closed (its faces meshed apart, #116)
    // is judged visual: the "export mesh" check says how many edges are open.
    private withMesh( r : GraphResult, options : GraphOptions ) : GraphResult {
        if (options.mesh == null) return r;
        const ex = this.exportMesh( r, options.mesh );
        if (r.lattice != null || options.mesh == "analysis") return { ...r, export : ex };
        const m = ex.mesh.checkClosedManifold();
        const check = { name : "export mesh", passed : m.closedManifold,
            detail : m.closedManifold ? "the export mesh is closed" : `the export mesh is not closed (${m.boundaryEdges} open and ${m.badEdges} non-manifold edges)` };
        const checks = r.verdict.checks.concat( [check] );
        const failed = checks.filter( c => !c.passed );
        const verdict : ModelVerdict = { ...r.verdict, checks : checks, kind : failed.length == 0 ? "buildable" : "visual",
            reasons : failed.length == 0 ? r.verdict.reasons : failed.map( c => c.detail ) };
        return { ...r, verdict : verdict, export : ex };
    }

    /**
     * Compiles a graph document into a model document. Number nodes become parameters and solid nodes features, under
     * their own ids. Refuses, with a message naming the node and the port: an unknown type or port, an id that is not
     * a name (or a number node named like a function or constant of `Expr`), a reference to a missing node or port,
     * a wire between a number and a solid, a solid input left unconnected, and an expression naming something other
     * than a number node, an output that is not a solid node, a top-level key the format does not have, and a `set`
     * for something other than a `number` node. Every output is checked, whichever one is compiled.
     */
    public static compile( doc : GraphDocument, options : GraphOptions = {} ) : ModelDocument {
        return Graph.compileTyped( doc, options ).model;
    }

    // Builds a model, reporting a failure as a `GraphError` at the node of the feature at fault (`types`: each
    // feature's node type).
    private static build( make : () => ModelResult, types : { [feature : string] : string } ) : ModelResult {
        try {
            return make();
        } catch (e) {
            if (e instanceof GraphError) throw e;
            const message = e instanceof Error ? e.message : String( e );
            const feature = e instanceof ModelError ? e.feature : undefined;
            const cause = e instanceof Error && (e as { cause? : unknown }).cause !== undefined ? (e as { cause? : unknown }).cause : e;
            throw new GraphError( message, "build", feature == null ? {} : { node : feature, type : types[feature] ?? (e as ModelError).type }, cause );
        }
    }

    // `compile`, with each feature's node type.
    private static compileTyped( doc : GraphDocument, options : GraphOptions ) : { model : ModelDocument, types : { [feature : string] : string }, looks : Array<GraphLook> } {
        const c = Graph.compileAll( doc, options, [], doc.components ?? {} );
        const names = Object.keys( doc.outputs );
        const want = options.output ?? names[0];
        let output : string;
        if (want.startsWith( "@" )) {
            const m = REF.exec( want.trim() );
            const f = m == null ? null : m[2] == null ? c.via[m[1]] ?? m[1] : c.features[m[1] + "/" + (c.outputs[`${m[1]}.${m[2]}`] ?? "")] != null ? m[1] + "/" + c.outputs[`${m[1]}.${m[2]}`] : null;
            if (f == null || c.features[f] == null) throw new GraphError( `Graph: the output "${want}" is ${JSON.stringify( want )}, not a reference to a solid node`, "document", { output : want } );
            output = f;
        } else {
            if (c.outputs[want] == null) throw new GraphError( `Graph: the document has no output "${want}" (${names.join( ", " )})`, "document", { output : want } );
            output = c.outputs[want];
        }
        const model : ModelDocument = { version : 1, parameters : c.parameters, features : c.features, output : output };
        if (doc.machine != null) model.machine = doc.machine;
        return { model : model, types : c.types, looks : c.looks };
    }

    /**
     * The looks that reach a model's output, with their values at the parameters' values and the faces they cover: a
     * face is a look's when it comes from a feature upstream of the look's solid (its name's path ends at one: "b.tube",
     * "bm/b.tube", "inst/b.side"). Innermost first: a look over fewer features comes before one over more, so a look
     * applied later in the graph covers an earlier one.
     */
    private static looksOf( looks : Array<GraphLook>, model : ModelDocument, faceNames : Array<string>, params : { [name : string] : number } ) : Array<GraphLookResult> {
        const inputs = ( f : ModelFeature ) : Array<string> => {
            const x = f as { of? : string | Array<string>, from? : string, minus? : Array<string>, then? : string, else? : string };
            return ([] as Array<string | undefined>).concat( x.of ?? [], x.from ?? [], x.minus ?? [], x.then, x.else ).filter( (v) : v is string => typeof v == "string" );
        };
        const memo = new Map<string, Set<string>>();
        const upstream = ( id : string ) : Set<string> => {
            const known = memo.get( id );
            if (known != null) return known;
            const out = new Set<string>( [id] );
            memo.set( id, out );
            const f = model.features[id];
            if (f != null) for (const i of inputs( f )) for (const u of upstream( i )) out.add( u );
            return out;
        };
        const reach = upstream( model.output );
        // each face's path: the feature ids before its name's first "." (inside "round(" and the like, the first name)
        const paths = faceNames.map( n => { const m = /[A-Za-z_][A-Za-z0-9_]*(?:\/[A-Za-z_][A-Za-z0-9_]*)*(?=\.)/.exec( n ); return m ? m[0] : ""; } );
        const num = ( v : ModelValue ) => typeof v == "number" ? v : Expr.evaluate( v, params );
        return looks.filter( l => reach.has( l.of ) ).map( l => ({ l, up : upstream( l.of ) }) ).sort( (a, b) => a.up.size - b.up.size || a.l.depth - b.l.depth ).map( ({ l, up }) => {
            const faces : Array<number> = [];
            paths.forEach( ( p, i ) => { for (const u of up) if (p == u || p.endsWith( "/" + u )) { faces.push( i ); return; } } );
            const values : { [k : string] : number | string } = {};
            for (const [k, v] of Object.entries( l.values )) values[k] = typeof v == "string" && (/^#/.test( v ) || /^[a-z]+$/.test( v ) && l.kind == "motif" && k == "motif") ? v : num( v );
            return { id : l.id, kind : l.kind, values : values, faces : faces };
        } );
    }

    /**
     * The content hash of a graph document: what a component node's `hash` pins. `meta` and `view` are left out, so
     * moving a node or renaming the document does not change it.
     */
    public static hash( doc : GraphDocument ) : string {
        const lib = doc.components == null ? undefined : Object.fromEntries( Object.entries( doc.components ).map( ([k, d]) => [k, Graph.hash( d )] ) );
        return Model.hash( Model.canonical( { version : doc.version, nodes : doc.nodes, outputs : doc.outputs, machine : doc.machine, components : lib } ) );
    }

    // Compiles a whole document: every parameter, every feature, and the feature of each output (plus, for each
    // instance's output, "instance.output" to the feature inside it, without the instance's prefix). `stack`: the
    // components being compiled, outermost first, to refuse a component that uses itself.
    private static compileAll( doc : GraphDocument, options : GraphOptions, stack : Array<string>, library : Library ) : Compiled {
        const where : Where = {};
        try {
            return Graph.compileIn( doc, options, stack, where, library );
        } catch (e) {
            if (e instanceof GraphError) throw e;
            throw new GraphError( e instanceof Error ? e.message : String( e ), where.node != null ? "node" : "document", where );
        }
    }

    // `compileAll`'s work, keeping in `where` the node, port or output it is at, for the error if it fails.
    private static compileIn( doc : GraphDocument, options : GraphOptions, stack : Array<string>, where : Where, library : Library ) : Compiled {
        const here = ( w : Where ) => { delete where.node; delete where.type; delete where.port; delete where.output; Object.assign( where, w ); };
        if (doc.version !== 2) throw new Error( `Graph: unknown document version ${String( ( doc as { version? : unknown } ).version )}` );
        for (const k of Object.keys( doc )) if (!TOP.includes( k )) throw new Error( `Graph: "${k}" is not a key of a graph document (${TOP.join( ", " )})` );
        if (stack.length > 0 && doc.components != null) throw new Error( `Graph: the component "${stack[stack.length - 1]}" has a library of its own; components are kept in the top document's "components"` );
        let nodes = doc.nodes ?? {};
        if (options.set != null) {
            nodes = { ...nodes };
            for (const [id, v] of Object.entries( options.set )) {
                if (nodes[id]?.type != "number") throw new Error( `Graph: cannot set "${id}", which is not a number node` );
                nodes[id] = { ...nodes[id], in : { ...nodes[id].in, value : v } };
            }
        }
        const numbers = new Set<string>();
        // each node's type; a component's is made from the document it uses
        const types : { [id : string] : GraphNodeType } = {};
        const inner : { [id : string] : { doc : GraphDocument, compiled : Compiled } } = {};
        const from = stack.length == 0 ? null : stack[stack.length - 1];
        for (const [id, n] of Object.entries( nodes )) {
            here( { node : id, type : n.type } );
            if (!ID.test( id )) throw new Error( `Graph: "${id}" is not a valid node id (letters, digits and _, not starting with a digit)` );
            if (n.type == "component") {
                if (typeof n.use != "string" || n.use == "") throw new Error( `Graph: component "${id}" has no "use"` );
                const own = n.use.startsWith( "#" );
                if (own && library[n.use.slice( 1 )] == null)
                    throw new Error( `Graph: component "${id}" uses "${n.use}", which is not in the document's components (${Object.keys( library ).join( ", " ) || "none"})` );
                if (!own && options.resolve == null) throw new Error( `Graph: component "${id}" uses "${n.use}", but nothing was given to resolve components` );
                if (stack.includes( n.use )) throw new Error( `Graph: component "${id}" uses "${n.use}", which uses itself (${[...stack, n.use].join( " → " )})` );
                const used = own ? library[n.use.slice( 1 )] : options.resolve!( n.use, from );
                if (n.hash != null && Graph.hash( used ) != n.hash)
                    throw new Error( `Graph: component "${id}" pins "${n.use}" at ${n.hash}, but it is now ${Graph.hash( used )}` );
                let compiled : Compiled;
                try {
                    compiled = Graph.compileAll( used, { resolve : options.resolve }, [...stack, n.use], library );
                } catch (e) {
                    // inside the instance: its path goes through the instance (the component's own document at fault
                    // is the instance node)
                    if (!(e instanceof GraphError)) throw e;
                    throw new GraphError( e.message, "node", e.node != null ? { node : id + "/" + e.node, type : e.type, port : e.port }
                        : { node : id, type : "component", output : e.output }, (e as { cause? : unknown }).cause );
                }
                inner[id] = { doc : used, compiled : compiled };
                types[id] = Graph.componentType( n.use, used );
            } else if (n.use != null || n.hash != null) throw new Error( `Graph: node "${id}" has "use" or "hash", which only a component has` );
            const t = types[id] ?? Graph.REGISTRY[n.type];
            if (t == null) throw new Error( `Graph: node "${id}" has an unknown type "${n.type}"` );
            types[id] = t;
            for (const k of Object.keys( n.in ?? {} )) if (t.inputs[k] == null) { here( { node : id, type : n.type, port : k } ); throw new Error( `Graph: node "${id}" (${n.type}) has no input "${k}"` ); }
            if (Graph.isNumber( t )) {
                // a number node is a parameter, named by its id in expressions
                if (Expr.reserved( id )) throw new Error( `Graph: "${id}" is a function or constant of expressions; give the number node another id` );
                numbers.add( id );
            }
        }
        // the looks wired through, while one wire is followed (a cycle of looks is refused)
        const seen = new Set<string>();
        // "@id" or "@id.port", checked against the node's outputs and the wire's kind
        const wire = ( id : string, k : string, v : string, want : GraphWire ) : string => {
            here( { node : id, type : nodes[id].type, port : k } );
            const m = REF.exec( v.trim() );
            if (m == null) throw new Error( `Graph: "${id}.${k}" must be a reference like "@node", not "${v}"` );
            const src = nodes[m[1]];
            if (src == null) throw new Error( `Graph: "${id}.${k}" refers to "${m[1]}", which is not a node` );
            const outs = types[m[1]].outputs;
            const port = m[2] ?? Object.keys( outs )[0];
            if (outs[port] == null) throw new Error( `Graph: "${id}.${k}" refers to "${m[1]}.${port}", which is not an output` );
            if (outs[port] != want) throw new Error( `Graph: "${id}.${k}" takes a ${want}, but "${m[1]}.${port}" is a ${outs[port]}` );
            // a look passes its solid through
            if (src.type.startsWith( "look/" )) {
                const of = src.in?.of;
                if (typeof of != "string" || of.trim() == "") throw new Error( `Graph: "${id}.${k}" goes through "${m[1]}", which is given no solid` );
                if (seen.has( m[1] )) throw new Error( `Graph: "${m[1]}" goes through itself` );
                seen.add( m[1] );
                try { return wire( m[1], "of", of, want ); } finally { seen.delete( m[1] ); }
            }
            // an instance's output is a feature inside it
            return inner[m[1]] != null ? m[1] + "/" + inner[m[1]].compiled.outputs[port] : m[1];
        };
        // a number input: literal, expression over number nodes ("@h" may stand for "h"), or a wire
        const number = ( id : string, k : string ) : ModelValue => {
            here( { node : id, type : nodes[id].type, port : k } );
            const p = types[id].inputs[k] as Extract<GraphPort, { kind : "number" }>;
            const v = nodes[id].in?.[k] ?? p.value;
            if (typeof v == "number") return v;
            if (typeof v != "string") throw new Error( `Graph: "${id}.${k}" must be a number or an expression` );
            if (REF.test( v.trim() )) return wire( id, k, v, "number" );
            const text = v.replace( /@([A-Za-z_][A-Za-z0-9_]*)(\.value)?/g, "$1" );
            for (const name of Expr.names( text ))
                if (!numbers.has( name )) throw new Error( `Graph: "${id}.${k}" uses "${name}", which is not a number node` );
            return `(${text})`;
        };
        const input = ( id : string, k : string ) : ModelValue => {
            here( { node : id, type : nodes[id].type, port : k } );
            const p = types[id].inputs[k];
            const v = nodes[id].in?.[k];
            switch (p.kind) {
                case "number": return number( id, k );
                case "solid":
                    if (typeof v != "string" || v.trim() == "") throw new Error( `Graph: "${id}.${k}" (${p.label}) needs a solid` );
                    return wire( id, k, v, "solid" );
                case "choice": {
                    const c = v ?? p.value;
                    if (typeof c != "string" || !p.options.includes( c )) throw new Error( `Graph: "${id}.${k}" must be one of ${p.options.join( ", " )}` );
                    return c;
                }
                case "text": case "function": case "profile": case "points":
                    if (v != null && typeof v != "string") throw new Error( `Graph: "${id}.${k}" must be text` );
                    return v ?? p.value;
                case "outline": throw new Error( `Graph: "${id}.${k}" is a profile, not a number or text` );
            }
        };
        // an outline input: the region's JSON, its shape checked here and its geometry when it is built
        const outline = ( id : string, k : string ) : ProfileSpec => {
            here( { node : id, type : nodes[id].type, port : k } );
            const p = types[id].inputs[k] as Extract<GraphPort, { kind : "outline" }>;
            const v = nodes[id].in?.[k] ?? p.value;
            const path = ( q : unknown, what : string ) => {
                const o = q as { kind? : unknown, segments? : unknown, center? : unknown, r? : unknown, start? : unknown };
                if (o == null || typeof o != "object") throw new Error( `Graph: "${id}.${k}" ${what} must be a path or a circle` );
                if (o.kind == "circle") { if (!Array.isArray( o.center ) || typeof o.r != "number") throw new Error( `Graph: "${id}.${k}" ${what} is a circle with a center [x, y] and a radius r` ); return; }
                if (o.kind != "path" || !Array.isArray( o.start ) || !Array.isArray( o.segments ) || o.segments.length == 0)
                    throw new Error( `Graph: "${id}.${k}" ${what} must be { kind: "path", start: [x, y], segments: [...] } or { kind: "circle", center: [x, y], r }` );
            };
            if (v == null || typeof v != "object" || Array.isArray( v )) throw new Error( `Graph: "${id}.${k}" must be a profile { outer, holes }` );
            const spec = v as ProfileSpec;
            path( spec.outer, "outer" );
            if (spec.holes != null && !Array.isArray( spec.holes )) throw new Error( `Graph: "${id}.${k}" holes must be a list of paths` );
            (spec.holes ?? []).forEach( ( h, i ) => path( h, `hole ${i}` ) );
            return spec;
        };
        // a function input, as the expression it is at one value of its variable: the variable becomes that number,
        // in parentheses, and the number nodes it names stay names, so the model keeps the parameters
        const sampler = ( id : string, k : string ) : ( t : number ) => ModelValue => {
            const p = types[id].inputs[k] as Extract<GraphPort, { kind : "function" }>;
            const v = nodes[id].in?.[k] ?? p.value;
            if (typeof v == "number") return () => v;
            if (typeof v != "string" || v.trim() == "") throw new Error( `Graph: "${id}.${k}" must be an expression of ${p.variable}` );
            const text = v.replace( /@([A-Za-z_][A-Za-z0-9_]*)(\.value)?/g, "$1" );
            for (const name of Expr.names( text ))
                if (name != p.variable && !numbers.has( name )) throw new Error( `Graph: "${id}.${k}" uses "${name}", which is neither ${p.variable} nor a number node` );
            return ( t : number ) => `(${text.replace( WORD, w => w == p.variable ? `(${t})` : w )})`;
        };
        // how many samples a freeform node takes: a whole number written in the document, since it shapes the model
        const count = ( id : string, k : string ) : number => {
            const p = types[id].inputs[k] as Extract<GraphPort, { kind : "number" }>;
            const v = nodes[id].in?.[k] ?? p.value;
            if (typeof v != "number" || !Number.isInteger( v ) || v < p.min || v > p.max)
                throw new Error( `Graph: "${id}.${k}" must be a whole number from ${p.min} to ${p.max}, written as a number, not ${JSON.stringify( v )}` );
            return v;
        };
        // a profile input: its points, or null when it is empty and may be
        const points = ( id : string, k : string ) : Array<[number, number]> | null => {
            const p = types[id].inputs[k] as Extract<GraphPort, { kind : "profile" }>;
            const v = nodes[id].in?.[k] ?? p.value;
            if (typeof v != "string") throw new Error( `Graph: "${id}.${k}" must be points "r z; r z; ..."` );
            if (v.trim() == "") {
                if (p.optional) return null;
                throw new Error( `Graph: "${id}.${k}" needs points "r z; r z; ..."` );
            }
            const pts = v.split( ";" ).map( s => s.trim() ).filter( s => s != "" ).map( ( s, i ) => {
                const xy = s.split( /[\s,]+/ ).map( Number );
                if (xy.length != 2 || !xy.every( Number.isFinite )) throw new Error( `Graph: "${id}.${k}" point ${i + 1} is "${s}", not two numbers "r z"` );
                return xy as [number, number];
            } );
            if (pts.length < 2) throw new Error( `Graph: "${id}.${k}" has ${pts.length} point; a profile needs two or more` );
            return pts;
        };
        // a points input: its points, each coordinate a number or an expression over number nodes (in parentheses),
        // split at the semicolons and commas outside parentheses
        const pointsOf = ( id : string, k : string ) : Array<Array<ModelValue>> => {
            const p = types[id].inputs[k] as Extract<GraphPort, { kind : "points" }>;
            const v = nodes[id].in?.[k] ?? p.value;
            if (typeof v != "string" || v.trim() == "") throw new Error( `Graph: "${id}.${k}" needs points "x, y; x, y; ..."` );
            const parts = ( text : string, sep : string ) => {
                const out : Array<string> = [];
                let depth = 0, cur = "";
                for (const c of text) {
                    if (c == "(") depth++;
                    if (c == ")") depth--;
                    if (c == sep && depth == 0) { out.push( cur ); cur = ""; } else cur += c;
                }
                out.push( cur );
                return out.map( x => x.trim() ).filter( x => x != "" );
            };
            return parts( v, ";" ).map( ( pt, i ) => {
                const xy = parts( pt, "," );
                if (xy.length != 2 && xy.length != 3) throw new Error( `Graph: "${id}.${k}" point ${i + 1} is "${pt}", not "x, y" or "x, y, r"` );
                return xy.map( c => {
                    if (c != "" && !isNaN( +c )) return +c;
                    const text = c.replace( /@([A-Za-z_][A-Za-z0-9_]*)(\.value)?/g, "$1" );
                    for (const name of Expr.names( text ))
                        if (!numbers.has( name )) throw new Error( `Graph: "${id}.${k}" point ${i + 1} uses "${name}", which is not a number node` );
                    return `(${text})`;
                } );
            } );
        };
        // the variable's values at n samples, 0 to 1, evenly spaced
        const samples = ( n : number ) => Array.from( { length : n }, ( _, i ) => i / (n - 1) );

        const parameters : { [name : string] : ModelValue } = {};
        const features : { [id : string] : ModelFeature } = {};
        const looks : Array<GraphLook> = [], via : { [look : string] : string } = {};
        for (const [id, n] of Object.entries( nodes )) {
            here( { node : id, type : n.type } );
            const t = types[id];
            const at = ( k : string ) => input( id, k );
            if (n.type == "component") {
                // the instance: the component's parameters and features under names prefixed with the instance's id,
                // its parameters set from the instance's inputs
                const c = inner[id].compiled;
                const own = ( name : string ) => `${id}__${name}`;
                const rename = Graph.renamer( id + "/", name => c.parameters[name] != null ? own( name ) : name );
                for (const [name, v] of Object.entries( c.parameters )) {
                    if (numbers.has( own( name ) )) throw new Error( `Graph: the parameter "${name}" of component "${id}" would be named "${own( name )}", which is already a number node` );
                    parameters[own( name )] = n.in?.[name] != null ? number( id, name ) : rename.value( v );
                }
                for (const [fid, f] of Object.entries( c.features )) features[id + "/" + fid] = rename.feature( f );
                for (const l of c.looks) looks.push( { id : id + "/" + l.id, kind : l.kind, of : id + "/" + l.of, depth : l.depth,
                    values : Object.fromEntries( Object.entries( l.values ).map( ([k, v]) => [k, typeof v == "string" && /^#|^[a-z]+$/.test( v ) ? v : rename.value( v )] ) ) } );
                continue;
            }
            const asNum = at;
            if (n.type == "number") { parameters[id] = asNum( "value" ); continue; }
            if (n.type.startsWith( "look/" )) {
                // a look: no feature; the solid it is given passes through it (`wire`), and it covers that solid's faces
                const values : { [k : string] : ModelValue } = {};
                for (const [k, p] of Object.entries( t.inputs )) {
                    if (p.kind == "solid") continue;
                    const v = at( k );
                    if (k == "color" && !/^#[0-9a-fA-F]{6}$/.test( String( v ) )) throw new Error( `Graph: "${id}.color" must be a colour "#rrggbb", not "${String( v )}"` );
                    values[k] = v;
                }
                let depth = 0;
                for (let k = REF.exec( String( n.in?.of ?? "" ).trim() ); k != null && nodes[k[1]]?.type.startsWith( "look/" ); k = REF.exec( String( nodes[k[1]].in?.of ?? "" ).trim() ))
                    if (++depth > 1000) break;
                looks.push( { id : id, kind : n.type.slice( 5 ) as GraphLook["kind"], of : at( "of" ) as string, depth : depth, values : values } );
                via[id] = at( "of" ) as string;
                continue;
            }
            if (n.type == "expression") {
                const text = String( at( "expr" ) );
                for (const name of Expr.names( text ))
                    if (!numbers.has( name )) throw new Error( `Graph: "${id}.expr" uses "${name}", which is not a number node` );
                parameters[id] = text;
                continue;
            }
            const m = MATH[n.type];
            if (m != null) { parameters[id] = m.expr( m.inputs.map( k => `(${String( asNum( k ) )})` ) ); continue; }
            // boxes and cylinders are the model's own features, which shells can offset
            if (n.type == "primitive/box") {
                const half = ( v : ModelValue ) : ModelValue => typeof v == "number" ? v / 2 : `(${v}) / 2`;
                const neg = ( v : ModelValue ) : ModelValue => typeof v == "number" ? -v : `-(${v})`;
                const w = half( asNum( "width" ) ), d = half( asNum( "depth" ) );
                features[id] = { type : "box", min : [neg( w ), neg( d ), 0], max : [w, d, asNum( "height" )] };
                continue;
            }
            if (n.type == "primitive/cylinder") {
                features[id] = { type : "cylinder", from : [0, 0, 0], to : [0, 0, asNum( "height" )], radius : asNum( "radius" ) };
                continue;
            }
            if (n.type.startsWith( "primitive/" )) {
                const values : { [name : string] : ModelValue } = {};
                for (const [k, p] of Object.entries( t.inputs )) values[p.label] = asNum( k );
                features[id] = { type : "primitive", shape : Graph.shapeOf( n.type ), values : values };
                continue;
            }
            const s = ( k : string ) => at( k ) as string;
            if (n.type == "profile/extrude") {
                features[id] = { type : "extrude", profile : outline( id, "profile" ), height : asNum( "height" ), z : asNum( "z" ), twist : asNum( "twist" ), scaleTop : asNum( "scaleTop" ) };
                continue;
            }
            if (n.type == "profile/revolve") {
                features[id] = { type : "lathe", profile : outline( id, "profile" ), degrees : asNum( "degrees" ) };
                continue;
            }
            const pt = ( a : string, b : string, c : string ) : [ModelValue, ModelValue, ModelValue] => [asNum( a ), asNum( b ), asNum( c )];
            switch (n.type) {
                case "transform/move": features[id] = { type : "transform", of : s( "of" ), translate : pt( "x", "y", "z" ) }; break;
                case "transform/rotate": {
                    const axis = s( "axis" );
                    features[id] = { type : "transform", of : s( "of" ), rotate : { axis : [axis == "x" ? 1 : 0, axis == "y" ? 1 : 0, axis == "z" ? 1 : 0], degrees : asNum( "degrees" ) } };
                    break;
                }
                case "transform/scale": features[id] = { type : "transform", of : s( "of" ), scale : asNum( "factor" ) }; break;
                case "boolean/union": features[id] = { type : "union", of : [s( "a" ), s( "b" )] }; break;
                case "boolean/intersection": features[id] = { type : "intersection", of : [s( "a" ), s( "b" )] }; break;
                case "boolean/difference": features[id] = { type : "difference", from : s( "from" ), minus : [s( "minus" )] }; break;
                case "logic/switch": {
                    // either side may be left unconnected: nothing
                    const side = ( k : string ) => { const v = nodes[id].in?.[k]; return typeof v == "string" && v.trim() != "" ? { [k == "on_solid" ? "then" : "else"] : wire( id, k, v, "solid" ) } : {}; };
                    features[id] = { type : "choose", when : asNum( "on" ), ...side( "on_solid" ), ...side( "off_solid" ) };
                    break;
                }
                case "finish/round": {
                    const shape = s( "shape" ) as "circular" | "curvature" | "chamfer";
                    const rules = s( "edges" ).split( "," ).map( e => e.trim() ).filter( e => e != "" ).map( e => ({ edges : e, radius : asNum( "radius" ) }) );
                    if (rules.length == 0) throw new Error( `Graph: "${id}.edges" names no edges` );
                    features[id] = { type : "round", of : s( "of" ), rules : rules, shape : shape };
                    break;
                }
                case "freeform/revolve": {
                    const r = sampler( id, "radius" ), h = asNum( "height" );
                    const z = ( t : number ) : ModelValue => typeof h == "number" ? h * t : `(${h}) * ${t}`;
                    features[id] = { type : "revolve", profile : samples( count( id, "samples" ) ).map( t => [r( t ), z( t )] as [ModelValue, ModelValue] ) };
                    break;
                }
                case "freeform/vessel": {
                    // the body turned from its outer profile, less the cavity open at the rim and the hollow under a
                    // foot, each its own revolve under the node's id
                    const minus : Array<string> = [];
                    for (const k of ["cavity", "foot"]) {
                        const pts = points( id, k );
                        if (pts == null) continue;
                        features[`${id}/${k}`] = { type : "revolve", profile : pts };
                        minus.push( `${id}/${k}` );
                    }
                    const body = { type : "revolve" as const, profile : points( id, "outer" )! };
                    if (minus.length == 0) features[id] = body;
                    else { features[`${id}/body`] = body; features[id] = { type : "difference", from : `${id}/body`, minus : minus }; }
                    break;
                }
                case "freeform/prism": {
                    const pts = pointsOf( id, "outline" );
                    if (pts.length < 3) throw new Error( `Graph: "${id}.outline" has ${pts.length} points; an outline needs three or more` );
                    // (an exact extrusion, #99: `center`, the point its caps once fanned from, is still accepted and checked,
                    // so documents that give one keep loading, but it no longer shapes anything)
                    const c = typeof (nodes[id].in?.center ?? "") == "string" && String( nodes[id].in?.center ?? "" ).trim() != "" ? pointsOf( id, "center" ) : null;
                    if (c != null && (c.length != 1 || c[0].length != 2)) throw new Error( `Graph: "${id}.center" is one point "x, y"` );
                    features[id] = { type : "prism", outline : pts, height : asNum( "height" ) };
                    break;
                }
                case "freeform/pipe": {
                    const x = sampler( id, "x" ), y = sampler( id, "y" ), z = sampler( id, "z" );
                    features[id] = { type : "pipe", through : samples( count( id, "samples" ) ).map( t => [x( t ), y( t ), z( t )] as [ModelValue, ModelValue, ModelValue] ),
                        radius : asNum( "radius" ) };
                    break;
                }
                case "finish/shell": {
                    const open = s( "open" ).split( "," ).map( e => e.trim() ).filter( e => e != "" );
                    features[id] = { type : "shell", of : s( "of" ), thickness : asNum( "thickness" ), open : open };
                    break;
                }
                default: throw new Error( `Graph: node type "${n.type}" has no compiler` );
            }
        }
        // every output names a solid node, or an instance's output
        const solidOf = ( name : string, ref : unknown ) : string => {
            here( { output : name } );
            const m = typeof ref == "string" ? REF.exec( ref.trim() ) : null;
            const sub = m == null ? null : inner[m[1]];
            if (m != null && m[2] == null && via[m[1]] != null) return via[m[1]];
            const f = m == null ? null : sub != null ? (m[2] != null && sub.compiled.outputs[m[2]] != null ? m[1] + "/" + sub.compiled.outputs[m[2]] : null)
                : m[2] == null || types[m[1]]?.outputs[m[2]] == "solid" ? m[1] : null;
            if (f == null || features[f] == null) throw new Error( `Graph: the output "${name}" is ${JSON.stringify( ref )}, not a reference to a solid node` );
            return f;
        };
        here( {} );
        const outputs = doc.outputs ?? {};
        const names = Object.keys( outputs );
        if (names.length == 0) throw new Error( `Graph: the document has no outputs` );
        const resolved : { [name : string] : string } = {};
        for (const name of names) {
            here( { output : name } );
            if (!NAME.test( name )) throw new Error( `Graph: "${name}" is not a valid output name (letters, digits, _ and -, starting with a letter or _)` );
            resolved[name] = solidOf( name, outputs[name] );
        }
        // for "@instance.output" references from `compile`
        for (const [id, sub] of Object.entries( inner ))
            for (const [name, f] of Object.entries( sub.compiled.outputs )) resolved[`${id}.${name}`] = f;
        // each feature's node type: a node's own, an instance's from inside it. A node that compiles to several
        // features (`freeform/vessel` gives `v/body`, `v/cavity`, ...) names them under its id, like an instance.
        const typeOf : { [feature : string] : string } = {};
        for (const fid of Object.keys( features )) {
            const slash = fid.indexOf( "/" ), owner = slash < 0 ? fid : fid.slice( 0, slash );
            typeOf[fid] = inner[owner] != null ? inner[owner].compiled.types[fid.slice( slash + 1 )] : nodes[owner].type;
        }
        return { parameters : parameters, features : features, outputs : resolved, types : typeOf, looks : looks, via : via };
    }

    /**
     * The node type of a component: its `number` nodes are its inputs (with their values, when numbers, as defaults),
     * its outputs its solid outputs. `use` names it in the title when the document has no `meta.name`.
     */
    public static componentType( use : string, doc : GraphDocument ) : GraphNodeType {
        const inputs : { [port : string] : GraphPort } = {};
        for (const [id, n] of Object.entries( doc.nodes ?? {} )) {
            if (n.type != "number") continue;
            const v = n.in?.value;
            const value = typeof v == "number" ? v : Number.NaN;
            inputs[id] = { kind : "number", label : n.label ?? id, value : value, min : Math.min( 0, value || 0 ), max : Math.max( 4 * (value || 0), 50 ), step : 0.5 };
        }
        const outputs : { [port : string] : GraphWire } = {};
        for (const name of Object.keys( doc.outputs ?? {} )) outputs[name] = "solid";
        return { title : doc.meta?.name ?? use, category : "component", help : doc.meta?.description ?? `An instance of ${use}`, inputs : inputs, outputs : outputs };
    }

    // Renames what a compiled component holds into an instance of it: features get `prefix` before every feature id
    // (references, and each feature id of a face or edge pattern), parameters `param(name)` in every expression.
    private static renamer( prefix : string, param : ( name : string ) => string ) {
        const value = ( v : ModelValue ) : ModelValue => typeof v == "number" ? v : v.replace( WORD, w => param( w ) );
        const point = ( p : [ModelValue, ModelValue, ModelValue] ) : [ModelValue, ModelValue, ModelValue] => [value( p[0] ), value( p[1] ), value( p[2] )];
        const pair = ( p : [ModelValue, ModelValue] ) : [ModelValue, ModelValue] => [value( p[0] ), value( p[1] )];
        const ref = ( id : string ) => prefix + id;
        // "a/b.face|c.*" -> "p/a/p/b.face|p/c.*": every segment of a name's path is a feature id
        const pattern = ( g : string ) => g.split( "|" ).map( term => {
            const dot = term.indexOf( "." );
            const path = dot < 0 ? term : term.slice( 0, dot ), rest = dot < 0 ? "" : term.slice( dot );
            return path.split( "/" ).map( seg => prefix + seg ).join( "/" ) + rest;
        } ).join( "|" );
        const feature = ( f : ModelFeature ) : ModelFeature => {
            switch (f.type) {
                case "box": return { ...f, min : point( f.min ), max : point( f.max ), ...(f.divs != null ? { divs : value( f.divs ) } : {}) };
                case "cylinder": return { ...f, from : point( f.from ), to : point( f.to ), radius : value( f.radius ), ...(f.divs != null ? { divs : pair( f.divs ) } : {}) };
                case "pipe": return { ...f, through : f.through.map( point ), radius : value( f.radius ), ...(f.divs != null ? { divs : pair( f.divs ) } : {}) };
                case "revolve": return { ...f, profile : f.profile.map( pair ), ...(f.divs != null ? { divs : pair( f.divs ) } : {}) };
                case "prism": return { ...f, outline : f.outline.map( p => p.map( value ) ), height : value( f.height ), ...(f.center != null ? { center : pair( f.center ) } : {}) };
                case "extrude": return { ...f, height : value( f.height ), ...(f.z != null ? { z : value( f.z ) } : {}),
                    ...(f.twist != null ? { twist : value( f.twist ) } : {}), ...(f.scaleTop != null ? { scaleTop : value( f.scaleTop ) } : {}) };
                case "lathe": return { ...f, ...(f.degrees != null ? { degrees : value( f.degrees ) } : {}) };
                case "primitive": return { ...f, ...(f.values != null ? { values : Object.fromEntries( Object.entries( f.values ).map( ([k, v]) => [k, value( v )] ) ) } : {}) };
                case "transform": return { ...f, of : ref( f.of ),
                    ...(f.scale != null ? { scale : Array.isArray( f.scale ) ? point( f.scale ) : value( f.scale ) } : {}),
                    ...(f.rotate != null ? { rotate : { axis : point( f.rotate.axis ), degrees : value( f.rotate.degrees ), ...(f.rotate.about != null ? { about : point( f.rotate.about ) } : {}) } } : {}),
                    ...(f.translate != null ? { translate : point( f.translate ) } : {}) };
                case "union": case "intersection": return { ...f, of : f.of.map( ref ) };
                case "difference": return { ...f, from : ref( f.from ), minus : f.minus.map( ref ) };
                case "choose": return { ...f, when : value( f.when ), ...(f.then != null ? { then : ref( f.then ) } : {}), ...(f.else != null ? { else : ref( f.else ) } : {}) };
                case "round": return { ...f, of : ref( f.of ), rules : f.rules.map( r => ({ edges : pattern( r.edges ), radius : value( r.radius ) }) ) };
                case "shell": return { ...f, of : ref( f.of ), thickness : value( f.thickness ), ...(f.open != null ? { open : f.open.map( pattern ) } : {}) };
                case "lattice": return { ...f, of : ref( f.of ), cell : value( f.cell ), wall : value( f.wall ),
                    ...(f.skin != null ? { skin : value( f.skin ) } : {}), ...(f.blend != null ? { blend : value( f.blend ) } : {}), ...(f.size != null ? { size : value( f.size ) } : {}),
                    ...(f.grade != null ? { grade : { axis : f.grade.axis, to : value( f.grade.to ) } } : {}), ...(f.open != null ? { open : f.open.map( pattern ) } : {}) };
            }
        };
        return { value : value, feature : feature };
    }

    /**
     * The JSON Schema (draft 2020-12) of graph documents, version 2, made from `Graph.REGISTRY`: every node type with
     * its inputs, their kinds and defaults. `schema/graph.v2.schema.json` is this, checked in; a test keeps the two
     * equal, and refuses a change to a released type, port or default (docs/formats.md, "Stability").
     * The schema checks shape only: what refers to what (wires, expressions, outputs) is checked by `compile`.
     */
    public static schema() : { [key : string] : unknown } {
        const value = { type : ["number", "string"] };
        const wire = { type : "string", pattern : REF.source };
        const defs : { [key : string] : unknown } = {};
        const types = Object.keys( Graph.REGISTRY );
        for (const type of types) {
            const t = Graph.REGISTRY[type];
            const ports : { [port : string] : unknown } = {};
            for (const [k, p] of Object.entries( t.inputs ))
                ports[k] = p.kind == "number" ? { ...value, description : p.unit == null ? p.label : `${p.label} (${p.unit})`, default : p.value }
                    : p.kind == "solid" ? { ...wire, description : `${p.label}: a solid, "@node"` }
                    : p.kind == "choice" ? { enum : p.options, description : p.label, default : p.value }
                    : p.kind == "points" ? { type : "string", description : `${p.label}: points "x, y; x, y, r; ...", millimetres; each value a number or an expression over number nodes; r rounds that corner`, default : p.value }
                    : p.kind == "profile" ? { type : "string", description : `${p.label}: points "r z; r z; ...", millimetres, from the base up${p.optional ? "; empty for none" : ""}`, default : p.value }
                    : p.kind == "function" ? { type : "string", description : `${p.label}, an expression of ${p.variable} (0 to 1) and number nodes`, default : p.value }
                    : p.kind == "outline" ? { type : "object", description : `${p.label}: { outer, holes }, paths of lines, three-point arcs and cubic Béziers, or circles, in millimetres (docs/formats.md, Profiles)`,
                        required : ["outer"], properties : { outer : { type : "object" }, holes : { type : "array", items : { type : "object" } } }, default : p.value }
                    : { type : "string", description : p.label, default : p.value };
            defs[type.replace( /\//g, "." )] = { title : t.title, description : t.help, type : "object", required : ["type"], additionalProperties : false,
                properties : { type : { const : type }, label : { type : "string" }, in : { type : "object", additionalProperties : false, properties : ports } } };
        }
        // an instance of another document: its inputs are that document's number nodes, so any name
        defs["component"] = { title : "Component", description : "An instance of another graph document (docs/formats.md, Components)", type : "object",
            required : ["type", "use"], additionalProperties : false,
            properties : { type : { const : "component" }, use : { type : "string", minLength : 1 }, hash : { type : "string", pattern : "^[0-9a-f]{16}$" },
                label : { type : "string" }, in : { type : "object", propertyNames : { pattern : ID.source }, additionalProperties : value } } };
        types.push( "component" );
        return {
            $schema : "https://json-schema.org/draft/2020-12/schema",
            $id : "https://github.com/smor/verb-nurbs-ts/schema/graph.v2.schema.json",
            title : "verb-nurbs-ts graph document, version 2",
            description : "A node graph (docs/formats.md). Lengths in millimetres, angles in degrees.",
            type : "object",
            required : ["version", "nodes", "outputs"],
            additionalProperties : false,
            properties : {
                version : { const : 2 },
                nodes : { type : "object", propertyNames : { pattern : ID.source }, additionalProperties : { $ref : "#/$defs/node" } },
                outputs : { type : "object", minProperties : 1, propertyNames : { pattern : NAME.source }, additionalProperties : wire },
                view : { type : "object" },
                meta : { type : "object" },
                machine : { anyOf : [{ type : "string" }, { type : "object" }] },
                components : { type : "object", description : "The document's own components, by name; \"#name\" uses one", additionalProperties : { $ref : "#" } },
            },
            $defs : {
                node : { type : "object", required : ["type"], properties : { type : { enum : types } },
                    allOf : types.map( type => ({ if : { properties : { type : { const : type } } }, then : { $ref : `#/$defs/${type.replace( /\//g, "." )}` } }) ) },
                ...defs,
            },
        };
    }

    /** Whether a node type gives a number (and so compiles into a parameter). */
    public static isNumber( t : GraphNodeType ) : boolean {
        return Object.values( t.outputs ).includes( "number" );
    }

    // the Catalog shape a primitive node type builds
    private static shapeOf( type : string ) : string {
        const e = Catalog.ENTRIES.find( x => "primitive/" + slug( x.name ) == type );
        if (e == null) throw new Error( `Graph: no catalogued shape for "${type}"` );
        return e.name;
    }

    private static registry() : { [type : string] : GraphNodeType } {
        const r : { [type : string] : GraphNodeType } = {};
        r["number"] = { title : "Number", category : "parameter", help : "A parameter: other nodes read it by a wire or by its id in an expression",
            inputs : { value : num( "value", 10, 0, 200, 0.5 ) }, outputs : { value : "number" } };
        r["expression"] = { title : "Expression", category : "math", help : "Any expression over number nodes, by their ids: h / 2 + wall",
            inputs : { expr : { kind : "text", label : "expression", value : "1" } }, outputs : { value : "number" } };
        for (const [type, m] of Object.entries( MATH ))
            r[type] = { title : m.title, category : "math", help : m.help, inputs : Object.fromEntries( m.inputs.map( k => [k, { ...value, label : k }] ) ),
                outputs : { value : "number" } };
        for (const e of Catalog.ENTRIES) {
            const type = "primitive/" + slug( e.name );
            if (r[type] != null) continue;  // a second catalogue entry of the same name cannot be built by name
            const inputs : { [port : string] : GraphPort } = {};
            for (const p of e.parameters)
                inputs[slug( p.name ).replace( /-/g, "_" )] = { kind : "number", label : p.name, value : p.value, min : p.min, max : p.max > 1000 ? Math.max( 4 * p.value, 50 ) : p.max,
                    step : p.integer ? 1 : 0.5, unit : p.degrees ? "°" : p.integer ? undefined : "mm", integer : p.integer };
            r[type] = { title : e.name[0].toUpperCase() + e.name.slice( 1 ), category : "primitive", help : `Catalogue: ${e.family}`, inputs : inputs, outputs : { solid : "solid" } };
        }
        // freeform solids: exact NURBS through points sampled from functions of t, 0 to 1
        const fn = ( label : string, v : string ) : GraphPort => ({ kind : "function", label : label, value : v, variable : "t" });
        const many = ( v : number ) : GraphPort => ({ kind : "number", label : "samples", value : v, min : 2, max : 64, step : 1, integer : true });
        r["freeform/revolve"] = { title : "Revolve", category : "freeform",
            help : "A solid of revolution about z, its radius a function of t from 0 at the base to 1 at the top: circles at the samples, lofted. A vase, a column, a bulb",
            inputs : { radius : fn( "radius", "18 + 7 * sin(pi * (1.4 * t + 0.1)) - 6 * t" ), height : num( "height", 90, 1, 400, 0.5, "mm" ), samples : many( 14 ) },
            outputs : { solid : "solid" } };
        r["freeform/pipe"] = { title : "Pipe", category : "freeform",
            help : "A round tube along the smooth curve through (x, y, z) at the samples of t from 0 to 1, capped at both ends: a tendril, a stem, a whiplash",
            inputs : { x : fn( "x", "25 * cos(3 * pi * t)" ), y : fn( "y", "25 * sin(3 * pi * t)" ), z : fn( "z", "70 * t" ),
                radius : num( "radius", 3, 0.2, 50, 0.1, "mm" ), samples : many( 24 ) },
            outputs : { solid : "solid" } };
        // a straight prism over an outline whose coordinates may be expressions: plates, ribs, tabs
        r["freeform/prism"] = { title : "Prism", category : "freeform",
            help : "An outline in the xy plane, extruded from z = 0 to its height. Points 'x, y' or 'x, y, r' (r rounds the corner), each value a number or an expression over number nodes. Any simple polygon: it is built as an exact extrusion, its caps planes trimmed by the outline. For curves, arcs and holes, Extrude profile",
            inputs : { outline : { kind : "points", label : "outline", value : "0, 0; 40, 0, 4; 40, 20, 4; 0, 20" }, height : num( "height", 5, 0.1, 400, 0.1, "mm" ),
                center : { kind : "points", label : "cap centre (not used)", value : "" } },
            outputs : { solid : "solid" } };
        // a vessel from its drawn section: the archaeologist's half-profile, outside, inside and under the foot
        const prof = ( label : string, v : string, optional : boolean ) : GraphPort => ({ kind : "profile", label : label, value : v, optional : optional });
        r["freeform/vessel"] = { title : "Vessel", category : "freeform",
            help : "A pot from its drawn half-section, in millimetres from the base up: the outer profile turned about z, less the cavity (from its floor to above the rim) and the hollow under a foot",
            inputs : { outer : prof( "outer", "30 0; 40 12; 46 30; 40 50; 44 60", false ), cavity : prof( "cavity", "26 5; 36 14; 42 30; 36 50; 40 63", true ),
                foot : prof( "foot", "", true ) },
            outputs : { solid : "solid" } };
        // a planar region extruded along z (507's profiles: lines, three-point arcs, cubic Béziers and circles, with holes)
        r["profile/extrude"] = { title : "Extrude profile", category : "primitive",
            help : "A planar profile (an outer path and holes: lines, three-point arcs, cubic Béziers, circles) extruded from z up by height, exact; the top turned by twist degrees and scaled by scaleTop about the z axis (helical and conical sides); faces bottom, top, outer.k and hole{i}.k for segment k",
            inputs : { profile : { kind : "outline", label : "profile", value : { outer : { kind : "path", start : [0, 0], segments : [
                    { type : "line", to : [30, 0] }, { type : "arc", via : [38, 10], to : [30, 20] }, { type : "line", to : [0, 20] }, { type : "line", to : [0, 0] }] },
                    holes : [{ kind : "circle", center : [12, 10], r : 4 }] } },
                height : num( "height", 6, 0.1, 400, 0.5, "mm" ), z : num( "z", 0, -200, 200, 0.5, "mm" ),
                twist : num( "twist", 0, -3600, 3600, 1, "°" ), scaleTop : num( "scaleTop", 1, 0.05, 4, 0.01 ) },
            outputs : { solid : "solid" } };
        // the same profile in the (r, z) half-plane turned about z (507's pulleys, eccentrics and hand wheels)
        r["profile/revolve"] = { title : "Revolve profile", category : "primitive",
            help : "A profile drawn in the (r, z) half-plane, x the radius and y the height (lines, three-point arcs, cubic Béziers, circles), turned about the z axis, exact; a segment along the axis makes no face; faces outer.k for segment k",
            inputs : { profile : { kind : "outline", label : "profile", value : { outer : { kind : "path", start : [3, 0], segments : [
                    { type : "line", to : [20, 0] }, { type : "line", to : [20, 2] }, { type : "line", to : [16, 6] }, { type : "line", to : [20, 10] },
                    { type : "line", to : [20, 12] }, { type : "line", to : [3, 12] }, { type : "line", to : [3, 0] }] } } },
                degrees : num( "degrees", 360, 1, 360, 1, "°" ) },
            outputs : { solid : "solid" } };
        const of = { of : solid( "solid" ) };
        r["transform/move"] = { title : "Move", category : "transform", help : "Translate by (x, y, z)",
            inputs : { ...of, x : num( "x", 0, -200, 200, 0.5, "mm" ), y : num( "y", 0, -200, 200, 0.5, "mm" ), z : num( "z", 0, -200, 200, 0.5, "mm" ) }, outputs : { solid : "solid" } };
        r["transform/rotate"] = { title : "Rotate", category : "transform", help : "Rotate about an axis through the origin",
            inputs : { ...of, axis : { kind : "choice", label : "axis", value : "z", options : ["x", "y", "z"] }, degrees : num( "degrees", 0, -180, 180, 1, "°" ) },
            outputs : { solid : "solid" } };
        r["transform/scale"] = { title : "Scale", category : "transform", help : "Scale about the origin; negative mirrors",
            inputs : { ...of, factor : num( "factor", 1, -4, 4, 0.05 ) }, outputs : { solid : "solid" } };
        r["boolean/union"] = { title : "Union", category : "boolean", help : "a ∪ b", inputs : { a : solid( "a" ), b : solid( "b" ) }, outputs : { solid : "solid" } };
        r["boolean/intersection"] = { title : "Intersection", category : "boolean", help : "a ∩ b", inputs : { a : solid( "a" ), b : solid( "b" ) }, outputs : { solid : "solid" } };
        r["boolean/difference"] = { title : "Difference", category : "boolean", help : "from − minus", inputs : { from : solid( "from" ), minus : solid( "minus" ) },
            outputs : { solid : "solid" } };
        r["logic/switch"] = { title : "Switch", category : "logic",
            help : "One solid or another, or nothing, as a number is on (not 0) or off (0): a part to include or not, holes to cut or not. Nothing drops out of a union and out of a difference's cutters",
            inputs : { on : { kind : "number", label : "on", value : 1, min : 0, max : 1, step : 1, integer : true },
                on_solid : { kind : "solid", label : "when on", optional : true }, off_solid : { kind : "solid", label : "when off", optional : true } },
            outputs : { solid : "solid" } };
        // looks: what the solid is made of and how it is painted; nothing built changes (glTF's metallic-roughness)
        const frac = ( label : string, value : number ) : GraphPort => ({ kind : "number", label : label, value : value, min : 0, max : 1, step : 0.01 });
        const colour = ( value : string ) : GraphPort => ({ kind : "text", label : "colour", value : value });
        r["look/material"] = { title : "Material", category : "look",
            help : "What the solid looks made of: a base colour, how rough (0 polished to 1 matt) and how metallic it is, a clear glossy coat over it (a glaze), and grain (the speckle of a coarse clay). Changes nothing that is built",
            inputs : { of : { kind : "solid", label : "solid" }, color : colour( "#b5653a" ), roughness : frac( "roughness", 0.85 ), metalness : frac( "metalness", 0 ),
                clearcoat : frac( "glaze", 0 ), grain : frac( "grain", 0.3 ) }, outputs : { solid : "solid" } };
        r["look/band"] = { title : "Painted band", category : "look",
            help : "A band of paint round the solid, between two heights given as fractions of its own height (0 the foot, 1 the top)",
            inputs : { of : { kind : "solid", label : "solid" }, color : colour( "#1c1613" ), from : frac( "from", 0.45 ), to : frac( "to", 0.5 ) }, outputs : { solid : "solid" } };
        r["look/motif"] = { title : "Painted motif", category : "look",
            help : "A frieze painted round the solid between two heights (fractions of its height): a meander, waves, a zigzag, dots, rays or a chequer, repeated `count` times round",
            inputs : { of : { kind : "solid", label : "solid" }, motif : { kind : "choice", label : "motif", value : "meander", options : ["meander", "wave", "zigzag", "dots", "rays", "checker"] },
                color : colour( "#1c1613" ), from : frac( "from", 0.55 ), to : frac( "to", 0.65 ), count : { kind : "number", label : "repeats", value : 12, min : 1, max : 60, step : 1, integer : true } },
            outputs : { solid : "solid" } };
        r["finish/round"] = { title : "Round edges", category : "finish", help : "Fillets or chamfers on the edges named by patterns, comma separated: box.*|box.*",
            inputs : { ...of, radius : num( "radius", 2, 0.1, 20, 0.1, "mm" ), edges : { kind : "text", label : "edges", value : "*" },
                shape : { kind : "choice", label : "shape", value : "circular", options : ["circular", "curvature", "chamfer"] } }, outputs : { solid : "solid" } };
        r["finish/shell"] = { title : "Shell", category : "finish", help : "Hollow the solid; faces named by patterns are left open",
            inputs : { ...of, thickness : num( "thickness", 2, 0.2, 20, 0.1, "mm" ), open : { kind : "text", label : "open faces", value : "" } }, outputs : { solid : "solid" } };
        return r;
    }
}
