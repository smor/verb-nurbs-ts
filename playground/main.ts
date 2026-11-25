import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { toCreasedNormals } from "three/examples/jsm/utils/BufferGeometryUtils.js";

declare const WORKER_SOURCE : string;

type ModelId = "vessel" | "knot" | "ring" | "mug" | "pierced" | "ribbon";
interface Slider { key : string; label : string; min : number; max : number; step : number; value : number; unit? : string }

const MODELS : Record<ModelId, { name : string; note : string; sliders : Slider[] }> = {
    vessel : {
        name : "Vessel",
        note : "Seven folded sections lofted into a wall, offset inward for thickness, floor cut and capped.",
        sliders : [
            { key : "height", label : "Height", min : 80, max : 260, step : 1, value : 160, unit : "mm" },
            { key : "baseRadius", label : "Base radius", min : 35, max : 110, step : 1, value : 70, unit : "mm" },
            { key : "rimRadius", label : "Rim radius", min : 35, max : 120, step : 1, value : 80, unit : "mm" },
            { key : "belly", label : "Belly", min : -15, max : 25, step : 0.5, value : 1.5, unit : "mm" },
            { key : "lean", label : "Lean", min : -20, max : 20, step : 0.5, value : 4, unit : "mm" },
            { key : "folds", label : "Fold depth", min : 0, max : 1.8, step : 0.05, value : 1, unit : "×" },
            { key : "drift", label : "Fold drift", min : 0, max : 3, step : 0.05, value : 1, unit : "×" },
            { key : "turn", label : "Fold turn", min : -1.5, max : 1.5, step : 0.05, value : 0, unit : "rad" },
            { key : "wall", label : "Wall", min : 1.2, max : 8, step : 0.1, value : 3, unit : "mm" },
            { key : "floor", label : "Floor", min : 1.5, max : 15, step : 0.5, value : 4, unit : "mm" },
        ]
    },
    knot : {
        name : "Knot pipe",
        note : "A circle swept on rotation-minimising frames along a (p, q) torus knot, radius swelling as it goes.",
        sliders : [
            { key : "p", label : "Loops p", min : 2, max : 5, step : 1, value : 2 },
            { key : "q", label : "Winds q", min : 3, max : 7, step : 1, value : 3 },
            { key : "radius", label : "Knot radius", min : 15, max : 60, step : 1, value : 30, unit : "mm" },
            { key : "tube", label : "Torus tube", min : 4, max : 25, step : 0.5, value : 12, unit : "mm" },
            { key : "pipe", label : "Pipe radius", min : 1, max : 9, step : 0.1, value : 5, unit : "mm" },
            { key : "swell", label : "Swell", min : 0, max : 0.8, step : 0.01, value : 0.35, unit : "×" },
        ]
    },
    ring : {
        name : "Twisted ring",
        note : "A rounded-square section swept along a wavy ring, turning about the rail as it goes.",
        sliders : [
            { key : "radius", label : "Ring radius", min : 15, max : 60, step : 0.5, value : 32, unit : "mm" },
            { key : "wave", label : "Wave height", min : 0, max : 12, step : 0.25, value : 4, unit : "mm" },
            { key : "waves", label : "Waves", min : 0, max : 8, step : 1, value : 3 },
            { key : "width", label : "Section width", min : 1, max : 14, step : 0.25, value : 6, unit : "mm" },
            { key : "height", label : "Section height", min : 1, max : 10, step : 0.25, value : 3, unit : "mm" },
            { key : "exponent", label : "Squareness", min : 2, max : 8, step : 0.25, value : 4 },
            { key : "turns", label : "Turns", min : 0, max : 4, step : 1, value : 1 },
        ]
    },
    mug : {
        name : "Mug",
        note : "NURBS Boolean: (body + handle) − cavity. Seams are exact surface/surface intersections, trimmed on both faces.",
        sliders : [
            { key : "height", label : "Height", min : 70, max : 160, step : 1, value : 110, unit : "mm" },
            { key : "baseRadius", label : "Base radius", min : 28, max : 70, step : 1, value : 40, unit : "mm" },
            { key : "rimRadius", label : "Rim radius", min : 28, max : 75, step : 1, value : 44, unit : "mm" },
            { key : "folds", label : "Fold depth", min : 0, max : 1.4, step : 0.05, value : 1, unit : "×" },
            { key : "wall", label : "Wall", min : 2, max : 6, step : 0.1, value : 3, unit : "mm" },
            { key : "handle", label : "Handle radius", min : 3, max : 9, step : 0.1, value : 5.5, unit : "mm" },
            { key : "reach", label : "Handle reach", min : 20, max : 50, step : 1, value : 32, unit : "mm" },
            { key : "low", label : "Lower joint", min : 0.12, max : 0.45, step : 0.01, value : 0.25, unit : "×H" },
            { key : "high", label : "Upper joint", min : 0.55, max : 0.85, step : 0.01, value : 0.75, unit : "×H" },
        ]
    },
    pierced : {
        name : "Pierced vessel",
        note : "NURBS Boolean: body − cavity − round tools. Holes go through the wall; notches cut the rim, where three faces meet at exact triple points.",
        sliders : [
            { key : "height", label : "Height", min : 80, max : 220, step : 1, value : 140, unit : "mm" },
            { key : "baseRadius", label : "Base radius", min : 40, max : 90, step : 1, value : 55, unit : "mm" },
            { key : "rimRadius", label : "Rim radius", min : 40, max : 95, step : 1, value : 62, unit : "mm" },
            { key : "folds", label : "Fold depth", min : 0, max : 1.4, step : 0.05, value : 1, unit : "×" },
            { key : "wall", label : "Wall", min : 2, max : 6, step : 0.1, value : 3, unit : "mm" },
            { key : "holes", label : "Holes per row", min : 0, max : 14, step : 1, value : 9 },
            { key : "rows", label : "Rows", min : 1, max : 3, step : 1, value : 2 },
            { key : "hole", label : "Hole radius", min : 3, max : 12, step : 0.5, value : 7, unit : "mm" },
            { key : "notches", label : "Rim notches", min : 0, max : 14, step : 1, value : 9 },
            { key : "notch", label : "Notch radius", min : 3, max : 9, step : 0.5, value : 7, unit : "mm" },
        ]
    },
    ribbon : {
        name : "Ribbon knot",
        note : "A flat ribbon swept along a torus knot, twisting as it goes. At zero thickness it is a bare sheet: fine to look at, impossible to make.",
        sliders : [
            { key : "p", label : "Loops p", min : 2, max : 5, step : 1, value : 3 },
            { key : "q", label : "Winds q", min : 3, max : 8, step : 1, value : 5 },
            { key : "radius", label : "Knot radius", min : 20, max : 60, step : 1, value : 34, unit : "mm" },
            { key : "tube", label : "Torus tube", min : 6, max : 25, step : 0.5, value : 13, unit : "mm" },
            { key : "width", label : "Ribbon width", min : 2, max : 20, step : 0.5, value : 9, unit : "mm" },
            { key : "thickness", label : "Thickness", min : 0, max : 4, step : 0.1, value : 1.6, unit : "mm" },
            { key : "turns", label : "Twist turns", min : 0, max : 8, step : 1, value : 2 },
        ]
    }
};

