import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { toCreasedNormals } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { EXAMPLES } from "./examples.js";

declare const WORKER_SOURCE : string;

interface Field { values : Float32Array; unit : string; symmetric : boolean }
interface Layer {
    name : string; kind : "points" | "lines" | "mesh"; color : string; visible : boolean; dashed : boolean; itemColors : boolean;
    pos : Float32Array; idx : Uint32Array | null; pick : Int32Array | null; nrm : Float32Array | null; fields : Record<string, Field>;
}
interface Item { label : string; type : string; facts : Array<[string, string]>; overlay : Array<Layer> }
interface ViewMsg { id : number; ok : boolean; message? : string; title : string; kind : string; facts : Array<[string, string]>; layers : Array<Layer>; items : Array<Item>; ms : number; solid? : boolean }
interface StepMsg { id : number; ok : true; step : string; name : string }

const $ = (id : string) => document.getElementById( id )!;
const GROUPS = ["Curves", "Surfaces", "B-reps", "Meshes"] as const;

// ---------- three.js ----------
const canvas = $( "view" ) as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer( { canvas, antialias : true, alpha : true } );
renderer.setPixelRatio( Math.min( window.devicePixelRatio, 2 ) );
renderer.toneMapping = THREE.ACESFilmicToneMapping;
const scene = new THREE.Scene();
scene.environment = new THREE.PMREMGenerator( renderer ).fromScene( new RoomEnvironment(), 0.04 ).texture;
const camera = new THREE.PerspectiveCamera( 35, 1, 0.1, 20000 );
camera.up.set( 0, 0, 1 );
const controls = new OrbitControls( camera, canvas );
controls.enableDamping = true;
const sun = new THREE.DirectionalLight( 0xffffff, 1.2 );
scene.add( sun );
const root = new THREE.Group(), overlayRoot = new THREE.Group();
scene.add( root, overlayRoot );

function resize() {
    const r = canvas.parentElement!.getBoundingClientRect();
    renderer.setSize( r.width, r.height, false );
    camera.aspect = r.width / Math.max( r.height, 1 );
    camera.updateProjectionMatrix();
}
new ResizeObserver( resize ).observe( canvas.parentElement! );
renderer.setAnimationLoop( () => {
    controls.update();
    sun.position.copy( camera.position );
    renderer.render( scene, camera );
} );

// ---------- colour maps ----------
// diverging (blue - white - red) for signed fields such as curvature; sequential (orange - teal) for thickness
const DIVERGING = ["#2f5fb3", "#8fb0e0", "#f3f4f4", "#e8a08a", "#b8322a"];
const SEQUENTIAL = ["#c2410c", "#f59e0b", "#e8e3c8", "#7cc4b8", "#1f6f6a"];
function ramp( stops : Array<string>, t : number, out : THREE.Color ) {
    t = Math.min( 1, Math.max( 0, t ) ) * (stops.length - 1);
    const i = Math.min( stops.length - 2, Math.floor( t ) );
    const a = new THREE.Color( stops[i] ), b = new THREE.Color( stops[i + 1] );
    return out.copy( a ).lerp( b, t - i );
}
function range( f : Field ) : [number, number] {
    const v = Array.from( f.values ).filter( x => isFinite( x ) ).sort( (a, b) => a - b );
    if (v.length == 0) return [0, 1];
    const q = (p : number) => v[Math.min( v.length - 1, Math.floor( p * v.length ) )];
    if (f.symmetric) {
        const m = Math.max( Math.abs( q( 0.02 ) ), Math.abs( q( 0.98 ) ), 1e-12 );
        // constant-sign fields (a sphere) keep their sign on one side of white
        return [-m, m];
    }
    const lo = q( 0.01 ), hi = q( 0.95 );
    return [lo, hi > lo ? hi : lo + 1];
}
const ITEM_COLORS = ["#8fb8c9", "#b9c99a", "#d9b48f", "#a9a3cf", "#9cc9b4", "#cfa3b5", "#c9c28f", "#93b0d6", "#c7b199", "#a6c3c7"];
const FILLET_COLOR = "#e3c15a";

