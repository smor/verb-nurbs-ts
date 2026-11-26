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
import { Graph, Expr } from "../src/index.js";
import type { GraphDocument, GraphPort, ModelValue } from "../src/index.js";
import { SAMPLE } from "./sample.js";
import { History } from "./history.js";

declare const WORKER_SOURCE : string;

const REGISTRY = Graph.REGISTRY;
const REF = /^@([A-Za-z_][A-Za-z0-9_]*)(?:\.([A-Za-z_][A-Za-z0-9_ ]*))?$/;
const ref = ( v : ModelValue | undefined ) : [string, string] | null => {
    if (typeof v != "string") return null;
    const m = REF.exec( v.trim() );
    return m ? [m[1], m[2] ?? ""] : null;
};
const clone = <T,>( x : T ) : T => JSON.parse( JSON.stringify( x ) ) as T;

let DOC : GraphDocument = clone( SAMPLE );
// the solid node the 3D view shows: the one asked for with Show, else the document's first output
const shownNode = () : string => {
    const s = DOC.view?.show;
    if (typeof s == "string" && DOC.nodes[s] != null) return s;
    return ref( Object.values( DOC.outputs ?? {} )[0] )?.[0] ?? "";
};
// the name of the output that exports a node, if any; adding one names it after the node, removing the last is refused
const outputOf = ( id : string ) : string | null => Object.entries( DOC.outputs ?? {} ).find( ([, v]) => ref( v )?.[0] == id )?.[0] ?? null;
const toggleOutput = ( id : string ) => {
    const name = outputOf( id );
    if (name == null) DOC.outputs = { ...DOC.outputs, [id] : "@" + id };
    else if (Object.keys( DOC.outputs ).length > 1) delete DOC.outputs[name];
};
const view = () => { DOC.view = DOC.view ?? {}; DOC.view.nodes = DOC.view.nodes ?? {}; return DOC.view.nodes; };

// ---------------------------------------------------------------- undo: a snapshot of the document after each edit
// One user action can reach the document through several callbacks (deleting a node also deletes its wires), so the
// snapshot is taken once, after the current event, from everything recorded during it. A key names a stream of edits
// that merge into one step (one slider); edits with different keys in the same event do not merge.
const history = new History<GraphDocument>();
history.reset( DOC );
let recordQueued = false, recordKey : string | null = null, historyListener = () => {};
function record( key : string | null = null ) {
    recordKey = recordQueued && recordKey != key ? null : key;
    if (recordQueued) return;
    recordQueued = true;
    queueMicrotask( () => {
        recordQueued = false;
        if (history.commit( DOC, recordKey, performance.now() )) historyListener();
        recordKey = null;
    } );
}

// ---------------------------------------------------------------- evaluation: one job in flight, the latest edit wins
interface Result { ok : boolean; pos? : Float32Array; idx? : Uint32Array; ms : number; error? : string; volume? : number; faces? : number;
    verdict? : { kind : string, reasons : string[] }; nodes? : Record<string, string>; model? : unknown }
const worker = new Worker( URL.createObjectURL( new Blob( [WORKER_SOURCE], { type : "text/javascript" } ) ) );
let busy = false, pending = false, seq = 0, listener : ( r : Result ) => void = () => {};
function evaluate() {
    if (busy) { pending = true; return; }
    busy = true;
    const shown = shownNode();
    worker.postMessage( { seq : ++seq, doc : DOC, output : shown == "" ? undefined : "@" + shown } );
}
worker.onmessage = ( e : MessageEvent<Result> ) => {
    busy = false;
    listener( e.data );
    if (pending) { pending = false; evaluate(); }
};

// ---------------------------------------------------------------- nodes
const Ctx = createContext<{ status : Record<string, string>, shown : string, changed : ( key? : string ) => void }>( { status : {}, shown : "", changed : () => {} } );

