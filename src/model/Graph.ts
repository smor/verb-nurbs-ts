import { Catalog } from "../solid/primitives/Catalog.js";
import { Expr } from "./Expr.js";
import { Model } from "./Model.js";
import type { Machine } from "../solid/Makeable.js";
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
    category : "parameter" | "math" | "primitive" | "transform" | "boolean" | "finish";
    help : string;
    inputs : { [port : string] : GraphPort };
    outputs : { [port : string] : GraphWire };
}

/** A node of a graph document. */
export interface GraphNode {
    type : string;
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
}

/** A graph evaluated: the model's result, the model document it compiled into, and each node's state. */
export interface GraphResult extends ModelResult {
    model : ModelDocument;
    // the output evaluated: its name, or the reference asked for
    output : string;
    // "built": computed by this evaluation; "cached": taken from an earlier one; "parameter": a number node;
    // "unused": not upstream of the output
    nodes : { [id : string] : "built" | "cached" | "parameter" | "unused" };
}

// the top-level keys of a graph document
const TOP = ["version", "nodes", "outputs", "view", "meta", "machine"];
const ID = /^[A-Za-z_][A-Za-z0-9_]*$/;
// an output's name: an id that may also hold "-" (a part's name, "axle-washer"); never used in expressions
const NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const REF = /^@([A-Za-z_][A-Za-z0-9_]*)(?:\.([A-Za-z_][A-Za-z0-9_ ]*))?$/;

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

    /**
     * Evaluates a graph document (or a version 1 model document, as it is). The graph keeps what it built, so
     * evaluating an edited document rebuilds only what the edit changed.
     */
    public evaluate( doc : GraphDocument | ModelDocument, options : GraphOptions = {} ) : GraphResult {
        if (doc.version === 1) {
            const r = this.model.evaluate( doc );
            const nodes : GraphResult["nodes"] = {};
            for (const [id, f] of Object.entries( r.features )) nodes[id] = f.built ? "built" : "cached";
            return { ...r, model : doc, output : doc.output, nodes : nodes };
        }
        const model = Graph.compile( doc, options );
        const r = this.model.evaluate( model );
        const nodes : GraphResult["nodes"] = {};
        for (const id of Object.keys( doc.nodes )) {
            const t = Graph.REGISTRY[doc.nodes[id].type];
            const f = r.features[id];
            nodes[id] = Graph.isNumber( t ) ? "parameter" : f == null ? "unused" : f.built ? "built" : "cached";
        }
        return { ...r, model : model, output : options.output ?? Object.keys( doc.outputs )[0], nodes : nodes };
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
        for (const [id, n] of Object.entries( nodes )) {
            if (!ID.test( id )) throw new Error( `Graph: "${id}" is not a valid node id (letters, digits and _, not starting with a digit)` );
            const t = Graph.REGISTRY[n.type];
            if (t == null) throw new Error( `Graph: node "${id}" has an unknown type "${n.type}"` );
            for (const k of Object.keys( n.in ?? {} )) if (t.inputs[k] == null) throw new Error( `Graph: node "${id}" (${n.type}) has no input "${k}"` );
            if (Graph.isNumber( t )) {
                // a number node is a parameter, named by its id in expressions
                if (Expr.reserved( id )) throw new Error( `Graph: "${id}" is a function or constant of expressions; give the number node another id` );
                numbers.add( id );
            }
        }
        // "@id" or "@id.port", checked against the node's outputs and the wire's kind
        const wire = ( id : string, k : string, v : string, want : GraphWire ) : string => {
            const m = REF.exec( v.trim() );
            if (m == null) throw new Error( `Graph: "${id}.${k}" must be a reference like "@node", not "${v}"` );
            const src = nodes[m[1]];
            if (src == null) throw new Error( `Graph: "${id}.${k}" refers to "${m[1]}", which is not a node` );
            const outs = Graph.REGISTRY[src.type].outputs;
            const port = m[2] ?? Object.keys( outs )[0];
            if (outs[port] == null) throw new Error( `Graph: "${id}.${k}" refers to "${m[1]}.${port}", which is not an output` );
            if (outs[port] != want) throw new Error( `Graph: "${id}.${k}" takes a ${want}, but "${m[1]}.${port}" is a ${outs[port]}` );
            return m[1];
        };
        // a number input: literal, expression over number nodes ("@h" may stand for "h"), or a wire
        const number = ( id : string, k : string ) : ModelValue => {
            const p = Graph.REGISTRY[nodes[id].type].inputs[k] as Extract<GraphPort, { kind : "number" }>;
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
            const p = Graph.REGISTRY[nodes[id].type].inputs[k];
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
            const t = Graph.REGISTRY[n.type];
            const at = ( k : string ) => input( id, k );
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
        // every output names a solid node; the one asked for (by name, or "@id") is the model's output
        const solidOf = ( name : string, ref : unknown ) : string => {
            const m = typeof ref == "string" ? REF.exec( ref.trim() ) : null;
            if (m == null || features[m[1]] == null) throw new Error( `Graph: the output "${name}" is ${JSON.stringify( ref )}, not a reference to a solid node` );
            return m[1];
        };
        const outputs = doc.outputs ?? {};
        const names = Object.keys( outputs );
        if (names.length == 0) throw new Error( `Graph: the document has no outputs` );
        for (const name of names) {
            if (!NAME.test( name )) throw new Error( `Graph: "${name}" is not a valid output name (letters, digits, _ and -, starting with a letter or _)` );
            solidOf( name, outputs[name] );
        }
        const want = options.output ?? names[0];
        if (!want.startsWith( "@" ) && outputs[want] == null) throw new Error( `Graph: the document has no output "${want}" (${names.join( ", " )})` );
        const output = solidOf( want, want.startsWith( "@" ) ? want : outputs[want] );
        const model : ModelDocument = { version : 1, parameters : parameters, features : features, output : output };
        if (doc.machine != null) model.machine = doc.machine;
        return model;
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