const MACHINES : [string, string][] = [
    ["fdm", "FDM printer, 0.8 mm walls"], ["sla", "Resin printer, 0.5 mm walls"], ["sls", "SLS nylon, 0.7 mm walls"],
    ["cnc", "3-axis CNC, 1.5 mm walls"], ["ceramic", "Ceramic slip casting, 2.5 mm walls"]];

const $ = (id : string) => document.getElementById( id )!;
let current : ModelId = "vessel";
const values : Record<ModelId, Record<string, number>> = { vessel : {}, knot : {}, ring : {}, mug : {}, pierced : {}, ribbon : {} };
let mode : "free" | "make" = "free", machine = "fdm";
for (const m of Object.keys( MODELS ) as ModelId[]) for (const s of MODELS[m].sliders) values[m][s.key] = s.value;
try {
    const saved = JSON.parse( localStorage.getItem( "verb-playground" ) || "null" );
    if (saved && saved.values) for (const m of Object.keys( values ) as ModelId[]) Object.assign( values[m], saved.values[m] || {} );
    if (saved && MODELS[saved.current as ModelId]) current = saved.current;
    if (saved && (saved.mode == "free" || saved.mode == "make")) mode = saved.mode;
    if (saved && MACHINES.some( m => m[0] == saved.machine )) machine = saved.machine;
} catch (e) { /* storage unavailable */ }
const remember = () => { try { localStorage.setItem( "verb-playground", JSON.stringify( { current, values, mode, machine } ) ); } catch (e) { /* ignore */ } };

