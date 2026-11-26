import { Catalog } from "../solid/primitives/Catalog.js";
import { Expr } from "./Expr.js";
import { Model, ModelError } from "./Model.js";
import { ShellBuilder } from "../solid/BrepShell.js";
import { ShellMesher } from "../solid/ShellMesher.js";
import type { BrepShell } from "../solid/BrepShell.js";
import type { BooleanResult } from "../solid/BrepBoolean.js";
import type { Machine } from "../solid/Makeable.js";
import type { MeshTolerance } from "../solid/ShellMesher.js";
import type { TriMesh } from "../solid/TriMesh.js";
import type { ModelDocument, ModelFeature, ModelResult, ModelValue } from "./Model.js";

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
    // a solid: always a wire
    | { kind : "solid", label : string }
    // a word chosen from a list (a fillet's shape, an axis)
    | { kind : "choice", label : string, value : string, options : Array<string> }
    // free text that is not an expression (an edge or face name pattern)
    | { kind : "text", label : string, value : string };

/** A node type: its ports, and how it compiles into model parameters or features. */
export interface GraphNodeType {
    title : string;
    category : "parameter" | "math" | "primitive" | "transform" | "boolean" | "finish" | "component";
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
    in? : { [port : string] : ModelValue };
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
    // the tolerance asked ("analysis": none), and the largest deviation from the exact faces measured (null: not measured)
    tolerance : MeshTolerance | null;
    deviation : number | null;
}

// A document compiled whole: every parameter and feature, the feature each output names, and the node type of each
// feature (an instance's features under their prefixed ids).
interface Compiled { parameters : { [name : string] : ModelValue }, features : { [id : string] : ModelFeature }, outputs : { [name : string] : string },
                     types : { [feature : string] : string } }

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
    // "unused": not upstream of the output
    nodes : { [id : string] : "built" | "cached" | "parameter" | "unused" };
    // the export mesh, when `mesh` was asked for
    export? : GraphMesh;
}