// ---------- state ----------
let view : ViewMsg | null = null;
let group : typeof GROUPS[number] = "B-reps";
let example = "mug";
let colourMode = "";
let picked = -1;
const layerVisible = new Map<string, boolean>();
const objects = new Map<string, THREE.Object3D>();
let pickMesh : { mesh : THREE.Mesh, layer : Layer } | null = null;

function lineObject( l : Layer, opacity = 1 ) : THREE.Object3D {
    const g = new THREE.BufferGeometry();
    g.setAttribute( "position", new THREE.BufferAttribute( l.pos, 3 ) );
    if (l.kind == "points") {
        return new THREE.Points( g, new THREE.PointsMaterial( { color : l.color, size : 7, sizeAttenuation : false, depthTest : true } ) );
    }
    if (l.idx) g.setIndex( new THREE.BufferAttribute( l.idx, 1 ) );
    const seg = new THREE.LineSegments( g, l.dashed
        ? new THREE.LineDashedMaterial( { color : l.color, dashSize : 3, gapSize : 2, transparent : opacity < 1, opacity } )
        : new THREE.LineBasicMaterial( { color : l.color, transparent : opacity < 1, opacity } ) );
    if (l.dashed) seg.computeLineDistances();
    return seg;
}

// a mesh layer, unwelded so each triangle can take its item's colour. With the surface's exact normals (NURBS and
// B-reps) the shading shows the surface itself; without them (plain meshes), creased normals keep sharp edges sharp.
function meshObject( l : Layer ) : THREE.Mesh {
    const idx = l.idx!;
    const n = idx.length;
    const pos = new Float32Array( n * 3 );
    for (let k = 0; k < n; k++) { const i = idx[k]; pos[3 * k] = l.pos[3 * i]; pos[3 * k + 1] = l.pos[3 * i + 1]; pos[3 * k + 2] = l.pos[3 * i + 2]; }
    let g = new THREE.BufferGeometry();
    g.setAttribute( "position", new THREE.BufferAttribute( pos, 3 ) );
    g.setAttribute( "color", new THREE.BufferAttribute( new Float32Array( n * 3 ), 3 ) );
    if (l.nrm) {
        const nrm = new Float32Array( n * 3 );
        for (let k = 0; k < n; k++) { const i = idx[k]; nrm[3 * k] = l.nrm[3 * i]; nrm[3 * k + 1] = l.nrm[3 * i + 1]; nrm[3 * k + 2] = l.nrm[3 * i + 2]; }
        g.setAttribute( "normal", new THREE.BufferAttribute( nrm, 3 ) );
    } else g = toCreasedNormals( g, Math.PI / 6 );
    return new THREE.Mesh( g, surfaceMaterial() );
}