// ---------- three.js view ----------
const canvas = $( "view" ) as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer( { canvas, antialias : true, alpha : true } );
renderer.setPixelRatio( Math.min( window.devicePixelRatio, 2 ) );
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
scene.environment = new THREE.PMREMGenerator( renderer ).fromScene( new RoomEnvironment(), 0.04 ).texture;
const camera = new THREE.PerspectiveCamera( 35, 1, 1, 5000 );
camera.up.set( 0, 0, 1 );
const controls = new OrbitControls( camera, canvas );
controls.enableDamping = true;
const sun = new THREE.DirectionalLight( 0xffffff, 1.4 );
sun.position.set( 200, -300, 500 );
sun.castShadow = true;
sun.shadow.mapSize.set( 2048, 2048 );
scene.add( sun, sun.target );
const material = new THREE.MeshPhysicalMaterial( { color : 0x3f9c95, roughness : 0.18, metalness : 0.0, clearcoat : 1, clearcoatRoughness : 0.08, side : THREE.DoubleSide } );
const mesh = new THREE.Mesh( new THREE.BufferGeometry(), material );
mesh.castShadow = true;
scene.add( mesh );
const floor = new THREE.Mesh( new THREE.CircleGeometry( 1, 64 ), new THREE.ShadowMaterial( { opacity : 0.18 } ) );
floor.receiveShadow = true;
scene.add( floor );
let framed = "";

function resize() {
    const r = canvas.parentElement!.getBoundingClientRect();
    renderer.setSize( r.width, r.height, false );
    camera.aspect = r.width / Math.max( r.height, 1 );
    camera.updateProjectionMatrix();
}
new ResizeObserver( resize ).observe( canvas.parentElement! );
renderer.setAnimationLoop( () => { controls.update(); renderer.render( scene, camera ); } );

function frame( force : boolean ) {
    const g = mesh.geometry;
    g.computeBoundingSphere();
    const bs = g.boundingSphere!;
    g.computeBoundingBox();
    floor.position.set( bs.center.x, bs.center.y, g.boundingBox!.min.z - 0.01 );
    floor.scale.setScalar( bs.radius * 3 );
    sun.target.position.copy( bs.center );
    sun.position.copy( bs.center ).add( new THREE.Vector3( 0.25, -0.35, 1 ).normalize().multiplyScalar( bs.radius * 4 ) );
    const sc = sun.shadow.camera;
    sc.left = sc.bottom = -bs.radius * 1.5; sc.right = sc.top = bs.radius * 1.5; sc.near = 1; sc.far = bs.radius * 8;
    sc.updateProjectionMatrix();
    if (!force && framed == current) return;
    framed = current;
    controls.target.copy( bs.center );
    const vfov = THREE.MathUtils.degToRad( camera.fov );
    const hfov = 2 * Math.atan( Math.tan( vfov / 2 ) * camera.aspect );
    const d = bs.radius / Math.sin( Math.min( vfov, hfov ) / 2 ) * 1.05;
    camera.position.copy( bs.center ).add( new THREE.Vector3( 0.55, -0.75, 0.42 ).normalize().multiplyScalar( d ) );
}