function NumberInput( { id, k, port } : { id : string, k : string, port : Extract<GraphPort, { kind : "number" }> } ) {
    const { changed } = useContext( Ctx );
    const v = DOC.nodes[id].in?.[k];
    const shown = String( v ?? port.value );
    const [text, setText] = useState( shown );
    useEffect( () => setText( shown ), [shown] );
    const set = ( x : ModelValue, key? : string ) => { const n = DOC.nodes[id]; n.in = { ...n.in, [k] : x }; changed( key ); };
    const commit = () => set( text.trim() != "" && !isNaN( +text ) ? +text : text.trim() );
    const r = ref( v );
    return <div className="row">
        <Handle type="target" position={Position.Left} id={k} className="h-number" />
        <span className="lbl">{port.label}</span>
        {r ? <span className="wired">← {DOC.nodes[r[0]]?.label ?? r[0]}</span> : <>
            {typeof v == "string"
                ? <span className="expr-tag" title="An expression over number nodes">ƒ</span>
                : <input className="nodrag" type="range" aria-label={port.label} min={port.min} max={port.max} step={port.step} value={Number( v ?? port.value )}
                    onChange={e => { setText( e.target.value ); set( +e.target.value, id + "." + k ); }} />}
            <input className="nodrag val" aria-label={port.label + " value or expression"} value={text} onChange={e => setText( e.target.value )}
                onBlur={commit} onKeyDown={e => { if (e.key == "Enter") (e.target as HTMLInputElement).blur(); }} />
            {port.unit && <span className="unit">{port.unit}</span>}
        </>}
    </div>;
}

function TextInput( { id, k, port } : { id : string, k : string, port : Extract<GraphPort, { kind : "text" | "choice" }> } ) {
    const { changed } = useContext( Ctx );
    const v = String( DOC.nodes[id].in?.[k] ?? port.value );
    const [text, setText] = useState( v );
    useEffect( () => setText( v ), [v] );
    const set = ( x : string ) => { const n = DOC.nodes[id]; n.in = { ...n.in, [k] : x }; changed(); };
    return <div className="row">
        <span className="lbl">{port.label}</span>
        {port.kind == "choice"
            ? <select className="nodrag" aria-label={port.label} value={v} onChange={e => set( e.target.value )}>
                {port.options.map( o => <option key={o}>{o}</option> )}</select>
            : <input className="nodrag val wide" aria-label={port.label} value={text} onChange={e => setText( e.target.value )}
                onBlur={() => set( text )} onKeyDown={e => { if (e.key == "Enter") (e.target as HTMLInputElement).blur(); }} />}
    </div>;
}

function GraphNodeView( { id } : NodeProps ) {
    const nd = DOC.nodes[id], t = REGISTRY[nd?.type];
    const { status, shown, changed } = useContext( Ctx );
    if (nd == null || t == null) return null;
    const state = status[id] ?? "idle";
    const isSolid = Object.values( t.outputs ).includes( "solid" );
    return <div className={"gn" + (shown == id ? " shown" : "") + " cat-" + t.category} title={t.help}>
        <div className="gn-head">
            <span className="gn-title">{nd.label ?? t.title}</span>
            {state != "parameter" && <span className={"pill " + state}>{state}</span>}
        </div>
        <div className="gn-type">{t.title} · <code>{id}</code></div>
        {Object.entries( t.inputs ).map( ([k, p]) => p.kind == "number" ? <NumberInput key={k} id={id} k={k} port={p} />
            : p.kind == "solid" ? <div className="row" key={k}>
                <Handle type="target" position={Position.Left} id={k} className="h-solid" />
                <span className="lbl">{p.label}</span>
                <span className="wired">{ref( nd.in?.[k] ) ? "← " + (DOC.nodes[ref( nd.in?.[k] )![0]]?.label ?? ref( nd.in?.[k] )![0]) : "connect a solid"}</span></div>
            : <TextInput key={k} id={id} k={k} port={p} /> )}
        {Object.entries( t.outputs ).map( ([k, ty]) => <div className="row out" key={k}>
            {isSolid && <button className="nodrag show" aria-pressed={shown == id} onClick={() => { DOC.view = { ...DOC.view, show : id }; changed(); }}>
                {shown == id ? "Shown" : "Show"}</button>}
            {isSolid && <button className="nodrag show out-toggle" aria-pressed={outputOf( id ) != null} title="Export this solid as an output of the graph file"
                onClick={() => { toggleOutput( id ); changed(); }}>{outputOf( id ) != null ? "Output: " + outputOf( id ) : "Make output"}</button>}
            <span className="lbl">{k}</span>
            <Handle type="source" position={Position.Right} id={k} className={"h-" + ty} /></div> )}
    </div>;
}
const nodeTypes = { g : GraphNodeView };

