// Components in the editor: the document's own library (`components`, used as "#name"), a component made from a
// selection of nodes, and an instance unpacked back into nodes. Pure functions over graph documents; the editor calls
// them and records one undo step for each.
import { Graph } from "../src/index.js";
import type { GraphDocument, GraphNode, GraphNodeType, ModelValue } from "../src/index.js";

type Library = { [name : string] : GraphDocument };
const REF = /^@([A-Za-z_][A-Za-z0-9_]*)(?:\.([A-Za-z_][A-Za-z0-9_ -]*))?$/;
// a name inside an expression or a list of points (not part of a number like 1e5, nor after a ".")
const WORD = /(?<![A-Za-z0-9_.])[A-Za-z_][A-Za-z0-9_]*/g;
const ID = /^[A-Za-z_][A-Za-z0-9_]*$/;
const clone = <T,>( x : T ) : T => JSON.parse( JSON.stringify( x ) ) as T;

/** The node type of a node: its registry type, or for an instance of the library, the component's. */
export function typeOf( node : GraphNode | undefined, library : Library ) : GraphNodeType | null {
    if (node == null) return null;
    if (node.type != "component") return Graph.REGISTRY[node.type] ?? null;
    const used = typeof node.use == "string" && node.use.startsWith( "#" ) ? library[node.use.slice( 1 )] : undefined;
    return used == null ? null : Graph.componentType( node.use!, used );
}

/** Whether a node gives a number (a parameter, a math node). */
const givesNumber = ( t : GraphNodeType | null ) => t != null && Graph.isNumber( t );

/** An id made from a name: letters, digits and _, not starting with a digit, and not one of `taken`. */
export function freeId( name : string, taken : ( id : string ) => boolean ) : string {
    let base = name.normalize( "NFD" ).replace( /[̀-ͯ]/g, "" ).replace( /[^A-Za-z0-9_]+/g, "_" ).replace( /^_+|_+$/g, "" ) || "part";
    if (/^\d/.test( base )) base = "c_" + base;
    let id = base, k = 1;
    while (taken( id )) id = `${base}${++k}`;
    return id;
}

// what a node's inputs refer to: wires ("@id", "@id.port") and the names in its expressions and points
function uses( node : GraphNode, t : GraphNodeType | null ) : { wires : Array<{ port : string, id : string, out : string | null }>, names : Set<string> } {
    const wires : Array<{ port : string, id : string, out : string | null }> = [], names = new Set<string>();
    for (const [k, v] of Object.entries( node.in ?? {} )) {
        if (typeof v != "string") continue;
        const m = REF.exec( v.trim() );
        if (m) { wires.push( { port : k, id : m[1], out : m[2] ?? null } ); continue; }
        const kind = t?.inputs[k]?.kind;
        if (kind == "number" || kind == "function" || kind == "points" || kind == "profile")
            for (const w of v.replace( /@([A-Za-z_][A-Za-z0-9_]*)(\.value)?/g, "$1" ).match( WORD ) ?? []) names.add( w );
    }
    return { wires, names };
}

// Renames node ids in a node's inputs: wires, names in expressions and points, and the feature ids at the start of the
// face and edge names of its patterns (`map(id)`: the new name, or null to keep it)
function renameIn( node : GraphNode, t : GraphNodeType | null, wire : ( id : string, out : string | null ) => string | null,
    name : ( id : string ) => string | null, face : ( id : string ) => string | null ) {
    if (node.in == null) return;
    for (const [k, v] of Object.entries( node.in )) {
        if (typeof v != "string") continue;
        const m = REF.exec( v.trim() );
        if (m) { const w = wire( m[1], m[2] ?? null ); if (w != null) node.in[k] = w; continue; }
        const kind = t?.inputs[k]?.kind;
        if (kind == "number" || kind == "function" || kind == "points" || kind == "profile")
            node.in[k] = v.replace( /@([A-Za-z_][A-Za-z0-9_]*)/g, ( all, id : string ) => { const n = name( id ); return n == null ? all : "@" + n; } )
                .replace( WORD, w => name( w ) ?? w );
        else if (kind == "text")
            // "s.side.3|*", "*crank/disc.top": a feature id after a pattern's start, a "|", a "*" or a ","
            node.in[k] = v.replace( /(?<![A-Za-z0-9_/.])([A-Za-z_][A-Za-z0-9_]*)(?=[./])/g, ( all, id : string ) => face( id ) ?? all );
    }
}