// ---------- worker ----------
const worker = new Worker( URL.createObjectURL( new Blob( [WORKER_SOURCE], { type : "text/javascript" } ) ) );
let seq = 0, latest = 0, busy = false, queued : { fine : boolean } | null = null;
let lastPos : Float32Array | null = null, lastIdx : Uint32Array | null = null;

function request( fine : boolean ) {
    if (busy) { queued = { fine : fine || (queued != null && queued.fine) }; return; }
    busy = true;
    latest = ++seq;
    $( "status" ).textContent = fine ? "Refining…" : "Building…";
    $( "status" ).dataset.state = "busy";
    worker.postMessage( { id : latest, model : current, params : values[current], fine, make : mode == "make", machine } );
}

let fineTimer = 0;
worker.onmessage = (e : MessageEvent) => {
    busy = false;
    const r = e.data;
    if (queued) { const q = queued; queued = null; request( q.fine ); }
    if (r.model != current) return; // a build for a model the user has since left
    if (!r.ok) { showError( r.message ); return; }
    const indexed = new THREE.BufferGeometry();
    indexed.setAttribute( "position", new THREE.BufferAttribute( r.pos, 3 ) );
    indexed.setIndex( new THREE.BufferAttribute( r.idx, 1 ) );
    // smooth shading, but keep sharp edges (rims, hole edges) sharp
    const g = toCreasedNormals( indexed, Math.PI / 5 );
    indexed.dispose();
    mesh.geometry.dispose();
    mesh.geometry = g;
    lastPos = r.pos; lastIdx = r.idx;
    frame( false );
    showStats( r.stats, r.ms, r.fine );
    if (!r.fine && !queued) { clearTimeout( fineTimer ); fineTimer = window.setTimeout( () => request( true ), 450 ); }
};

function showError( msg : string ) {
    $( "status" ).textContent = "Can't build this shape: " + msg.replace( /^Shell: /, "" );
    $( "status" ).dataset.state = "bad";
}

function showStats( s : any, ms : number, fine : boolean ) {
    const m = s.manifold;
    const st = $( "status" );
    const issues = $( "issues" );
    issues.innerHTML = "";
    let canSave = true;
    if (mode == "free") {
        st.textContent = (m.closedManifold ? "Closed solid" : "Open surface, visual only") + (fine ? ", final resolution" : ", preview");
        st.dataset.state = "good";
    } else if (!fine || !s.check) {
        st.textContent = "Preview: making checks run on the final model";
        st.dataset.state = "busy";
        canSave = false;
    } else {
        const c = s.check;
        st.textContent = c.makeable ? "Makeable: " + c.machine : "Not makeable yet: " + c.issues.length + (c.issues.length == 1 ? " issue" : " issues");
        st.dataset.state = c.makeable ? "good" : "bad";
        issues.innerHTML = c.issues.map( (x : string) => `<li>${x.replace( /&/g, "&amp;" ).replace( /</g, "&lt;" )}</li>` ).join( "" );
        canSave = c.makeable;
    }
    const rows : [string, string][] = [
        ["Triangles", s.triangles.toLocaleString( "en" )],
        ["Watertight", m.closedManifold ? "yes" : "no, " + m.boundaryEdges + " open edges"],
        ["Genus", m.genus == null || isNaN( m.genus ) ? "–" : String( m.genus )],
        ["Material", m.closedManifold ? (s.volume / 1000).toFixed( 1 ) + " cm³" : "–"],
        ["Size", s.size ? s.size.map( (x : number) => x.toFixed( 0 ) ).join( " × " ) + " mm" : "–"],
        current == "mug" || current == "pierced" ? ["Seam error", s.error.toExponential( 1 ) + " mm"] : ["Fit error", s.error.toFixed( 3 ) + " mm"],
    ];
    if (s.check && isFinite( s.check.wall )) rows.push( ["Thinnest wall", s.check.wall.toFixed( 2 ) + " mm"] );
    rows.push( ["Build", Math.round( ms ) + " ms"] );
    $( "stats" ).innerHTML = rows.map( ([k, v]) => `<div><dt>${k}</dt><dd>${v.replace( /&/g, "&amp;" ).replace( /</g, "&lt;" )}</dd></div>` ).join( "" );
    ($( "save" ) as HTMLButtonElement).disabled = !canSave;
}