const toNodes = () : Node[] => Object.keys( DOC.nodes ).map( id => ({ id, type : "g", position : view()[id] ?? { x : 0, y : 0 }, data : {}, dragHandle : ".gn-head" }) );
const toEdges = () : Edge[] => Object.entries( DOC.nodes ).flatMap( ([id, nd]) => Object.entries( nd.in ?? {} ).flatMap( ([k, v]) => {
    const r = ref( v );
    if (!r || !DOC.nodes[r[0]] || !REGISTRY[DOC.nodes[r[0]].type]) return [];
    const outs = REGISTRY[DOC.nodes[r[0]].type].outputs, port = r[1] || Object.keys( outs )[0];
    return [{ id : `${id}.${k}`, source : r[0], sourceHandle : port, target : id, targetHandle : k, className : "e-" + outs[port] }];
} ) );

// ---------------------------------------------------------------- 3D view
function Viewport( { result } : { result : Result | null } ) {
    const host = useRef<HTMLDivElement>( null );
    const three = useRef<{ mesh : THREE.Mesh, render : () => void } | null>( null );
    useEffect( () => {
        const el = host.current!;
        const renderer = new THREE.WebGLRenderer( { antialias : true, alpha : true } );
        renderer.setPixelRatio( Math.min( devicePixelRatio, 2 ) );
        el.appendChild( renderer.domElement );
        const scene = new THREE.Scene();
        scene.environment = new THREE.PMREMGenerator( renderer ).fromScene( new RoomEnvironment(), 0.04 ).texture;
        const camera = new THREE.PerspectiveCamera( 35, 1, 1, 5000 );
        camera.up.set( 0, 0, 1 ); camera.position.set( 110, -150, 110 );
        const controls = new OrbitControls( camera, renderer.domElement );
        const colour = getComputedStyle( document.documentElement ).getPropertyValue( "--solid" ).trim() || "#8fa7bf";
        const mesh = new THREE.Mesh( new THREE.BufferGeometry(), new THREE.MeshStandardMaterial( { color : colour, metalness : 0.15, roughness : 0.45 } ) );
        scene.add( mesh );
        const grid = new THREE.GridHelper( 200, 20, 0x888888, 0x888888 );
        grid.rotation.x = Math.PI / 2;
        const gm = grid.material as THREE.Material; gm.opacity = 0.18; gm.transparent = true;
        scene.add( grid );
        const render = () => renderer.render( scene, camera );
        const resize = () => { const w = el.clientWidth, h = el.clientHeight; renderer.setSize( w, h ); camera.aspect = w / Math.max( h, 1 ); camera.updateProjectionMatrix(); render(); };
        const ro = new ResizeObserver( resize ); ro.observe( el );
        controls.addEventListener( "change", render );
        three.current = { mesh, render };
        resize();
        return () => { ro.disconnect(); renderer.dispose(); el.innerHTML = ""; };
    }, [] );
    useEffect( () => {
        const t = three.current;
        if (!t || !result?.ok || !result.pos) return;
        const g = new THREE.BufferGeometry();
        g.setAttribute( "position", new THREE.BufferAttribute( result.pos, 3 ) );
        g.setIndex( new THREE.BufferAttribute( result.idx!, 1 ) );
        t.mesh.geometry.dispose(); t.mesh.geometry = toCreasedNormals( g, Math.PI / 6 );
        t.render();
    }, [result] );
    return <div className="viewport" ref={host} role="img" aria-label="3D view of the shown solid" />;
}

// ---------------------------------------------------------------- palette
const CATEGORIES : Array<[string, string]> = [["parameter", "Parameters"], ["math", "Math"], ["primitive", "Primitives"], ["transform", "Transforms"],
    ["boolean", "Booleans"], ["finish", "Finishing"]];