// ---------- surface analysis shading ----------
// "studio": physically based shading in a soft room. "zebra": reflection lines, the reflection of an environment
// of parallel stripes; they move with the view, and their continuity across a seam reads off the seam's continuity
// (stripes break: G0, position only; kink: G1, tangent; flow smoothly: G2, curvature). "isophotes": lines of equal
// angle between the normal and a fixed light, fixed to the object, the same test without the view dependence.
let shading : "studio" | "zebra" | "isophotes" = "studio";
let stripes = 12;
const analysisUniforms = { mode : { value : 0 }, stripes : { value : stripes }, across : { value : 0 }, light : { value : new THREE.Vector3( 0.3, -0.5, 0.81 ).normalize() } };
function surfaceMaterial() : THREE.Material {
    if (shading == "studio") return new THREE.MeshStandardMaterial( { vertexColors : true, roughness : 0.45, metalness : 0.0, side : THREE.DoubleSide,
        polygonOffset : true, polygonOffsetFactor : 1, polygonOffsetUnits : 1 } );
    analysisUniforms.mode.value = shading == "zebra" ? 0 : 1;
    return new THREE.ShaderMaterial( {
        uniforms : analysisUniforms, side : THREE.DoubleSide, polygonOffset : true, polygonOffsetFactor : 1, polygonOffsetUnits : 1,
        vertexShader : `
            varying vec3 vViewNormal; varying vec3 vViewPos; varying vec3 vWorldNormal;
            void main() {
                vec4 mv = modelViewMatrix * vec4( position, 1.0 );
                vViewPos = mv.xyz;
                vViewNormal = normalize( normalMatrix * normal );
                vWorldNormal = normalize( mat3( modelMatrix ) * normal );
                gl_Position = projectionMatrix * mv;
            }`,
        fragmentShader : `
            uniform int mode; uniform float stripes; uniform vec3 light; uniform int across;
            varying vec3 vViewNormal; varying vec3 vViewPos; varying vec3 vWorldNormal;
            const float PI = 3.141592653589793;
            void main() {
                vec3 n = normalize( vViewNormal );
                if (!gl_FrontFacing) n = -n;
                float x;
                if (mode == 0) {
                    // reflect the view ray and take its angle around the view's vertical axis (vertical stripes) or
                    // its elevation (horizontal stripes)
                    vec3 r = reflect( normalize( vViewPos ), n );
                    x = across == 1 ? asin( clamp( r.y, -1.0, 1.0 ) ) / PI : atan( r.x, -r.z ) / PI;
                } else {
                    vec3 w = normalize( vWorldNormal ) * (gl_FrontFacing ? 1.0 : -1.0);
                    x = acos( clamp( dot( w, light ), -1.0, 1.0 ) ) / PI;
                }
                float f = x * stripes;
                // anti-aliased square wave: the edge is as wide as a pixel
                float w = fwidth( f );
                float s = smoothstep( 0.5 - w, 0.5 + w, abs( fract( f ) - 0.5 ) * 2.0 );
                float shade = 0.35 + 0.65 * abs( n.z );
                vec3 dark = vec3( 0.08, 0.09, 0.1 ), lit = vec3( 0.97 ) * shade + 0.03;
                gl_FragColor = vec4( mix( dark, lit, s ), 1.0 );
            }`,
    } );
}
function applyShading() {
    for (const o of root.children) if ((o as THREE.Mesh).isMesh) {
        const mesh = o as THREE.Mesh;
        (mesh.material as THREE.Material).dispose();
        mesh.material = surfaceMaterial();
    }
    ($( "colourRow" ) as HTMLElement).style.display = shading == "studio" ? "" : "none";
    ($( "stripesRow" ) as HTMLElement).style.display = shading == "studio" ? "none" : "";
    if (shading == "studio") paint(); else $( "legend" ).style.display = "none";
}

function paint() {
    if (!view || !pickMesh) { $( "legend" ).style.display = "none"; return; }
    const l = pickMesh.layer, idx = l.idx!;
    const col = pickMesh.mesh.geometry.getAttribute( "color" ) as THREE.BufferAttribute;
    const c = new THREE.Color();
    const field = colourMode != "" && colourMode != "items" ? l.fields[colourMode] : null;
    let lo = 0, hi = 1;
    if (field) {
        [lo, hi] = range( field );
        $( "legend" ).style.display = "block";
        $( "legendName" ).textContent = colourMode[0].toUpperCase() + colourMode.slice( 1 ) + (field.unit ? " (" + field.unit + ")" : "");
        ($( "legendBar" ) as HTMLElement).style.background = "linear-gradient(90deg," + (field.symmetric ? DIVERGING : SEQUENTIAL).join( "," ) + ")";
        $( "legendMin" ).textContent = fmt( lo ); $( "legendMax" ).textContent = fmt( hi );
    } else $( "legend" ).style.display = "none";
    const base = new THREE.Color( l.color );
    for (let k = 0; k < idx.length; k++) {
        const tri = Math.floor( k / 3 );
        const item = l.pick ? l.pick[tri] : -1;
        if (field) {
            const v = field.values[idx[k]];
            if (!isFinite( v )) c.set( "#9aa3a8" );
            else ramp( field.symmetric ? DIVERGING : SEQUENTIAL, (v - lo) / (hi - lo), c );
        } else if (colourMode == "items" && item >= 0 && view.items[item]) {
            c.set( view.items[item].type == "Fillet face" ? FILLET_COLOR : ITEM_COLORS[item % ITEM_COLORS.length] );
        } else c.copy( base );
        if (picked >= 0 && item == picked) c.lerp( new THREE.Color( "#1f6f6a" ), 0.45 );
        col.setXYZ( k, c.r, c.g, c.b );
    }
    col.needsUpdate = true;
}

