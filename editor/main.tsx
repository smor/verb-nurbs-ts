// The node editor: a React Flow canvas over a graph document (docs/visual-programming.md). The document is the truth;
// the canvas's nodes and edges are derived from it, and every edit is written back into it and sent to the worker.
import { createRoot } from "react-dom/client";
import { useEffect, useRef, useState, createContext, useContext, useMemo } from "react";
import { ReactFlow, ReactFlowProvider, Handle, Position, useNodesState, useEdgesState, useReactFlow, Background, Controls, MiniMap } from "@xyflow/react";
import type { Node, Edge, Connection, NodeProps } from "@xyflow/react";
import flowCss from "@xyflow/react/dist/style.css";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { toCreasedNormals } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { CSS2DRenderer, CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { Graph, Expr } from "../src/index.js";
import type { GraphDocument, GraphPort, ModelValue } from "../src/index.js";
import { SAMPLES } from "./samples.js";
import { History } from "./history.js";
import { NumberField, ToggleField, ChoiceField } from "./controls/NumberField.js";
import { ParamMenu } from "./controls/ParamMenu.js";
import type { ParamMeta } from "./controls/ParamMenu.js";
import { resolve as resolveRange } from "./controls/math.js";
import { layout } from "./shelf.js";
import { encode, fromLink, restore, autosave, saveFile, saveBinary, openFile, forgetFile, LINK_KEY, inViewer, zip } from "./storage.js";
import type { ShelfSpec, Box } from "./shelf.js";
import { typeOf, makeComponent, unpack, usage } from "./components.js";

declare const WORKER_SOURCE : string;
// a document the build opens on (EDITOR_START), or ""
declare const START_DOC : string;

const REGISTRY = Graph.REGISTRY;
const REF = /^@([A-Za-z_][A-Za-z0-9_]*)(?:\.([A-Za-z_][A-Za-z0-9_ ]*))?$/;
const ref = ( v : ModelValue | object | undefined ) : [string, string] | null => {
    if (typeof v != "string") return null;
    const m = REF.exec( v.trim() );
    return m ? [m[1], m[2] ?? ""] : null;
};
const clone = <T,>( x : T ) : T => JSON.parse( JSON.stringify( x ) ) as T;

const isGraph = ( d : unknown ) : d is GraphDocument => typeof d == "object" && d != null && (d as GraphDocument).version === 2 && typeof (d as GraphDocument).nodes == "object";
// the document the editor opens with: the last one autosaved in this browser, else the first sample (a document in the
// link, #g=..., replaces it as soon as it is decoded)
const SAVED = restore();
const START = (() => { try { const d = START_DOC ? JSON.parse( START_DOC ) as unknown : null; return isGraph( d ) ? d : null; } catch { return null; } })();
let DOC : GraphDocument = isGraph( SAVED ) ? SAVED : START != null ? clone( START ) : clone( SAMPLES[0].doc );
// The graph on the canvas: the document, or one of its components being edited (SCOPES: the components opened, the
// innermost last, by name in the document's `components`). Undo, autosave, files and links are of the whole document.
const SCOPES : Array<string> = [];
const G = () : GraphDocument => { const s = SCOPES[SCOPES.length - 1]; return s != null && DOC.components?.[s] != null ? DOC.components[s] : DOC; };
const setG = ( g : GraphDocument ) => { const s = SCOPES[SCOPES.length - 1]; if (s != null && DOC.components?.[s] != null) DOC.components[s] = g; else DOC = { ...g, components : DOC.components }; };
const LIB = () => DOC.components ?? {};
// a node's type: the registry's, or an instance's, from its component
const T = ( id : string ) => typeOf( G().nodes[id], LIB() );
// what the graph builds for a solid node: "@id", or an instance's first output
const solidRef = ( id : string ) => {
    if (G().nodes[id]?.type != "component") return "@" + id;
    const o = Object.keys( T( id )?.outputs ?? {} )[0];
    return o == null ? "@" + id : `@${id}.${o}`;
};
// what the worker builds: the document, or the component being edited with the document's library
const evalDoc = () : GraphDocument => G() === DOC ? DOC : { ...G(), components : LIB() };
// the solid node the 3D view shows: the one asked for with Show, else the document's first output
const shownNode = () : string => {
    const s = G().view?.show;
    if (typeof s == "string" && G().nodes[s] != null) return s;
    return ref( Object.values( G().outputs ?? {} )[0] )?.[0] ?? "";
};
// the name of the output that exports a node, if any; adding one names it after the node, removing the last is refused
const outputOf = ( id : string ) : string | null => Object.entries( G().outputs ?? {} ).find( ([, v]) => ref( v )?.[0] == id )?.[0] ?? null;
const toggleOutput = ( id : string ) => {
    const name = outputOf( id );
    if (name == null) G().outputs = { ...G().outputs, [id] : solidRef( id ) };
    else if (Object.keys( G().outputs ).length > 1) delete G().outputs[name];
};
const view = () => { const g = G(); g.view = g.view ?? {}; g.view.nodes = g.view.nodes ?? {}; return g.view.nodes; };

// ---------------------------------------------------------------- undo: a snapshot of the document after each edit
// One user action can reach the document through several callbacks (deleting a node also deletes its wires), so the
// snapshot is taken once, after the current event, from everything recorded during it. A key names a stream of edits
// that merge into one step (one slider); edits with different keys in the same event do not merge.
const history = new History<GraphDocument>();
const history_ = window.history;
history.reset( DOC );
let recordQueued = false, recordKey : string | null = null, historyListener = () => {};
function record( key : string | null = null ) {
    recordKey = recordQueued && recordKey != key ? null : key;
    if (recordQueued) return;
    recordQueued = true;
    queueMicrotask( () => {
        recordQueued = false;
        if (history.commit( DOC, recordKey, performance.now() )) { historyListener(); autosave( DOC ); }
        recordKey = null;
    } );
}

// ---------------------------------------------------------------- evaluation: one job in flight, the latest edit wins
// A mesh as the worker sends it: positions, triangles, and per triangle the index of its face's persistent name.
// The analysis mesh comes first; the view mesh (from the exact shell, within 0.1 mm) replaces it when ready (refine).
interface Mesh { pos? : Float32Array; idx? : Uint32Array; face? : Uint32Array; names? : Array<string>; normal? : Float32Array; refine? : boolean; deviation? : number | null }
interface Result extends Mesh { seq : number; ok : boolean; ms : number; error? : string; volume? : number; faces? : number;
    verdict? : { kind : string, reasons : string[] }; nodes? : Record<string, string>; model? : unknown; shelf? : boolean; params? : Record<string, number>;
    off? : Array<string> }
// one output of a shelf evaluation, sent as soon as it is built, and again with its view mesh
interface Part extends Mesh { seq : number; part : string; pos : Float32Array; idx : Uint32Array; verdict : string }
const worker = new Worker( URL.createObjectURL( new Blob( [WORKER_SOURCE], { type : "text/javascript" } ) ) );
// the camera frames the solid of the first evaluation sent after a document is opened (fitAt), not a stale one
let fitWanted = true, fitAt = 0;
// SHELF: every output at once. A shelf request is sent at once, even while one is running: the worker drops a shelf
// as soon as a newer request arrives, and parts of an older one are ignored here
let SHELF = false;
let busy = false, pending = false, seq = 0, listener : ( r : Result ) => void = () => {}, partListener : ( p : Part ) => void = () => {},
    refineListener : ( m : Mesh ) => void = () => {};
// ---------------------------------------------------------------- parameters
// How a number node shows lives in view.params[id] (it never changes what is built). Its range is fixed for the session
// once seen (a range recomputed from the current value would move under the thumb), and soft: typing beyond is allowed.
const metaOf = ( id : string ) : ParamMeta => ((G().view as { params? : Record<string, ParamMeta> } | undefined)?.params ?? {})[id] ?? {};
const setMeta = ( id : string, m : ParamMeta ) => {
    G().view = G().view ?? {};
    const v = G().view as { params? : Record<string, ParamMeta> };
    v.params = { ...(v.params ?? {}), [id] : m };
};
const sessionRange = new Map<string, { min : number, max : number, step : number }>(), openValue = new Map<string, number>();
const forgetSession = () => { sessionRange.clear(); openValue.clear(); };
function rangeOf( key : string, value : number, given : { min? : number, max? : number, step? : number }, whole : boolean, tame : boolean ) {
    const k = `${key}|${given.min}|${given.max}|${given.step}`;
    if (!sessionRange.has( k )) sessionRange.set( k, resolveRange( isFinite( value ) ? value : 0, given, whole, tame ) );
    if (!openValue.has( key ) && isFinite( value )) openValue.set( key, value );
    return sessionRange.get( k )!;
}
// Live or on release: decided at the start of each gesture from the median of the last three rebuilds, with
// hysteresis (live below 120 ms, on release above 250 ms)
const times : Array<number> = [];
let liveMode = true;
function noteTime( ms : number ) {
    times.push( ms );
    if (times.length > 3) times.shift();
    const m = [...times].sort( (a, b) => a - b )[Math.floor( times.length / 2 )];
    if (liveMode && m > 250) liveMode = false; else if (!liveMode && m < 120) liveMode = true;
}
const typicalMs = () => times.length ? [...times].sort( (a, b) => a - b )[Math.floor( times.length / 2 )] : 0;
// what each evaluation was of, to offer the last buildable state back
const sent = new Map<number, string>();
let lastGood : string | null = null;

function evaluate() {
    if (busy && !SHELF) { pending = true; return; }
    busy = true;
    const shown = shownNode();
    worker.postMessage( { seq : ++seq, doc : evalDoc(), output : shown == "" ? undefined : solidRef( shown ), shelf : SHELF } );
    sent.set( seq, JSON.stringify( DOC ) );
    for (const k of sent.keys()) if (k < seq - 20) sent.delete( k );
    if (fitWanted) { fitWanted = false; fitAt = seq; }
}
worker.onmessage = ( e : MessageEvent<Result | Part | StlReply> ) => {
    if ("stl" in e.data) { stlReplies.get( e.data.stl )?.( e.data ); stlReplies.delete( e.data.stl ); return; }
    if (e.data.seq != seq && (SHELF || "part" in e.data)) return;
    if ("part" in e.data) { partListener( e.data ); return; }
    // a finer mesh of the solid on display: not a new evaluation
    if (e.data.refine) { if (e.data.seq == seq) refineListener( e.data ); return; }
    busy = false;
    listener( e.data );
    if (pending) { pending = false; evaluate(); }
};

// ---------------------------------------------------------------- print files
// The STL of an output (or of any solid node, "@id"), meshed by the worker from the exact faces within 0.02 mm.
interface StlReply { stl : string; ok : boolean; data? : ArrayBuffer; triangles? : number; deviation? : number | null; verdict? : string; error? : string }
const stlReplies = new Map<string, ( r : StlReply ) => void>();
let stlSeq = 0;
function requestStl( output : string, name : string ) : Promise<StlReply> {
    const key = `${name}#${++stlSeq}`;
    return new Promise( res => { stlReplies.set( key, res ); worker.postMessage( { stl : key, doc : evalDoc(), output } ); } );
}
const fileName = ( s : string ) => s.normalize( "NFD" ).replace( /[\u0300-\u036f]/g, "" ).replace( /[^A-Za-z0-9_-]+/g, "-" ).replace( /^-|-$/g, "" ) || "graph";

// ---------------------------------------------------------------- nodes
interface Edit {
    // a value while a gesture lasts (rebuilt live when rebuilds are quick), and the gesture's end (an undo step)
    preview( id : string, k : string, v : number ) : void;
    commit( id : string, k : string, v : number | string, key : string ) : void;
    holding( on : boolean ) : void;
    menu( id : string, at : { x : number, y : number } ) : void;
    locate( id : string ) : void;
    params : Record<string, number>;
}
interface ComponentActions { open( id : string ) : void; unpack( id : string ) : void }
const Ctx = createContext<{ status : Record<string, string>, shown : string, changed : ( key? : string ) => void, edit : Edit | null, comp : ComponentActions | null }>(
    { status : {}, shown : "", changed : () => {}, edit : null, comp : null } );
// how an instance's input shows: as the component shows that number node
const instanceMeta = ( id : string, k : string ) : ParamMeta | null => {
    const n = G().nodes[id];
    if (n?.type != "component" || !n.use?.startsWith( "#" )) return null;
    return ((LIB()[n.use.slice( 1 )]?.view as { params? : Record<string, ParamMeta> } | undefined)?.params ?? {})[k] ?? {};
};
// an instance input's default: the component's number node, as it is there (a number or an expression)
const instanceDefault = ( id : string, k : string ) : ModelValue | undefined => {
    const n = G().nodes[id];
    const v = n?.type == "component" && n.use?.startsWith( "#" ) ? LIB()[n.use.slice( 1 )]?.nodes[k]?.in?.value : undefined;
    return typeof v == "number" || typeof v == "string" ? v : undefined;
};

// A number input of a node, or a parameter of the panel: a number node shows as its kind (number, switch, choice);
// another node's number port as a compact number with a range tamed to its value
function ParamControl( { id, k, port, full } : { id : string, k : string, port : Extract<GraphPort, { kind : "number" }>, full? : boolean } ) {
    const { edit } = useContext( Ctx );
    if (edit == null) return null;
    const isParam = G().nodes[id].type == "number";
    const inst = instanceMeta( id, k );
    const meta = isParam ? metaOf( id ) : inst ?? {};
    const raw = G().nodes[id].in?.[k] ?? (inst != null ? instanceDefault( id, k ) : undefined);
    const value : number | string = typeof raw == "number" || typeof raw == "string" ? raw : port.value;
    // an expression's value now: a number node's own parameter, or an instance's (named under its id)
    const computed = typeof value == "string" ? edit.params[isParam ? id : `${id}__${k}`] ?? null : null;
    const label = full && isParam ? (G().nodes[id].label ?? id) : port.label;
    const fid = `p-${id}-${k}${full ? "-panel" : ""}`;
    if (meta.kind == "toggle" || (!isParam && inst == null && port.integer && port.min == 0 && port.max == 1)) return <ToggleField label={label} id={fid} value={Number( value ) || 0} onCommit={( v, key ) => edit.commit( id, k, v, key )} />;
    if (meta.kind == "choice" && meta.presets && meta.presets.length > 1)
        return <ChoiceField label={label} id={fid} value={Number( value )} options={meta.presets} segments={full ? 5 : 3} onCommit={( v, key ) => edit.commit( id, k, v, key )} />;
    const n = typeof value == "number" ? value : computed ?? port.value;
    const own = isParam || inst != null;
    const range = rangeOf( `${id}.${k}`, n, own ? { min : meta.min, max : meta.max, step : meta.step } : { min : port.min, max : port.max, step : port.step }, !!port.integer, !own );
    return <NumberField label={label} id={fid} value={value} computed={computed} range={range} compact={!full} unit={meta.unit ?? port.unit}
        hard={port.integer ? { integer : true } : undefined} defaultValue={meta.default ?? openValue.get( `${id}.${k}` )}
        presets={meta.kind == "choice" ? undefined : meta.presets} live={() => liveMode}
        onPreview={v => edit.preview( id, k, v )} onCommit={( v, key ) => edit.commit( id, k, v, key )} onHolding={edit.holding}
        onMenu={isParam ? at => edit.menu( id, at ) : undefined} onLocate={full ? () => edit.locate( id ) : undefined} />;
}

function NumberInput( { id, k, port } : { id : string, k : string, port : Extract<GraphPort, { kind : "number" }> } ) {
    const r = ref( G().nodes[id].in?.[k] );
    return <div className="row">
        <Handle type="target" position={Position.Left} id={k} className="h-number" />
        {r ? <><span className="lbl">{port.label}</span><span className="wired">← {G().nodes[r[0]]?.label ?? r[0]}</span></> : <ParamControl id={id} k={k} port={port} />}
    </div>;
}

function TextInput( { id, k, port } : { id : string, k : string, port : Extract<GraphPort, { kind : "text" | "choice" | "function" | "profile" | "points" }> } ) {
    const { changed } = useContext( Ctx );
    const v = String( G().nodes[id].in?.[k] ?? port.value );
    const [text, setText] = useState( v );
    useEffect( () => setText( v ), [v] );
    const set = ( x : string ) => { const n = G().nodes[id]; n.in = { ...n.in, [k] : x }; changed(); };
    return <div className="row">
        <span className="lbl">{port.label}</span>
        {port.kind == "function" && <span className="expr-tag" title={`An expression of ${port.variable}, from 0 to 1, and number nodes`}>ƒ({port.variable})</span>}
        {port.kind == "choice"
            ? <select className="nodrag" aria-label={port.label} value={v} onChange={e => set( e.target.value )}>
                {port.options.map( o => <option key={o}>{o}</option> )}</select>
            : <input className="nodrag val wide" aria-label={port.label} value={text} onChange={e => setText( e.target.value )}
                onBlur={() => set( text )} onKeyDown={e => { if (e.key == "Enter") (e.target as HTMLInputElement).blur(); }} />}
    </div>;
}

// a profile (JSON { outer, holes }), edited as JSON: kept as typed until it parses
function OutlineInput( { id, k, port } : { id : string, k : string, port : Extract<GraphPort, { kind : "outline" }> } ) {
    const { changed } = useContext( Ctx );
    const v = JSON.stringify( G().nodes[id].in?.[k] ?? port.value );
    const [text, setText] = useState( v );
    const [bad, setBad] = useState( false );
    useEffect( () => { setText( v ); setBad( false ); }, [v] );
    const set = ( x : string ) => {
        try { const n = G().nodes[id]; n.in = { ...n.in, [k] : JSON.parse( x ) }; setBad( false ); changed(); } catch { setBad( true ); }
    };
    return <div className="row">
        <span className="lbl">{port.label}</span>
        <input className={"nodrag val wide" + (bad ? " bad" : "")} aria-label={port.label} title="A profile as JSON: { outer, holes }" value={text}
            onChange={e => setText( e.target.value )} onBlur={() => set( text )} onKeyDown={e => { if (e.key == "Enter") (e.target as HTMLInputElement).blur(); }} />
    </div>;
}

function GraphNodeView( { id } : NodeProps ) {
    const nd = G().nodes[id], t = T( id );
    const { status, shown, changed, comp } = useContext( Ctx );
    if (nd == null) return null;
    if (t == null) return <div className="gn cat-component broken"><div className="gn-head"><span className="gn-title">{nd.label ?? id}</span></div>
        <p className="muted small">{nd.type == "component" ? `Uses "${nd.use ?? ""}", which this document's components do not have` : `Unknown node type "${nd.type}"`}</p></div>;
    const state = status[id] ?? "idle";
    const isSolid = Object.values( t.outputs ).includes( "solid" );
    return <div className={"gn" + (shown == id ? " shown" : "") + " cat-" + t.category} title={t.help}>
        <div className="gn-head">
            <span className="gn-title">{nd.label ?? t.title}</span>
            {state != "parameter" && <span className={"pill " + state}>{state}</span>}
        </div>
        <div className="gn-type">{nd.type == "component" ? "Component" : t.title} · <code>{id}</code></div>
        {nd.type == "component" && comp && <div className="row gn-comp">
            <button className="nodrag show" onClick={() => comp.open( id )} title="Open the component to edit it: every instance of it changes">Edit component</button>
            <button className="nodrag show" onClick={() => comp.unpack( id )} title="Put the component's nodes in place of this instance">Unpack</button></div>}
        {Object.entries( t.inputs ).map( ([k, p]) => p.kind == "number" ? <NumberInput key={k} id={id} k={k} port={p} />
            : p.kind == "solid" ? <div className="row" key={k}>
                <Handle type="target" position={Position.Left} id={k} className="h-solid" />
                <span className="lbl">{p.label}</span>
                <span className="wired">{ref( nd.in?.[k] ) ? "← " + (G().nodes[ref( nd.in?.[k] )![0]]?.label ?? ref( nd.in?.[k] )![0]) : p.optional ? "nothing" : "connect a solid"}</span></div>
            : p.kind == "outline" ? <OutlineInput key={k} id={id} k={k} port={p} />
            : <TextInput key={k} id={id} k={k} port={p} /> )}
        {Object.entries( t.outputs ).map( ([k, ty]) => <div className="row out" key={k}>
            {isSolid && <button className="nodrag show" aria-pressed={shown == id} onClick={() => { G().view = { ...G().view, show : id }; changed(); }}>
                {shown == id ? "Shown" : "Show"}</button>}
            {isSolid && <button className="nodrag show out-toggle" aria-pressed={outputOf( id ) != null} title="Export this solid as an output of the graph file"
                onClick={() => { toggleOutput( id ); changed(); }}>{outputOf( id ) != null ? "Output: " + outputOf( id ) : "Make output"}</button>}
            <span className="lbl">{k}</span>
            <Handle type="source" position={Position.Right} id={k} className={"h-" + ty} /></div> )}
    </div>;
}
const nodeTypes = { g : GraphNodeView };

// a node without a place on the canvas (a document written by hand or by a program) gets one: a column per step of
// the longest chain of wires leading to it, so wires run left to right
function placeUnplaced() {
    const v = view(), depth : Record<string, number> = {}, rows : Record<number, number> = {};
    const at = ( id : string, seen : Set<string> ) : number => {
        if (depth[id] != null) return depth[id];
        if (seen.has( id )) return 0;
        seen.add( id );
        let d = 0;
        for (const x of Object.values( G().nodes[id]?.in ?? {} )) { const r = ref( x ); if (r && G().nodes[r[0]] != null) d = Math.max( d, at( r[0], seen ) + 1 ); }
        return depth[id] = d;
    };
    for (const id of Object.keys( G().nodes )) {
        if (v[id] != null) continue;
        const c = at( id, new Set() ), r = rows[c] ?? 0;
        rows[c] = r + 1;
        v[id] = { x : c * 300, y : r * 230 };
    }
}
const toNodes = () : Node[] => (placeUnplaced(), Object.keys( G().nodes )).map( id => ({ id, type : "g", position : view()[id] ?? { x : 0, y : 0 }, data : {}, dragHandle : ".gn-head" }) );
const toEdges = () : Edge[] => Object.entries( G().nodes ).flatMap( ([id, nd]) => Object.entries( nd.in ?? {} ).flatMap( ([k, v]) => {
    const r = ref( v );
    const t = r ? T( r[0] ) : null;
    if (!r || t == null) return [];
    const outs = t.outputs, port = r[1] || Object.keys( outs )[0];
    if (outs[port] == null) return [];
    return [{ id : `${id}.${k}`, source : r[0], sourceHandle : port, target : id, targetHandle : k, className : "e-" + outs[port] }];
} ) );

// ---------------------------------------------------------------- 3D view
// One solid (the shown node), or the shelf: every output at once, laid out by editor/shelf.ts, with the row and
// column labels of the document's `view.shelf`, and a card for the piece under the pointer.
const shelfSpec = () : ShelfSpec | null => {
    const s = DOC.view?.shelf as ShelfSpec | undefined;
    return s != null && Array.isArray( s.rows ) && Array.isArray( s.columns ) && typeof s.place == "object" ? s : null;
};
// A mesh as a geometry shaded face by face: a vertex shared by two faces is split, so normals are smooth within each
// face (one exact surface) and sharp where faces meet. Keeps, per triangle, its face (userData.face, .names) and a
// colour per vertex, so a face can be lit up.
const BASE = new THREE.Color( 1, 1, 1 ), LIT = new THREE.Color( 1.25, 0.78, 0.45 );
const toGeometry = ( m : Mesh ) => {
    const pos = m.pos!, idx = m.idx!, face = m.face;
    if (face == null || face.length * 3 != idx.length) {
        const g = new THREE.BufferGeometry();
        g.setAttribute( "position", new THREE.BufferAttribute( pos, 3 ) );
        g.setIndex( new THREE.BufferAttribute( idx, 1 ) );
        const c = toCreasedNormals( g, Math.PI / 6 );
        g.dispose(); c.computeBoundingBox();
        c.setAttribute( "color", new THREE.Float32BufferAttribute( new Float32Array( c.getAttribute( "position" ).count * 3 ).fill( 1 ), 3 ) );
        return c;
    }
    const at = new Map<number, number>(), p : Array<number> = [], vface : Array<number> = [], vn : Array<number> = [];
    const given = m.normal != null && m.normal.length == idx.length * 3 ? m.normal : null;

    const out = new Uint32Array( idx.length );
    for (let t = 0; t < face.length; t++) for (let k = 0; k < 3; k++) {
        const v = idx[3 * t + k], key = face[t] * pos.length + v;
        let n = at.get( key );
        if (n == null) {
            n = vface.length; at.set( key, n ); p.push( pos[3 * v], pos[3 * v + 1], pos[3 * v + 2] ); vface.push( face[t] );
            const c = 9 * t + 3 * k;
            if (given) vn.push( given[c], given[c + 1], given[c + 2] ); else vn.push( 0, 0, 0 );
        }
        out[3 * t + k] = n;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute( "position", new THREE.Float32BufferAttribute( p, 3 ) );
    g.setAttribute( "color", new THREE.Float32BufferAttribute( new Float32Array( vface.length * 3 ).fill( 1 ), 3 ) );
    g.setIndex( new THREE.BufferAttribute( out, 1 ) );
    // the exact normals the worker gives, where it could; the triangles' average elsewhere
    g.computeVertexNormals();
    const nrm = g.getAttribute( "normal" ) as THREE.BufferAttribute;
    for (let i = 0; i < vface.length; i++) if (vn[3 * i] != 0 || vn[3 * i + 1] != 0 || vn[3 * i + 2] != 0) nrm.setXYZ( i, vn[3 * i], vn[3 * i + 1], vn[3 * i + 2] );
    g.computeBoundingBox();
    g.userData = { face, names : m.names ?? [], vface : Uint32Array.from( vface ), lit : -1 };
    return g;
};
// lights up one face of a geometry (or none: -1)
const light = ( g : THREE.BufferGeometry, f : number ) => {
    const u = g.userData as { vface? : Uint32Array, lit? : number };
    const col = g.getAttribute( "color" ) as THREE.BufferAttribute | undefined;
    if (u.vface == null || col == null || u.lit == f) return;
    for (let i = 0; i < u.vface.length; i++) {
        const c = u.vface[i] == f ? LIT : BASE;
        col.setXYZ( i, c.r, c.g, c.b );
    }
    col.needsUpdate = true;
    u.lit = f;
};

interface Three {
    mesh : THREE.Mesh, shelf : THREE.Group, labels : THREE.Group, render : () => void,
    fit : ( o : THREE.Object3D, front : boolean ) => void, material : THREE.Material, pick : ( x : number, y : number ) => string | null,
}
function Viewport( { result, parts, shelfMode, onHover } : { result : Result | null, parts : Map<string, Part>, shelfMode : boolean,
    onHover : ( name : string | null, x : number, y : number, kind : "piece" | "face" ) => void } ) {
    const host = useRef<HTMLDivElement>( null );
    const three = useRef<Three | null>( null );
    const hover = useRef( onHover );
    hover.current = onHover;
    useEffect( () => {
        const el = host.current!;
        const renderer = new THREE.WebGLRenderer( { antialias : true, alpha : true } );
        renderer.setPixelRatio( Math.min( devicePixelRatio, 2 ) );
        el.appendChild( renderer.domElement );
        const css = new CSS2DRenderer();
        css.domElement.className = "labels";
        el.appendChild( css.domElement );
        const scene = new THREE.Scene();
        scene.environment = new THREE.PMREMGenerator( renderer ).fromScene( new RoomEnvironment(), 0.04 ).texture;
        const camera = new THREE.PerspectiveCamera( 35, 1, 1, 5000 );
        camera.up.set( 0, 0, 1 ); camera.position.set( 110, -150, 110 );
        const controls = new OrbitControls( camera, renderer.domElement );
        const colour = getComputedStyle( document.documentElement ).getPropertyValue( "--solid" ).trim() || "#8fa7bf";
        const material = new THREE.MeshStandardMaterial( { color : colour, metalness : 0.15, roughness : 0.45, vertexColors : true } );
        const mesh = new THREE.Mesh( new THREE.BufferGeometry(), material );
        const shelf = new THREE.Group(), labels = new THREE.Group();
        scene.add( mesh, shelf, labels );
        const grid = new THREE.GridHelper( 200, 20, 0x888888, 0x888888 );
        grid.rotation.x = Math.PI / 2;
        const gm = grid.material as THREE.Material; gm.opacity = 0.18; gm.transparent = true;
        scene.add( grid );
        const render = () => {
            grid.visible = mesh.visible;
            renderer.render( scene, camera );
            css.render( scene, camera );
        };
        const resize = () => {
            const w = el.clientWidth, h = el.clientHeight;
            renderer.setSize( w, h ); css.setSize( w, h );
            camera.aspect = w / Math.max( h, 1 ); camera.updateProjectionMatrix(); render();
        };
        const ro = new ResizeObserver( resize ); ro.observe( el );
        controls.addEventListener( "change", render );
        // frame an object: from the front right and above for one solid, from the front for the shelf
        const fit = ( o : THREE.Object3D, front : boolean ) => {
            const s = new THREE.Box3().setFromObject( o ).getBoundingSphere( new THREE.Sphere() );
            if (!(s.radius > 0)) return;
            const half = THREE.MathUtils.degToRad( camera.fov / 2 );
            const d = s.radius / Math.sin( Math.min( half, Math.atan( Math.tan( half ) * camera.aspect ) ) ) * (front ? 0.95 : 1.08);
            controls.target.copy( s.center );
            const dir = front ? new THREE.Vector3( 0.1, -1, 0.7 ) : new THREE.Vector3( 0.55, -0.75, 0.42 );
            camera.position.copy( s.center ).addScaledVector( dir.normalize(), d );
            camera.near = Math.max( 0.1, d / 200 ); camera.far = d * 20; camera.updateProjectionMatrix();
            controls.update();
        };
        const ray = new THREE.Raycaster();
        // what is under the pointer: on the shelf, a piece (its output's name); otherwise a face of the solid, lit up
        // (its persistent name)
        const pick = ( x : number, y : number ) : string | null => {
            const r = renderer.domElement.getBoundingClientRect();
            ray.setFromCamera( new THREE.Vector2( (x - r.left) / r.width * 2 - 1, -(y - r.top) / r.height * 2 + 1 ), camera );
            if (shelf.visible) { const hit = ray.intersectObjects( shelf.children, false )[0]; return hit ? hit.object.name : null; }
            const hit = ray.intersectObject( mesh, false )[0], g = mesh.geometry, u = g.userData as { face? : Uint32Array, names? : Array<string> };
            const f = hit?.faceIndex != null && u.face != null ? u.face[hit.faceIndex] : -1;
            light( g, f );
            render();
            return f >= 0 ? u.names![f] : null;
        };
        const move = ( e : PointerEvent ) => { if (e.buttons == 0) hover.current( pick( e.clientX, e.clientY ), e.clientX, e.clientY, shelf.visible ? "piece" : "face" ); };
        const leave = () => { light( mesh.geometry, -1 ); render(); hover.current( null, 0, 0, "face" ); };
        renderer.domElement.addEventListener( "pointermove", move );
        renderer.domElement.addEventListener( "pointerleave", leave );
        three.current = { mesh, shelf, labels, render, fit, material, pick };
        resize();
        return () => { ro.disconnect(); renderer.dispose(); el.innerHTML = ""; };
    }, [] );
    // one solid
    useEffect( () => {
        const t = three.current;
        if (!t || shelfMode || !result?.ok || !result.pos) return;
        t.mesh.geometry.dispose(); t.mesh.geometry = toGeometry( result );
        if (fitAt > 0 && result.seq >= fitAt) { fitAt = 0; t.fit( t.mesh, false ); }
        t.render();
    }, [result, shelfMode] );
    // the shelf: one mesh per output, laid out again as pieces arrive
    useEffect( () => {
        const t = three.current;
        if (!t) return;
        t.mesh.visible = !shelfMode; t.shelf.visible = shelfMode; t.labels.visible = shelfMode;
        if (!shelfMode) { t.render(); return; }
        const have = new Map( t.shelf.children.map( c => [c.name, c as THREE.Mesh] ) );
        for (const [name, p] of parts) {
            const m = have.get( name );
            if (m != null && m.userData.part === p) continue;
            if (m != null) { m.geometry.dispose(); t.shelf.remove( m ); }
            const mesh = new THREE.Mesh( toGeometry( p ), t.material );
            mesh.name = name; mesh.userData.part = p;
            t.shelf.add( mesh );
        }
        for (const [name, m] of have) if (!parts.has( name )) { m.geometry.dispose(); t.shelf.remove( m ); }
        const boxes : { [name : string] : Box } = {};
        for (const c of t.shelf.children) {
            const b = (c as THREE.Mesh).geometry.boundingBox!;
            boxes[c.name] = { min : [b.min.x, b.min.y, b.min.z], max : [b.max.x, b.max.y, b.max.z] };
        }
        const L = layout( boxes, shelfSpec() );
        for (const c of t.shelf.children) c.position.set( ...L.move[c.name] );
        // labels: periods on the left of their rows, forms above their columns
        for (const c of [...t.labels.children]) { t.labels.remove( c ); (c as CSS2DObject).element.remove(); }
        const label = ( text : string, note : string | undefined, cls : string, x : number, z : number ) => {
            const div = document.createElement( "div" );
            div.className = "shelf-label " + cls;
            div.textContent = text;
            if (note) { const s = document.createElement( "small" ); s.textContent = note; div.appendChild( s ); }
            const o = new CSS2DObject( div );
            o.position.set( x, 0, z );
            t.labels.add( o );
        };
        const pad = Math.max( 10, 0.04 * L.size[0] );
        for (const r of L.rows) if (r.label) label( r.label, r.note, "row", -pad, r.z + r.height / 2 );
        for (const c of L.columns) if (c.label) label( c.label, undefined, "col", c.x + c.width / 2, pad * 0.6 );
        if (fitAt > 0 && (result?.seq ?? 0) >= fitAt && result?.shelf) { fitAt = 0; t.fit( t.shelf, true ); }
        else if (t.shelf.children.length == 1 && fitAt > 0) t.fit( t.shelf, true );
        t.render();
    }, [parts, shelfMode, result] );
    return <div className="viewport" ref={host} role="img" aria-label={shelfMode ? "3D view of every output, on a shelf" : "3D view of the shown solid"} />;
}

// ---------------------------------------------------------------- palette
const CATEGORIES : Array<[string, string]> = [["parameter", "Parameters"], ["math", "Math"], ["freeform", "Freeform"], ["primitive", "Primitives"], ["transform", "Transforms"],
    ["boolean", "Booleans"], ["logic", "Switches"], ["finish", "Finishing"]];

function Palette( { add, remove } : { add : ( type : string, use? : string ) => void, remove : ( name : string ) => void } ) {
    const [q, setQ] = useState( "" );
    const lib = Object.entries( LIB() ).filter( ([name, d]) => !SCOPES.includes( name ) &&
        (q == "" || (String( d.meta?.name ?? name ) + " " + name).toLowerCase().includes( q.toLowerCase() )) );
    const used = usage( DOC );
    const groups = useMemo( () => CATEGORIES.map( ([c, title]) => [title, Object.entries( REGISTRY ).filter( ([type, t]) => t.category == c &&
        (q == "" || (t.title + " " + type).toLowerCase().includes( q.toLowerCase() )) )] as const ).filter( g => g[1].length > 0 ), [q] );
    return <nav className="palette" aria-label="Add a node">
        <input id="palette-search" type="search" placeholder="Add a node…" aria-label="Search node types" value={q} onChange={e => setQ( e.target.value )} />
        <div className="palette-list">
            {lib.length > 0 && <section><h3>This document's components</h3>
                {lib.map( ([name, d]) => <div key={name} className="pal-comp">
                    <button title={String( d.meta?.description ?? `An instance of ${name}` )} onClick={() => add( "component", name )}>{String( d.meta?.name ?? name )}
                        <span className="pp-count"> {used[name] ?? 0}×</span></button>
                    {(used[name] ?? 0) == 0 && <button className="pal-del" aria-label={`Remove ${name} from the document's components`} title="Remove it: nothing uses it"
                        onClick={() => remove( name )}>×</button>}</div> )}</section>}
            {groups.map( ([title, items]) => <section key={title}><h3>{title}</h3>
                {items.map( ([type, t]) => <button key={type} title={t.help} onClick={() => add( type )}>{t.title}</button> )}</section> )}
        </div>
    </nav>;
}

// ---------------------------------------------------------------- the card of a piece on the shelf
// What the document says about an output (`meta.items[name]`): any fields, the known ones first and named
interface Item { [key : string] : unknown }
const FIELDS : Array<[string, string]> = [["form", "Form"], ["period", "Period"], ["subperiod", "Sub-period"], ["site", "Site"], ["region", "Region"],
    ["context_type", "Context"], ["funerary_function", "Use in the grave"], ["grave", "Grave"], ["ware", "Ware"], ["technique", "Made"],
    ["height_cm", "Height (cm)"], ["max_width_cm", "Width (cm)"], ["rim_diameter_cm", "Rim (cm)"], ["capacity_l", "Capacity (l)"], ["source", "Source"],
    ["aippd_id", "AIPPD record"]];
function PieceCard( { name, x, y } : { name : string, x : number, y : number } ) {
    const items = (DOC.meta as { items? : Record<string, Item> } | undefined)?.items;
    const it = items?.[name];
    return <div className="piece-card" style={{ left : x + 14, top : y + 14 }} role="tooltip">
        <b>{name}</b>
        {it != null && <dl>{FIELDS.filter( ([k]) => it[k] != null && it[k] !== "" ).map( ([k, label]) => <div key={k}><dt>{label}</dt><dd>{String( it[k] )}</dd></div> )}</dl>}
    </div>;
}

// ---------------------------------------------------------------- the parameters panel
// Every number node, grouped (view.params[id].group, else "Parameters"), with full controls. Hovering a row lights its
// node on the canvas; a click on the label shows it.
function ParamPanel() {
    const [closed, setClosed] = useState<Record<string, boolean>>( {} );
    const ids = Object.keys( G().nodes ).filter( id => G().nodes[id].type == "number" );
    const instances = Object.keys( G().nodes ).filter( id => G().nodes[id].type == "component" && T( id ) != null &&
        Object.keys( T( id )!.inputs ).some( k => !ref( G().nodes[id].in?.[k] ) ) );
    if (ids.length == 0 && instances.length == 0) return <p className="muted small pp-empty">This graph has no number nodes. Add one from the palette (Parameters) and wire it or name it in expressions.</p>;
    const order = ((G().view as { groups? : Array<string> } | undefined)?.groups) ?? [];
    const groups = new Map<string, Array<string>>();
    for (const g of order) groups.set( g, [] );
    for (const id of ids) { const g = metaOf( id ).group ?? "Parameters"; if (!groups.has( g )) groups.set( g, [] ); groups.get( g )!.push( id ); }
    const light = ( id : string, on : boolean ) => document.querySelector( `.react-flow__node[data-id="${CSS.escape( id )}"]` )?.classList.toggle( "lit", on );
    const port = REGISTRY["number"].inputs.value as Extract<GraphPort, { kind : "number" }>;
    return <div className="param-panel">
        {[...groups].filter( ([, list]) => list.length > 0 ).map( ([g, list]) => <section key={g}>
            <h3><button type="button" aria-expanded={!closed[g]} onClick={() => setClosed( c => ({ ...c, [g] : !c[g] }) )}>{g}<span className="pp-count">{list.length}</span></button></h3>
            {!closed[g] && list.map( id => <div key={id} className="pp-row" onMouseEnter={() => light( id, true )} onMouseLeave={() => light( id, false )}>
                {ref( G().nodes[id].in?.value ) ? <span className="muted small">{G().nodes[id].label ?? id}: wired</span> : <ParamControl id={id} k="value" port={port} full />}
            </div> )}
        </section> )}
        {instances.map( id => { const g = `${G().nodes[id].label ?? id} (component)`; const t = T( id )!; return <section key={"i-" + id}>
            <h3><button type="button" aria-expanded={!closed[g]} onClick={() => setClosed( c => ({ ...c, [g] : !c[g] }) )}>{g}
                <span className="pp-count">{Object.keys( t.inputs ).length}</span></button></h3>
            {!closed[g] && Object.entries( t.inputs ).filter( ([k]) => !ref( G().nodes[id].in?.[k] ) ).map( ([k, p]) =>
                <div key={k} className="pp-row" onMouseEnter={() => light( id, true )} onMouseLeave={() => light( id, false )}>
                    <ParamControl id={id} k={k} port={p as Extract<GraphPort, { kind : "number" }>} full /></div> )}
        </section>; } )}
    </div>;
}

// ---------------------------------------------------------------- app
function App() {
    const [nodes, setNodes, onNodesChange] = useNodesState( toNodes() );
    const [edges, setEdges, onEdgesChange] = useEdgesState( toEdges() );
    const [, setTick] = useState( 0 );
    const [result, setResult] = useState<Result | null>( null );
    const [tab, setTab] = useState<"params" | "graph" | "model">( Object.values( G().nodes ).some( n => n.type == "number" ) ? "params" : "graph" );
    const [holding, setHolding] = useState( false );
    const [menuAt, setMenuAt] = useState<{ id : string, x : number, y : number } | null>( null );
    const [parts, setParts] = useState<Map<string, Part>>( new Map() );
    const [shelfMode, setShelfMode] = useState( false );
    const [big, setBig] = useState( false );
    const [hovered, setHovered] = useState<{ name : string, x : number, y : number, kind : "piece" | "face" } | null>( null );
    // the shelf is on for a document that lays one out, and can be turned on for any document with outputs
    const setShelf = ( on : boolean ) => { SHELF = on; busy = false; setShelfMode( on ); if (!on) setHovered( null ); };
    const flow = useReactFlow();
    const file = useRef<HTMLInputElement>( null );
    // every edit of the document goes through changed (or reload, for a whole new document), which records an undo step
    const changed = ( key? : string ) => { setTick( x => x + 1 ); setEdges( toEdges() ); setNodes( ns => ns.map( n => ({ ...n, data : {} }) ) ); record( key ?? null ); evaluate(); };
    const reload = ( fit = true ) => {
        if (fit) forgetSession();
        if (fit) { fitWanted = true; setParts( new Map() ); setShelf( DOC.view?.shelf != null ); setBig( DOC.view?.shelf != null ); }
        setNodes( toNodes() ); setEdges( toEdges() ); setTick( x => x + 1 ); evaluate();
        if (fit) setTimeout( () => flow.fitView( { padding : 0.08 } ), 50 );
    };
    const restore = ( d : GraphDocument | null ) => { if (d != null) { DOC = d; while (SCOPES.length && DOC.components?.[SCOPES[SCOPES.length - 1]] == null) SCOPES.pop(); reload( false ); } };
    const undo = () => restore( history.undo() ), redo = () => restore( history.redo() );
    useEffect( () => {
        listener = r => {
            setResult( r );
            if (r.ok) noteTime( r.ms );
            if (r.ok && r.verdict?.kind == "buildable" && sent.has( r.seq )) lastGood = sent.get( r.seq )!;
            // a finished shelf: drop pieces of outputs that are gone
            if (r.shelf) setParts( m => new Map( [...m].filter( ([k]) => G().outputs?.[k] != null && !(r.off ?? []).includes( k ) ) ) );
        };
        partListener = p => setParts( m => new Map( m ).set( p.part, p ) );
        refineListener = m => setResult( r => r == null ? r : { ...r, ...m } );
        setShelf( DOC.view?.shelf != null ); setBig( DOC.view?.shelf != null );
        evaluate();
        historyListener = () => setTick( x => x + 1 );
        // Ctrl+Z / Cmd+Z, and Shift+Ctrl+Z, Cmd+Shift+Z or Ctrl+Y to redo; a text field keeps its own undo while typing
        const keys = ( e : KeyboardEvent ) => {
            if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
            const k = e.key.toLowerCase();
            if (k != "z" && k != "y") return;
            const t = e.target as HTMLElement;
            if (t.isContentEditable || t instanceof HTMLTextAreaElement || (t instanceof HTMLInputElement && t.type != "range")) return;
            e.preventDefault();
            if (k == "y" || e.shiftKey) redo(); else undo();
        };
        window.addEventListener( "keydown", keys );
        return () => window.removeEventListener( "keydown", keys );
    }, [] );

    const add = ( type : string, use? : string ) => {
        const base = (use ?? type.split( "/" ).pop()!).toLowerCase().replace( /[^a-z0-9]+/g, "_" ).replace( /^_+|_+$/g, "" ).replace( /^(\d)|^$/, "n$1" );
        let k = 1, id = base;
        while (G().nodes[id] != null || Expr.reserved( id )) id = base + ++k;
        G().nodes[id] = use != null ? { type : "component", use : "#" + use, label : String( LIB()[use]?.meta?.name ?? use ) } : { type };
        const r = document.querySelector( ".canvas" )!.getBoundingClientRect();
        const p = flow.screenToFlowPosition( { x : r.left + r.width / 2 - 110, y : r.top + r.height / 3 } );
        view()[id] = { x : Math.round( p.x ), y : Math.round( p.y ) };
        setNodes( toNodes() );
        changed();
    };
    const onConnect = ( c : Connection ) => { const n = G().nodes[c.target]; n.in = { ...n.in, [c.targetHandle!] : "@" + c.source }; changed(); };
    const onEdgesDelete = ( es : Edge[] ) => {
        for (const e of es) { const n = G().nodes[e.target]; if (n?.in) delete n.in[e.targetHandle!]; }
        changed();
    };
    const onNodesDelete = ( ns : Node[] ) => {
        for (const x of ns) { delete G().nodes[x.id]; delete view()[x.id]; }
        for (const [name, v] of Object.entries( G().outputs ?? {} )) if (G().nodes[ref( v )?.[0] ?? ""] == null) delete G().outputs[name];
        for (const n of Object.values( G().nodes )) for (const [k, v] of Object.entries( n.in ?? {} )) { const r = ref( v ); if (r && G().nodes[r[0]] == null) delete n.in![k]; }
        changed();
    };
    const isValidConnection = ( c : Edge | Connection ) => {
        if (c.source == c.target) return false;
        const out = T( c.source )?.outputs[c.sourceHandle ?? ""], inp = T( c.target )?.inputs[c.targetHandle ?? ""];
        return inp != null && out != null && inp.kind == out;
    };
    const onNodeDragStop = ( _e : unknown, _n : Node, moved : Node[] ) => {
        for (const n of moved) view()[n.id] = { x : Math.round( n.position.x ), y : Math.round( n.position.y ) };
        setTick( x => x + 1 ); record();
    };
    const [note, setNote] = useState( "" );
    const tell = ( text : string ) => { setNote( text ); setTimeout( () => setNote( n => n == text ? "" : n ), 4000 ); };
    const docName = () => fileName( String( DOC.meta?.name ?? "graph" ) );
    // Save: to the file the document came from or was last saved to, where the browser can write files back
    const save = async () => {
        const name = await saveFile( JSON.stringify( DOC, null, 1 ) + "\n", docName() + ".graph.json" );
        if (name) tell( `Saved ${name}` );
    };
    const openText = ( name : string, text : string ) => {
        try {
            const d = JSON.parse( text ) as unknown;
            if (!isGraph( d )) throw new Error( "not a version 2 graph document" );
            DOC = d; SCOPES.length = 0; reload(); record();
            tell( `Opened ${name}` );
        } catch (e) { setResult( { seq : 0, ok : false, ms : 0, error : `Could not open ${name}: ${(e as Error).message}` } ); }
    };
    const open = async ( f : File ) => { forgetFile(); openText( f.name, await f.text() ); };
    const openDialog = async () => { const f = await openFile( () => file.current?.click() ); if (f) openText( f.name, f.text ); };
    // Share: the document in the link itself, so a colleague opens this exact graph with its parameters
    const share = async () => {
        const url = location.href.split( "#" )[0] + "#" + LINK_KEY + "=" + await encode( DOC );
        history_.replaceState( null, "", url );
        try { await navigator.clipboard.writeText( url ); tell( `Link copied (${(url.length / 1024).toFixed( 1 )} kB): it holds the whole graph` ); }
        catch { tell( "The link is in the address bar: copy it from there" ); }
    };
    // STL: the shown part, or on the shelf every output, each its own file
    const downloadStl = async () => {
        const outs = shelfMode ? Object.keys( G().outputs ) : [shownNode() == "" ? Object.keys( G().outputs )[0] : "@" + shownNode()];
        if (inViewer()) {
            // the viewer saves no .stl: every part's STL in one zip
            const files : Array<{ name : string, data : Uint8Array }> = [];
            for (const o of outs) {
                const label = o.startsWith( "@" ) ? o.slice( 1 ) : o;
                tell( `Meshing ${label} for printing…` );
                const r = await requestStl( o, label );
                if (r.ok && r.data != null) files.push( { name : `${docName()}-${fileName( label )}.stl`, data : new Uint8Array( r.data ) } );
                else tell( `Could not mesh ${label}: ${r.error}` );
            }
            if (files.length == 0) return;
            try {
                const name = await saveBinary( zip( files ), `${docName()}-stl.zip`, "application/zip" );
                if (name) tell( `${name}: ${files.length} STL file${files.length > 1 ? "s" : ""}, within 0.02 mm` );
            } catch (e) { tell( `Could not save: ${(e as Error).message}` ); }
            return;
        }
        for (const o of outs) {
            const label = o.startsWith( "@" ) ? o.slice( 1 ) : o;
            tell( `Meshing ${label} for printing…` );
            const r = await requestStl( o, label );
            if (!r.ok || r.data == null) { tell( `Could not mesh ${label}: ${r.error}` ); continue; }
            const name = await saveBinary( r.data, `${docName()}-${fileName( label )}.stl`, "model/stl" );
            if (name) tell( `${name}: ${r.triangles!.toLocaleString()} triangles, within ${r.deviation != null ? r.deviation.toFixed( 3 ) : "0.02"} mm${r.verdict == "buildable" ? "" : " (verdict: " + r.verdict + ")"}` );
        }
    };
    // a document in the link (#g=...): opened once decoded
    useEffect( () => {
        void fromLink( location.hash ).then( d => { if (isGraph( d )) { DOC = d; SCOPES.length = 0; reload(); record(); tell( "Opened the graph in the link" ); } } )
            .catch( () => tell( "The link's graph could not be read" ) );
    }, [] );

    // parameter edits: previews move the value (and rebuild live when rebuilds are quick); a commit is an undo step
    const setValue = ( id : string, k : string, v : ModelValue ) => { const n = G().nodes[id]; n.in = { ...n.in, [k] : v }; };
    const edit : Edit = {
        preview : ( id, k, v ) => { setValue( id, k, v ); if (liveMode) evaluate(); },
        commit : ( id, k, v, key ) => { setValue( id, k, v ); changed( key ); },
        holding : on => setHolding( on ),
        menu : ( id, at ) => setMenuAt( { id, ...at } ),
        locate : id => { void flow.fitView( { nodes : [{ id }], duration : 300, maxZoom : 1.2 } ); },
        params : result?.params ?? {},
    };
    // components: one undo step each (opening one is not an edit)
    const structural = () => { reload( false ); record(); };
    const makeComp = () => {
        const sel = nodes.filter( n => n.selected ).map( n => n.id );
        if (sel.length == 0) { tell( "Select the nodes first: Shift-drag a box round them, or Ctrl-click (⌘-click) each" ); return; }
        const title = window.prompt( "Name of the new component", "Part" );
        if (title == null || title.trim() == "") return;
        try {
            const m = makeComponent( G(), sel, title.trim(), LIB(), result?.params ?? {} );
            const lib = { ...LIB(), [m.name] : m.component };
            setG( m.graph );
            DOC.components = lib;
            structural();
            const k = Object.values( m.component.nodes ).filter( n => n.type == "number" ).length;
            tell( `Made the component ${title.trim()}: ${Object.keys( m.component.nodes ).length} nodes, ${k} number input${k == 1 ? "" : "s"}` );
        } catch (e) { tell( (e as Error).message ); }
    };
    const comp : ComponentActions = {
        open : id => { const n = G().nodes[id]; if (n?.use?.startsWith( "#" ) && LIB()[n.use.slice( 1 )] != null) { SCOPES.push( n.use.slice( 1 ) ); reload(); } },
        unpack : id => { try { setG( unpack( G(), id, LIB() ) ); structural(); } catch (e) { tell( (e as Error).message ); } },
    };
    const removeComp = ( name : string ) => { if (DOC.components == null) return; delete DOC.components[name]; if (Object.keys( DOC.components ).length == 0) delete DOC.components; structural(); };
    const leave = ( depth : number ) => { SCOPES.length = depth; reload(); };
    const backToGood = () => { if (lastGood == null) return; DOC = JSON.parse( lastGood ) as GraphDocument; while (SCOPES.length && DOC.components?.[SCOPES[SCOPES.length - 1]] == null) SCOPES.pop(); forgetSession(); reload( false ); record(); tell( "Back to the last buildable values" ); };
    const unbuildable = result != null && (!result.ok || (result.verdict != null && result.verdict.kind != "buildable"));

    const shown = shownNode();
    const status = result?.nodes ?? {};
    const rebuilt = Object.keys( status ).filter( k => status[k] == "built" ), reused = Object.keys( status ).filter( k => status[k] == "cached" );
    return <Ctx.Provider value={{ status, shown, changed, edit, comp }}>
        <main className={"layout" + (big ? " big" : "")}>
            <Palette add={add} remove={removeComp} />
            <section className={"canvas" + (SCOPES.length ? " scoped" : "")} aria-label="Node graph">
                {SCOPES.length > 0 && <nav className="crumbs" aria-label="Where you are">
                    <button onClick={() => leave( 0 )}>{String( DOC.meta?.name ?? "Main graph" )}</button>
                    {SCOPES.map( ( s, i ) => <span key={i}> › {i < SCOPES.length - 1
                        ? <button onClick={() => leave( i + 1 )}>{String( LIB()[s]?.meta?.name ?? s )}</button>
                        : <b>{String( LIB()[s]?.meta?.name ?? s )}</b>}</span> )}
                    <span className="muted small"> · component, used {usage( DOC )[SCOPES[SCOPES.length - 1]] ?? 0}×: every instance changes with it</span>
                </nav>}
                <div className="toolbar">
                    <button onClick={undo} disabled={!history.canUndo} title="Undo (Ctrl+Z or ⌘Z)">Undo</button>
                    <button onClick={redo} disabled={!history.canRedo} title="Redo (Shift+Ctrl+Z, ⌘⇧Z or Ctrl+Y)">Redo</button>
                    <select aria-label="Open a sample" value="" onChange={e => { const s = e.target.value == "start" ? { doc : START! } : SAMPLES[+e.target.value]; if (s) { DOC = clone( s.doc ); SCOPES.length = 0; reload(); record(); } }}>
                        <option value="" disabled>Open a sample…</option>
                        {START != null && <option value="start">{String( START.meta?.name ?? "This project" )} (as built)</option>}
                        {[...new Set( SAMPLES.map( s => s.group ) )].map( grp => <optgroup key={grp} label={grp}>
                            {SAMPLES.map( ( s, i ) => s.group == grp && <option key={i} value={i}>{s.title}</option> )}</optgroup> )}
                    </select>
                    <button onClick={() => void openDialog()}>Open…</button>
                    <button onClick={() => void save()} title="Save the graph file (it is also kept in this browser as you work)">Save</button>
                    {!inViewer() && <button onClick={() => void share()} title="Copy a link that holds the whole graph: whoever opens it gets this graph and its parameters">Share link</button>}
                    <button onClick={() => void downloadStl()} title="Download the shown part as STL for printing (on the shelf: every part), meshed within 0.02 mm of its exact faces">STL</button>
                    <button aria-pressed={shelfMode} onClick={() => { setShelf( !shelfMode ); fitWanted = true; evaluate(); }}
                        title="Show every output of the graph at once, side by side">Shelf</button>
                    <button aria-pressed={big} onClick={() => setBig( !big )} title="A larger 3D view">Large view</button>
                    <button onClick={makeComp} title="Make a component of the selected nodes (Shift-drag to select): one node, its numbers as inputs, reusable from the palette">Make component</button>
                    {note && <span className="note" role="status">{note}</span>}
                    <input ref={file} type="file" accept=".json,application/json" hidden onChange={e => { const f = e.target.files?.[0]; if (f) void open( f ); e.target.value = ""; }} />
                </div>
                <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
                    onConnect={onConnect} onEdgesDelete={onEdgesDelete} onNodesDelete={onNodesDelete} isValidConnection={isValidConnection}
                    onNodeDragStop={onNodeDragStop} fitView fitViewOptions={{ padding : 0.08 }} minZoom={0.2} deleteKeyCode={["Backspace", "Delete"]}>
                    <Background gap={24} size={1} /><Controls showInteractive={false} /><MiniMap pannable zoomable />
                </ReactFlow>
            </section>
            <aside className={"side" + (tab == "params" ? " customizing" : "")}>
                <div className="view3d">
                    <Viewport result={result} parts={parts} shelfMode={shelfMode} onHover={( name, x, y, kind ) => setHovered( name == null ? null : { name, x, y, kind } )} />
                    {hovered && (hovered.kind == "piece" ? <PieceCard name={hovered.name} x={hovered.x} y={hovered.y} />
                        : <div className="piece-card face" style={{ left : hovered.x + 14, top : hovered.y + 14 }} role="tooltip">face <b>{hovered.name}</b></div>)}
                </div>
                <div className="readout" aria-live="polite">
                    {holding && <p className="hold-hint">Release to rebuild{typicalMs() > 0 ? ` (about ${typicalMs() < 1000 ? Math.round( typicalMs() / 100 ) / 10 : Math.round( typicalMs() / 1000 )} s)` : ""}</p>}
                    {unbuildable && lastGood != null && lastGood != JSON.stringify( DOC ) &&
                        <p className="back-good"><button type="button" onClick={backToGood}>Back to the last buildable values</button></p>}
                    {result == null ? <p className="muted">Building…</p> : result.ok ? <>
                        <div className="verdict-line">
                            <span className={"pill big " + (result.verdict!.kind == "buildable" ? "ok" : "warn")}>{result.verdict!.kind}</span>
                            <span className="num">{result.ms.toFixed( 0 )} ms</span>
                            <span className="num">{(result.volume! / 1000).toFixed( 2 )} cm³</span>
                            {result.shelf ? <span className="num">{parts.size} pieces</span> : <span className="num">{result.faces} faces</span>}
                        </div>
                        <p className="muted small">{result.verdict!.reasons.join( "; " )}</p>
                        {!result.shelf && result.idx && <p className="muted small">{result.refine
                            ? `View mesh: ${(result.idx.length / 3).toLocaleString()} triangles from the exact faces, within ${result.deviation != null ? result.deviation.toFixed( 2 ) : "0.1"} mm`
                            : `Analysis mesh: ${(result.idx.length / 3).toLocaleString()} triangles; meshing the exact faces…`}</p>}
                        <p className="small" title={(rebuilt.length ? "Rebuilt: " + rebuilt.join( ", " ) : "") + (reused.length ? "\nFrom cache: " + reused.join( ", " ) : "")}>
                            <b>Rebuilt</b> {rebuilt.length <= 6 ? rebuilt.join( ", " ) || "nothing" : `${rebuilt.length} nodes`}
                            {reused.length > 0 && <> · <b>from cache</b> {reused.length <= 6 ? reused.join( ", " ) : `${reused.length} nodes`}</>}</p>
                    </> : <p className="err" role="alert">{result.error}</p>}
                </div>
                <div className="json">
                    <div className="tabs" role="tablist">
                        <button role="tab" aria-selected={tab == "params"} onClick={() => setTab( "params" )}>Customize</button>
                        <button role="tab" aria-selected={tab == "graph"} onClick={() => setTab( "graph" )}>Graph file</button>
                        <button role="tab" aria-selected={tab == "model"} onClick={() => setTab( "model" )}>Model document</button>
                    </div>
                    {tab == "params" ? <ParamPanel /> : <pre>{JSON.stringify( tab == "graph" ? DOC : result?.model ?? null, null, 2 )}</pre>}
                </div>
            </aside>
            {menuAt && G().nodes[menuAt.id] && (() => {
                const v = G().nodes[menuAt.id].in?.value, n = typeof v == "number" ? v : (result?.params?.[menuAt.id] ?? 0);
                const r = rangeOf( `${menuAt.id}.value`, n, metaOf( menuAt.id ), false, false );
                return <ParamMenu label={G().nodes[menuAt.id].label ?? menuAt.id} at={menuAt} meta={metaOf( menuAt.id )} effective={r} current={n}
                    onClose={() => setMenuAt( null )} onSave={m => { setMeta( menuAt.id, m ); setMenuAt( null ); changed(); }} />;
            })()}
        </main>
    </Ctx.Provider>;
}

document.head.appendChild( Object.assign( document.createElement( "style" ), { textContent : flowCss } ) );
createRoot( document.getElementById( "app" )! ).render( <ReactFlowProvider><App /></ReactFlowProvider> );