function Palette( { add } : { add : ( type : string ) => void } ) {
    const [q, setQ] = useState( "" );
    const groups = useMemo( () => CATEGORIES.map( ([c, title]) => [title, Object.entries( REGISTRY ).filter( ([type, t]) => t.category == c &&
        (q == "" || (t.title + " " + type).toLowerCase().includes( q.toLowerCase() )) )] as const ).filter( g => g[1].length > 0 ), [q] );
    return <nav className="palette" aria-label="Add a node">
        <input id="palette-search" type="search" placeholder="Add a node…" aria-label="Search node types" value={q} onChange={e => setQ( e.target.value )} />
        <div className="palette-list">
            {groups.map( ([title, items]) => <section key={title}><h3>{title}</h3>
                {items.map( ([type, t]) => <button key={type} title={t.help} onClick={() => add( type )}>{t.title}</button> )}</section> )}
        </div>
    </nav>;
}

// ---------------------------------------------------------------- app
function App() {
    const [nodes, setNodes, onNodesChange] = useNodesState( toNodes() );
    const [edges, setEdges, onEdgesChange] = useEdgesState( toEdges() );
    const [, setTick] = useState( 0 );
    const [result, setResult] = useState<Result | null>( null );
    const [tab, setTab] = useState<"graph" | "model">( "graph" );
    const flow = useReactFlow();
    const file = useRef<HTMLInputElement>( null );
    // every edit of the document goes through changed (or reload, for a whole new document), which records an undo step
    const changed = ( key? : string ) => { setTick( x => x + 1 ); setEdges( toEdges() ); setNodes( ns => ns.map( n => ({ ...n, data : {} }) ) ); record( key ?? null ); evaluate(); };
    const reload = ( fit = true ) => {
        setNodes( toNodes() ); setEdges( toEdges() ); setTick( x => x + 1 ); evaluate();
        if (fit) setTimeout( () => flow.fitView( { padding : 0.08 } ), 50 );
    };
    const restore = ( d : GraphDocument | null ) => { if (d != null) { DOC = d; reload( false ); } };
    const undo = () => restore( history.undo() ), redo = () => restore( history.redo() );
    useEffect( () => {
        listener = r => setResult( r ); evaluate();
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

    const add = ( type : string ) => {
        const base = type.split( "/" ).pop()!.replace( /[^A-Za-z0-9]+/g, "_" ).replace( /^(\d)/, "n$1" );
        let k = 1, id = base;
        while (DOC.nodes[id] != null || Expr.reserved( id )) id = base + ++k;
        DOC.nodes[id] = { type };
        const r = document.querySelector( ".canvas" )!.getBoundingClientRect();
        const p = flow.screenToFlowPosition( { x : r.left + r.width / 2 - 110, y : r.top + r.height / 3 } );
        view()[id] = { x : Math.round( p.x ), y : Math.round( p.y ) };
        setNodes( toNodes() );
        changed();
    };
    const onConnect = ( c : Connection ) => { const n = DOC.nodes[c.target]; n.in = { ...n.in, [c.targetHandle!] : "@" + c.source }; changed(); };
    const onEdgesDelete = ( es : Edge[] ) => {
        for (const e of es) { const n = DOC.nodes[e.target]; if (n?.in) delete n.in[e.targetHandle!]; }
        changed();
    };
    const onNodesDelete = ( ns : Node[] ) => {
        for (const x of ns) { delete DOC.nodes[x.id]; delete view()[x.id]; }
        for (const [name, v] of Object.entries( DOC.outputs ?? {} )) if (DOC.nodes[ref( v )?.[0] ?? ""] == null) delete DOC.outputs[name];
        for (const n of Object.values( DOC.nodes )) for (const [k, v] of Object.entries( n.in ?? {} )) { const r = ref( v ); if (r && DOC.nodes[r[0]] == null) delete n.in![k]; }
        changed();
    };
    const isValidConnection = ( c : Edge | Connection ) => {
        if (c.source == c.target) return false;
        const out = REGISTRY[DOC.nodes[c.source].type].outputs[c.sourceHandle ?? ""], inp = REGISTRY[DOC.nodes[c.target].type].inputs[c.targetHandle ?? ""];
        return inp != null && inp.kind == out;
    };
    const onNodeDragStop = ( _e : unknown, _n : Node, moved : Node[] ) => {
        for (const n of moved) view()[n.id] = { x : Math.round( n.position.x ), y : Math.round( n.position.y ) };
        setTick( x => x + 1 ); record();
    };
    const save = () => {
        const a = document.createElement( "a" );
        a.href = URL.createObjectURL( new Blob( [JSON.stringify( DOC, null, 2 )], { type : "application/json" } ) );
        a.download = "graph.json"; a.click();
    };
    const open = async ( f : File ) => {
        try {
            const d = JSON.parse( await f.text() ) as GraphDocument;
            if (d.version !== 2 || typeof d.nodes != "object") throw new Error( "not a version 2 graph document" );
            DOC = d; reload(); record();
        } catch (e) { setResult( { ok : false, ms : 0, error : `Could not open ${f.name}: ${(e as Error).message}` } ); }
    };

    const shown = shownNode();
    const status = result?.nodes ?? {};
    const rebuilt = Object.keys( status ).filter( k => status[k] == "built" ), reused = Object.keys( status ).filter( k => status[k] == "cached" );
    return <Ctx.Provider value={{ status, shown, changed }}>
        <main className="layout">
            <Palette add={add} />
            <section className="canvas" aria-label="Node graph">
                <div className="toolbar">
                    <button onClick={undo} disabled={!history.canUndo} title="Undo (Ctrl+Z or ⌘Z)">Undo</button>
                    <button onClick={redo} disabled={!history.canRedo} title="Redo (Shift+Ctrl+Z, ⌘⇧Z or Ctrl+Y)">Redo</button>
                    <button onClick={() => { DOC = clone( SAMPLE ); reload(); record(); }}>New from sample</button>
                    <button onClick={() => file.current?.click()}>Open…</button>
                    <button onClick={save}>Save graph.json</button>
                    <input ref={file} type="file" accept=".json,application/json" hidden onChange={e => { const f = e.target.files?.[0]; if (f) void open( f ); e.target.value = ""; }} />
                </div>
                <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
                    onConnect={onConnect} onEdgesDelete={onEdgesDelete} onNodesDelete={onNodesDelete} isValidConnection={isValidConnection}
                    onNodeDragStop={onNodeDragStop} fitView fitViewOptions={{ padding : 0.08 }} minZoom={0.2} deleteKeyCode={["Backspace", "Delete"]}>
                    <Background gap={24} size={1} /><Controls showInteractive={false} /><MiniMap pannable zoomable />
                </ReactFlow>
            </section>
            <aside className="side">
                <Viewport result={result} />
                <div className="readout" aria-live="polite">
                    {result == null ? <p className="muted">Building…</p> : result.ok ? <>
                        <div className="verdict-line">
                            <span className={"pill big " + (result.verdict!.kind == "buildable" ? "ok" : "warn")}>{result.verdict!.kind}</span>
                            <span className="num">{result.ms.toFixed( 0 )} ms</span>
                            <span className="num">{(result.volume! / 1000).toFixed( 2 )} cm³</span>
                            <span className="num">{result.faces} faces</span>
                        </div>
                        <p className="muted small">{result.verdict!.reasons.join( "; " )}</p>
                        <p className="small"><b>Rebuilt:</b> {rebuilt.join( ", " ) || "nothing"}{reused.length > 0 && <> · <b>From cache:</b> {reused.join( ", " )}</>}</p>
                    </> : <p className="err" role="alert">{result.error}</p>}
                </div>
                <div className="json">
                    <div className="tabs" role="tablist">
                        <button role="tab" aria-selected={tab == "graph"} onClick={() => setTab( "graph" )}>Graph file</button>
                        <button role="tab" aria-selected={tab == "model"} onClick={() => setTab( "model" )}>Model document</button>
                    </div>
                    <pre>{JSON.stringify( tab == "graph" ? DOC : result?.model ?? null, null, 2 )}</pre>
                </div>
            </aside>
        </main>
    </Ctx.Provider>;
}

document.head.appendChild( Object.assign( document.createElement( "style" ), { textContent : flowCss } ) );
createRoot( document.getElementById( "app" )! ).render( <ReactFlowProvider><App /></ReactFlowProvider> );