function fmt( x : number ) {
    const a = Math.abs( x );
    return a != 0 && (a < 1e-3 || a >= 1e5) ? x.toExponential( 2 ) : String( Math.round( x * 1000 ) / 1000 );
}

function clear( g : THREE.Group ) {
    for (const o of [...g.children]) {
        g.remove( o );
        (o as any).geometry?.dispose();
        (o as any).material?.dispose();
    }
}

function show( v : ViewMsg ) {
    view = v; picked = -1;
    clear( root ); clear( overlayRoot ); objects.clear(); pickMesh = null;
    for (const l of v.layers) {
        const o = l.kind == "mesh" ? meshObject( l ) : lineObject( l );
        if (l.kind == "mesh" && !pickMesh) pickMesh = { mesh : o as THREE.Mesh, layer : l };
        o.name = l.name;
        const key = v.kind + ":" + l.name;
        o.visible = layerVisible.has( key ) ? layerVisible.get( key )! : l.visible;
        objects.set( l.name, o );
        root.add( o );
    }
    // colour choices: the mesh's fields, and per-face colours for a B-rep
    const sel = $( "colour" ) as HTMLSelectElement;
    sel.innerHTML = "";
    const opts : Array<[string, string]> = [];
    if (pickMesh) {
        if (pickMesh.layer.itemColors) opts.push( ["items", "By face (fillets in gold)"] );
        for (const k in pickMesh.layer.fields) opts.push( [k, k[0].toUpperCase() + k.slice( 1 )] );
        opts.push( ["", "Plain"] );
    } else opts.push( ["", "Plain"] );
    for (const [k, label] of opts) { const o = document.createElement( "option" ); o.value = k; o.textContent = label; sel.append( o ); }
    colourMode = opts[0][0];
    sel.value = colourMode;
    sel.disabled = opts.length < 2;
    paint();
    renderLayers();
    renderFacts();
    renderPicked();
    frame();
}

function renderLayers() {
    const box = $( "layers" );
    box.innerHTML = "";
    if (!view) return;
    for (const l of view.layers) {
        const o = objects.get( l.name )!;
        const lab = document.createElement( "label" );
        const cb = document.createElement( "input" );
        cb.type = "checkbox"; cb.checked = o.visible;
        cb.onchange = () => { o.visible = cb.checked; layerVisible.set( view!.kind + ":" + l.name, cb.checked ); };
        const sw = document.createElement( "span" );
        sw.className = "sw" + (l.dashed ? " dash" : "") + (l.kind == "points" ? " dot" : "");
        sw.style.background = l.color; sw.style.color = l.color;
        const count = l.kind == "points" ? l.pos.length / 3 : l.kind == "lines" ? (l.idx ? l.idx.length / 2 : 0) : (l.idx ? l.idx.length / 3 : 0);
        const name = document.createElement( "span" );
        name.textContent = l.name;
        const n = document.createElement( "span" );
        n.style.cssText = "margin-left:auto;color:var(--soft);font-size:12px;font-variant-numeric:tabular-nums";
        n.textContent = count == 0 ? "none" : String( count );
        lab.append( cb, sw, name, n );
        box.append( lab );
    }
}