export interface Made {
    // the graph with the instance in place of the selection, and the component it is an instance of
    graph : GraphDocument;
    component : GraphDocument;
    // the component's name in the library ("#name"), and the instance's id
    name : string;
    instance : string;
}

/**
 * Makes a component of the selected nodes of `graph` (a top document or a component being edited; `library` is the top
 * document's). The component's inputs are its number nodes: the selected number nodes that nothing outside uses, and
 * a copy of each number the selection takes from outside (the instance is wired to the original, so the graph builds
 * the same). Its outputs are the selected solids used outside or exported, else the selection's last solids. Refused,
 * with a message, when the selection takes a solid from outside it, or holds no solid.
 * `values`: number nodes' current values, for those that are expressions.
 */
export function makeComponent( graph : GraphDocument, selected : Array<string>, title : string, library : Library, values : Record<string, number> = {} ) : Made {
    const g = clone( graph );
    const tOf = ( id : string ) => typeOf( g.nodes[id], library );
    const sel = new Set( selected.filter( id => g.nodes[id] != null ) );
    const outside = () => Object.keys( g.nodes ).filter( id => !sel.has( id ) );
    // a selected number node that something outside uses stays outside
    for (const id of [...sel]) if (g.nodes[id].type == "number" && outside().some( o => { const u = uses( g.nodes[o], tOf( o ) ); return u.names.has( id ) || u.wires.some( w => w.id == id ); } )) sel.delete( id );
    if (![...sel].some( id => !givesNumber( tOf( id ) ) )) throw new Error( "Select at least one solid node to make a component" );
    const label = ( id : string ) => g.nodes[id].label ?? id;

    // what the selection takes from outside: numbers become the component's parameters; a solid is refused
    const takes = new Set<string>();
    for (const id of sel) {
        const u = uses( g.nodes[id], tOf( id ) );
        for (const w of u.wires) if (!sel.has( w.id ) && g.nodes[w.id] != null) {
            if (!givesNumber( tOf( w.id ) )) throw new Error( `"${label( id )}" takes the solid of "${label( w.id )}", which is not selected: select it too, or leave "${label( id )}" out` );
            takes.add( w.id );
        }
        for (const n of u.names) if (!sel.has( n ) && givesNumber( tOf( n ) )) takes.add( n );
    }

    const name = freeId( title, k => library[k] != null );
    const inst = freeId( title.toLowerCase(), k => g.nodes[k] != null && !sel.has( k ) || k == "components" );
    const viewNodes = (g.view?.nodes ?? {}) as Record<string, { x : number, y : number }>;
    const params = ((g.view as { params? : Record<string, unknown> } | undefined)?.params ?? {});
    const c : GraphDocument = { version : 2, nodes : {}, outputs : {}, meta : { name : title }, view : { nodes : {}, params : {} } };
    const cv = c.view!.nodes!, cp = (c.view as { params : Record<string, unknown> }).params;
    for (const id of sel) {
        c.nodes[id] = g.nodes[id];
        if (viewNodes[id]) cv[id] = viewNodes[id];
        if (params[id] != null) cp[id] = params[id];
    }
    // the numbers taken from outside: a number node each, set to the value they have now, in a column on the left
    const xs = [...sel].map( id => viewNodes[id]?.x ?? 0 ), ys = [...sel].map( id => viewNodes[id]?.y ?? 0 );
    const left = Math.min( ...xs ), top = Math.min( ...ys );
    const instanceIn : { [k : string] : ModelValue } = {};
    [...takes].forEach( ( id, i ) => {
        const n = g.nodes[id];
        const own = n.type == "number" ? n.in?.value : undefined;
        const value : ModelValue = typeof own == "number" ? own : values[id] ?? 0;
        c.nodes[id] = { type : "number", in : { value }, ...(n.label != null ? { label : n.label } : {}) };
        cv[id] = { x : left - 300, y : top + i * 120 };
        if (params[id] != null) cp[id] = params[id];
        instanceIn[id] = "@" + id;
    } );

    // outputs: the selected solids that something outside uses or the graph exports
    const outName = ( id : string, out : string | null ) => out == null ? id : `${id}_${out.replace( /[^A-Za-z0-9_-]/g, "_" )}`;
    const exported = new Map<string, { id : string, out : string | null }>();
    const consider = ( id : string, out : string | null ) => { if (sel.has( id ) && !givesNumber( tOf( id ) )) exported.set( outName( id, out ), { id, out } ); };
    for (const o of outside()) for (const w of uses( g.nodes[o], tOf( o ) ).wires) consider( w.id, w.out );
    for (const v of Object.values( g.outputs ?? {} )) { const m = REF.exec( String( v ).trim() ); if (m) consider( m[1], m[2] ?? null ); }
    if (exported.size == 0) {
        // nothing outside uses the selection: its last solids, those no selected node takes
        const taken = new Set( [...sel].flatMap( id => uses( g.nodes[id], tOf( id ) ).wires.map( w => w.id ) ) );
        for (const id of sel) if (!givesNumber( tOf( id ) ) && !taken.has( id )) exported.set( id, { id, out : null } );
    }
    for (const [n, w] of exported) c.outputs[n] = "@" + w.id + (w.out != null ? "." + w.out : "");

    // the instance, in the middle of where the selection was
    for (const id of sel) { delete g.nodes[id]; delete viewNodes[id]; delete params[id]; }
    g.nodes[inst] = { type : "component", use : "#" + name, ...(Object.keys( instanceIn ).length ? { in : instanceIn } : {}), label : title };
    if (g.view != null) {
        g.view.nodes = { ...viewNodes, [inst] : { x : Math.round( xs.reduce( (a, b) => a + b, 0 ) / xs.length ), y : Math.round( ys.reduce( (a, b) => a + b, 0 ) / ys.length ) } };
        if (typeof g.view.show == "string" && sel.has( g.view.show )) delete g.view.show;
    }
    // what referred to the selection now refers to the instance: its outputs, and its faces under its id
    const lib = { ...library, [name] : c };
    const instOut = ( id : string, out : string | null ) => exported.has( outName( id, out ) ) ? `@${inst}.${outName( id, out )}` : null;
    for (const o of Object.keys( g.nodes )) if (o != inst)
        renameIn( g.nodes[o], typeOf( g.nodes[o], lib ), ( id, out ) => sel.has( id ) ? instOut( id, out ) : null, () => null, id => sel.has( id ) ? `${inst}/${id}` : null );
    for (const [k, v] of Object.entries( g.outputs ?? {} )) { const m = REF.exec( String( v ).trim() ); if (m && sel.has( m[1] )) g.outputs[k] = instOut( m[1], m[2] ?? null )!; }
    return { graph : g, component : c, name, instance : inst };
}