function renderMode() {
    document.querySelectorAll<HTMLButtonElement>( "#mode button" ).forEach( b => b.setAttribute( "aria-pressed", String( b.dataset.mode == mode ) ) );
    $( "machineRow" ).hidden = mode != "make";
    $( "modeHint" ).textContent = mode == "free"
        ? "Anything goes: open sheets and thin or self-crossing shapes are fine for images and animation."
        : "Each final model is checked: closed solid, wall thickness for the machine, and fit in its build volume.";
    const sel = $( "machine" ) as HTMLSelectElement;
    if (!sel.options.length) sel.innerHTML = MACHINES.map( ([k, n]) => `<option value="${k}">${n}</option>` ).join( "" );
    sel.value = machine;
}

$( "mode" ).addEventListener( "click", (e) => {
    const b = (e.target as HTMLElement).closest( "button" );
    if (!b) return;
    mode = b.dataset.mode as "free" | "make";
    remember(); renderMode(); request( mode == "make" );
} );
$( "machine" ).addEventListener( "change", (e) => {
    machine = (e.target as HTMLSelectElement).value;
    remember(); request( true );
} );

// ---------- controls ----------
function fmt( s : Slider, v : number ) { return (s.step >= 1 ? v.toFixed( 0 ) : s.step >= 0.1 ? v.toFixed( 1 ) : v.toFixed( 2 )) + (s.unit ? " " + s.unit : ""); }

function renderControls() {
    const m = MODELS[current];
    document.querySelectorAll<HTMLButtonElement>( "#models button" ).forEach( b => b.setAttribute( "aria-pressed", String( b.dataset.m == current ) ) );
    $( "note" ).textContent = m.note;
    $( "sliders" ).innerHTML = m.sliders.map( s => `
        <label class="row" for="s-${s.key}">
          <span class="lab">${s.label}</span><output id="o-${s.key}">${fmt( s, values[current][s.key] )}</output>
          <input type="range" id="s-${s.key}" data-k="${s.key}" min="${s.min}" max="${s.max}" step="${s.step}" value="${values[current][s.key]}">
        </label>` ).join( "" );
}

$( "sliders" ).addEventListener( "input", (e) => {
    const t = e.target as HTMLInputElement;
    const s = MODELS[current].sliders.find( x => x.key == t.dataset.k )!;
    values[current][s.key] = Number( t.value );
    $( "o-" + s.key ).textContent = fmt( s, values[current][s.key] );
    remember();
    request( false );
} );

$( "models" ).addEventListener( "click", (e) => {
    const b = (e.target as HTMLElement).closest( "button" );
    if (!b) return;
    current = b.dataset.m as ModelId;
    remember(); renderControls(); request( false );
} );

$( "reset" ).addEventListener( "click", () => {
    for (const s of MODELS[current].sliders) values[current][s.key] = s.value;
    remember(); renderControls(); request( false );
} );

$( "shuffle" ).addEventListener( "click", () => {
    for (const s of MODELS[current].sliders) {
        const span = (s.max - s.min) * 0.35;
        const v = s.value + (Math.random() * 2 - 1) * span;
        values[current][s.key] = Math.min( s.max, Math.max( s.min, Math.round( v / s.step ) * s.step ) );
    }
    remember(); renderControls(); request( false );
} );

$( "recenter" ).addEventListener( "click", () => frame( true ) );