// the top-level keys of a graph document
const TOP = ["version", "nodes", "outputs", "view", "meta", "machine"];
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
        const { model, types } = Graph.compileTyped( doc, options );
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
            nodes[id] = Graph.isNumber( t ) ? "parameter" : f == null ? "unused" : f.built ? "built" : "cached";
        }
        return this.withMesh( { ...r, model : model, output : options.output ?? Object.keys( doc.outputs )[0], nodes : nodes }, options );
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
            return { mesh : r.result.mesh, faceNames : r.result.faceOf.map( f => r.faceNames[f] ), tolerance : null, deviation : null };
        }
        const T = ShellMesher.tolerance( given );
        let known = this.shells.get( r.result );
        if (known == null) {
            known = { shell : ShellBuilder.fromResult( r.result ), meshes : new Map() };
            this.shells.set( r.result, known );
        }
        const key = JSON.stringify( [T.chordal, T.angle ?? null, T.maxEdge ?? null] );
        let m = known.meshes.get( key );
        if (m == null) {
            const shell = known.shell, sm = ShellMesher.mesh( shell, T );
            m = { mesh : sm.mesh, faceNames : sm.faceOf.map( k => r.faceNames[shell.faces[k].source] ), tolerance : T, deviation : sm.deviation };
            known.meshes.set( key, m );
        }
        return m;
    }

    private withMesh( r : GraphResult, options : GraphOptions ) : GraphResult {
        return options.mesh == null ? r : { ...r, export : this.exportMesh( r, options.mesh ) };
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
    private static compileTyped( doc : GraphDocument, options : GraphOptions ) : { model : ModelDocument, types : { [feature : string] : string } } {
        const c = Graph.compileAll( doc, options, [] );
        const names = Object.keys( doc.outputs );
        const want = options.output ?? names[0];
        let output : string;
        if (want.startsWith( "@" )) {
            const m = REF.exec( want.trim() );
            const f = m == null ? null : m[2] == null ? m[1] : c.features[m[1] + "/" + (c.outputs[`${m[1]}.${m[2]}`] ?? "")] != null ? m[1] + "/" + c.outputs[`${m[1]}.${m[2]}`] : null;
            if (f == null || c.features[f] == null) throw new GraphError( `Graph: the output "${want}" is ${JSON.stringify( want )}, not a reference to a solid node`, "document", { output : want } );
            output = f;
        } else {
            if (c.outputs[want] == null) throw new GraphError( `Graph: the document has no output "${want}" (${names.join( ", " )})`, "document", { output : want } );
            output = c.outputs[want];
        }
        const model : ModelDocument = { version : 1, parameters : c.parameters, features : c.features, output : output };
        if (doc.machine != null) model.machine = doc.machine;
        return { model : model, types : c.types };
    }

    /**
     * The content hash of a graph document: what a component node's `hash` pins. `meta` and `view` are left out, so
     * moving a node or renaming the document does not change it.
     */
    public static hash( doc : GraphDocument ) : string {
        return Model.hash( Model.canonical( { version : doc.version, nodes : doc.nodes, outputs : doc.outputs, machine : doc.machine } ) );
    }

    // Compiles a whole document: every parameter, every feature, and the feature of each output (plus, for each
    // instance's output, "instance.output" to the feature inside it, without the instance's prefix). `stack`: the
    // components being compiled, outermost first, to refuse a component that uses itself.
    private static compileAll( doc : GraphDocument, options : GraphOptions, stack : Array<string> ) : Compiled {
        const where : Where = {};
        try {
            return Graph.compileIn( doc, options, stack, where );
        } catch (e) {
            if (e instanceof GraphError) throw e;
            throw new GraphError( e instanceof Error ? e.message : String( e ), where.node != null ? "node" : "document", where );
        }
    }

    // `compileAll`'s work, keeping in `where` the node, port or output it is at, for the error if it fails.
    private static compileIn( doc : GraphDocument, options : GraphOptions, stack : Array<string>, where : Where ) : Compiled {
        const here = ( w : Where ) => { delete where.node; delete where.type; delete where.port; delete where.output; Object.assign( where, w ); };
        if (doc.version !== 2) throw new Error( `Graph: unknown document version ${String( ( doc as { version? : unknown } ).version )}` );
        for (const k of Object.keys( doc )) if (!TOP.includes( k )) throw new Error( `Graph: "${k}" is not a key of a graph document (${TOP.join( ", " )})` );
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
                if (options.resolve == null) throw new Error( `Graph: component "${id}" uses "${n.use}", but nothing was given to resolve components` );
                if (stack.includes( n.use )) throw new Error( `Graph: component "${id}" uses "${n.use}", which uses itself (${[...stack, n.use].join( " → " )})` );
                const used = options.resolve( n.use, from );
                if (n.hash != null && Graph.hash( used ) != n.hash)
                    throw new Error( `Graph: component "${id}" pins "${n.use}" at ${n.hash}, but it is now ${Graph.hash( used )}` );
                let compiled : Compiled;
                try {
                    compiled = Graph.compileAll( used, { resolve : options.resolve }, [...stack, n.use] );
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
                case "text":
                    if (v != null && typeof v != "string") throw new Error( `Graph: "${id}.${k}" must be text` );
                    return v ?? p.value;
            }
        };

        const parameters : { [name : string] : ModelValue } = {};
        const features : { [id : string] : ModelFeature } = {};
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
                continue;
            }
            const asNum = at;
            if (n.type == "number") { parameters[id] = asNum( "value" ); continue; }
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
                case "finish/round": {
                    const shape = s( "shape" ) as "circular" | "curvature" | "chamfer";
                    const rules = s( "edges" ).split( "," ).map( e => e.trim() ).filter( e => e != "" ).map( e => ({ edges : e, radius : asNum( "radius" ) }) );
                    if (rules.length == 0) throw new Error( `Graph: "${id}.edges" names no edges` );
                    features[id] = { type : "round", of : s( "of" ), rules : rules, shape : shape };
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
        // each feature's node type: a node's own, an instance's from inside it
        const typeOf : { [feature : string] : string } = {};
        for (const fid of Object.keys( features )) {
            const slash = fid.indexOf( "/" );
            typeOf[fid] = slash < 0 ? nodes[fid].type : inner[fid.slice( 0, slash )].compiled.types[fid.slice( slash + 1 )];
        }
        return { parameters : parameters, features : features, outputs : resolved, types : typeOf };
    }

    // The node type of a component: its `number` nodes are its inputs (with their values, when numbers, as defaults),
    // its outputs its solid outputs.
    private static componentType( use : string, doc : GraphDocument ) : GraphNodeType {
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
                case "primitive": return { ...f, ...(f.values != null ? { values : Object.fromEntries( Object.entries( f.values ).map( ([k, v]) => [k, value( v )] ) ) } : {}) };
                case "transform": return { ...f, of : ref( f.of ),
                    ...(f.scale != null ? { scale : Array.isArray( f.scale ) ? point( f.scale ) : value( f.scale ) } : {}),
                    ...(f.rotate != null ? { rotate : { axis : point( f.rotate.axis ), degrees : value( f.rotate.degrees ), ...(f.rotate.about != null ? { about : point( f.rotate.about ) } : {}) } } : {}),
                    ...(f.translate != null ? { translate : point( f.translate ) } : {}) };
                case "union": case "intersection": return { ...f, of : f.of.map( ref ) };
                case "difference": return { ...f, from : ref( f.from ), minus : f.minus.map( ref ) };
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
        r["finish/round"] = { title : "Round edges", category : "finish", help : "Fillets or chamfers on the edges named by patterns, comma separated: box.*|box.*",
            inputs : { ...of, radius : num( "radius", 2, 0.1, 20, 0.1, "mm" ), edges : { kind : "text", label : "edges", value : "*" },
                shape : { kind : "choice", label : "shape", value : "circular", options : ["circular", "curvature", "chamfer"] } }, outputs : { solid : "solid" } };
        r["finish/shell"] = { title : "Shell", category : "finish", help : "Hollow the solid; faces named by patterns are left open",
            inputs : { ...of, thickness : num( "thickness", 2, 0.2, 20, 0.1, "mm" ), open : { kind : "text", label : "open faces", value : "" } }, outputs : { solid : "solid" } };
        return r;
    }
}