/**
 * Unpacks an instance of the library: the component's nodes take its place (renamed where an id is taken), its
 * parameters set as the instance set them, and what used the instance's outputs uses the nodes inside.
 */
export function unpack( graph : GraphDocument, instance : string, library : Library ) : GraphDocument {
    const g = clone( graph );
    const node = g.nodes[instance];
    const c = node?.type == "component" && typeof node.use == "string" && node.use.startsWith( "#" ) ? clone( library[node.use.slice( 1 )] ) : null;
    if (c == null) throw new Error( `"${instance}" is not an instance of one of this document's components` );
    // the instance gives way first: a node inside may take its id
    delete g.nodes[instance];
    const before = Object.keys( g.nodes );
    const map = new Map<string, string>();
    // a parameter the instance wires to an outer number node is that node: what used it inside uses it
    const alias = new Set<string>();
    for (const [id, n] of Object.entries( c.nodes )) {
        const w = n.type == "number" ? REF.exec( String( node.in?.[id] ?? "" ).trim() ) : null;
        if (w != null && (w[2] == null || w[2] == "value") && g.nodes[w[1]] != null) { map.set( id, w[1] ); alias.add( id ); }
    }
    for (const id of Object.keys( c.nodes )) if (!alias.has( id )) map.set( id, freeId( id, k => g.nodes[k] != null || [...map.values()].includes( k ) || !ID.test( k ) ) );
    const viewNodes = (g.view = g.view ?? {}, g.view.nodes = g.view.nodes ?? {});
    const at = viewNodes[instance] ?? { x : 0, y : 0 };
    delete viewNodes[instance];
    const cv = c.view?.nodes ?? {};
    const cxs = Object.keys( c.nodes ).map( id => cv[id]?.x ?? 0 ), cys = Object.keys( c.nodes ).map( id => cv[id]?.y ?? 0 );
    const ox = Math.min( ...cxs ), oy = Math.min( ...cys );
    const params = ((g.view as { params? : Record<string, unknown> }).params ??= {});
    const cparams = (c.view as { params? : Record<string, unknown> } | undefined)?.params ?? {};
    for (const [id, n] of Object.entries( c.nodes )) {
        if (alias.has( id )) continue;
        const to = map.get( id )!;
        renameIn( n, typeOf( n, library ), ( src, out ) => map.has( src ) ? "@" + map.get( src ) + (out != null ? "." + out : "") : null,
            w => map.get( w ) ?? null, f => map.get( f ) ?? null );
        // a parameter the instance sets: its value, as the instance gave it
        if (n.type == "number" && node.in?.[id] != null) n.in = { ...n.in, value : node.in[id] as ModelValue };
        g.nodes[to] = n;
        viewNodes[to] = { x : Math.round( at.x + (cv[id]?.x ?? 0) - ox ), y : Math.round( at.y + (cv[id]?.y ?? 0) - oy ) };
        if (cparams[id] != null) params[to] = cparams[id];
    }
    // the instance's outputs: the nodes inside that gave them
    const inside = ( out : string | null ) => {
        const r = REF.exec( String( c.outputs[out ?? Object.keys( c.outputs )[0]] ?? "" ).trim() );
        return r == null ? null : "@" + map.get( r[1] ) + (r[2] != null ? "." + r[2] : "");
    };
    for (const o of before) renameIn( g.nodes[o], typeOf( g.nodes[o], library ), ( id, out ) => id == instance ? inside( out ) : null, () => null, () => null );
    for (const o of before) { const n = g.nodes[o]; if (n.in) for (const [k, v] of Object.entries( n.in )) {
        // faces of the instance in patterns: "inst/x.top" becomes "x'.top"
        if (typeof v == "string" && v.includes( instance + "/" ))
            n.in[k] = v.replace( new RegExp( `(?<![A-Za-z0-9_/.])${instance}/([A-Za-z_][A-Za-z0-9_]*)`, "g" ), ( all, id : string ) => map.get( id ) ?? all );
    } }
    for (const [k, v] of Object.entries( g.outputs ?? {} )) { const m = REF.exec( String( v ).trim() ); if (m && m[1] == instance) g.outputs[k] = inside( m[2] ?? null )!; }
    if (g.view.show == instance) delete g.view.show;
    return g;
}

/** The instances of the library in a document and in its components: how many use each component. */
export function usage( doc : GraphDocument ) : Record<string, number> {
    const n : Record<string, number> = {};
    for (const d of [doc, ...Object.values( doc.components ?? {} )])
        for (const x of Object.values( d.nodes )) if (x.type == "component" && x.use?.startsWith( "#" )) n[x.use.slice( 1 )] = (n[x.use.slice( 1 )] ?? 0) + 1;
    return n;
}