function binarySTL() : Uint8Array {
    const pos = lastPos!, idx = lastIdx!;
    const n = idx.length / 3;
    const buf = new ArrayBuffer( 84 + n * 50 );
    const dv = new DataView( buf );
    dv.setUint32( 80, n, true );
    let o = 84;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), nr = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
        a.fromArray( pos, idx[3*i] * 3 ); b.fromArray( pos, idx[3*i+1] * 3 ); c.fromArray( pos, idx[3*i+2] * 3 );
        nr.subVectors( b, a ).cross( c.clone().sub( a ) ).normalize();
        for (const v of [nr, a, b, c]) { dv.setFloat32( o, v.x, true ); dv.setFloat32( o + 4, v.y, true ); dv.setFloat32( o + 8, v.z, true ); o += 12; }
        o += 2;
    }
    return new Uint8Array( buf );
}

// A zip with one stored (uncompressed) file. The artifact viewer only lets pages save common formats, and .stl is
// not one of them, so there the STL travels inside a zip.
function zipOne( name : string, data : Uint8Array ) : Uint8Array {
    let crc = 0xffffffff;
    for (let i = 0; i < data.length; i++) {
        crc ^= data[i];
        for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const fn = new TextEncoder().encode( name );
    const out = new Uint8Array( 30 + fn.length + data.length + 46 + fn.length + 22 );
    const dv = new DataView( out.buffer );
    let o = 0;
    const head = (sig : number, central : boolean) => {
        dv.setUint32( o, sig, true ); o += 4;
        if (central) { dv.setUint16( o, 20, true ); o += 2; }
        dv.setUint16( o, 20, true ); dv.setUint16( o + 2, 0, true ); dv.setUint16( o + 4, 0, true );
        dv.setUint16( o + 6, 0, true ); dv.setUint16( o + 8, 0x21, true ); dv.setUint32( o + 10, crc, true );
        dv.setUint32( o + 14, data.length, true ); dv.setUint32( o + 18, data.length, true );
        dv.setUint16( o + 22, fn.length, true ); dv.setUint16( o + 24, 0, true ); o += 26;
    };
    head( 0x04034b50, false );
    out.set( fn, o ); o += fn.length;
    out.set( data, o ); o += data.length;
    const cd = o;
    head( 0x02014b50, true );
    dv.setUint16( o, 0, true ); dv.setUint16( o + 2, 0, true ); dv.setUint16( o + 4, 0, true ); dv.setUint32( o + 6, 0, true ); dv.setUint32( o + 10, 0, true ); o += 14;
    out.set( fn, o ); o += fn.length;
    dv.setUint32( o, 0x06054b50, true ); dv.setUint16( o + 4, 0, true ); dv.setUint16( o + 6, 0, true );
    dv.setUint16( o + 8, 1, true ); dv.setUint16( o + 10, 1, true ); dv.setUint32( o + 12, o - cd, true );
    dv.setUint32( o + 16, cd, true ); dv.setUint16( o + 20, 0, true );
    return out;
}

let downloads : any = null;
(window as any).claude?.use?.( "downloads" ).then( (d : any) => { downloads = d; } ).catch( () => {} );

$( "save" ).addEventListener( "click", async () => {
    if (!lastPos) return;
    const filename = MODELS[current].name.toLowerCase().replace( / /g, "-" ) + ".stl";
    const data = binarySTL();
    try {
        if (downloads) {
            await downloads.save( { filename : filename.replace( ".stl", "-stl.zip" ), data : new Blob( [zipOne( filename, data )] ) } );
            return;
        }
        const a = document.createElement( "a" );
        a.href = URL.createObjectURL( new Blob( [data], { type : "model/stl" } ) );
        a.download = filename;
        a.click();
    } catch (err : any) {
        if (err && err.code == "declined") return;
        $( "status" ).textContent = "The download was not saved.";
        $( "status" ).dataset.state = "bad";
    }
} );

renderControls();
renderMode();
resize();
request( false );