function dl( el : HTMLElement, facts : Array<[string, string]> ) {
    el.innerHTML = "";
    for (const [k, v] of facts) {
        const dt = document.createElement( "dt" ), dd = document.createElement( "dd" );
        dt.textContent = k; dd.textContent = v;
        el.append( dt, dd );
    }
}

function renderFacts() {
    if (!view) return;
    $( "factsTitle" ).textContent = view.title;
    dl( $( "facts" ), view.facts.concat( [["Built in", Math.round( view.ms ) + " ms"]] ) );
}

function renderPicked() {
    clear( overlayRoot );
    const card = $( "picked" );
    if (!view || picked < 0 || !view.items[picked]) { card.style.display = "none"; return; }
    const it = view.items[picked];
    card.style.display = "block";
    $( "pickedName" ).textContent = it.label;
    $( "pickedType" ).textContent = it.type + (view.kind == "brep" ? ": its whole surface's control net and knot lines are drawn" : "");
    dl( $( "pickedFacts" ), it.facts );
    for (const l of it.overlay) overlayRoot.add( lineObject( l, 0.9 ) );
}

function frame() {
    const box = new THREE.Box3().setFromObject( root );
    if (box.isEmpty()) return;
    const bs = box.getBoundingSphere( new THREE.Sphere() );
    controls.target.copy( bs.center );
    const vfov = THREE.MathUtils.degToRad( camera.fov );
    const hfov = 2 * Math.atan( Math.tan( vfov / 2 ) * camera.aspect );
    const d = bs.radius / Math.sin( Math.min( vfov, hfov ) / 2 ) * 1.05;
    camera.position.copy( bs.center ).add( new THREE.Vector3( 0.55, -0.75, 0.42 ).normalize().multiplyScalar( d ) );
    camera.near = d / 100; camera.far = d * 20; camera.updateProjectionMatrix();
}

// ---------- picking ----------
const ray = new THREE.Raycaster();
let down : { x : number, y : number } | null = null;
canvas.addEventListener( "pointerdown", e => { down = { x : e.clientX, y : e.clientY }; } );
canvas.addEventListener( "pointerup", e => {
    if (!down || Math.hypot( e.clientX - down.x, e.clientY - down.y ) > 4 || !view || !pickMesh || !pickMesh.layer.pick || view.items.length == 0) return;
    const r = canvas.getBoundingClientRect();
    ray.setFromCamera( new THREE.Vector2( (e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1 ), camera );
    const hit = pickMesh.mesh.visible ? ray.intersectObject( pickMesh.mesh )[0] : undefined;
    const next = hit && hit.faceIndex != null ? pickMesh.layer.pick[hit.faceIndex] : -1;
    picked = next == picked ? -1 : next;
    paint(); renderPicked();
} );

// ---------- worker ----------
const worker = new Worker( URL.createObjectURL( new Blob( [WORKER_SOURCE], { type : "text/javascript" } ) ) );
let seq = 0;
function status( text : string, state : string ) { $( "status" ).textContent = text; $( "status" ).dataset.state = state; }
function load( ex : string ) {
    example = ex;
    const e = EXAMPLES.find( x => x.id == ex )!;
    $( "note" ).textContent = e.note;
    status( "Building " + e.name.toLowerCase() + "…", "busy" );
    worker.postMessage( { id : ++seq, example : ex } );
    try { localStorage.setItem( "verb-viewer", JSON.stringify( { example : ex } ) ); } catch (err) { /* ignore */ }
}
function loadFile( f : File ) {
    status( "Reading " + f.name + "…", "busy" );
    $( "note" ).textContent = "Your file " + f.name + ", read in this browser.";
    f.arrayBuffer().then( data => worker.postMessage( { id : ++seq, file : { name : f.name, data } }, [data] ) );
}
let stepSeq = -1;
function downloadStep() {
    if (!view || !view.solid) return;
    stepSeq = ++seq;
    status( "Writing STEP…", "busy" );
    worker.postMessage( { id : stepSeq, step : true } );
}
worker.onmessage = (e : MessageEvent) => {
    if (e.data.id == stepSeq) {
        stepSeq = -1;
        if (!e.data.ok) { status( "Can't write STEP: " + e.data.message, "bad" ); return; }
        const s = e.data as StepMsg;
        const a = document.createElement( "a" );
        a.href = URL.createObjectURL( new Blob( [s.step], { type : "application/step" } ) );
        a.download = s.name.toLowerCase().replace( /[^a-z0-9]+/g, "-" ).replace( /^-|-$/g, "" ) + ".step";
        a.click();
        setTimeout( () => URL.revokeObjectURL( a.href ), 1000 );
        status( "Saved " + a.download + ": a closed solid of trimmed NURBS faces.", "good" );
        return;
    }
    const r = e.data as ViewMsg;
    if (r.id != seq) return;
    $( "stepRow" ).style.display = r.ok && r.solid ? "" : "none";
    if (!r.ok) { status( "Can't show this: " + r.message, "bad" ); return; }
    show( r );
    const hint = r.items.length > 0 ? " Click a face to inspect it." : "";
    status( r.title + "." + hint, "good" );
};

// ---------- controls ----------
function renderGroups() {
    const nav = $( "groups" );
    nav.innerHTML = "";
    for (const g of GROUPS) {
        const b = document.createElement( "button" );
        b.textContent = g; b.setAttribute( "aria-pressed", String( g == group ) );
        b.onclick = () => { group = g; renderGroups(); renderExamples(); load( EXAMPLES.find( x => x.group == g )!.id ); };
        nav.append( b );
    }
}
function renderExamples() {
    const sel = $( "example" ) as HTMLSelectElement;
    sel.innerHTML = "";
    for (const e of EXAMPLES.filter( x => x.group == group )) {
        const o = document.createElement( "option" ); o.value = e.id; o.textContent = e.name; sel.append( o );
    }
    sel.value = example;
}
($( "example" ) as HTMLSelectElement).onchange = e => load( (e.target as HTMLSelectElement).value );
($( "shading" ) as HTMLSelectElement).onchange = e => { shading = (e.target as HTMLSelectElement).value as typeof shading; applyShading(); };
($( "across" ) as HTMLSelectElement).onchange = e => { analysisUniforms.across.value = (e.target as HTMLSelectElement).value == "horizontal" ? 1 : 0; };
($( "stripes" ) as HTMLInputElement).oninput = e => { stripes = +(e.target as HTMLInputElement).value; analysisUniforms.stripes.value = stripes; };
($( "colour" ) as HTMLSelectElement).onchange = e => { colourMode = (e.target as HTMLSelectElement).value; paint(); };
$( "recenter" ).onclick = () => frame();
$( "step" ).onclick = () => downloadStep();
$( "open" ).onclick = () => ($( "file" ) as HTMLInputElement).click();
($( "file" ) as HTMLInputElement).onchange = e => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) loadFile( f ); };
const stage = $( "stage" );
stage.addEventListener( "dragover", e => { e.preventDefault(); stage.classList.add( "drag" ); } );
stage.addEventListener( "dragleave", () => stage.classList.remove( "drag" ) );
stage.addEventListener( "drop", e => { e.preventDefault(); stage.classList.remove( "drag" ); const f = e.dataTransfer?.files[0]; if (f) loadFile( f ); } );

try {
    const saved = JSON.parse( localStorage.getItem( "verb-viewer" ) ?? "null" );
    if (saved && EXAMPLES.some( x => x.id == saved.example )) example = saved.example;
} catch (err) { /* storage unavailable */ }
group = EXAMPLES.find( x => x.id == example )!.group;
renderGroups(); renderExamples(); resize(); load( example );
